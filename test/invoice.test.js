var assert = require('node:assert/strict');
var test = require('node:test');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');

test('invoice prints the billed total and the GST on each discounted line', function () {
  var order = {
    id: 1001,
    items: [
      { name: 'Rice', hsn: '1006', price: 600, qty: 2 },
      { name: 'Ghee', hsn: '0405', price: 800, qty: 1 }
    ],
    coupon: 'SAVE10',
    subtotal: 2000,
    discount: 150,
    tax: 144.30,
    total: 1994.30
  };

  var figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.total, order.total);
  assert.equal(figures.discount, order.discount);
  assert.equal(figures.tax, order.tax);
  assert.deepEqual([figures.cgst, figures.sgst], [72.15, 72.15]);
  assert.deepEqual(figures.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 55.50], [12, 88.80]]);

  var html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">\u20b91994\.30/);
  assert.match(html, /5%<\/td><td class="r">\u20b955\.50/);
  assert.match(html, /12%<\/td><td class="r">\u20b988\.80/);
});

test('an existing invoice recovers a missing discount even if the coupon is inactive', function () {
  var order = {
    items: [{ name: 'Tea', hsn: '0902', price: 1000, qty: 1 }],
    coupon: 'DIWALI20',
    subtotal: 1000,
    tax: 144,
    total: 944
  };
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.discount, 200);
  assert.equal(figures.rows[0].lineTax, 144);
  assert.equal(figures.total, 944);
  assert.match(invoice.render(order), /Line-level GST is estimated using current rates/);
});

test('an existing invoice shows recorded GST when its item breakdown cannot be reconstructed', function () {
  var order = {
    id: 1002,
    items: [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }],
    subtotal: 100,
    discount: 0,
    tax: 5
  };
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [5, 2.50, 2.50, 105]);
  assert.equal(figures.rows[0].gstPercent, null);
  assert.equal(figures.rows[0].lineTax, null);
  assert.match(invoice.render(order), /Line-level GST could not be reconstructed/);

  var report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.rows[0].matched, false);
  assert.equal(report.rows[0].invoiceTax, 18);
  assert.equal(report.rows[0].printedTax, 5);
  assert.equal(report.rows[0].delta, 0);
  assert.equal(report.totalDelta, 0);
});

test('reconciliation flags a saved total that disagrees with the billed components', function () {
  var order = {
    id: 1003,
    items: [{ name: 'Tea', price: 1000, qty: 1, gstPercent: 18, lineTax: 144 }],
    subtotal: 1000,
    discount: 200,
    tax: 144,
    total: 945
  };

  assert.equal(invoice.computeInvoiceFigures(order).total, 945);
  assert.match(invoice.render(order), /The recorded billing amounts do not add up/);
  var report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.rows[0].invoiceTotal, 944);
  assert.equal(report.rows[0].printedTotal, 945);
  assert.equal(report.rows[0].delta, -1);
  assert.equal(report.totalDelta, 1);
});

test('a saved total above subtotal plus GST does not imply a discount', function () {
  var order = {
    id: 1004,
    items: [{ name: 'Tea', price: 100, qty: 1 }],
    coupon: 'WELCOME',
    subtotal: 100,
    tax: 18,
    total: 118.01
  };

  var figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.discount, 5);
  assert.match(invoice.render(order), /The recorded billing amounts do not add up/);
});

test('a saved total below subtotal plus GST does not imply a coupon discount on an uncouponed order', function () {
  var order = {
    items: [{ name: 'Tea', price: 100, qty: 1 }],
    coupon: '',
    subtotal: 100,
    tax: 18,
    total: 117.99
  };

  assert.equal(invoice.computeInvoiceFigures(order).discount, 0);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].delta, 0.01);
});

test('legacy invoices label estimated GST and reconciliation identifies a derived total', function () {
  var order = { items: [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }], subtotal: 100 };
  assert.match(invoice.render(order), /Line-level GST is estimated using current rates/);

  var row = reports.getGstReconciliation({ orders: [{ ...order, tax: 18 }] }).rows[0];
  assert.equal(row.ledgerTotal, 118);
  assert.equal(row.ledgerTotalRecorded, false);
  assert.equal(row.invoiceTotal, 118);
  assert.equal(row.matched, false);
});

test('reconciliation checks the subtotal against the order lines', function () {
  var order = {
    id: 1005,
    items: [{ name: 'Tea', price: 100, qty: 1, gstPercent: 18, lineTax: 18 }],
    subtotal: 101,
    discount: 0,
    tax: 18,
    total: 119
  };

  assert.match(invoice.render(order), /The recorded billing amounts do not add up/);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 1);
});

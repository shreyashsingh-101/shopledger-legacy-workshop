var assert = require('node:assert/strict');
var test = require('node:test');
var pricing = require('../lib/pricing');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');
var store = require('../lib/store');
var tax = require('../lib/tax');
var orderRouter = require('../routes/orders');

test('checkout and invoice agree on an undiscounted line at the fallback GST rate', function () {
  var items = [{ name: 'Unclassified item', price: 50, qty: 2 }];
  var billed = pricing.computeTotals(items);
  var printed = invoice.computeInvoiceFigures({ items: items });

  for (var figures of [billed, printed]) {
    assert.equal(figures.subtotal, 100);
    assert.equal(figures.discount, 0);
    assert.equal(figures.tax, 18);
    assert.equal(figures.cgst, 9);
    assert.equal(figures.sgst, 9);
    assert.equal(figures.total, 118);
  }
});

test('invoice and reconciliation use the posted order’s HSN rates and capped coupon', function (t) {
  var db = {
    products: [
      { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 600, stock: 10 },
      { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 800, stock: 10 }
    ],
    nextOrderId: 1001,
    orders: []
  };
  var order;
  t.mock.method(store, 'read', function () { return db; });
  var write = t.mock.method(store, 'write', function (saved) {
    assert.strictEqual(saved, db);
  });

  orderRouter.handle({
    method: 'POST',
    url: '/orders',
    body: { items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], coupon: ' save10 ' }
  }, {
    status: function (code) {
      assert.equal(code, 201);
      return this;
    },
    json: function (body) { order = body; }
  }, function (error) {
    assert.fail(error || 'Order route did not respond');
  });

  assert.equal(write.mock.callCount(), 1);
  assert.strictEqual(order, db.orders[0]);
  assert.equal(order.coupon, 'SAVE10');
  assert.deepEqual(order.items.map(function (line) { return line.hsn; }), ['1006', '0405']);
  assert.equal(order.subtotal, 2000);
  assert.equal(order.discount, 150);
  assert.equal(order.tax, 144.30);
  assert.equal(order.total, 1994.30);

  var checkout = pricing.computeTotals(order.items, order.coupon);
  assert.deepEqual(checkout.lines.map(function (line) {
    return [line.gstPercent, line.discount, line.taxable, line.tax];
  }), [[5, 90, 1110, 55.50], [12, 60, 740, 88.80]]);
  assert.deepEqual([checkout.cgst, checkout.sgst], [72.15, 72.15]);

  var printed = invoice.computeInvoiceFigures(order);
  assert.deepEqual(printed.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 55.50], [12, 88.80]]);
  assert.equal(printed.discount, 150);
  assert.equal(printed.tax, 144.30);
  assert.deepEqual([printed.cgst, printed.sgst], [72.15, 72.15]);
  assert.equal(printed.total, 1994.30);

  var html = invoice.render(order);
  assert.doesNotMatch(html, /Line-level GST could not be reconstructed/);
  var report = reports.getGstReconciliation(db);
  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  assert.equal(report.rows[0].delta, 0);
  assert.equal(report.rows[0].matched, true);

  t.mock.method(tax, 'getRateForItem', function () { return 0.18; });
  assert.deepEqual(invoice.computeInvoiceFigures(order).rows, printed.rows);
  assert.equal(reports.getGstReconciliation(db).mismatchCount, 0);
});

test('invoice applies a flat coupon before calculating GST', function () {
  var items = [{ name: 'Tea', hsn: '0902', price: 400, qty: 1 }];
  var billed = pricing.computeTotals(items, 'FLAT50');
  var printed = invoice.computeInvoiceFigures({ items: items, coupon: 'FLAT50' });

  assert.deepEqual([billed.discount, billed.tax, billed.total], [50, 63, 413]);
  assert.deepEqual([printed.discount, printed.tax, printed.total], [50, 63, 413]);
});

test('invoice follows checkout coupon eligibility when the order has no recorded discount', function () {
  var items = [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }];

  for (var coupon of ['FLAT50', 'DIWALI20']) {
    var billed = pricing.computeTotals(items, coupon);
    var printed = invoice.computeInvoiceFigures({ items: items, coupon: coupon });
    assert.deepEqual([billed.discount, billed.tax, billed.total], [0, 18, 118], coupon);
    assert.deepEqual([printed.discount, printed.tax, printed.total], [0, 18, 118], coupon);
  }
});

test('invoice and checkout interpret numeric percentage, decimal, and zero GST rates alike', function () {
  for (var [gstRate, expectedPercent] of [[5, 5], [0.05, 5], [0, 0]]) {
    var items = [{ name: 'Legacy item', hsn: '0405', price: 100, qty: 1, gstRate: gstRate }];
    var billed = pricing.computeTotals(items);
    var printed = invoice.computeInvoiceFigures({ items: items });
    assert.deepEqual([billed.lines[0].gstPercent, billed.tax], [expectedPercent, expectedPercent]);
    assert.deepEqual([printed.rows[0].gstPercent, printed.tax], [expectedPercent, expectedPercent]);
  }
});

test('invoice and checkout round each GST line before summing', function () {
  var items = [{ name: 'Sample A', price: 0.03, qty: 1 }, { name: 'Sample B', price: 0.03, qty: 1 }];
  var billed = pricing.computeTotals(items);
  var printed = invoice.computeInvoiceFigures({ items: items });

  assert.deepEqual(billed.lines.map(function (line) { return line.tax; }), [0.01, 0.01]);
  assert.deepEqual(printed.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, billed.total], [0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual([printed.tax, printed.cgst, printed.sgst, printed.total], [0.02, 0.01, 0.01, 0.08]);
});

test('reconciliation matches the GST and total for the pending order and skips cancellation', function () {
  var order = {
    id: 1,
    status: 'pending',
    items: [{ name: 'Tea', hsn: '0902', price: 1000, qty: 1 }],
    coupon: 'SAVE10',
    subtotal: 1000,
    discount: 100,
    tax: 162,
    total: 1062
  };
  var db = { orders: [order, { ...order, id: 2, status: 'cancelled' }] };
  var report = reports.getGstReconciliation(db);
  var result = report.rows[0];

  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  assert.equal(result.orderId, 1);
  assert.equal(result.ledgerTax, 162);
  assert.equal(result.invoiceTax, 162);
  assert.equal(result.invoiceTotal, 1062);
  assert.equal(result.delta, 0);
  assert.equal(result.matched, true);
});

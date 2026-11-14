const test = require('node:test');
const assert = require('node:assert/strict');
const { load, config } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));

// One day at a truck: a cash check in Tacoma-rate territory, a cash check elsewhere
// (different tax), a card check, a voided cash payment and a partially refunded one.
function orders() {
  return [
    { guid: 'o1', checks: [{ amount: 20.00, taxAmount: 2.06, totalAmount: 22.06, payments: [
      { type: 'CASH', amount: 22.06, tipAmount: 0, paymentStatus: 'CAPTURED', refundStatus: 'NONE' }] }] },
    { guid: 'o2', checks: [{ amount: 10.00, taxAmount: 0.92, totalAmount: 12.92, payments: [
      { type: 'CASH', amount: 10.92, tipAmount: 2.00, paymentStatus: 'CAPTURED', refundStatus: 'NONE' }] }] },
    { guid: 'o3', checks: [{ amount: 30.00, taxAmount: 3.09, totalAmount: 33.09, payments: [
      { type: 'CREDIT', amount: 33.09, tipAmount: 5, paymentStatus: 'CAPTURED' }] }] },
    { guid: 'o4', checks: [{ amount: 5.00, taxAmount: 0.52, totalAmount: 5.52, payments: [
      { type: 'CASH', amount: 5.52, paymentStatus: 'VOIDED' }] }] },
    { guid: 'o5', voided: true, checks: [{ amount: 99, taxAmount: 9, payments: [{ type: 'CASH', amount: 108 }] }] },
    { guid: 'o6', checks: [{ amount: 10.00, taxAmount: 1.00, totalAmount: 11.00, payments: [
      { type: 'CASH', amount: 11.00, tipAmount: 0, paymentStatus: 'CAPTURED', refundStatus: 'PARTIAL',
        refund: { refundAmount: 5.50, tipRefundAmount: 0 } }] }] },
  ];
}

test('cash totals use the tax actually charged on each check', () => {
  const ctx = load();
  const c = plain(ctx.computeCashFromOrders(orders()));
  assert.equal(c.count, 3);
  assert.equal(c.grossCents, 2206 + 1292 + 1100);
  assert.equal(c.taxCents, 206 + 92 + 100);
  assert.equal(c.tipCents, 200);
  assert.equal(c.refundCents, 550);
  assert.equal(c.refundTaxCents, 50);
});

test('cash breakdown balances: cash on hand = sales + tax + tips', () => {
  const ctx = load();
  const cfg = config(ctx, { cash: { enabled: true, onHandAccount: 'Cash on Hand - Toast' } });
  const b = ctx.buildCashBreakdown({ orders: orders(), restaurantGuid: 'g', restaurantName: 'Truck 2', businessDate: '20261112', config: cfg });
  assert.equal(b.ok, true);
  const by = Object.fromEntries(b.lines.map((l) => [l.role, l.cents]));
  // gross 45.98 - refund 5.50 = 40.48; tax 3.98 - 0.50 refunded = 3.48; tips 2.00
  assert.deepEqual(plain(by), { sales: 3500, salesTax: 348, tips: 200 });
  assert.equal(b.bankCents, 4048);
  assert.equal(b.key, 'toast-cash:g:20261112');
  const credits = b.lines.reduce((s, l) => s + l.cents, 0);
  assert.equal(credits, b.bankCents);
});

test('syncCash posts one balanced journal entry per location-day and skips existing / empty days', () => {
  const ctx = load();
  const cfg = config(ctx, { toast: { restaurantIds: ['g1', 'g2'] }, cash: { enabled: true, onHandAccount: 'Cash on Hand - Toast' } });
  const created = [];
  const qbo = {
    resolveAccount: (n) => ({ value: 'id-' + n, name: n }), resolveDepartment: () => null, resolveClass: () => null,
    findExisting: (key) => (key === 'toast-cash:g2:20261111' ? { entity: 'JournalEntry', id: '9' } : null),
    create: (entity, payload) => { created.push({ entity, payload }); return { Id: '100' }; },
  };
  const toast = { getOrders: (g, d) => (g === 'g2' && d === '20261112' ? [] : orders()) };
  const r = ctx.syncCash({ config: cfg, toast, qbo, startYmd: '20261111', endYmd: '20261112', dryRun: false,
    locationNames: { g1: 'Tacoma', g2: 'Truck 2' } });
  assert.deepEqual(plain(r.posted.map((x) => x.label)), ['Cash Tacoma 2026-11-11', 'Cash Tacoma 2026-11-12']);
  assert.deepEqual(plain(r.existing.map((x) => x.label)), ['Cash Truck 2 2026-11-11']);
  assert.deepEqual(plain(r.skipped.map((x) => x.reason)), ['No cash payments.']);
  const je = created[0].payload;
  assert.equal(created[0].entity, 'JournalEntry');
  assert.match(je.PrivateNote, /^toast-cash:g1:20261111 \|/);
  const sum = (t) => je.Line.filter((l) => l.JournalEntryLineDetail.PostingType === t).reduce((s, l) => s + Math.round(l.Amount * 100), 0);
  assert.equal(sum('Debit'), sum('Credit'));
  assert.equal(je.Line[0].JournalEntryLineDetail.AccountRef.name, 'Cash on Hand - Toast');
});

test('Standard API client pages through orders and sends the restaurant header', () => {
  const calls = [];
  const page = (n) => Array.from({ length: n }, (_, i) => ({ guid: 'o' + i }));
  const ctx = load({
    props: { TOAST_STD_CLIENT_ID: 'sid', TOAST_STD_CLIENT_SECRET: 'ssec' },
    fetch: (url, opts) => {
      calls.push({ url, headers: opts.headers || {} });
      if (url.endsWith('/login')) return { code: 200, text: JSON.stringify({ token: { accessToken: 'std', expiresIn: 3600 } }) };
      const p = Number(/page=(\d+)/.exec(url)[1]);
      return { code: 200, text: JSON.stringify(page(p === 1 ? 100 : 7)) };
    },
  });
  const orders = new ctx.StandardToastClient(config(ctx)).getOrders('rest-guid', '20261112');
  assert.equal(orders.length, 107);
  const gets = calls.filter((c) => c.url.includes('ordersBulk'));
  assert.equal(gets.length, 2);
  assert.match(gets[0].url, /businessDate=20261112&pageSize=100&page=1/);
  assert.equal(gets[0].headers['Toast-Restaurant-External-ID'], 'rest-guid');
});

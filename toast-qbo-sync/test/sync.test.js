const test = require('node:test');
const assert = require('node:assert/strict');
const { load, config } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));

function row(name, guid, date, over = {}) {
  return {
    restaurantGuid: guid, restaurantName: name, settledDate: date, salesPeriodStartDateTime: '', salesPeriodEndDateTime: '',
    paymentAmount: 100, refundAmount: 0, totalFeeAmount: 3, withholdingAmount: 10, payoutAmount: 87, payoutStatus: 'SENT', ...over,
  };
}

function fakeToast(rows, detailFor) {
  return {
    getSettledPayouts: () => rows,
    getPayoutDetail: (r) => detailFor(r),
  };
}
const goodDetail = (r) => ({
  payments: [{ restaurantGuid: r.restaurantGuid, checkGuid: 'c', paymentGuid: 'p', settledDate: r.settledDate,
    paymentSubtotal: 90, paymentTotal: 100, tipAmount: 10, gratuityAmount: 0 }],
  checksByGuid: { c: { checkTotalAmount: 100, checkTaxAmount: 9, checkTipAmount: 10, checkGratuityAmount: 0 } },
});

function fakeQbo(existingKeys = []) {
  const created = [];
  return {
    created,
    resolveAccount: (n) => ({ value: 'id-' + n, name: n }),
    resolveDepartment: (n) => (n ? { value: 'd', name: n } : null),
    resolveClass: (n) => (n ? { value: 'c', name: n } : null),
    findExisting: (key) => (existingKeys.includes(key) ? { entity: 'Deposit', id: '42' } : null),
    create: (entity, payload) => { created.push({ entity, payload }); return { Id: String(100 + created.length) }; },
  };
}

test('posts new payouts, skips ones already in QuickBooks, holds bad ones, ignores empty days', () => {
  const ctx = load();
  const rows = [
    row('Truck 2', 'g2', '20261110'),
    row('Tacoma', 'g1', '20261110'),
    row('Trailer', 'g3', '20261110'),
    row('Truck 4', 'g4', '20261110', { paymentAmount: 0, totalFeeAmount: 0, withholdingAmount: 0, payoutAmount: 0 }),
    row('Truck 2', 'g2', '20261109', { payoutStatus: 'NONE' }),
  ];
  const toast = fakeToast(rows, (r) => (r.restaurantGuid === 'g3' ? { payments: [], checksByGuid: {} } : goodDetail(r)));
  const qbo = fakeQbo(['toast-payout:g1:20261110']);
  const r = ctx.syncPayouts({ config: config(ctx), toast, qbo, startYmd: '20261109', endYmd: '20261110', dryRun: false });

  assert.deepEqual(plain(r.posted.map((x) => x.label)), ['Truck 2 2026-11-10']);
  assert.deepEqual(plain(r.existing.map((x) => x.label)), ['Tacoma 2026-11-10']);
  assert.deepEqual(plain(r.held.map((x) => x.label).sort()), ['Trailer 2026-11-10', 'Truck 2 2026-11-09']);
  assert.deepEqual(plain(r.skipped.map((x) => x.label)), ['Truck 4 2026-11-10']);
  assert.equal(r.errors.length, 0);
  assert.equal(qbo.created.length, 1);
  const dep = qbo.created[0].payload;
  assert.equal(qbo.created[0].entity, 'Deposit');
  const total = dep.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
  assert.equal(total, 8700);
  const text = ctx.formatSyncResult(r);
  assert.match(text, /HELD/);
  assert.equal(ctx.syncNeedsAttention(r), true);
});

test('dry run writes nothing and works without QuickBooks connected', () => {
  const ctx = load();
  const toast = fakeToast([row('Truck 2', 'g2', '20261110')], goodDetail);
  const r = ctx.syncPayouts({ config: config(ctx), toast, qbo: null, startYmd: '20261110', endYmd: '20261110', dryRun: true });
  assert.equal(r.previews.length, 1);
  assert.equal(r.posted.length, 0);
  assert.match(ctx.formatSyncResult(r), /DRY RUN/);
  assert.match(r.previews[0].summary, /bank \$87\.00/);
});

test('an error on one payout does not stop the others', () => {
  const ctx = load();
  const toast = fakeToast([row('A', 'ga', '20261110'), row('B', 'gb', '20261110')], (r) => {
    if (r.restaurantGuid === 'ga') throw new Error('boom');
    return goodDetail(r);
  });
  const qbo = fakeQbo();
  const r = ctx.syncPayouts({ config: config(ctx), toast, qbo, startYmd: '20261110', endYmd: '20261110', dryRun: false });
  assert.deepEqual(plain(r.errors.map((e) => e.label + ':' + e.error)), ['A 2026-11-10:boom']);
  assert.equal(r.posted.length, 1);
});

test('falls back to a Journal Entry if QuickBooks rejects the Deposit', () => {
  const ctx = load();
  const qbo = fakeQbo();
  const realCreate = qbo.create;
  qbo.create = (entity, payload) => {
    if (entity === 'Deposit') throw new Error('Deposit line amounts must be positive');
    return realCreate(entity, payload);
  };
  const r = ctx.syncPayouts({ config: config(ctx), toast: fakeToast([row('A', 'ga', '20261110')], goodDetail), qbo,
    startYmd: '20261110', endYmd: '20261110', dryRun: false });
  assert.equal(r.posted.length, 1);
  assert.equal(r.posted[0].entity, 'JournalEntry');
  assert.match(r.posted[0].warnings.join(), /posted as a Journal Entry/);
  assert.equal(ctx.syncNeedsAttention(r), true);
});

test('respects the restaurantIds filter and the time budget', () => {
  const ctx = load();
  const toast = fakeToast([row('A', 'ga', '20261110'), row('B', 'gb', '20261110'), row('C', 'gc', '20261110')], (r) => {
    ctx.advance(3 * 60 * 1000); // each payout "takes" 3 minutes
    return goodDetail(r);
  });
  const cfg = config(ctx, { toast: { restaurantIds: ['ga', 'gb', 'gc'] }, sync: { timeBudgetMs: 4 * 60 * 1000 } });
  const r = ctx.syncPayouts({ config: cfg, toast, qbo: fakeQbo(), startYmd: '20261110', endYmd: '20261110', dryRun: false });
  assert.equal(r.posted.length, 2);
  assert.equal(r.unfinished, true);

  const filtered = ctx.syncPayouts({
    config: config(ctx, { toast: { restaurantIds: ['gb'] } }), toast: fakeToast([row('A', 'ga', '20261110'), row('B', 'gb', '20261110')], goodDetail),
    qbo: fakeQbo(), startYmd: '20261110', endYmd: '20261110', dryRun: false,
  });
  assert.deepEqual(plain(filtered.posted.map((x) => x.label)), ['B 2026-11-10']);
});

test('a Toast rate limit stops the run cleanly and marks it unfinished', () => {
  const ctx = load();
  const toast = fakeToast([row('A', 'ga', '20261110'), row('B', 'gb', '20261110'), row('C', 'gc', '20261110')], (r) => {
    if (r.restaurantGuid === 'gb') throw new Error(ctx.TOAST_RATE_LIMIT_MSG + ' (POST /era/v1/check/day)');
    return goodDetail(r);
  });
  const r = ctx.syncPayouts({ config: config(ctx), toast, qbo: fakeQbo(), startYmd: '20261110', endYmd: '20261110', dryRun: false });
  assert.equal(r.posted.length, 1);
  assert.equal(r.errors.length, 0);
  assert.equal(r.unfinished, true);
  assert.equal(r.skipped.length, 2);
});

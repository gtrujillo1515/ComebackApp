const test = require('node:test');
const assert = require('node:assert/strict');
const { load, config } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));
const GUID = 'rest-1';

function sampleRow(over = {}) {
  return {
    restaurantGuid: GUID, restaurantName: 'Stacks Burgers - Tacoma ', settledDate: '20261110',
    salesPeriodStartDateTime: '2026-11-09 10:01:00', salesPeriodEndDateTime: '2026-11-09 21:40:00',
    transactionCount: 2, paymentAmount: 1150.0, refundAmount: 20.0, totalFeeAmount: 35.5,
    withholdingAmount: 120.0, payoutAmount: 974.5, payoutStatus: 'SENT', ...over,
  };
}
function samplePayments() {
  return [
    { restaurantGuid: GUID, checkGuid: 'c1', paymentGuid: 'p1', settledDate: 20261110, paidDateTime: '2026-11-09 11:00:00',
      tipAmount: 15.0, gratuityAmount: 0, paymentSubtotal: 110.3, paymentTotal: 125.3 },
    { restaurantGuid: GUID, checkGuid: 'c2', paymentGuid: 'p2', settledDate: 20261110, paidDateTime: '2026-11-09 19:00:00',
      tipAmount: 104.0, gratuityAmount: 0, paymentSubtotal: 920.7, paymentTotal: 1024.7 },
  ];
}
function sampleChecks() {
  return {
    c1: { checkGuid: 'c1', checkTotalAmount: 125.3, checkTaxAmount: 10.3, checkTipAmount: 15.0, checkGratuityAmount: 0 },
    c2: { checkGuid: 'c2', checkTotalAmount: 1024.7, checkTaxAmount: 85.98, checkTipAmount: 104.0, checkGratuityAmount: 0 },
  };
}
const fullConfig = (ctx) => config(ctx, {
  withholdingRules: [
    { name: 'Equipment lease', account: 'Toast Equipment Lease', method: 'fixed', amount: 25, locations: ['Stacks Burgers - Tacoma'] },
    { name: 'Toast Capital', account: 'Toast Capital Loan', method: 'remainder', locations: ['*'] },
  ],
  payoutSplits: [{ name: 'Toast checking', account: 'Toast Checking', method: 'percent', percent: 10, locations: ['*'] }],
});

function byRole(b) {
  const out = {};
  for (const l of b.lines) out[l.label] = l.cents;
  return out;
}

test('splits a payout into sales, tax, tips, fees, withholdings, Toast checking and bank', () => {
  const ctx = load();
  const b = ctx.buildPayoutBreakdown({ row: sampleRow(), payments: samplePayments(), checksByGuid: sampleChecks(), config: fullConfig(ctx) });
  assert.equal(b.ok, true, b.holdReasons.join());
  assert.deepEqual(plain(byRole(b)), {
    'Card sales': 93472,
    'Sales tax on card sales': 9628,
    'Card tips': 11900,
    'Card refunds': 2000,
    'Card processing fees': 3550,
    'Equipment lease': 2500,
    'Toast Capital': 9500,
    'Toast checking': 9745,
  });
  assert.equal(b.bankCents, 87705);
  assert.equal(b.bankAccount, 'Business Checking');
  assert.deepEqual(plain(b.warnings), []);
  const credits = b.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.cents, 0);
  const debits = b.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.cents, 0);
  assert.equal(credits, debits + b.bankCents);
});

test('prorates tax for a partial payment on a check', () => {
  const ctx = load();
  const card = ctx.computeCardComponents(
    [{ checkGuid: 'c', paymentSubtotal: 90, paymentTotal: 100, tipAmount: 10, gratuityAmount: 0 }],
    { c: { checkTotalAmount: 200, checkTaxAmount: 18, checkTipAmount: 20, checkGratuityAmount: 0 } },
    null,
  );
  assert.equal(card.taxCents, 900);
  assert.equal(card.tipCents, 1000);
  assert.equal(card.taxFromChecks, 1);
});

test('falls back to the location default tax rate when the check is missing', () => {
  const ctx = load();
  const card = ctx.computeCardComponents([{ checkGuid: 'x', paymentSubtotal: 110.3, paymentTotal: 110.3, tipAmount: 0 }], {}, 0.103);
  assert.equal(card.taxCents, 1030);
  assert.equal(card.taxFromRate, 1);
});

test('holds the payout when per-payment detail does not add up', () => {
  const ctx = load();
  const b = ctx.buildPayoutBreakdown({ row: sampleRow(), payments: samplePayments().slice(0, 1), checksByGuid: sampleChecks(), config: fullConfig(ctx) });
  assert.equal(b.ok, false);
  assert.match(b.holdReasons[0], /does not match/);
});

test('small card differences within tolerance go to sales with a warning', () => {
  const ctx = load();
  const b = ctx.buildPayoutBreakdown({
    row: sampleRow({ paymentAmount: 1150.03, payoutAmount: 974.53 }),
    payments: samplePayments(), checksByGuid: sampleChecks(), config: fullConfig(ctx),
  });
  assert.equal(b.ok, true);
  assert.equal(byRole(b)['Card sales'], 93475);
  assert.match(b.warnings.join(), /differs from payout total/);
});

test('withholdings with no matching rule go to the unallocated account', () => {
  const ctx = load();
  const cfg = config(ctx, { withholdingRules: [] });
  const b = ctx.buildPayoutBreakdown({ row: sampleRow(), payments: samplePayments(), checksByGuid: sampleChecks(), config: cfg });
  const line = b.lines.find((l) => l.role === 'withholding');
  assert.equal(line.account, 'Toast Withholdings - Unallocated');
  assert.equal(line.cents, 12000);
  assert.match(b.warnings.join(), /not covered by withholdingRules/);
});

test('withholding rules respect date windows and percent rules', () => {
  const ctx = load();
  const ctxArgs = { restaurantGuid: GUID, restaurantName: 'Tacoma', settledDate: '20261110', paymentCents: 100000 };
  const rules = [
    { name: 'Old lease', account: 'Lease', method: 'fixed', amount: 50, endDate: '20261031' },
    { name: 'Capital 8%', account: 'Capital', method: 'percent', percent: 8, percentOf: 'payment' },
    { name: 'Rest', account: 'Other', method: 'remainder' },
  ];
  const r = plain(ctx.allocateWithholding(10000, ctxArgs, rules));
  assert.deepEqual(r, { lines: [{ name: 'Capital 8%', account: 'Capital', cents: 8000 }, { name: 'Rest', account: 'Other', cents: 2000 }], unallocatedCents: 0 });
  // Negative (reversal) goes to the remainder rule.
  const neg = plain(ctx.allocateWithholding(-500, ctxArgs, rules));
  assert.deepEqual(neg.lines, [{ name: 'Rest', account: 'Other', cents: -500 }]);
});

test("books Toast's penny rounding to the reconciliation account", () => {
  const ctx = load();
  const b = ctx.buildPayoutBreakdown({
    row: sampleRow({ payoutAmount: 974.51 }), payments: samplePayments(), checksByGuid: sampleChecks(), config: fullConfig(ctx),
  });
  assert.equal(b.ok, true);
  const rec = b.lines.find((l) => l.role === 'reconciliation');
  assert.equal(rec.cents, -1);
  assert.equal(rec.account, 'Toast Reconciliation Differences');
});

test('per-location account overrides and matching by restaurant name', () => {
  const ctx = load();
  const cfg = config(ctx, {
    locations: { 'Stacks Burgers - Tacoma': { department: 'Tacoma', class: 'Restaurant', accounts: { sales: 'Sales:Tacoma' } } },
  });
  const b = ctx.buildPayoutBreakdown({ row: sampleRow(), payments: samplePayments(), checksByGuid: sampleChecks(), config: cfg });
  assert.equal(b.lines.find((l) => l.role === 'sales').account, 'Sales:Tacoma');
  assert.equal(b.location.department, 'Tacoma');
  assert.equal(b.location.klass, 'Restaurant');
  assert.equal(b.lines.find((l) => l.role === 'fees').account, 'Merchant Processing Fees');
});

test('handles a refund-only day with negative payout', () => {
  const ctx = load();
  const row = sampleRow({ paymentAmount: 0, refundAmount: 23.74, totalFeeAmount: 0, withholdingAmount: 0, payoutAmount: -23.74 });
  const b = ctx.buildPayoutBreakdown({ row, payments: [], checksByGuid: {}, config: config(ctx) });
  assert.equal(b.ok, true);
  assert.equal(b.bankCents, -2374);
  assert.deepEqual(plain(byRole(b)), { 'Card refunds': 2374 });
});

test('Stacks rules: capital 19.8%, lease 0.75%, Toast Checking matches the payout, rest to pending', () => {
  const ctx = load();
  const T = 'tacoma';
  const cfg = config(ctx, {
    withholdingRules: [
      { name: 'Capital', account: 'Toast Capital loan', method: 'percent', percent: 19.8, percentOf: 'payment', locations: [T] },
      { name: 'Lease', account: 'Rent & Lease', method: 'percent', percent: 0.75, percentOf: 'payment', locations: [T] },
      { name: 'Savings', account: 'Toast Checking (3569)', method: 'matchPayout', locations: ['*'] },
      { name: 'Other', account: 'Pending', method: 'remainder', locations: ['*'] },
    ],
  });
  // Toast's own payout screen: card 15,261.37, fees 443.08, withheld 9,051.77, payout 5,766.52
  const row = { restaurantGuid: T, restaurantName: 'Tacoma', settledDate: '20261102', paymentAmount: 15261.37, refundAmount: 0,
    totalFeeAmount: 443.08, withholdingAmount: 9051.77, payoutAmount: 5766.52, payoutStatus: 'SENT' };
  const payments = [{ restaurantGuid: T, checkGuid: 'c', paymentGuid: 'p', settledDate: 20261102, paymentSubtotal: 15261.37, paymentTotal: 15261.37, tipAmount: 0 }];
  const b = ctx.buildPayoutBreakdown({ row, payments, checksByGuid: {}, config: cfg });
  const w = Object.fromEntries(b.lines.filter((l) => l.role === 'withholding').map((l) => [l.label, l.cents]));
  // Toast's screen: capital 3,021.42 / lease 114.37 / savings 5,786.85 / other 129.13
  assert.deepEqual(plain(w), { Capital: 302175, Lease: 11446, Savings: 576652, Other: 14904 });
  assert.equal(b.bankCents, 576652);
  // Truck without a loan: only savings + remainder.
  const t2 = ctx.buildPayoutBreakdown({ row: { ...row, restaurantGuid: 'truck2', restaurantName: 'Truck 2', withholdingAmount: 1016.90, paymentAmount: 2032.10,
    totalFeeAmount: 64.98, payoutAmount: 950.22 }, payments: [{ ...payments[0], paymentSubtotal: 2032.10, paymentTotal: 2032.10 }], checksByGuid: {}, config: cfg });
  const w2 = Object.fromEntries(t2.lines.filter((l) => l.role === 'withholding').map((l) => [l.label, l.cents]));
  assert.deepEqual(plain(w2), { Savings: 95022, Other: 6668 });
});

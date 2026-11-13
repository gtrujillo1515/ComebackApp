const test = require('node:test');
const assert = require('node:assert/strict');
const { load, config } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));
const refs = {
  account: (n) => ({ value: 'A:' + n, name: n }),
  department: (n) => (n ? { value: 'D:' + n, name: n } : null),
  klass: (n) => (n ? { value: 'C:' + n, name: n } : null),
};

function breakdown(ctx, cfg, rowOver = {}) {
  const row = {
    restaurantGuid: 'g', restaurantName: 'Truck 2', settledDate: '20261110', paymentAmount: 500, refundAmount: 0,
    totalFeeAmount: 15, withholdingAmount: 40, payoutAmount: 445, payoutStatus: 'SENT', ...rowOver,
  };
  const payments = row.paymentAmount
    ? [{ restaurantGuid: 'g', checkGuid: 'c', paymentGuid: 'p', settledDate: 20261110, tipAmount: 50, gratuityAmount: 0, paymentSubtotal: 450, paymentTotal: 500 }]
    : [];
  const checks = { c: { checkTotalAmount: 500, checkTaxAmount: 40, checkTipAmount: 50, checkGratuityAmount: 0 } };
  return ctx.buildPayoutBreakdown({ row, payments, checksByGuid: checks, config: cfg });
}

test('builds a Deposit whose lines sum to the bank amount', () => {
  const ctx = load();
  const cfg = config(ctx, { locations: { 'Truck 2': { department: 'Truck 2', class: 'Trucks' } } });
  const b = breakdown(ctx, cfg);
  const txn = plain(ctx.buildQboTransaction(b, refs, cfg));
  assert.equal(txn.entity, 'Deposit');
  assert.equal(txn.payload.TxnDate, '2026-11-10');
  assert.deepEqual(txn.payload.DepositToAccountRef, { value: 'A:Business Checking', name: 'Business Checking' });
  assert.deepEqual(txn.payload.DepartmentRef, { value: 'D:Truck 2', name: 'Truck 2' });
  assert.match(txn.payload.PrivateNote, /^toast-payout:g:20261110 \|/);
  const amounts = Object.fromEntries(txn.payload.Line.map((l) => [l.DepositLineDetail.AccountRef.name, l.Amount]));
  assert.deepEqual(amounts, {
    Sales: 410, 'Sales Tax Payable - Toast': 40, 'Tips Payable': 50,
    'Merchant Processing Fees': -15, 'Toast Capital Loan': -40,
  });
  const total = txn.payload.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
  assert.equal(total, 44500);
  assert.ok(txn.payload.Line.every((l) => l.DepositLineDetail.ClassRef.name === 'Trucks'));
});

test('uses a balanced Journal Entry when the payout is zero or negative', () => {
  const ctx = load();
  const cfg = config(ctx);
  const b = breakdown(ctx, cfg, { paymentAmount: 0, refundAmount: 0, totalFeeAmount: 0, withholdingAmount: 40, payoutAmount: -40 });
  assert.equal(b.ok, true, b.holdReasons.join());
  const txn = plain(ctx.buildQboTransaction(b, refs, cfg));
  assert.equal(txn.entity, 'JournalEntry');
  let dr = 0, cr = 0;
  for (const l of txn.payload.Line) {
    assert.ok(l.Amount > 0);
    if (l.JournalEntryLineDetail.PostingType === 'Debit') dr += Math.round(l.Amount * 100);
    else cr += Math.round(l.Amount * 100);
  }
  assert.equal(dr, cr);
  const bank = txn.payload.Line.find((l) => l.JournalEntryLineDetail.AccountRef.name === 'Business Checking');
  assert.equal(bank.JournalEntryLineDetail.PostingType, 'Credit');
  assert.equal(bank.Amount, 40);
});

test('journal mode produces balanced entries for normal payouts too', () => {
  const ctx = load();
  const cfg = config(ctx, { sync: { postingMode: 'journal' } });
  const txn = plain(ctx.buildQboTransaction(breakdown(ctx, cfg), refs, cfg));
  assert.equal(txn.entity, 'JournalEntry');
  const sum = (t) => txn.payload.Line.filter((l) => l.JournalEntryLineDetail.PostingType === t).reduce((s, l) => s + Math.round(l.Amount * 100), 0);
  assert.equal(sum('Debit'), 50000);
  assert.equal(sum('Credit'), 50000);
});

test('QuickBooks errors include the fault message and intuit_tid', () => {
  const ctx = load({
    fetch: () => ({
      code: 400,
      headers: { Intuit_Tid: '1-abc-123' },
      text: JSON.stringify({ Fault: { Error: [{ Message: 'Invalid account', Detail: 'Account 99 not found' }] } }),
    }),
  });
  const qbo = new ctx.QboClient(config(ctx), { getAccessToken: () => 't', refresh: () => {}, realmId: '1' });
  assert.throws(() => qbo.create('Deposit', {}), /Invalid account - Account 99 not found \[intuit_tid 1-abc-123\]/);
});

test('txnDateOffsetDays shifts the QuickBooks date', () => {
  const ctx = load();
  const cfg = config(ctx, { sync: { txnDateOffsetDays: 1 } });
  const txn = ctx.buildQboTransaction(breakdown(ctx, cfg), refs, cfg);
  assert.equal(txn.payload.TxnDate, '2026-11-11');
});

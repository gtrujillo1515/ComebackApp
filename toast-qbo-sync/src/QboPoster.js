/**
 * Turns a payout breakdown into a QuickBooks Deposit (default) or Journal
 * Entry payload. Pure function: the `refs` object resolves names to QBO refs.
 *
 * Deposit layout (total = exactly what hits the bank, so the bank feed matches):
 *    + Card sales            -> Sales income
 *    + Sales tax             -> Sales tax payable
 *    + Card tips / gratuity  -> Tips payable
 *    - Refunds               -> Refunds
 *    - Card fees             -> Merchant fees
 *    - Toast Capital / lease -> loan / lease liability
 *    - Toast checking sweep  -> Toast checking (bank)
 *    = Deposit total
 */

/**
 * @param {Object} b       breakdown from buildPayoutBreakdown
 * @param {Object} refs    { account(name), department(name), klass(name) } -> {value,name} | null
 * @param {Object} config  CONFIG
 */
function buildQboTransaction(b, refs, config) {
  var txnDate = ymdToIso(addDaysYmd(b.settledDate, config.sync.txnDateOffsetDays || 0));
  var classRef = b.location.klass ? refs.klass(b.location.klass) : null;
  var deptRef = b.location.department ? refs.department(b.location.department) : null;
  var bankRef = refs.account(b.bankAccount);
  var memo = b.key + ' | Toast payout ' + b.restaurantName + ' settled ' + ymdToIso(b.settledDate) +
    ' | card ' + formatMoney(b.toast.payment) + ', refunds ' + formatMoney(b.toast.refund) +
    ', fees ' + formatMoney(b.toast.fee) + ', withheld ' + formatMoney(b.toast.withholding) +
    ', payout ' + formatMoney(b.toast.payout) + ' | posted by toast-qbo-sync';

  function desc(l) { return l.label + ' - ' + b.restaurantName + ' ' + ymdToIso(b.settledDate); }

  var useDeposit = config.sync.postingMode !== 'journal' && b.bankCents > 0;

  if (useDeposit) {
    var lines = b.lines.map(function (l) {
      var signed = l.side === 'credit' ? l.cents : -l.cents;
      var detail = { AccountRef: refs.account(l.account) };
      if (classRef) detail.ClassRef = classRef;
      return { Amount: fromCents(signed), DetailType: 'DepositLineDetail', Description: desc(l), DepositLineDetail: detail };
    });
    var dep = {
      TxnDate: txnDate,
      DepositToAccountRef: bankRef,
      PrivateNote: memo,
      Line: lines,
    };
    if (deptRef) dep.DepartmentRef = deptRef;
    return { entity: 'Deposit', txnDate: txnDate, payload: dep, totalCents: b.bankCents };
  }

  // Journal entry: every amount positive, direction via PostingType.
  var jeLines = [];
  function jeLine(accountRef, cents, posting, description) {
    if (cents === 0) return;
    if (cents < 0) { cents = -cents; posting = posting === 'Debit' ? 'Credit' : 'Debit'; }
    var detail = { PostingType: posting, AccountRef: accountRef };
    if (classRef) detail.ClassRef = classRef;
    if (deptRef) detail.DepartmentRef = deptRef;
    jeLines.push({ Amount: fromCents(cents), DetailType: 'JournalEntryLineDetail', Description: description, JournalEntryLineDetail: detail });
  }
  jeLine(bankRef, b.bankCents, 'Debit', 'Toast payout deposit - ' + b.restaurantName + ' ' + ymdToIso(b.settledDate));
  b.lines.forEach(function (l) {
    jeLine(refs.account(l.account), l.cents, l.side === 'credit' ? 'Credit' : 'Debit', desc(l));
  });
  return {
    entity: 'JournalEntry',
    txnDate: txnDate,
    payload: { TxnDate: txnDate, PrivateNote: memo, Line: jeLines },
    totalCents: b.bankCents,
  };
}

/**
 * Orchestration: Toast settled payouts -> breakdown -> QuickBooks.
 * Clients are passed in so this can be tested end-to-end with fakes.
 */

/** Refs that just echo names, used for dry runs before QuickBooks is connected. */
var NAME_ONLY_REFS = {
  account: function (n) { return { value: '?', name: n }; },
  department: function (n) { return n ? { value: '?', name: n } : null; },
  klass: function (n) { return n ? { value: '?', name: n } : null; },
};

function qboRefs(qbo) {
  return {
    account: function (n) { return qbo.resolveAccount(n); },
    department: function (n) { return qbo.resolveDepartment(n); },
    klass: function (n) { return qbo.resolveClass(n); },
  };
}

/**
 * @param {Object} opts
 *   config, toast (ToastClient), qbo (QboClient or null for an offline dry run),
 *   startYmd, endYmd, dryRun, onPayout(record) optional hook (audit files)
 * @return {Object} result with posted / existing / held / skipped / errors / dryRun lists
 */
function syncPayouts(opts) {
  var config = opts.config;
  var toast = opts.toast;
  var qbo = opts.qbo;
  var dryRun = !!opts.dryRun;
  var started = Runtime.now();
  var tol = config.sync.reconcileToleranceCents;
  var allowed = config.sync.postStatuses || ['SENT', 'CAPTURED'];
  var wanted = config.toast.restaurantIds || [];

  var result = {
    range: { start: opts.startYmd, end: opts.endYmd }, dryRun: dryRun,
    posted: [], existing: [], held: [], skipped: [], previews: [], errors: [], unfinished: false,
  };

  var rows = toast.getSettledPayouts(opts.startYmd, opts.endYmd)
    .filter(function (r) { return !wanted.length || wanted.indexOf(r.restaurantGuid) >= 0; })
    .sort(function (a, b) {
      var d = String(a.settledDate).localeCompare(String(b.settledDate));
      return d !== 0 ? d : String(a.restaurantName).localeCompare(String(b.restaurantName));
    });

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var label = String(row.restaurantName || row.restaurantGuid).trim() + ' ' + ymdToIso(row.settledDate);
    if (Runtime.now() - started > config.sync.timeBudgetMs) {
      result.unfinished = true;
      result.skipped.push({ label: label, reason: 'Out of time this run; will continue next run.' });
      continue;
    }
    try {
      var status = String(row.payoutStatus || '').toUpperCase();
      var active = toCents(row.paymentAmount) !== 0 || toCents(row.payoutAmount) !== 0 ||
        toCents(row.withholdingAmount) !== 0 || toCents(row.refundAmount) !== 0 || toCents(row.totalFeeAmount) !== 0;
      if (!active) {
        result.skipped.push({ label: label, reason: 'No activity.' });
        continue;
      }
      if (allowed.indexOf(status) < 0) {
        // Never skip silently: anything not postable is held and reported.
        var why = status === 'NONE'
          ? 'Toast reports this payout as failed/unavailable (status NONE).'
          : 'Toast payout status is "' + (row.payoutStatus === undefined ? '(missing)' : row.payoutStatus) +
            '", not one of ' + allowed.join('/') + '; add it to CONFIG.sync.postStatuses if this payout reached the bank.';
        result.held.push({ label: label, reason: why });
        continue;
      }

      var key = payoutKey(row.restaurantGuid, row.settledDate);
      var txnDateIso = ymdToIso(addDaysYmd(row.settledDate, config.sync.txnDateOffsetDays || 0));
      if (qbo) {
        var found = qbo.findExisting(key, txnDateIso);
        if (found) {
          result.existing.push({ label: label, entity: found.entity, id: found.id });
          continue;
        }
      }

      var detail = toast.getPayoutDetail(row, tol);
      var b = buildPayoutBreakdown({ row: row, payments: detail.payments, checksByGuid: detail.checksByGuid, config: config });
      var record = { label: label, breakdown: b, summary: describeBreakdown(b), warnings: b.warnings };

      if (!b.ok) {
        record.reason = b.holdReasons.join(' ');
        result.held.push(record);
        if (opts.onPayout) opts.onPayout(record, 'held');
        continue;
      }

      var txn = buildQboTransaction(b, qbo ? qboRefs(qbo) : NAME_ONLY_REFS, config);
      record.transaction = txn;
      if (dryRun) {
        result.previews.push(record);
        if (opts.onPayout) opts.onPayout(record, 'preview');
        continue;
      }
      var created;
      try {
        created = qbo.create(txn.entity, txn.payload);
      } catch (depErr) {
        if (txn.entity !== 'Deposit') throw depErr;
        // QuickBooks rejected the Deposit (nothing was saved); book the same
        // amounts as an equivalent journal entry instead.
        var jeConfig = Object.assign({}, config, { sync: Object.assign({}, config.sync, { postingMode: 'journal' }) });
        txn = buildQboTransaction(b, qboRefs(qbo), jeConfig);
        record.transaction = txn;
        created = qbo.create(txn.entity, txn.payload);
        record.warnings = record.warnings.concat(['Deposit was rejected (' + String(depErr.message || depErr).slice(0, 200) +
          '); posted as a Journal Entry instead.']);
      }
      record.qboId = created && created.Id;
      record.entity = txn.entity;
      result.posted.push(record);
      if (opts.onPayout) opts.onPayout(record, 'posted');
    } catch (e) {
      var msg = String(e && e.message || e);
      if (msg.indexOf(TOAST_RATE_LIMIT_MSG) === 0) {
        result.unfinished = true;
        result.rateLimited = true;
        for (var k = i; k < rows.length; k++) {
          result.skipped.push({ label: String(rows[k].restaurantName || rows[k].restaurantGuid).trim() + ' ' +
            ymdToIso(rows[k].settledDate), reason: 'Toast rate limit reached; will continue next run.' });
        }
        break;
      }
      result.errors.push({ label: label, error: msg });
    }
  }
  return result;
}

/** Plain-text report for email / logs. */
function formatSyncResult(r) {
  var out = [];
  out.push('Toast -> QuickBooks payout sync ' + (r.dryRun ? '(DRY RUN - nothing written) ' : '') +
    'for settled dates ' + ymdToIso(r.range.start) + ' to ' + ymdToIso(r.range.end));
  out.push('');
  function section(title, items, fn) {
    if (!items.length) return;
    out.push(title + ' (' + items.length + ')');
    items.forEach(function (it) { out.push('  - ' + fn(it)); });
    out.push('');
  }
  section('ERRORS', r.errors, function (x) { return x.label + ': ' + x.error; });
  section('HELD - needs a look, will retry next run', r.held, function (x) { return x.label + ': ' + x.reason; });
  section('Posted to QuickBooks', r.posted, function (x) { return x.summary + ' [' + x.entity + ' #' + x.qboId + ']'; });
  section('Would post (dry run)', r.previews, function (x) { return x.summary; });
  section('Already in QuickBooks', r.existing, function (x) { return x.label + ' [' + x.entity + ' #' + x.id + ']'; });
  var warned = r.posted.concat(r.previews).filter(function (x) { return x.warnings && x.warnings.length; });
  section('Warnings', warned, function (x) { return x.label + ': ' + x.warnings.join(' '); });
  section('Skipped', r.skipped, function (x) { return x.label + ': ' + x.reason; });
  if (r.unfinished) out.push('Ran out of time; the remaining payouts will be handled on the next run.');
  return out.join('\n');
}

function syncNeedsAttention(r) {
  var warned = r.posted.concat(r.previews).some(function (x) { return x.warnings && x.warnings.length; });
  return r.errors.length > 0 || r.held.length > 0 || warned;
}

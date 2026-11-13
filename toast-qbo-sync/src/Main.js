/**
 * ============================================================================
 *  ENTRY POINTS: pick these from the function dropdown in the Apps Script editor.
 * ============================================================================
 *   1. authorizeQuickBooks  - logs a link; open it to connect QuickBooks (one time)
 *   2. checkSetup           - lists Toast locations and checks every QBO account name
 *   3. previewYesterday     - dry run for the most recent settled date, shows the entries
 *   4. runDailySync         - the real job (respects CONFIG.sync.dryRun)
 *   5. installDailyTrigger  - schedule runDailySync every day at CONFIG.sync.triggerHour
 *   backfill                - edit the dates inside it, then run it to catch up history
 */

function authorizeQuickBooks() {
  var service = getQboService();
  if (service.hasAccess() && Runtime.props().getProperty('QBO_REALM_ID')) {
    Logger.log('QuickBooks is already connected (company ' + Runtime.props().getProperty('QBO_REALM_ID') +
      '). Run disconnectQuickBooks first to connect a different company.');
    return;
  }
  Logger.log('Redirect URI to register in your Intuit app (Keys & credentials -> Redirect URIs):\n' +
    OAuth2.getRedirectUri());
  Logger.log('Open this link to connect QuickBooks:\n' + service.getAuthorizationUrl());
}

function disconnectQuickBooks() {
  getQboService().reset();
  Runtime.props().deleteProperty('QBO_REALM_ID');
  Logger.log('QuickBooks disconnected.');
}

/** Verify credentials, list Toast locations, and check every configured QBO name. */
function checkSetup() {
  var problems = [];
  var toast = new ToastClient(CONFIG);
  try {
    var rests = toast.getRestaurants();
    Logger.log('Toast locations visible to this credential:');
    rests.forEach(function (r) {
      Logger.log('  ' + r.restaurantGuid + '  ' + String(r.restaurantName).trim() +
        (r.active === false ? '  (inactive)' : '') + (r.testMode ? '  (test mode)' : ''));
    });
  } catch (e) {
    problems.push('Toast: ' + e.message);
  }

  var qbo = null;
  try {
    qbo = new QboClient(CONFIG);
  } catch (e) {
    problems.push('QuickBooks: ' + e.message);
  }
  if (qbo) {
    configuredQboNames(CONFIG).forEach(function (item) {
      try {
        var ref = item.kind === 'account' ? qbo.resolveAccount(item.name)
          : item.kind === 'location' ? qbo.resolveDepartment(item.name) : qbo.resolveClass(item.name);
        Logger.log('  OK  ' + item.kind + ' "' + item.name + '" -> id ' + ref.value + '  (' + item.usedBy + ')');
      } catch (e) {
        problems.push(e.message + '  (' + item.usedBy + ')');
      }
    });
  }

  if (problems.length) {
    Logger.log('\nFIX THESE:\n  - ' + problems.join('\n  - '));
  } else {
    Logger.log('\nEverything checks out.');
  }
}

/** Print the QuickBooks chart of accounts (type, name, balance) so names can be copied into CONFIG. */
function listQuickBooksAccounts() {
  var qbo = new QboClient(CONFIG);
  var rows = qbo.queryAll('SELECT * FROM Account WHERE Active = true', 'Account');
  rows.sort(function (a, b) {
    return (a.AccountType + a.FullyQualifiedName).localeCompare(b.AccountType + b.FullyQualifiedName);
  });
  var lines = rows.map(function (a) {
    return a.AccountType + ' | ' + a.FullyQualifiedName + ' | ' + formatMoney(toCents(a.CurrentBalance || 0));
  });
  // Apps Script truncates very long log lines, so print in chunks.
  Logger.log(rows.length + ' active QuickBooks accounts (type | name | balance):');
  for (var i = 0; i < lines.length; i += 40) Logger.log(lines.slice(i, i + 40).join('\n'));
}

/** Print the last 14 days of Toast payouts per location: card sales, refunds, fees, withholdings, payout. */
function showRecentPayouts() {
  var toast = new ToastClient(CONFIG);
  var end = addDaysYmd(todayYmd(), -1);
  var rows = toast.getSettledPayouts(addDaysYmd(end, -13), end);
  rows.sort(function (a, b) {
    var n = String(a.restaurantName).localeCompare(String(b.restaurantName));
    return n !== 0 ? n : String(a.settledDate).localeCompare(String(b.settledDate));
  });
  var lines = rows.map(function (r) {
    return [String(r.restaurantName).trim(), ymdToIso(r.settledDate), 'card ' + formatMoney(toCents(r.paymentAmount)),
      'refunds ' + formatMoney(toCents(r.refundAmount)), 'fees ' + formatMoney(toCents(r.totalFeeAmount)),
      'withheld ' + formatMoney(toCents(r.withholdingAmount)) +
        (toCents(r.paymentAmount) ? ' (' + (100 * toCents(r.withholdingAmount) / toCents(r.paymentAmount)).toFixed(2) + '% of card)' : ''),
      'payout ' + formatMoney(toCents(r.payoutAmount)),
      r.payoutStatus].join(' | ');
  });
  Logger.log(rows.length + ' Toast payouts, last 14 settled days:');
  for (var i = 0; i < lines.length; i += 40) Logger.log(lines.slice(i, i + 40).join('\n'));
}

/**
 * Troubleshooting: shows what Toast's per-payment report returns around the
 * most recent payout, so a HELD payout can be diagnosed. Writes nothing.
 */
function debugPayoutDetail() {
  var toast = new ToastClient(CONFIG);
  var d = latestSettledDate_(CONFIG, toast, 10);
  if (!d) { Logger.log('No recent payouts.'); return; }
  var wanted = CONFIG.toast.restaurantIds || [];
  var rows = toast.getSettledPayouts(d, d).filter(function (r) {
    return (!wanted.length || wanted.indexOf(r.restaurantGuid) >= 0) && toCents(r.paymentAmount) !== 0;
  });
  if (!rows.length) { Logger.log('No payouts on ' + d); return; }
  var row = rows[0];
  Logger.log('Payout row: ' + JSON.stringify(row));
  var start = row.salesPeriodStartDateTime ? toYmd(row.salesPeriodStartDateTime) : addDaysYmd(d, -1);
  dateRangeYmd(addDaysYmd(start, -1), d).forEach(function (day) {
    var ps = toast.getPaymentsForSalesDate(day);
    var mine = ps.filter(function (p) { return sameGuid(p.restaurantGuid, row.restaurantGuid); });
    var settled = {};
    mine.forEach(function (p) { settled[String(p.settledDate)] = (settled[String(p.settledDate)] || 0) + 1; });
    Logger.log('Sales date ' + day + ': ' + ps.length + ' payments total, ' + mine.length + ' for ' + row.restaurantName +
      '; settledDate values: ' + JSON.stringify(settled));
    if (mine.length) Logger.log('  example: ' + JSON.stringify(mine[0]));
    else if (ps.length) Logger.log('  example (other location): ' + JSON.stringify(ps[0]));
  });
}

/** Every QuickBooks name the config refers to, for checkSetup. */
function configuredQboNames(config) {
  var items = [];
  var seen = {};
  function add(kind, name, usedBy) {
    if (!name) return;
    var k = kind + '|' + normName(name);
    if (seen[k]) return;
    seen[k] = true;
    items.push({ kind: kind, name: name, usedBy: usedBy });
  }
  Object.keys(config.accounts).forEach(function (k) { add('account', config.accounts[k], 'accounts.' + k); });
  Object.keys(config.locations || {}).forEach(function (loc) {
    var l = config.locations[loc];
    add('location', l.department, 'locations["' + loc + '"].department');
    add('class', l.class, 'locations["' + loc + '"].class');
    Object.keys(l.accounts || {}).forEach(function (k) { add('account', l.accounts[k], 'locations["' + loc + '"].accounts.' + k); });
  });
  (config.withholdingRules || []).forEach(function (r) { add('account', r.account, 'withholdingRules: ' + r.name); });
  (config.payoutSplits || []).forEach(function (s) { add('account', s.account, 'payoutSplits: ' + s.name); });
  return items;
}

/** The scheduled job. */
function runDailySync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another sync is already running; exiting.');
    return;
  }
  try {
    var end = addDaysYmd(todayYmd(), -1);
    var start = addDaysYmd(end, -(Math.max(CONFIG.sync.lookbackDays, 1) - 1));
    runSync_(start, end, CONFIG.sync.dryRun, 'Daily sync');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Dry run for the most recent settled date that has payouts (Toast can take a
 * day or two to publish them). Never writes to QuickBooks.
 */
function previewYesterday() {
  var d = latestSettledDate_(CONFIG, new ToastClient(CONFIG), 10);
  if (!d) {
    Logger.log('No Toast payouts found for your locations in the last 10 days.');
    return;
  }
  Logger.log('Previewing the most recent settled date with payouts: ' + ymdToIso(d));
  runSync_(d, d, true, 'Preview');
}

/** Most recent settled date (YYYYMMDD) in the last `days` days with activity at a configured location. */
function latestSettledDate_(config, toast, days) {
  var end = addDaysYmd(todayYmd(), -1);
  var wanted = config.toast.restaurantIds || [];
  var best = '';
  toast.getSettledPayouts(addDaysYmd(end, -(days - 1)), end).forEach(function (r) {
    if (wanted.length && wanted.indexOf(r.restaurantGuid) < 0) return;
    if (toCents(r.paymentAmount) === 0 && toCents(r.payoutAmount) === 0) return;
    var d = toYmd(r.settledDate);
    if (d > best) best = d;
  });
  return best;
}

/** Catch up a past range. Edit the dates, run, re-run until it says nothing is left. */
function backfill() {
  var START = '20261101'; // YYYYMMDD settled date
  var END = '20261111';
  runSync_(START, END, CONFIG.sync.dryRun, 'Backfill');
}

function runSync_(startYmd, endYmd, dryRun, title) {
  var toast = new ToastClient(CONFIG);
  var qbo = null;
  var result;
  try {
    try {
      qbo = new QboClient(CONFIG);
    } catch (e) {
      if (!dryRun) throw e;
      Logger.log('QuickBooks not connected; dry run will show account names only. (' + e.message + ')');
    }
    result = syncPayouts({
      config: CONFIG, toast: toast, qbo: qbo, startYmd: startYmd, endYmd: endYmd, dryRun: dryRun,
      onPayout: writeAuditFile_,
    });
  } catch (e) {
    notify_(title + ' FAILED', 'The Toast -> QuickBooks sync could not run:\n\n' + (e.stack || e.message), true);
    throw e;
  }
  var text = formatSyncResult(result);
  Logger.log(text);
  var attention = syncNeedsAttention(result);
  var didSomething = result.posted.length || result.previews.length;
  if (attention || (CONFIG.sync.sendDailySummary && didSomething)) {
    notify_(title + (attention ? ': needs attention' : ': ' + (result.posted.length || result.previews.length) + ' payout(s)'),
      text, attention);
  }
  return result;
}

function notify_(subject, body, important) {
  var to = CONFIG.sync.alertEmail || Session.getEffectiveUser().getEmail();
  if (!to) return;
  MailApp.sendEmail(to, (important ? '[ACTION] ' : '') + 'Toast->QBO ' + subject, body);
}

function writeAuditFile_(record, outcome) {
  var folderId = CONFIG.sync.auditFolderId;
  if (!folderId) return;
  try {
    var b = record.breakdown;
    var name = 'qbo-' + outcome + '-' + b.settledDate + '-' + b.restaurantName.replace(/[^A-Za-z0-9]+/g, '_') + '.json';
    DriveApp.getFolderById(folderId).createFile(name, JSON.stringify({
      outcome: outcome, writtenAt: new Date().toISOString(), qboId: record.qboId || null,
      breakdown: b, transaction: record.transaction || null,
    }, null, 2), 'application/json');
  } catch (e) {
    Logger.log('Could not write audit file: ' + e.message);
  }
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailySync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailySync').timeBased().everyDays(1).atHour(CONFIG.sync.triggerHour).create();
  Logger.log('runDailySync scheduled daily around ' + CONFIG.sync.triggerHour + ':00 (' + Session.getScriptTimeZone() + ').');
}

function removeDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailySync') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Daily trigger removed.');
}

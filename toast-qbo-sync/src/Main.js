/**
 * ============================================================================
 *  ENTRY POINTS: pick these from the function dropdown in the Apps Script editor.
 * ============================================================================
 *   1. authorizeQuickBooks  - logs a link; open it to connect QuickBooks (one time)
 *   2. checkSetup           - lists Toast locations and checks every QBO account name
 *   3. previewYesterday     - dry run for the most recent settled date, shows the entries
 *   4. runDailySync         - the real job (dry run unless Script Property SYNC_MODE = live)
 *   5. installDailyTrigger  - schedule runDailySync every day at CONFIG.sync.triggerHour
 *   startCatchUp            - post every payout from START_DATE up to the last 14 days, one
 *                             week per hour, automatically (about 60 payout days per day)
 *   catchUpStatus / stopCatchUp
 *   previewCash             - dry run of yesterday's cash sales per location (Standard API)
 *   backfill                - edit the dates inside it, then run it to catch up a range once
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
  Logger.log('Mode: ' + (isLive_() ? 'LIVE - writes to QuickBooks' : 'DRY RUN - nothing is written (set Script Property SYNC_MODE = live to turn on)'));
  Logger.log('Start date: ' + (startDateFloor_() ? ymdToIso(startDateFloor_()) : 'not set (Script Property START_DATE)'));
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

  if (cashConfigured_()) {
    try {
      var std = new StandardToastClient(CONFIG);
      var g = (CONFIG.toast.restaurantIds || [])[0];
      var day = addDaysYmd(todayYmd(), -1);
      var orders = std.getOrders(g, day);
      var cash = computeCashFromOrders(orders);
      Logger.log('Toast Standard API works: ' + orders.length + ' orders and ' + cash.count + ' cash payments (' +
        formatMoney(cash.grossCents) + ') at the first location on ' + ymdToIso(day) + '.');
    } catch (e) {
      problems.push('Toast Standard API (cash): ' + e.message);
    }
    Logger.log('Cash start date: ' + (cashStartFloor_() ? ymdToIso(cashStartFloor_()) : 'not set (Script Property CASH_START_DATE)'));
  } else {
    Logger.log('Cash sales: off (add Script Properties TOAST_STD_CLIENT_ID and TOAST_STD_CLIENT_SECRET to turn on).');
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

/** Which Toast locations (including excluded ones) had payouts in January 2026. */
function showJanuaryPayouts() { showPayoutsByLocation_('20260101', '20260131'); }

/** Which Toast locations (including excluded ones) had payouts in February 2026. */
function showFebruaryPayouts() { showPayoutsByLocation_('20260201', '20260228'); }

/** Which Toast locations (including excluded ones) had payouts in June 2026. */
function showJunePayouts() { showPayoutsByLocation_('20260601', '20260630'); }

function showPayoutsByLocation_(startYmd, endYmd) {
  var all = JSON.parse(JSON.stringify(CONFIG));
  all.toast.restaurantIds = []; // ask Toast for every location
  var toast = new ToastClient(all);
  var wanted = CONFIG.toast.restaurantIds || [];
  try {
    Logger.log('Toast location records: ' + JSON.stringify(toast.getRestaurants().map(function (r) {
      return String(r.restaurantName).trim() + (r.active === false ? ' [inactive]' : '') + (r.archived ? ' [archived]' : '') +
        (r.testMode ? ' [test]' : '');
    })));
  } catch (e) { Logger.log('Could not list locations: ' + e.message); }

  [['ACTIVE location records', {}], ['INACTIVE location records', { inactive: true }]].forEach(function (pass) {
    var rows;
    try {
      rows = toast.getSettledPayouts(startYmd, endYmd, pass[1]);
    } catch (e) {
      Logger.log(pass[0] + ': error ' + e.message);
      return;
    }
    var by = {};
    rows.forEach(function (r) {
      var k = r.restaurantGuid;
      var b = by[k] || (by[k] = { name: r.restaurantName, n: 0, card: 0, wh: 0, payout: 0, first: '', last: '', statuses: {} });
      b.n++;
      b.card += toCents(r.paymentAmount);
      b.wh += toCents(r.withholdingAmount);
      b.payout += toCents(r.payoutAmount);
      var d = toYmd(r.settledDate);
      if (!b.first || d < b.first) b.first = d;
      if (!b.last || d > b.last) b.last = d;
      b.statuses[r.payoutStatus] = (b.statuses[r.payoutStatus] || 0) + 1;
    });
    var lines = Object.keys(by).map(function (k) {
      var b = by[k];
      return '  ' + (wanted.indexOf(k) >= 0 ? 'INCLUDED ' : 'excluded ') + b.name + ' (' + k + '): ' + b.n + ' payouts ' +
        ymdToIso(b.first) + '..' + ymdToIso(b.last) + ', card ' + formatMoney(b.card) + ', withheld ' + formatMoney(b.wh) +
        (b.card ? ' (' + (100 * b.wh / b.card).toFixed(2) + '%)' : '') + ', paid out ' + formatMoney(b.payout) +
        ', status ' + JSON.stringify(b.statuses);
    });
    Logger.log(pass[0] + ', ' + ymdToIso(startYmd) + '..' + ymdToIso(endYmd) + ': ' + rows.length + ' payouts\n' +
      (lines.join('\n') || '  (none)'));
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
  if (config.cash && config.cash.enabled) add('account', config.cash.onHandAccount, 'cash.onHandAccount');
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
    runSync_(start, end, !isLive_(), 'Daily sync');
    if (cashConfigured_()) runCash_(start, end, !isLive_(), 'Daily cash');
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
  runSync_(START, END, !isLive_(), 'Backfill');
}

/** Live only when Script Property SYNC_MODE is "live"; anything else is a dry run. */
function isLive_() {
  return String(Runtime.props().getProperty('SYNC_MODE') || '').trim().toLowerCase() === 'live';
}

/** Earliest settled date (YYYYMMDD) that may be posted, from Script Property START_DATE. */
function startDateFloor_() {
  var v = String(Runtime.props().getProperty('START_DATE') || '').trim();
  return v ? toYmd(v) : '';
}

function runSync_(startYmd, endYmd, dryRun, title, opts) {
  opts = opts || {};
  var floor = startDateFloor_();
  if (!dryRun && !floor) {
    throw new Error('Set Script Property START_DATE (e.g. 20261114) before turning on SYNC_MODE = live.');
  }
  if (!dryRun && floor && startYmd < floor) startYmd = floor;
  if (startYmd > endYmd) {
    Logger.log(title + ': nothing to do - every date in range is before START_DATE ' + ymdToIso(floor) + '.');
    return null;
  }
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
  if (opts.quiet) return result; // caller reports
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

/* ------------------------------------------------------------------------ */
/* Catch-up: works from START_DATE forward, one week per hourly run, until it */
/* reaches the window the daily sync covers. Toast allows ~60 detail reports  */
/* a day, so it pauses itself when the limit is hit and continues next hour.  */
/* ------------------------------------------------------------------------ */

var CATCHUP_MAX_HELD = 60;

function startCatchUp() {
  var floor = startDateFloor_();
  if (!floor) throw new Error('Set Script Property START_DATE (e.g. 20260101) first.');
  if (!isLive_()) throw new Error('Catch-up only runs live (Script Property SYNC_MODE = live). Use previewYesterday to test first.');
  var props = Runtime.props();
  props.setProperty('CATCHUP_CURSOR', floor);
  props.setProperty('CATCHUP_HELD', '[]');
  props.setProperty('CATCHUP_COUNTS', JSON.stringify({ posted: 0, previews: 0, existing: 0, held: 0 }));
  removeCatchUpTriggers_();
  ScriptApp.newTrigger('catchUpStep').timeBased().everyHours(1).create();
  Logger.log('Catch-up started from ' + ymdToIso(floor) + (isLive_() ? ' (LIVE).' : ' (DRY RUN - nothing written).') +
    ' It runs every hour and emails you when it is finished.');
  catchUpStep();
}

function stopCatchUp() {
  removeCatchUpTriggers_();
  Runtime.props().deleteProperty('CATCHUP_CURSOR');
  Logger.log('Catch-up stopped.');
}

function catchUpStatus() {
  var props = Runtime.props();
  var cursor = props.getProperty('CATCHUP_CURSOR');
  Logger.log(cursor ? 'Catch-up is at ' + ymdToIso(cursor) + '. Totals so far: ' + props.getProperty('CATCHUP_COUNTS') +
    '\nHeld so far:\n' + JSON.parse(props.getProperty('CATCHUP_HELD') || '[]').join('\n') : 'No catch-up is running.');
}

function removeCatchUpTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'catchUpStep') ScriptApp.deleteTrigger(t);
  });
}

function catchUpStep() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // the daily sync is running; try next hour
  try {
    var props = Runtime.props();
    var cursor = props.getProperty('CATCHUP_CURSOR');
    if (!cursor) { removeCatchUpTriggers_(); return; }
    var stopAt = addDaysYmd(todayYmd(), -CONFIG.sync.lookbackDays); // the daily sync covers the rest
    if (cursor > stopAt) { finishCatchUp_(); return; }
    var end = addDaysYmd(cursor, 6) < stopAt ? addDaysYmd(cursor, 6) : stopAt;
    var result = runSync_(cursor, end, !isLive_(), 'Catch-up ' + ymdToIso(cursor) + '..' + ymdToIso(end), { quiet: true });
    if (!result) { props.setProperty('CATCHUP_CURSOR', addDaysYmd(end, 1)); return; }

    var counts = JSON.parse(props.getProperty('CATCHUP_COUNTS') || '{}');
    counts.posted = (counts.posted || 0) + result.posted.length;
    counts.previews = (counts.previews || 0) + result.previews.length;
    counts.existing = (counts.existing || 0) + result.existing.length;
    counts.held = (counts.held || 0) + result.held.length;
    counts.skipped = (counts.skipped || 0) + result.skipped.length;
    counts.toastPayoutsSeen = (counts.toastPayoutsSeen || 0) + result.posted.length + result.existing.length +
      result.held.length + result.skipped.length + result.errors.length + result.previews.length;
    props.setProperty('CATCHUP_COUNTS', JSON.stringify(counts));
    var held = JSON.parse(props.getProperty('CATCHUP_HELD') || '[]');
    result.held.forEach(function (h) {
      if (held.length < CATCHUP_MAX_HELD) held.push((h.label + ': ' + (h.reason || '')).slice(0, 220));
    });
    props.setProperty('CATCHUP_HELD', JSON.stringify(held));

    if (result.errors.length) {
      notify_('Catch-up needs attention', formatSyncResult(result) + '\n\nIt will retry this week on the next hourly run.', true);
      return;
    }
    // Move on only when the whole week was handled; otherwise redo it next hour
    // (already-posted payouts are detected and skipped).
    if (!result.unfinished) props.setProperty('CATCHUP_CURSOR', addDaysYmd(end, 1));
  } finally {
    lock.releaseLock();
  }
}

function finishCatchUp_() {
  var props = Runtime.props();
  removeCatchUpTriggers_();
  var counts = props.getProperty('CATCHUP_COUNTS');
  var held = JSON.parse(props.getProperty('CATCHUP_HELD') || '[]');
  props.deleteProperty('CATCHUP_CURSOR');
  notify_('Catch-up finished', 'Catch-up from ' + ymdToIso(startDateFloor_()) + ' is complete.\nTotals: ' + counts +
    (held.length ? '\n\nHELD payouts (not posted) - review these:\n' + held.join('\n') +
      (held.length >= CATCHUP_MAX_HELD ? '\n(list truncated)' : '') : '\n\nNothing was held.'), held.length > 0);
}

/* ------------------------------------------------------------------------ */
/* Cash sales (Toast Standard API)                                           */
/* ------------------------------------------------------------------------ */

function cashConfigured_() {
  return !!(CONFIG.cash && CONFIG.cash.enabled && Runtime.props().getProperty('TOAST_STD_CLIENT_ID'));
}

/** First business date whose cash may be posted, from Script Property CASH_START_DATE. */
function cashStartFloor_() {
  var v = String(Runtime.props().getProperty('CASH_START_DATE') || '').trim();
  return v ? toYmd(v) : '';
}

/** Dry run: yesterday's cash sales per location. Never writes to QuickBooks. */
function previewCash() {
  var d = addDaysYmd(todayYmd(), -1);
  runCash_(d, d, true, 'Cash preview');
}

function runCash_(startYmd, endYmd, dryRun, title) {
  var floor = cashStartFloor_();
  if (!dryRun && !floor) {
    Logger.log(title + ': skipped - set Script Property CASH_START_DATE to turn on cash posting.');
    return null;
  }
  if (!dryRun && startYmd < floor) startYmd = floor;
  if (startYmd > endYmd) return null;
  var qbo = null;
  try {
    qbo = new QboClient(CONFIG);
  } catch (e) {
    if (!dryRun) throw e;
  }
  var result;
  try {
    result = syncCash({
      config: CONFIG, toast: new StandardToastClient(CONFIG), qbo: qbo, startYmd: startYmd, endYmd: endYmd,
      dryRun: dryRun, locationNames: new ToastClient(CONFIG).getLocationNames(),
    });
  } catch (e) {
    notify_(title + ' FAILED', 'Cash sales could not be posted:\n\n' + (e.stack || e.message), true);
    throw e;
  }
  var text = formatSyncResult(result).replace('payout sync', 'cash sales').replace('for settled dates', 'for business dates');
  if (qbo) {
    try {
      var bal = qbo.accountBalance(CONFIG.cash.onHandAccount);
      text += '\n\n' + CONFIG.cash.onHandAccount + ' balance: ' + formatMoney(toCents(bal)) +
        ' (cash Toast recorded that has not been deposited yet; a negative number means more was deposited than Toast recorded).';
    } catch (e) { /* account may not exist yet */ }
  }
  Logger.log(text);
  var attention = syncNeedsAttention(result);
  if (attention || (CONFIG.sync.sendDailySummary && (result.posted.length || result.previews.length))) {
    notify_(title + (attention ? ': needs attention' : ''), text, attention);
  }
  return result;
}

// Toast -> QuickBooks payout sync. GENERATED from src/ by `npm run bundle`; edit src/ instead.
// Paste this whole file into the Apps Script editor as Code.gs (replacing its contents).

// ===== Config.js =====
/**
 * ============================================================================
 *  CONFIGURATION: edit this file for your business.
 * ============================================================================
 *
 * Secrets (API keys) do NOT go here. Put them in Project Settings ->
 * Script Properties:
 *   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET   (Toast Analytics API credential)
 *   QBO_CLIENT_ID,   QBO_CLIENT_SECRET     (Intuit developer app keys)
 *
 * Account / class / location names below must match QuickBooks exactly
 * (case-insensitive). Sub-accounts can be written "Parent:Child".
 * Run `checkSetup` after editing; it lists anything QuickBooks can't find.
 */
var CONFIG = {
  toast: {
    apiHost: 'https://ws-api.toasttab.com',
    // Restaurant GUIDs to include. Empty = every location the credential sees.
    // Run `checkSetup` to print the GUID and name of each location.
    restaurantIds: [
      'e46bdc5d-4dbd-4103-9bdf-c270aaad4610', // Stacks Burgers - Truck 2
      '257c9926-e0f6-478f-aa82-5db0a7f8931b', // Stacks Burgers - Tacoma
      '81257d52-4aaa-4c02-a028-3e4c2159524b', // Stacks Burgers Food Trailer
      '39c00539-3850-487e-a353-f2285b5104ac', // Stacks Truck 4 - Truck 4
      // Not included: Stacks Burgers Truck 3 (dc37ea3a-c84d-44ec-a787-895fa09f45f5)
      // Not included: Independent Kitchen LLC (test mode)
    ],
  },

  qbo: {
    environment: 'production', // 'production' or 'sandbox'
    minorVersion: 75,
  },

  sync: {
    // Start in dry-run. Nothing is written to QuickBooks until this is false.
    dryRun: true,

    // Each run re-checks this many past settled dates and posts anything that
    // is missing. Already-posted payouts are detected and skipped, so missed
    // runs heal themselves.
    lookbackDays: 7,

    // Toast payout statuses that are safe to post. NONE = failed payout.
    postStatuses: ['SENT', 'CAPTURED'],

    // 'deposit' (recommended: matches the bank feed line directly) or
    // 'journal'. Payouts that net to zero or below always use a journal entry.
    postingMode: 'deposit',

    // QuickBooks transaction date = Toast settled date + this many days.
    // Use 1 if your bank shows Toast deposits the day after Toast settles.
    txnDateOffsetDays: 0,

    // If Toast's per-payment detail doesn't add up to the payout's card total
    // within this many cents, the payout is HELD (not posted) and you get an
    // alert. It is retried automatically on the next run.
    reconcileToleranceCents: 100,

    // Hour of day (script time zone) for the automatic daily run.
    triggerHour: 9,

    // Where alerts and summaries go. Blank = the Google account running this.
    alertEmail: '',
    sendDailySummary: true,

    // Optional Drive folder ID for a JSON audit file per payout. Blank = off.
    auditFolderId: '',

    // Apps Script stops a run after 6 minutes; we stop starting new work at
    // this point and finish the rest on the next run.
    timeBudgetMs: 4.5 * 60 * 1000,
  },

  /**
   * Default QuickBooks accounts. Every location uses these unless it has an
   * override in `locations` below.
   */
  accounts: {
    deposit: 'Business Basic Checking (8410) - 4', // bank account Toast pays into (TO CONFIRM)
    sales: 'Sales',                        // income: food & beverage sales
    salesTax: 'Sales Tax Payable - Toast', // liability (TO CONFIRM: name of your sales tax liability account)
    tips: 'Tips Payable',                  // liability (TO CONFIRM: card tips owed to staff)
    gratuity: 'Tips Payable',              // liability: auto-gratuity / service charges paid to staff
    refunds: 'Refunds & Discounts',        // contra-income
    fees: 'Bank Charges & Fees',           // expense: card processing fees
    unallocatedWithholding: 'Bookkeeping Suspense - Unresolved Balances', // anything the rules below don't explain
    reconciliationDifference: 'Bookkeeping Suspense - Unresolved Balances', // penny rounding from Toast
  },

  /**
   * Optional per-location settings, keyed by restaurant GUID or by the exact
   * Toast restaurant name. All fields are optional.
   *
   *   'Stacks Burgers - Tacoma': {
   *     department: 'Tacoma',        // QuickBooks Location
   *     class: 'Restaurant',         // QuickBooks Class
   *     defaultTaxRate: 0.103,       // used only if Toast has no tax detail for a check
   *     accounts: { sales: 'Sales:Tacoma', deposit: 'Tacoma Checking' },
   *   },
   */
  locations: {},

  /**
   * Toast reports every withholding (Toast Capital, equipment lease / Easy
   * Pay, Instant Deposit, etc.) as ONE combined amount per payout. These rules
   * split it into the right accounts. They run in order:
   *   method 'fixed'     -> a set dollar amount per payout (equipment leases)
   *   method 'percent'   -> percent of `percentOf` ('payment' = card sales,
   *                         'withholding' = total withheld)
   *   method 'remainder' -> whatever is left (use this for Toast Capital)
   * Any amount still left goes to accounts.unallocatedWithholding and you get
   * an alert.
   * `locations`: ['*'] for all, or a list of GUIDs / restaurant names.
   * `startDate` / `endDate` (YYYYMMDD, optional) limit when a rule applies.
   */
  withholdingRules: [
    // Example: daily equipment lease payment on the Tacoma location.
    // { name: 'Equipment lease (Easy Pay)', account: 'Toast Equipment Lease', method: 'fixed', amount: 25.00,
    //   locations: ['Stacks Burgers - Tacoma'], startDate: '20250101', endDate: '20270101' },
    // PROVISIONAL until confirmed against a Toast Payout Details report:
    // about half of each day's card sales is swept to Toast checking, the rest is Toast Capital.
    { name: 'Sweep to Toast checking', account: 'Toast Checking (3569)', method: 'percent', percent: 50, percentOf: 'payment', locations: ['*'] },
    { name: 'Toast Capital loan repayment', account: 'Toast Capital loan', method: 'remainder', locations: ['*'] },
  ],

  /**
   * Money taken out of the payout AFTER withholdings, before it reaches your
   * outside bank: for example, a portion swept into a Toast checking account.
   * Each split becomes a transfer line to that QuickBooks account, and the
   * deposit to `accounts.deposit` is reduced by the same amount.
   *   method 'fixed'   -> `amount` dollars per payout
   *   method 'percent' -> `percent` percent of the payout
   */
  payoutSplits: [
    // { name: 'Toast checking', account: 'Toast Checking', method: 'percent', percent: 10, locations: ['*'] },
  ],
};

// ===== Main.js =====
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

/** Dry run for yesterday's settled payouts. Never writes to QuickBooks. */
function previewYesterday() {
  var d = addDaysYmd(todayYmd(), -1);
  runSync_(d, d, true, 'Preview');
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

// ===== Util.js =====
/**
 * Small helpers shared by every file. All money is handled as integer cents
 * to avoid floating point drift; convert back to dollars only when talking to
 * QuickBooks.
 */

/** Dollars (number or numeric string) -> integer cents. */
function toCents(dollars) {
  if (dollars === null || dollars === undefined || dollars === '') return 0;
  var n = Number(dollars);
  if (!isFinite(n)) throw new Error('Not a number: ' + dollars);
  return Math.round(n * 100);
}

/** Integer cents -> dollars number with exactly two decimals of precision. */
function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

/** Format cents as "$1,234.56" for emails and logs. */
function formatMoney(cents) {
  var neg = cents < 0;
  var abs = Math.abs(cents);
  var dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var rem = ('0' + (abs % 100)).slice(-2);
  return (neg ? '-$' : '$') + dollars + '.' + rem;
}

/** Normalise "20261110", 20261110, "2026-11-10" or "2026-11-10 08:00:00" to "20261110". */
function toYmd(value) {
  if (value === null || value === undefined || value === '') return '';
  var s = String(value).trim();
  var m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) throw new Error('Unrecognised date: ' + value);
  return m[1] + m[2] + m[3];
}

/** "20261110" -> "2026-11-10" (QuickBooks TxnDate format). */
function ymdToIso(ymd) {
  var s = toYmd(ymd);
  return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
}

/** Add whole days to a YYYYMMDD string (calendar math in UTC, no DST issues). */
function addDaysYmd(ymd, days) {
  var s = toYmd(ymd);
  var d = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + ('0' + (d.getUTCMonth() + 1)).slice(-2) + ('0' + d.getUTCDate()).slice(-2);
}

/** Inclusive list of YYYYMMDD dates from start to end. */
function dateRangeYmd(start, end) {
  var out = [];
  var cur = toYmd(start);
  var last = toYmd(end);
  if (cur > last) return out;
  while (cur <= last) {
    out.push(cur);
    cur = addDaysYmd(cur, 1);
  }
  return out;
}

/** Split an inclusive date range into chunks of at most `size` days. */
function chunkDateRange(start, end, size) {
  var days = dateRangeYmd(start, end);
  var chunks = [];
  for (var i = 0; i < days.length; i += size) {
    var part = days.slice(i, i + size);
    chunks.push({ start: part[0], end: part[part.length - 1], days: part.length });
  }
  return chunks;
}

/** Case/whitespace-insensitive comparison key for names. */
function normName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Stable idempotency key written into every QuickBooks transaction we create. */
function payoutKey(restaurantGuid, settledDate) {
  return 'toast-payout:' + restaurantGuid + ':' + toYmd(settledDate);
}

// ===== Runtime.js =====
/**
 * Thin wrapper around Apps Script services so the rest of the code can be
 * unit-tested in Node by swapping these out (see test/harness.js).
 */
var Runtime = {
  fetch: function (url, options) {
    var opts = Object.assign({ muteHttpExceptions: true }, options || {});
    var res = UrlFetchApp.fetch(url, opts);
    return {
      code: res.getResponseCode(),
      text: res.getContentText(),
      headers: res.getAllHeaders ? res.getAllHeaders() : res.getHeaders(),
    };
  },
  sleep: function (ms) { Utilities.sleep(ms); },
  now: function () { return Date.now(); },
  props: function () { return PropertiesService.getScriptProperties(); },
  cache: function () { return CacheService.getScriptCache(); },
  log: function (msg) { Logger.log(msg); },
  timeZone: function () { return Session.getScriptTimeZone(); },
  formatDate: function (date, tz, fmt) { return Utilities.formatDate(date, tz, fmt); },
};

function requireProp(name) {
  var v = String(Runtime.props().getProperty(name) || '').trim();
  if (!v) throw new Error('Missing Script Property "' + name + '". Add it in Project Settings -> Script Properties.');
  return v;
}

/** Today's date (YYYYMMDD) in the script's time zone. */
function todayYmd() {
  return Runtime.formatDate(new Date(Runtime.now()), Runtime.timeZone(), 'yyyyMMdd');
}

// ===== PayoutBuilder.js =====
/**
 * Pure accounting logic: turns one Toast payout (one location, one settled
 * date) plus its per-payment and per-check detail into a balanced set of
 * accounting lines. No network calls here, so this is fully unit-tested.
 *
 * Toast's numbers for a payout:
 *   payoutAmount = paymentAmount - refundAmount - totalFeeAmount - withholdingAmount
 *
 * What we book (credits = money in, debits = where it went):
 *   CREDIT  Sales           card payments minus tax, tips and gratuity
 *   CREDIT  Sales tax       tax portion of those card payments (from check detail)
 *   CREDIT  Tips payable    card tips
 *   CREDIT  Gratuity        auto-gratuity
 *   DEBIT   Refunds         card refunds settled in this payout
 *   DEBIT   Card fees       processing fees
 *   DEBIT   Withholdings    split by CONFIG.withholdingRules (Capital, lease, ...)
 *   DEBIT   Payout splits   e.g. Toast checking sweep
 *   DEBIT   Bank            what actually lands in the outside bank account
 */

/** Merge default accounts with any per-location overrides. */
function locationSettings(config, restaurantGuid, restaurantName) {
  var locs = config.locations || {};
  var loc = locs[restaurantGuid];
  if (!loc) {
    var want = normName(restaurantName);
    Object.keys(locs).forEach(function (k) {
      if (!loc && normName(k) === want) loc = locs[k];
    });
  }
  loc = loc || {};
  var accounts = {};
  Object.keys(config.accounts).forEach(function (k) { accounts[k] = config.accounts[k]; });
  Object.keys(loc.accounts || {}).forEach(function (k) { accounts[k] = loc.accounts[k]; });
  return {
    name: String(restaurantName || '').trim(),
    department: loc.department || '',
    klass: loc.class || '',
    defaultTaxRate: typeof loc.defaultTaxRate === 'number' ? loc.defaultTaxRate : null,
    accounts: accounts,
  };
}

/** Does a withholding rule / payout split apply to this location and date? */
function ruleApplies(rule, restaurantGuid, restaurantName, settledDate) {
  var locs = rule.locations && rule.locations.length ? rule.locations : ['*'];
  var match = locs.some(function (l) {
    return l === '*' || l === restaurantGuid || normName(l) === normName(restaurantName);
  });
  if (!match) return false;
  var d = toYmd(settledDate);
  if (rule.startDate && d < toYmd(rule.startDate)) return false;
  if (rule.endDate && d > toYmd(rule.endDate)) return false;
  return true;
}

/**
 * Sum tips, gratuity and sales tax across the card payments in one payout.
 * Tax per payment = payment subtotal x (check tax / check pre-tip total),
 * where check pre-tip total = checkTotalAmount - checkTipAmount - checkGratuityAmount
 * (Toast's check total includes tax and tip). Falls back to the location's
 * defaultTaxRate (tax-inclusive) when the check isn't available.
 */
function computeCardComponents(payments, checksByGuid, defaultTaxRate) {
  var out = {
    count: 0, totalCents: 0, subtotalCents: 0, tipCents: 0, gratuityCents: 0, taxCents: 0,
    taxFromChecks: 0, taxFromRate: 0, taxMissing: 0,
  };
  (payments || []).forEach(function (p) {
    var total = toCents(p.paymentTotal);
    var sub = toCents(p.paymentSubtotal);
    var tip = toCents(p.tipAmount);
    var grat = toCents(p.gratuityAmount);
    out.count++;
    out.totalCents += total;
    out.subtotalCents += sub;
    out.tipCents += tip;
    out.gratuityCents += grat;

    var check = checksByGuid ? checksByGuid[p.checkGuid] : null;
    var tax = null;
    if (check) {
      var cTax = toCents(check.checkTaxAmount);
      var cPreTip = toCents(check.checkTotalAmount) - toCents(check.checkTipAmount) - toCents(check.checkGratuityAmount);
      if (cPreTip > 0) {
        tax = Math.round(sub * cTax / cPreTip);
        out.taxFromChecks++;
      } else if (cTax === 0) {
        tax = 0;
        out.taxFromChecks++;
      }
    }
    if (tax === null) {
      if (defaultTaxRate !== null && defaultTaxRate !== undefined) {
        tax = Math.round(sub * defaultTaxRate / (1 + defaultTaxRate));
        out.taxFromRate++;
      } else {
        tax = 0;
        out.taxMissing++;
      }
    }
    if (tax > sub) tax = sub;
    if (tax < 0 && sub >= 0) tax = 0;
    out.taxCents += tax;
  });
  return out;
}

/** Split Toast's single withholding total across the configured rules. */
function allocateWithholding(withholdingCents, ctx, rules) {
  var lines = [];
  var remaining = withholdingCents;
  var applicable = (rules || []).filter(function (r) {
    return ruleApplies(r, ctx.restaurantGuid, ctx.restaurantName, ctx.settledDate);
  });

  if (withholdingCents > 0) {
    applicable.forEach(function (r) {
      if (r.method === 'remainder' || remaining <= 0) return;
      var want;
      if (r.method === 'fixed') {
        want = toCents(r.amount);
      } else if (r.method === 'percent') {
        var base = r.percentOf === 'withholding' ? withholdingCents : ctx.paymentCents;
        want = Math.round(base * Number(r.percent) / 100);
      } else {
        throw new Error('Unknown withholding rule method "' + r.method + '" on rule "' + r.name + '"');
      }
      var take = Math.min(Math.max(want, 0), remaining);
      if (take > 0) {
        lines.push({ name: r.name, account: r.account, cents: take });
        remaining -= take;
      }
    });
  }

  // The remainder rule also absorbs negative withholdings (Toast reversals).
  var remainderRule = applicable.filter(function (r) { return r.method === 'remainder'; })[0];
  if (remaining !== 0 && remainderRule) {
    lines.push({ name: remainderRule.name, account: remainderRule.account, cents: remaining });
    remaining = 0;
  }
  return { lines: lines, unallocatedCents: remaining };
}

/** Amounts swept out of the payout before it reaches the outside bank. */
function computePayoutSplits(payoutCents, ctx, splits) {
  var lines = [];
  var remaining = Math.max(payoutCents, 0);
  (splits || []).forEach(function (s) {
    if (!ruleApplies(s, ctx.restaurantGuid, ctx.restaurantName, ctx.settledDate)) return;
    var want;
    if (s.method === 'fixed') want = toCents(s.amount);
    else if (s.method === 'percent') want = Math.round(payoutCents * Number(s.percent) / 100);
    else throw new Error('Unknown payout split method "' + s.method + '" on split "' + s.name + '"');
    var take = Math.min(Math.max(want, 0), remaining);
    if (take > 0) {
      lines.push({ name: s.name, account: s.account, cents: take });
      remaining -= take;
    }
  });
  return lines;
}

/**
 * Build the full breakdown for one payout row.
 * @param {Object} args
 *   row           one element of the /era/v1/payout (settled date) report
 *   payments      /era/v1/payout/payments rows for THIS restaurant + settled date
 *   checksByGuid  checkGuid -> /era/v1/check row
 *   config        CONFIG
 */
function buildPayoutBreakdown(args) {
  var row = args.row;
  var config = args.config;
  var settledDate = toYmd(row.settledDate);
  var guid = row.restaurantGuid;
  var name = String(row.restaurantName || '').trim();
  var loc = locationSettings(config, guid, name);
  var acct = loc.accounts;
  var tolerance = config.sync.reconcileToleranceCents;

  var c = {
    payment: toCents(row.paymentAmount),
    refund: toCents(row.refundAmount),
    fee: toCents(row.totalFeeAmount),
    withholding: toCents(row.withholdingAmount),
    payout: toCents(row.payoutAmount),
  };

  var warnings = [];
  var holdReasons = [];
  var card = computeCardComponents(args.payments, args.checksByGuid, loc.defaultTaxRate);

  // Do the per-payment details add up to the card total Toast settled?
  var cardDiff = c.payment - card.totalCents;
  if (Math.abs(cardDiff) > tolerance) {
    holdReasons.push('Per-payment detail (' + card.count + ' payments, ' + formatMoney(card.totalCents) +
      ') does not match Toast payout card total ' + formatMoney(c.payment) + '.');
  } else if (cardDiff !== 0) {
    warnings.push('Card detail differs from payout total by ' + formatMoney(cardDiff) + '; booked to sales.');
  }
  if (card.taxMissing > 0) {
    warnings.push(card.taxMissing + ' payment(s) had no check tax detail and no defaultTaxRate; tax booked as $0 for them.');
  }
  if (card.taxFromRate > 0) {
    warnings.push(card.taxFromRate + ' payment(s) used the location defaultTaxRate because check detail was unavailable.');
  }

  var taxCents = card.taxCents;
  var tipCents = card.tipCents;
  var gratCents = card.gratuityCents;
  var salesCents = c.payment - taxCents - tipCents - gratCents;
  if (salesCents < 0 && c.payment >= 0) {
    holdReasons.push('Computed sales are negative (' + formatMoney(salesCents) + '); detail looks inconsistent.');
  }

  var ctx = { restaurantGuid: guid, restaurantName: name, settledDate: settledDate, paymentCents: c.payment };
  var wh = allocateWithholding(c.withholding, ctx, config.withholdingRules);
  if (wh.unallocatedCents !== 0) {
    warnings.push(formatMoney(wh.unallocatedCents) + ' of withholdings not covered by withholdingRules; booked to "' +
      acct.unallocatedWithholding + '".');
  }

  var splits = computePayoutSplits(c.payout, ctx, config.payoutSplits);
  var splitTotal = splits.reduce(function (s, l) { return s + l.cents; }, 0);
  var bankCents = c.payout - splitTotal;

  // Toast's payoutAmount should equal the formula; book any penny difference.
  var formulaPayout = c.payment - c.refund - c.fee - c.withholding;
  var payoutDiff = c.payout - formulaPayout;
  if (Math.abs(payoutDiff) > tolerance) {
    holdReasons.push('Toast payoutAmount ' + formatMoney(c.payout) + ' differs from payments - refunds - fees - withholdings (' +
      formatMoney(formulaPayout) + ').');
  }

  var lines = [];
  function add(role, label, account, cents, side) {
    if (cents !== 0) lines.push({ role: role, label: label, account: account, cents: cents, side: side });
  }
  add('sales', 'Card sales', acct.sales, salesCents, 'credit');
  add('salesTax', 'Sales tax on card sales', acct.salesTax, taxCents, 'credit');
  add('tips', 'Card tips', acct.tips, tipCents, 'credit');
  add('gratuity', 'Auto-gratuity', acct.gratuity, gratCents, 'credit');
  add('refunds', 'Card refunds', acct.refunds, c.refund, 'debit');
  add('fees', 'Card processing fees', acct.fees, c.fee, 'debit');
  wh.lines.forEach(function (l) { add('withholding', l.name, l.account, l.cents, 'debit'); });
  add('withholding', 'Unallocated Toast withholding', acct.unallocatedWithholding, wh.unallocatedCents, 'debit');
  splits.forEach(function (l) { add('split', l.name, l.account, l.cents, 'debit'); });
  add('reconciliation', 'Toast payout rounding', acct.reconciliationDifference, -payoutDiff, 'debit');

  // Balance check: credits must equal debits + bank.
  var credits = 0, debits = 0;
  lines.forEach(function (l) { if (l.side === 'credit') credits += l.cents; else debits += l.cents; });
  if (credits !== debits + bankCents) {
    holdReasons.push('Internal balance check failed (credits ' + formatMoney(credits) + ' vs debits+bank ' +
      formatMoney(debits + bankCents) + ').');
  }

  return {
    key: payoutKey(guid, settledDate),
    restaurantGuid: guid,
    restaurantName: name,
    settledDate: settledDate,
    payoutStatus: row.payoutStatus || '',
    salesPeriodStart: row.salesPeriodStartDateTime || '',
    salesPeriodEnd: row.salesPeriodEndDateTime || '',
    transactionCount: row.transactionCount,
    location: loc,
    toast: c,
    card: card,
    bankCents: bankCents,
    bankAccount: acct.deposit,
    lines: lines,
    warnings: warnings,
    holdReasons: holdReasons,
    ok: holdReasons.length === 0,
  };
}

/** One-line human summary for logs and emails. */
function describeBreakdown(b) {
  var parts = b.lines.map(function (l) {
    return (l.side === 'credit' ? '+' : '-') + l.label + ' ' + formatMoney(l.cents);
  });
  return b.restaurantName + ' ' + ymdToIso(b.settledDate) + ': bank ' + formatMoney(b.bankCents) +
    ' = ' + parts.join(', ');
}

// ===== ToastClient.js =====
/**
 * Toast Analytics API client (https://doc.toasttab.com/doc/devguide/apiAnalyticsOverview.html).
 *
 * Every analytics report is two steps:
 *   1. POST /era/v1/<report>/<timeRange>  -> returns a reportRequestGuid
 *   2. GET  /era/v1/<report>/<guid>       -> 202 while Toast is still building
 *                                            the report, 200 with the data when ready
 * Treating that 202 as "no data" makes every day look empty, so we poll until 200.
 */

// /era/v1/payout/payments and /era/v1/check allow 5 POSTs per minute.
var TOAST_SLOW_POST_GAP_MS = 13000;
// Waits between polls while a report is being built (ms). ~3 minutes total.
var TOAST_POLL_DELAYS_MS = [2000, 3000, 5000, 8000, 10000, 15000, 20000, 25000, 30000, 30000, 30000];

function ToastClient(config) {
  this.config = config;
  this.host = String(config.toast.apiHost).replace(/\/+$/, '');
  this.restaurantIds = config.toast.restaurantIds || [];
  this.lastSlowPostAt = 0;
  this.paymentsByDate = {}; // salesDate -> rows (all restaurants)
  this.checksByDate = {};   // businessDate -> { checkGuid: row }
}

ToastClient.prototype.getToken = function (forceRefresh) {
  var cache = Runtime.cache();
  if (!forceRefresh) {
    var cached = cache.get('toast_access_token');
    if (cached) return cached;
  }
  var res = Runtime.fetch(this.host + '/authentication/v1/authentication/login', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      clientId: requireProp('TOAST_CLIENT_ID'),
      clientSecret: requireProp('TOAST_CLIENT_SECRET'),
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  });
  if (res.code !== 200) {
    throw new Error('Toast login failed (HTTP ' + res.code + '): ' + String(res.text).slice(0, 500));
  }
  var body = JSON.parse(res.text);
  var token = body.token && body.token.accessToken;
  if (!token) throw new Error('Toast login returned no access token: ' + String(res.text).slice(0, 300));
  var ttl = Math.min(Math.max((body.token.expiresIn || 3600) - 300, 60), 21600);
  cache.put('toast_access_token', token, ttl);
  return token;
};

/** Low-level request with token refresh on 401 and backoff on 429. */
ToastClient.prototype.request = function (method, path, body) {
  var refreshed = false;
  for (var attempt = 0; attempt < 6; attempt++) {
    var opts = {
      method: method,
      headers: { Authorization: 'Bearer ' + this.getToken(false) },
    };
    if (body !== undefined) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(body);
    }
    var res = Runtime.fetch(this.host + path, opts);
    if (res.code === 401 && !refreshed) {
      refreshed = true;
      this.getToken(true);
      continue;
    }
    if (res.code === 429) {
      var retryAfter = Number(res.headers && (res.headers['Retry-After'] || res.headers['retry-after']));
      Runtime.sleep((isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 15 * (attempt + 1)) * 1000);
      continue;
    }
    return res;
  }
  throw new Error('Toast API kept rate-limiting ' + method.toUpperCase() + ' ' + path);
};

ToastClient.prototype.reportBody_ = function (extra) {
  var body = { restaurantIds: this.restaurantIds, excludedRestaurantIds: [] };
  Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
  return body;
};

/**
 * Create a report and wait for it. `slow` = endpoint limited to 5 POSTs/min.
 * Returns the parsed array of rows.
 */
ToastClient.prototype.runReport = function (postPath, getBase, body, slow) {
  for (var round = 0; round < 2; round++) {
    if (slow) {
      var wait = this.lastSlowPostAt + TOAST_SLOW_POST_GAP_MS - Runtime.now();
      if (wait > 0) Runtime.sleep(wait);
      this.lastSlowPostAt = Runtime.now();
    }
    var post = this.request('post', postPath, body);
    if (post.code !== 200) {
      throw new Error('Toast POST ' + postPath + ' failed (HTTP ' + post.code + '): ' + String(post.text).slice(0, 500));
    }
    var guid = parseReportGuid(post.text);

    for (var i = 0; i <= TOAST_POLL_DELAYS_MS.length; i++) {
      var get = this.request('get', getBase + '/' + guid);
      if (get.code === 200) return parseReportRows(get.text);
      if (get.code === 202) {
        if (i === TOAST_POLL_DELAYS_MS.length) break;
        Runtime.sleep(TOAST_POLL_DELAYS_MS[i]);
        continue;
      }
      if (get.code === 409) break; // Toast asks for a new request
      throw new Error('Toast GET ' + getBase + '/' + guid + ' failed (HTTP ' + get.code + '): ' + String(get.text).slice(0, 500));
    }
  }
  throw new Error('Toast report ' + postPath + ' was still not ready after waiting; will retry next run.');
};

function parseReportGuid(text) {
  var t = String(text).trim();
  try {
    var v = JSON.parse(t);
    if (typeof v === 'string') return v;
    if (v && v.reportRequestGuid) return v.reportRequestGuid;
  } catch (e) { /* fall through */ }
  t = t.replace(/^"|"$/g, '');
  if (!/^[0-9a-f-]{36}$/i.test(t)) throw new Error('Unexpected report request response: ' + t.slice(0, 200));
  return t;
}

function parseReportRows(text) {
  if (!text || !String(text).trim()) return [];
  var v = JSON.parse(text);
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.data)) return v.data;
  throw new Error('Unexpected report body: ' + String(text).slice(0, 200));
}

/**
 * Full location names keyed by restaurant GUID. The payout reports often give
 * only the brand ("Stacks Burgers") in restaurantName, which can't tell
 * locations apart, so we use the names from restaurants-information.
 */
ToastClient.prototype.getLocationNames = function () {
  if (!this.locationNames) {
    var names = {};
    try {
      this.getRestaurants().forEach(function (r) {
        names[r.restaurantGuid] = String(r.restaurantName || '').trim().replace(/\s+/g, ' ');
      });
    } catch (e) {
      Runtime.log('Could not load Toast location names: ' + e.message);
    }
    this.locationNames = names;
  }
  return this.locationNames;
};

/** Best human name for a report row: full location name, else brand + location. */
ToastClient.prototype.locationName = function (row) {
  var full = this.getLocationNames()[row.restaurantGuid];
  if (full) return full;
  var brand = String(row.restaurantName || '').trim();
  var loc = String(row.restaurantLocationName || '').trim();
  return (loc && brand.indexOf(loc) < 0 ? brand + ' - ' + loc : brand).replace(/\s+/g, ' ');
};

/** Settled-date payout rows for an inclusive date range (any length). */
ToastClient.prototype.getSettledPayouts = function (startYmd, endYmd) {
  var self = this;
  var rows = [];
  chunkDateRange(startYmd, endYmd, 7).forEach(function (ch) {
    var range = ch.days === 1 ? 'day' : 'week';
    var part = self.runReport('/era/v1/payout/' + range, '/era/v1/payout',
      self.reportBody_({ startDate: ch.start, endDate: ch.end }), false);
    rows = rows.concat(part);
  });
  rows.forEach(function (r) {
    r.toastBrandName = r.restaurantName;
    r.restaurantName = self.locationName(r);
  });
  return rows;
};

/** Per-payment payout detail for one sales date (all restaurants). Cached per run. */
ToastClient.prototype.getPaymentsForSalesDate = function (ymd) {
  ymd = toYmd(ymd);
  if (!this.paymentsByDate[ymd]) {
    this.paymentsByDate[ymd] = this.runReport('/era/v1/payout/payments/day', '/era/v1/payout/payments',
      this.reportBody_({ startDate: ymd, endDate: ymd }), true);
  }
  return this.paymentsByDate[ymd];
};

/** Check detail (tax/tip/total) for one business date, keyed by checkGuid. Cached per run. */
ToastClient.prototype.getChecksForBusinessDate = function (ymd) {
  ymd = toYmd(ymd);
  if (!this.checksByDate[ymd]) {
    var rows = this.runReport('/era/v1/check/day', '/era/v1/check',
      this.reportBody_({ startBusinessDate: ymd, endBusinessDate: ymd }), true);
    var map = {};
    rows.forEach(function (r) { map[r.checkGuid] = r; });
    this.checksByDate[ymd] = map;
  }
  return this.checksByDate[ymd];
};

ToastClient.prototype.getRestaurants = function () {
  var res = this.request('get', '/era/v1/restaurants-information');
  if (res.code !== 200) throw new Error('Toast restaurants-information failed (HTTP ' + res.code + '): ' + String(res.text).slice(0, 300));
  return JSON.parse(res.text);
};

/**
 * Gather the payments that make up one settled payout, plus their checks.
 * Starts with the sales dates Toast says the payout covers, and widens one day
 * at a time (up to 3 extra) until the payments add up to the payout's card total.
 */
ToastClient.prototype.getPayoutDetail = function (row, toleranceCents) {
  var self = this;
  var settled = toYmd(row.settledDate);
  var start = row.salesPeriodStartDateTime ? toYmd(row.salesPeriodStartDateTime) : addDaysYmd(settled, -1);
  var end = row.salesPeriodEndDateTime ? toYmd(row.salesPeriodEndDateTime) : addDaysYmd(settled, -1);
  if (end > settled) end = settled;
  if (start > end) start = end;
  var target = toCents(row.paymentAmount);

  function collect(from) {
    var out = [];
    dateRangeYmd(from, end).forEach(function (d) {
      self.getPaymentsForSalesDate(d).forEach(function (p) {
        if (p.restaurantGuid === row.restaurantGuid && String(p.settledDate) === settled) out.push(p);
      });
    });
    var seen = {};
    return out.filter(function (p) {
      if (seen[p.paymentGuid]) return false;
      seen[p.paymentGuid] = true;
      return true;
    });
  }
  function sum(ps) { return ps.reduce(function (s, p) { return s + toCents(p.paymentTotal); }, 0); }

  var payments = target === 0 ? [] : collect(start);
  var extra = 0;
  while (target !== 0 && Math.abs(target - sum(payments)) > toleranceCents && extra < 3) {
    extra++;
    start = addDaysYmd(start, -1);
    payments = collect(start);
  }

  // Look up the check behind each payment for the exact tax split.
  var checks = {};
  var needed = {};
  payments.forEach(function (p) {
    needed[p.checkGuid] = toYmd(p.orderOpenDateTime || p.paidDateTime || end);
  });
  Object.keys(needed).forEach(function (checkGuid) {
    var d = needed[checkGuid];
    var found = self.getChecksForBusinessDate(d)[checkGuid];
    if (!found) found = self.getChecksForBusinessDate(addDaysYmd(d, -1))[checkGuid];
    if (found) checks[checkGuid] = found;
  });
  return { payments: payments, checksByGuid: checks };
};

// ===== QboClient.js =====
/**
 * QuickBooks Online Accounting API client.
 * OAuth uses Google's OAuth2 library for Apps Script (library symbol `OAuth2`),
 * which stores Intuit's rotating refresh token in Script Properties and
 * refreshes the access token automatically.
 */

function getQboService() {
  var id = requireProp('QBO_CLIENT_ID');
  var secret = requireProp('QBO_CLIENT_SECRET');
  return OAuth2.createService('quickbooks')
    .setAuthorizationBaseUrl('https://appcenter.intuit.com/connect/oauth2')
    .setTokenUrl('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer')
    .setClientId(id)
    .setClientSecret(secret)
    .setCallbackFunction('qboAuthCallback')
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setCache(CacheService.getScriptCache())
    .setLock(LockService.getScriptLock())
    .setScope('com.intuit.quickbooks.accounting');
}

/** Run this if connecting fails: checks the stored keys for common copy-paste problems (never prints them). */
function diagnoseQuickBooksKeys() {
  var props = PropertiesService.getScriptProperties();
  ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'].forEach(function (name) {
    var raw = props.getProperty(name);
    if (!raw) { Logger.log(name + ': MISSING'); return; }
    var trimmed = raw.trim();
    Logger.log(name + ': ' + trimmed.length + ' characters' +
      (raw !== trimmed ? ' (had extra spaces - they are ignored now)' : '') +
      (/\s/.test(trimmed) ? ' WARNING: contains a space or line break in the middle' : ''));
  });
  Logger.log('Redirect URI (must be listed in your Intuit app under Production): ' + OAuth2.getRedirectUri());
}

/** OAuth redirect target. Intuit sends the company (realm) id along with the code. */
function qboAuthCallback(request) {
  var ok = getQboService().handleCallback(request);
  if (ok && request.parameter.realmId) {
    PropertiesService.getScriptProperties().setProperty('QBO_REALM_ID', request.parameter.realmId);
    return HtmlService.createHtmlOutput('QuickBooks connected. You can close this tab and go back to the script.');
  }
  return HtmlService.createHtmlOutput('QuickBooks connection failed or was cancelled. Run authorizeQuickBooks again.');
}

/**
 * @param {Object} config  CONFIG
 * @param {Object=} auth   { getAccessToken(), refresh(), realmId } - injectable for tests
 */
function QboClient(config, auth) {
  if (!auth) {
    var service = getQboService();
    if (!service.hasAccess()) {
      throw new Error('QuickBooks is not connected. Run authorizeQuickBooks and open the link it logs.');
    }
    auth = {
      getAccessToken: function () { return service.getAccessToken(); },
      refresh: function () { service.refresh(); },
      realmId: requireProp('QBO_REALM_ID'),
    };
  }
  this.auth = auth;
  this.minorVersion = config.qbo.minorVersion || 75;
  var host = config.qbo.environment === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  this.base = host + '/v3/company/' + auth.realmId;
  this.accounts = null;
  this.departments = null;
  this.classes = null;
}

QboClient.prototype.request = function (method, path, body) {
  var url = this.base + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'minorversion=' + this.minorVersion;
  var refreshed = false;
  for (var attempt = 0; attempt < 5; attempt++) {
    var opts = {
      method: method,
      headers: { Authorization: 'Bearer ' + this.auth.getAccessToken(), Accept: 'application/json' },
    };
    if (body !== undefined) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(body);
    }
    var res = Runtime.fetch(url, opts);
    if (res.code === 401 && !refreshed) {
      refreshed = true;
      this.auth.refresh();
      continue;
    }
    if (res.code === 429 || res.code === 503) {
      Runtime.sleep(5000 * (attempt + 1));
      continue;
    }
    var json = null;
    try { json = res.text ? JSON.parse(res.text) : null; } catch (e) { /* non-JSON error */ }
    if (res.code >= 200 && res.code < 300 && !(json && json.Fault)) return json;
    // intuit_tid identifies the request for Intuit support; include it in every error.
    var tid = intuitTid(res.headers);
    throw new Error('QuickBooks ' + method.toUpperCase() + ' ' + path.split('?')[0] + ' failed (HTTP ' + res.code + '): ' +
      describeQboFault(json, res.text) + (tid ? ' [intuit_tid ' + tid + ']' : ''));
  }
  throw new Error('QuickBooks kept throttling ' + path);
};

function intuitTid(headers) {
  if (!headers) return '';
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === 'intuit_tid') return String(headers[keys[i]]);
  }
  return '';
}

function describeQboFault(json, text) {
  var errs = json && json.Fault && json.Fault.Error;
  if (errs && errs.length) {
    return errs.map(function (e) { return e.Message + (e.Detail ? ' - ' + e.Detail : ''); }).join('; ');
  }
  return String(text || '').slice(0, 500);
}

/** Run a QBO SQL-like query, following pagination. Returns rows of `entity`. */
QboClient.prototype.queryAll = function (sql, entity) {
  var out = [];
  var start = 1;
  var page = 1000;
  for (;;) {
    var q = sql + ' STARTPOSITION ' + start + ' MAXRESULTS ' + page;
    var res = this.request('get', '/query?query=' + encodeURIComponent(q));
    var rows = (res.QueryResponse && res.QueryResponse[entity]) || [];
    out = out.concat(rows);
    if (rows.length < page) return out;
    start += page;
  }
};

function buildLookup(rows, label) {
  var byFull = {}, byName = {};
  rows.forEach(function (r) {
    var ref = { value: r.Id, name: r.FullyQualifiedName || r.Name };
    byFull[normName(r.FullyQualifiedName || r.Name)] = ref;
    var n = normName(r.Name);
    byName[n] = byName[n] ? 'AMBIGUOUS' : ref;
  });
  return function (name) {
    var key = normName(name);
    if (!key) return null;
    if (byFull[key]) return byFull[key];
    if (byName[key] === 'AMBIGUOUS') {
      throw new Error(label + ' "' + name + '" matches more than one QuickBooks ' + label.toLowerCase() +
        '; use the full "Parent:Child" name.');
    }
    if (byName[key]) return byName[key];
    throw new Error(label + ' "' + name + '" was not found in QuickBooks.');
  };
}

QboClient.prototype.resolveAccount = function (name) {
  if (!this.accounts) {
    this.accounts = buildLookup(this.queryAll('SELECT * FROM Account WHERE Active = true', 'Account'), 'Account');
  }
  return this.accounts(name);
};

QboClient.prototype.resolveDepartment = function (name) {
  if (!name) return null;
  if (!this.departments) {
    this.departments = buildLookup(this.queryAll('SELECT * FROM Department WHERE Active = true', 'Department'), 'Location');
  }
  return this.departments(name);
};

QboClient.prototype.resolveClass = function (name) {
  if (!name) return null;
  if (!this.classes) {
    this.classes = buildLookup(this.queryAll('SELECT * FROM Class WHERE Active = true', 'Class'), 'Class');
  }
  return this.classes(name);
};

/**
 * Has this payout already been booked? Looks for our key in the memo of any
 * Deposit or Journal Entry on that date, so deleting the transaction in
 * QuickBooks lets the next run re-post it.
 */
QboClient.prototype.findExisting = function (key, txnDateIso) {
  var entities = ['Deposit', 'JournalEntry'];
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var rows = this.queryAll("SELECT * FROM " + e + " WHERE TxnDate = '" + txnDateIso + "'", e);
    for (var j = 0; j < rows.length; j++) {
      if (String(rows[j].PrivateNote || '').indexOf(key) >= 0) {
        return { entity: e, id: rows[j].Id };
      }
    }
  }
  return null;
};

QboClient.prototype.create = function (entity, payload) {
  var res = this.request('post', '/' + entity.toLowerCase(), payload);
  return res[entity];
};

// ===== QboPoster.js =====
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

// ===== Sync.js =====
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
        var why = status === 'NONE' ? 'Toast reports this payout as failed/unavailable (status NONE).' : 'Payout status ' + status + ' not in postStatuses.';
        (status === 'NONE' ? result.held : result.skipped).push({ label: label, reason: why });
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
      result.errors.push({ label: label, error: String(e && e.message || e) });
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

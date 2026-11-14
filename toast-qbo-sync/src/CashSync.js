/**
 * Cash sales from Toast's Standard API (orders API), booked exactly:
 * for each location and business date, every CASH payment is split into
 * sales, sales tax (the tax actually charged on that check, wherever the
 * truck was) and tips, and posted as one journal entry:
 *
 *   DEBIT  Cash on Hand - Toast        cash collected
 *   CREDIT Sales / Sales Tax / Tips
 *
 * Cash deposits into the cash bank account are moved out of Cash on Hand by a
 * bank rule, so its balance = cash collected that hasn't been deposited yet.
 *
 * Needs Script Properties TOAST_STD_CLIENT_ID / TOAST_STD_CLIENT_SECRET
 * (Toast Web -> Integrations -> Toast API access -> Standard API access,
 * scope orders:read).
 */

var CASH_VOID_STATUSES = ['VOIDED', 'CANCELLED', 'DENIED'];

function StandardToastClient(config) {
  this.host = String(config.toast.apiHost).replace(/\/+$/, '');
}

StandardToastClient.prototype.getToken = function (forceRefresh) {
  var cache = Runtime.cache();
  if (!forceRefresh) {
    var cached = cache.get('toast_std_access_token');
    if (cached) return cached;
  }
  var res = Runtime.fetch(this.host + '/authentication/v1/authentication/login', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      clientId: requireProp('TOAST_STD_CLIENT_ID'),
      clientSecret: requireProp('TOAST_STD_CLIENT_SECRET'),
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  });
  if (res.code !== 200) {
    throw new Error('Toast Standard API login failed (HTTP ' + res.code + '): ' + String(res.text).slice(0, 300));
  }
  var body = JSON.parse(res.text);
  var token = body.token && body.token.accessToken;
  if (!token) throw new Error('Toast Standard API login returned no token.');
  cache.put('toast_std_access_token', token, Math.min(Math.max((body.token.expiresIn || 3600) - 300, 60), 21600));
  return token;
};

StandardToastClient.prototype.get = function (path, restaurantGuid) {
  var refreshed = false;
  for (var attempt = 0; attempt < 5; attempt++) {
    var res = Runtime.fetch(this.host + path, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + this.getToken(false), 'Toast-Restaurant-External-ID': restaurantGuid },
    });
    if (res.code === 401 && !refreshed) { refreshed = true; this.getToken(true); continue; }
    if (res.code === 429) { Runtime.sleep(2000 * (attempt + 1)); continue; }
    if (res.code === 403) {
      throw new Error('Toast Standard API refused ' + path.split('?')[0] + ' (HTTP 403). The credential needs the ' +
        'orders:read scope and access to this location.');
    }
    if (res.code !== 200) {
      throw new Error('Toast GET ' + path.split('?')[0] + ' failed (HTTP ' + res.code + '): ' + String(res.text).slice(0, 300));
    }
    return res.text ? JSON.parse(res.text) : [];
  }
  throw new Error(TOAST_RATE_LIMIT_MSG + ' (GET ' + path.split('?')[0] + ')');
};

/** Every order for one location and business date (pages of 100). */
StandardToastClient.prototype.getOrders = function (restaurantGuid, businessYmd) {
  var all = [];
  for (var page = 1; page <= 50; page++) {
    var batch = this.get('/orders/v2/ordersBulk?businessDate=' + toYmd(businessYmd) + '&pageSize=100&page=' + page, restaurantGuid);
    all = all.concat(batch || []);
    if (!batch || batch.length < 100) return all;
  }
  throw new Error('More than 5,000 orders on one day? Stopping to be safe.');
};

/** Pure: total the cash payments in a day's orders. */
function computeCashFromOrders(orders) {
  var out = { count: 0, grossCents: 0, taxCents: 0, tipCents: 0, refundCents: 0, refundTaxCents: 0, refundTipCents: 0 };
  (orders || []).forEach(function (order) {
    if (order.voided || order.deleted) return;
    (order.checks || []).forEach(function (check) {
      if (check.voided || check.deleted) return;
      var checkTax = toCents(check.taxAmount);
      var preTip = toCents(check.amount) + checkTax; // check.amount excludes tax and tip
      (check.payments || []).forEach(function (p) {
        if (String(p.type || '').toUpperCase() !== 'CASH') return;
        if (CASH_VOID_STATUSES.indexOf(String(p.paymentStatus || '').toUpperCase()) >= 0) return;
        if (p.voidInfo) return;
        var amount = toCents(p.amount);
        var tip = toCents(p.tipAmount);
        var tax = preTip > 0 ? Math.round(amount * checkTax / preTip) : 0;
        if (tax > amount) tax = amount;
        out.count++;
        out.grossCents += amount + tip;
        out.taxCents += tax;
        out.tipCents += tip;
        if (p.refundStatus && p.refundStatus !== 'NONE' && p.refund) {
          var rAmt = toCents(p.refund.refundAmount);
          var rTip = toCents(p.refund.tipRefundAmount);
          out.refundCents += rAmt + rTip;
          out.refundTaxCents += amount > 0 ? Math.round(tax * rAmt / amount) : 0;
          out.refundTipCents += rTip;
        }
      });
    });
  });
  return out;
}

/** Pure: the journal entry lines for one location's cash day. */
function buildCashBreakdown(args) {
  var config = args.config;
  var loc = locationSettings(config, args.restaurantGuid, args.restaurantName);
  var acct = loc.accounts;
  var c = computeCashFromOrders(args.orders);
  var net = c.grossCents - c.refundCents;
  var tax = c.taxCents - c.refundTaxCents;
  var tips = c.tipCents - c.refundTipCents;
  var sales = net - tax - tips;
  var lines = [];
  function add(role, label, account, cents, side) {
    if (cents !== 0) lines.push({ role: role, label: label, account: account, cents: cents, side: side });
  }
  add('sales', 'Cash sales', acct.sales, sales, 'credit');
  add('salesTax', 'Sales tax on cash sales', acct.salesTax, tax, 'credit');
  add('tips', 'Cash tips (recorded in Toast)', acct.tips, tips, 'credit');
  return {
    key: 'toast-cash:' + args.restaurantGuid + ':' + toYmd(args.businessDate),
    restaurantGuid: args.restaurantGuid,
    restaurantName: loc.name,
    settledDate: toYmd(args.businessDate), // reused by buildQboTransaction for the date
    location: loc,
    toast: { payment: net, refund: c.refundCents, fee: 0, withholding: 0, payout: net },
    cash: c,
    bankCents: net,
    bankAccount: config.cash.onHandAccount,
    bankLabel: 'Cash collected (Toast cash payments)',
    lines: lines,
    warnings: [],
    holdReasons: sales < 0 ? ['Cash sales came out negative; check refunds in Toast.'] : [],
    ok: sales >= 0,
  };
}

/**
 * Post cash journal entries for every configured location and business date
 * in the range. Same result shape as syncPayouts so reports can be merged.
 */
function syncCash(opts) {
  var config = opts.config;
  var started = Runtime.now();
  var result = {
    range: { start: opts.startYmd, end: opts.endYmd }, dryRun: !!opts.dryRun,
    posted: [], existing: [], held: [], skipped: [], previews: [], errors: [], unfinished: false,
  };
  var names = opts.locationNames || {};
  var guids = config.toast.restaurantIds || [];
  var days = dateRangeYmd(opts.startYmd, opts.endYmd);
  var journal = Object.assign({}, config, { sync: Object.assign({}, config.sync, { postingMode: 'journal', txnDateOffsetDays: 0 }) });

  var stop = false;
  for (var di = 0; di < days.length && !stop; di++) {
    for (var gi = 0; gi < guids.length && !stop; gi++) {
      var guid = guids[gi];
      var label = 'Cash ' + (names[guid] || guid) + ' ' + ymdToIso(days[di]);
      if (Runtime.now() - started > config.sync.timeBudgetMs) {
        result.unfinished = true;
        result.skipped.push({ label: label, reason: 'Out of time this run; will continue next run.' });
        continue;
      }
      try {
        var key = 'toast-cash:' + guid + ':' + days[di];
        if (opts.qbo) {
          var found = opts.qbo.findExisting(key, ymdToIso(days[di]));
          if (found) { result.existing.push({ label: label, entity: found.entity, id: found.id }); continue; }
        }
        var orders = opts.toast.getOrders(guid, days[di]);
        var b = buildCashBreakdown({ orders: orders, restaurantGuid: guid, restaurantName: names[guid] || guid,
          businessDate: days[di], config: config });
        if (b.cash.count === 0) { result.skipped.push({ label: label, reason: 'No cash payments.' }); continue; }
        var record = { label: label, breakdown: b, warnings: b.warnings,
          summary: label + ': cash ' + formatMoney(b.bankCents) + ' = ' + b.lines.map(function (l) {
            return l.label + ' ' + formatMoney(l.cents); }).join(', ') };
        if (!b.ok) { record.reason = b.holdReasons.join(' '); result.held.push(record); continue; }
        var txn = buildQboTransaction(b, opts.qbo ? qboRefs(opts.qbo) : NAME_ONLY_REFS, journal);
        txn.payload.PrivateNote = b.key + ' | Toast cash sales ' + (names[guid] || guid) + ' ' + ymdToIso(days[di]) +
          ' | ' + b.cash.count + ' cash payments | posted by toast-qbo-sync';
        record.transaction = txn;
        if (opts.dryRun) { result.previews.push(record); continue; }
        var created = opts.qbo.create(txn.entity, txn.payload);
        record.qboId = created && created.Id;
        record.entity = txn.entity;
        result.posted.push(record);
      } catch (e) {
        var msg = String(e && e.message || e);
        if (msg.indexOf(TOAST_RATE_LIMIT_MSG) === 0) { result.unfinished = true; stop = true; continue; }
        result.errors.push({ label: label, error: msg });
      }
    }
  }
  return result;
}

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

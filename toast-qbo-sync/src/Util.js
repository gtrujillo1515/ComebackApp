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

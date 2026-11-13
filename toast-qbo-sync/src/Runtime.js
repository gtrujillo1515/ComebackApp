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

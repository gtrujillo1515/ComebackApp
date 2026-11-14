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

/** Current balance of an account by name (dollars, as QuickBooks reports it). */
QboClient.prototype.accountBalance = function (name) {
  var ref = this.resolveAccount(name);
  var rows = this.queryAll("SELECT * FROM Account WHERE Id = '" + ref.value + "'", 'Account');
  return rows.length ? Number(rows[0].CurrentBalance || 0) : null;
};

QboClient.prototype.create = function (entity, payload) {
  var res = this.request('post', '/' + entity.toLowerCase(), payload);
  return res[entity];
};

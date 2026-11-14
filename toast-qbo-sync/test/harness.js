// Loads the Apps Script sources into one Node VM context (Apps Script shares a
// single global scope across files) and swaps Runtime for fakes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['Util.js', 'Runtime.js', 'Config.js', 'PayoutBuilder.js', 'ToastClient.js', 'QboClient.js', 'QboPoster.js', 'Sync.js', 'CashSync.js'];

function load(overrides = {}) {
  const ctx = vm.createContext({ console });
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  let clock = 1_000_000;
  const props = { TOAST_CLIENT_ID: 'id', TOAST_CLIENT_SECRET: 'secret', ...(overrides.props || {}) };
  const cacheStore = {};
  ctx.sleeps = [];
  Object.assign(ctx.Runtime, {
    fetch: overrides.fetch || (() => { throw new Error('no fetch stub'); }),
    sleep: (ms) => { ctx.sleeps.push(ms); clock += ms; },
    now: () => clock,
    props: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }),
    cache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }),
    log: () => {},
    timeZone: () => 'America/Los_Angeles',
    formatDate: () => overrides.today || '20261112',
  });
  ctx.advance = (ms) => { clock += ms; };
  return ctx;
}

/** Deep copy of CONFIG from the context with overrides merged per section. */
function config(ctx, patch = {}) {
  const base = JSON.parse(JSON.stringify(ctx.CONFIG));
  // Tests use fixed settings so they don't change when the business's Config.js does.
  base.toast.restaurantIds = [];
  base.accounts = {
    deposit: 'Business Checking', sales: 'Sales', salesTax: 'Sales Tax Payable - Toast', tips: 'Tips Payable',
    gratuity: 'Tips Payable', refunds: 'Refunds', fees: 'Merchant Processing Fees',
    unallocatedWithholding: 'Toast Withholdings - Unallocated', reconciliationDifference: 'Toast Reconciliation Differences',
  };
  base.locations = {};
  base.withholdingRules = [{ name: 'Toast Capital', account: 'Toast Capital Loan', method: 'remainder', locations: ['*'] }];
  base.payoutSplits = [];
  base.sync = { ...base.sync, dryRun: true, postingMode: 'deposit', txnDateOffsetDays: 0, reconcileToleranceCents: 100 };
  for (const k of Object.keys(patch)) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base[k] && typeof base[k] === 'object') {
      base[k] = { ...base[k], ...patch[k] };
    } else {
      base[k] = patch[k];
    }
  }
  return base;
}

module.exports = { load, config };

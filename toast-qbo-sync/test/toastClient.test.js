const test = require('node:test');
const assert = require('node:assert/strict');
const { load, config } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));
const LOGIN = { code: 200, text: JSON.stringify({ token: { accessToken: 'tok', expiresIn: 19168 } }) };
const GUID1 = '11111111-1111-1111-1111-111111111111';
const GUID2 = '22222222-2222-2222-2222-222222222222';

/** Fake HTTP: routes is a list of [method, urlRegex, responder(callIndex, opts)]. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = (url, opts) => {
    const method = (opts.method || 'get').toLowerCase();
    calls.push({ method, url, body: opts.payload ? JSON.parse(opts.payload) : undefined });
    if (url.endsWith('/authentication/v1/authentication/login')) return LOGIN;
    for (const r of routes) {
      if (r[0] === method && r[1].test(url)) {
        r.count = (r.count || 0) + 1;
        return r[2](r.count, opts);
      }
    }
    throw new Error('Unexpected request ' + method + ' ' + url);
  };
  return { fetch, calls };
}

test('polls through 202 responses until the report is ready (the old job treated 202 as empty)', () => {
  const rows = [{ restaurantGuid: 'r', settledDate: '20261110', payoutAmount: 10 }];
  const f = fakeFetch([
    ['post', /\/era\/v1\/payout\/day$/, () => ({ code: 200, text: JSON.stringify(GUID1) })],
    ['get', new RegExp('/era/v1/payout/' + GUID1 + '$'), (n) => (n < 3 ? { code: 202, text: '' } : { code: 200, text: JSON.stringify(rows) })],
  ]);
  const ctx = load({ fetch: f.fetch });
  const client = new ctx.ToastClient(config(ctx));
  const out = client.getSettledPayouts('20261110', '20261110');
  assert.equal(out.length, 1);
  assert.equal(out[0].payoutAmount, 10);
  assert.equal(ctx.sleeps.length, 2);
  const post = f.calls.find((c) => c.method === 'post' && c.url.includes('/era/v1/payout/day'));
  assert.deepEqual(post.body, { restaurantIds: [], excludedRestaurantIds: [], startDate: '20261110', endDate: '20261110' });
});

test('uses the week report for multi-day ranges and chunks ranges longer than 7 days', () => {
  const f = fakeFetch([
    ['post', /\/era\/v1\/payout\/week$/, (n) => ({ code: 200, text: JSON.stringify(n === 1 ? GUID1 : GUID2) })],
    ['get', /\/era\/v1\/payout\/[0-9a-f-]{36}$/, () => ({ code: 200, text: '[]' })],
  ]);
  const ctx = load({ fetch: f.fetch });
  new ctx.ToastClient(config(ctx)).getSettledPayouts('20261101', '20261110');
  const posts = f.calls.filter((c) => c.method === 'post' && c.url.includes('/era/'));
  assert.deepEqual(posts.map((p) => [p.body.startDate, p.body.endDate]), [['20261101', '20261107'], ['20261108', '20261110']]);
});

test('re-requests the report when Toast answers 409', () => {
  const f = fakeFetch([
    ['post', /\/era\/v1\/payout\/day$/, (n) => ({ code: 200, text: JSON.stringify(n === 1 ? GUID1 : GUID2) })],
    ['get', new RegExp(GUID1), () => ({ code: 409, text: 'expired' })],
    ['get', new RegExp(GUID2), () => ({ code: 200, text: '[{"a":1}]' })],
  ]);
  const ctx = load({ fetch: f.fetch });
  const out = new ctx.ToastClient(config(ctx)).getSettledPayouts('20261110', '20261110');
  assert.equal(out.length, 1);
  assert.equal(out[0].a, 1);
});

test('refreshes the Toast token once on 401', () => {
  let logins = 0;
  const f = fakeFetch([
    ['get', /restaurants-information/, (n) => (n === 1 ? { code: 401, text: '' } : { code: 200, text: '[]' })],
  ]);
  const ctx = load({
    fetch: (u, o) => { if (u.endsWith('/login')) logins++; return f.fetch(u, o); },
  });
  new ctx.ToastClient(config(ctx)).getRestaurants();
  assert.equal(logins, 2);
});

test('collects the payments of one payout across sales dates, widening the window until it reconciles', () => {
  const pay = (guid, rest, settled, total, date) => ({
    restaurantGuid: rest, paymentGuid: guid, checkGuid: 'chk-' + guid, settledDate: Number(settled),
    paidDateTime: date + ' 12:00:00', paymentTotal: total, paymentSubtotal: total, tipAmount: 0, gratuityAmount: 0,
  });
  const byDate = {
    '20261109': [pay('a', 'R', '20261110', 60, '2026-11-09'), pay('b', 'OTHER', '20261110', 999, '2026-11-09'), pay('c', 'R', '20261111', 5, '2026-11-09')],
    '20261108': [pay('d', 'R', '20261110', 40, '2026-11-08')],
  };
  const f = fakeFetch([
    ['post', /\/era\/v1\/check\/day$/, () => ({ code: 200, text: JSON.stringify(GUID1) })],
    ['get', /\/era\/v1\/check\//, () => ({ code: 200, text: '[]' })],
  ]);
  const ctx = load({ fetch: f.fetch });
  const client = new ctx.ToastClient(config(ctx));
  // Serve per-date payments directly; the HTTP flow is covered by other tests.
  client.getPaymentsForSalesDate = function (d) { return byDate[d] || []; };
  const row = { restaurantGuid: 'R', settledDate: '20261110', paymentAmount: 100,
    salesPeriodStartDateTime: '2026-11-09 08:00:00', salesPeriodEndDateTime: '2026-11-09 20:00:00' };
  const detail = client.getPayoutDetail(row, 100);
  assert.deepEqual(plain(detail.payments.map((p) => p.paymentGuid).sort()), ['a', 'd']);
});

test('spaces out POSTs to the 5-per-minute endpoints', () => {
  const f = fakeFetch([
    ['post', /\/era\/v1\/check\/day$/, () => ({ code: 200, text: JSON.stringify(GUID1) })],
    ['get', /\/era\/v1\/check\//, () => ({ code: 200, text: '[{"checkGuid":"x"}]' })],
  ]);
  const ctx = load({ fetch: f.fetch });
  const client = new ctx.ToastClient(config(ctx));
  client.getChecksForBusinessDate('20261109');
  client.getChecksForBusinessDate('20261108');
  client.getChecksForBusinessDate('20261109'); // cached, no request
  assert.equal(f.calls.filter((c) => c.method === 'post' && c.url.includes('/check/day')).length, 2);
  assert.ok(ctx.sleeps.some((ms) => ms >= 12000), 'expected a rate-limit pause between POSTs');
});

test('replaces the brand-only payout name with the full location name', () => {
  const f = fakeFetch([
    ['post', /\/era\/v1\/payout\/day$/, () => ({ code: 200, text: JSON.stringify(GUID1) })],
    ['get', new RegExp('/era/v1/payout/' + GUID1), () => ({ code: 200, text: JSON.stringify([
      { restaurantGuid: 'a', restaurantName: 'Stacks Burgers', restaurantLocationName: null },
      { restaurantGuid: 'b', restaurantName: 'Stacks Burgers', restaurantLocationName: 'Tacoma' },
    ]) })],
    ['get', /restaurants-information/, () => ({ code: 200, text: JSON.stringify([{ restaurantGuid: 'a', restaurantName: 'Stacks Burgers  - Truck 2' }]) })],
  ]);
  const ctx = load({ fetch: f.fetch });
  const rows = new ctx.ToastClient(config(ctx)).getSettledPayouts('20261110', '20261110');
  assert.deepEqual(plain(rows.map((r) => r.restaurantName)), ['Stacks Burgers - Truck 2', 'Stacks Burgers - Tacoma']);
});

test('matches payments whose settledDate uses a dashed or numeric format', () => {
  const ctx = load();
  const client = new ctx.ToastClient(config(ctx));
  const mk = (id, settled) => ({ restaurantGuid: 'R', paymentGuid: id, checkGuid: 'c' + id, settledDate: settled,
    paidDateTime: '2026-11-10 12:00:00', paymentTotal: 50, paymentSubtotal: 50, tipAmount: 0, gratuityAmount: 0 });
  client.getPaymentsForSalesDate = () => [mk('a', '2026-11-11'), mk('b', 20261111), mk('c', '2026-11-12')];
  client.getChecksForBusinessDate = () => ({});
  const detail = client.getPayoutDetail({ restaurantGuid: 'r', settledDate: '20261111', paymentAmount: 100,
    salesPeriodStartDateTime: '2026-11-10 08:00:00', salesPeriodEndDateTime: '2026-11-10 20:00:00' }, 100);
  assert.deepEqual(plain(detail.payments.map((p) => p.paymentGuid)), ['a', 'b']);
});

test('reads a payout\'s payments from the settled-date report (how Toast actually keys it)', () => {
  const ctx = load();
  const client = new ctx.ToastClient(config(ctx));
  const asked = [];
  const pay = (id, settled) => ({ restaurantGuid: 'R', paymentGuid: id, checkGuid: 'c' + id, settledDate: settled,
    orderOpenDateTime: '2026-11-10 00:37:13', paidDateTime: '2026-11-10 00:38:50', paymentTotal: 50, paymentSubtotal: 50, tipAmount: 0, gratuityAmount: 0 });
  client.getPaymentsForSalesDate = (d) => { asked.push(d); return d === '20261111' ? [pay('a', 20261111), pay('b', 20261111)] : [pay('x', Number(d))]; };
  const checkDates = [];
  client.getChecksForBusinessDate = (d) => { checkDates.push(d); return d === '20261109' ? { ca: { checkTotalAmount: 50, checkTaxAmount: 5, checkTipAmount: 0, checkGratuityAmount: 0 } } : {}; };
  const detail = client.getPayoutDetail({ restaurantGuid: 'R', settledDate: '20261111', paymentAmount: 100,
    salesPeriodStartDateTime: '2026-11-09 19:04:59', salesPeriodEndDateTime: '2026-11-10 03:08:04' }, 100);
  assert.deepEqual(plain(detail.payments.map((p) => p.paymentGuid)), ['a', 'b']);
  assert.deepEqual(plain(asked), ['20261111']);
  assert.equal(checkDates[0], '20261109', 'UTC timestamps: look at the previous business date first');
  assert.ok(detail.checksByGuid.ca);
});

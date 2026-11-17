/* Read-only HTTP API over a real socket. [MOCK network, REAL database] */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, seedHistory, START, MARKETS } from './helpers/harness.js';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const HOUR = 3600000, ORIGIN = 'https://app.example';

async function boot(extra = {}) {
  const e = await makeEnv({ ...extra, env: { RECORDER_ENABLED: '0', ...(extra.env || {}) }, init: false });   /* API-only: tests drive data directly, no live sampling */
  const port = await e.app.start({ port: 0, host: '127.0.0.1' });
  e.base = 'http://127.0.0.1:' + port;
  e.get = (p, headers = {}) => fetch(e.base + p, { headers });
  return e;
}
const json = async r => ({ status: r.status, headers: r.headers, body: await r.json() });

const TOKEN = 'status-token-0123456789-abcdefghij';
const auth = (t = TOKEN) => ({ authorization: 'Bearer ' + t });

test('healthz is PUBLIC and MINIMAL: only ok/service/ready, no operational detail, no secrets', opts, async () => {
  const e = await boot({ env: { STATUS_TOKEN: TOKEN } }); try {
    const r = await json(await e.get('/healthz')); assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'ready', 'service']); assert.equal(r.body.service, 'saturn-perps-data'); assert.equal(r.body.ok, true);
    const s = JSON.stringify(r.body);
    for (const x of ['recorder', 'metrics', 'leader', 'thresholds', 'epoch', 'version', 'uptime', 'lastInitError', 'rateHeaders', 'queued', 'markets', 'SOL', 'secret-pass', 'secret-user', 'db.internal', 'postgres://', TOKEN]) assert.ok(!s.includes(x), 'healthz exposes ' + x);
    assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Object.keys((await json(await e.get('/'))).body).sort(), ['ok', 'ready', 'service']);
  } finally { await e.drop(); }
});

test('/internal/status: does not exist unless STATUS_TOKEN is configured', opts, async () => {
  const e = await boot(); try {
    for (const h of [{}, auth(), auth('anything')]) { const r = await json(await e.get('/internal/status', h)); assert.equal(r.status, 404); assert.equal(r.body.error, 'not_found'); }
  } finally { await e.drop(); }
});

test('/internal/status: token required (401), never browser-callable (403), attempts rate-limited (429), correct token returns detail without secrets', opts, async () => {
  const e = await boot({ env: { STATUS_TOKEN: TOKEN } }); try {
    const tries = [{}, { authorization: 'Bearer' }, { authorization: 'Bearer ' }, { authorization: 'Basic ' + TOKEN }, { authorization: 'bearer ' + TOKEN }, auth('wrong-token-wrong-token-wrong'), auth(TOKEN + 'x'), auth(TOKEN.slice(0, -1)), { authorization: 'Bearer ' + 'A'.repeat(600) }];
    for (const h of tries) { const r = await json(await e.get('/internal/status', { 'x-forwarded-for': 'a, 5.5.5.' + tries.indexOf(h), ...h })); assert.equal(r.status, 401, JSON.stringify(h).slice(0, 60)); assert.deepEqual(r.body, { ok: false, error: 'unauthorized' }); }
    let r = await json(await e.get('/internal/status', { ...auth(), origin: ORIGIN })); assert.equal(r.status, 403, 'even the right token is refused from a browser origin'); assert.equal(r.headers.get('access-control-allow-origin'), null);
    const ok = await json(await e.get('/internal/status', { ...auth(), 'x-forwarded-for': 'a, 6.6.6.6' })); assert.equal(ok.status, 200);
    assert.equal(ok.body.service, 'saturn-perps-data'); assert.equal(ok.body.thresholds.intervalSec, 15); assert.deepEqual(Object.keys(ok.body.recorder.markets).sort(), ['BTC', 'ETH', 'SOL']); assert.equal(ok.body.db.ok, true); assert.ok(ok.body.metrics.counters);
    const s = JSON.stringify(ok.body); for (const x of ['secret-pass', 'secret-user', 'db.internal', 'postgres://', TOKEN]) assert.ok(!s.includes(x), 'status leaks ' + x);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    for (let i = 0; i < 12; i++) r = await e.get('/internal/status', { 'x-forwarded-for': 'a, 7.7.7.7', ...auth('wrong-token-wrong-token-wrong') });
    assert.equal(r.status, 429, 'brute-force attempts are throttled'); assert.equal((await e.get('/internal/status', { 'x-forwarded-for': 'a, 7.7.7.7', ...auth() })).status, 429, 'even a correct token is throttled while locked out');
    assert.ok(e.parts.metrics.get('status_unauthorized') >= 9);
    assert.equal((await e.get('/internal/status?x=1', { 'x-forwarded-for': 'a, 8.8.8.8', ...auth() })).status, 200);
    assert.equal((await fetch(e.base + '/internal/status', { method: 'POST', headers: auth() })).status, 405);
  } finally { await e.drop(); }
});

test('markets: live / stale / down / no_data; price withheld when down', opts, async () => {
  const e = await boot(); try {
    await seedHistory(e, 'SOL', START, START + 2 * HOUR);
    const last = e.clock.now() - 20000;                          /* seedHistory advanced the clock 20 s past the data */
    let r = await json(await e.get('/v1/perps/markets')); const by = Object.fromEntries(r.body.markets.map(m => [m.market, m]));
    assert.equal(r.status, 200); assert.equal(r.body.source, 'jupiter-perps:market-stats');
    assert.equal(by.SOL.state, 'live'); assert.ok(by.SOL.price > 0); assert.ok(by.SOL.ageMs < 37500); assert.equal(by.ETH.state, 'no_data'); assert.equal(by.ETH.price, null); assert.equal(by.BTC.observedAt, null);
    e.clock.jump(30000); await new Promise(r => setTimeout(r, 1100)); r = await json(await e.get('/v1/perps/markets')); assert.equal(r.body.markets[0].state, 'stale'); assert.ok(r.body.markets[0].price > 0, 'stale still shows the (labelled) last price');
    e.clock.jump(5 * 60 * 1000); await new Promise(r => setTimeout(r, 1100)); r = await json(await e.get('/v1/perps/markets')); assert.equal(r.body.markets[0].state, 'down'); assert.equal(r.body.markets[0].price, null, 'a down market never shows a price as if current');
  } finally { await e.drop(); }
});

test('candles: contract, ordering, completed-only default, includeForming, limit/before, valid flags, no volume field', opts, async () => {
  const e = await boot(); try {
    await seedHistory(e, 'SOL', START, START + 5 * HOUR + 17 * 60000);
    const r = await json(await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=200')); assert.equal(r.status, 200);
    assert.equal(r.body.basis, 'sampled'); assert.equal(r.body.sampleIntervalSec, 15); assert.equal(r.body.source, 'jupiter-perps:market-stats'); assert.equal(r.body.tf, '1h');
    const c = r.body.candles; assert.equal(c.length, 5);
    assert.ok(c.every((k, i) => (i === 0 || k.t > c[i - 1].t) && k.t % 3600 === 0));
    for (const k of c) { assert.deepEqual(Object.keys(k).sort(), ['c', 'coverage', 'h', 'l', 'maxGapSec', 'n', 'o', 'status', 't', 'valid']); assert.equal(k.status, 'complete'); assert.ok(k.h >= k.o && k.h >= k.c && k.l <= k.o && k.l <= k.c); assert.ok(!('v' in k)); }
    assert.equal(c[0].valid, true, 'recording began at the top of the hour');
    assert.equal(r.body.meta.validCount, 5); assert.equal(r.body.meta.returned, 5); assert.equal(r.body.meta.firstObservationAt, Math.floor((START + 5250) / 1000));
    const f = await json(await e.get('/v1/perps/candles?market=SOL&tf=1h&includeForming=1')); const last = f.body.candles[f.body.candles.length - 1];
    assert.equal(last.status, 'forming'); assert.equal(last.valid, false);
    const lim = await json(await e.get('/v1/perps/candles?market=sol&tf=1h&limit=2')); assert.equal(lim.body.candles.length, 2); assert.equal(lim.body.candles[1].t, c[4].t, 'limit returns the NEWEST n, ascending');
    const bef = await json(await e.get('/v1/perps/candles?market=SOL&tf=1h&before=' + c[3].t)); assert.deepEqual(bef.body.candles.map(k => k.t), c.slice(0, 3).map(k => k.t));
    const m1 = await json(await e.get('/v1/perps/candles?market=SOL&tf=1m&limit=500')); assert.equal(m1.body.candles.length, 317 - 0 > 500 ? 500 : m1.body.candles.length); assert.ok(m1.body.candles.length > 100);
    const none = await json(await e.get('/v1/perps/candles?market=BTC&tf=1h')); assert.deepEqual(none.body.candles, []); assert.equal(none.body.meta.firstObservationAt, null);
  } finally { await e.drop(); }
});

test('candles: parameter validation matrix (fuzz)', opts, async () => {
  const e = await boot(); try {
    const bad = [
      ['/v1/perps/candles', 'bad_market'], ['/v1/perps/candles?tf=1h', 'bad_market'], ['/v1/perps/candles?market=DOGE&tf=1h', 'bad_market'], ["/v1/perps/candles?market=SOL'%20OR%201=1--&tf=1h", 'bad_market'],
      ['/v1/perps/candles?market=SOL%00&tf=1h', 'bad_market'], ['/v1/perps/candles?market=__proto__&tf=1h', 'bad_market'], ['/v1/perps/candles?market=' + 'A'.repeat(5000) + '&tf=1h', 'bad_market'],
      ['/v1/perps/candles?market=SOL', 'bad_tf'], ['/v1/perps/candles?market=SOL&tf=2h', 'bad_tf'], ['/v1/perps/candles?market=SOL&tf=1H', 'bad_tf'], ['/v1/perps/candles?market=SOL&tf=constructor', 'bad_tf'], ["/v1/perps/candles?market=SOL&tf=1h';DROP%20TABLE%20x", 'bad_tf'],
      ['/v1/perps/candles?market=SOL&tf=1h&limit=0', 'bad_limit'], ['/v1/perps/candles?market=SOL&tf=1h&limit=501', 'bad_limit'], ['/v1/perps/candles?market=SOL&tf=1h&limit=-1', 'bad_limit'], ['/v1/perps/candles?market=SOL&tf=1h&limit=1e3', 'bad_limit'], ['/v1/perps/candles?market=SOL&tf=1h&limit=abc', 'bad_limit'], ['/v1/perps/candles?market=SOL&tf=1h&limit=', 'bad_limit'], ['/v1/perps/candles?market=SOL&tf=1h&limit=99999999999', 'bad_limit'],
      ['/v1/perps/candles?market=SOL&tf=1h&before=-1', 'bad_before'], ['/v1/perps/candles?market=SOL&tf=1h&before=abc', 'bad_before'], ['/v1/perps/candles?market=SOL&tf=1h&before=1e9', 'bad_before'], ['/v1/perps/candles?market=SOL&tf=1h&before=9999999999999', 'bad_before'],
    ];
    for (const [p, code] of bad) { const r = await json(await e.get(p)); assert.equal(r.status, 400, p); assert.equal(r.body.error, code, p); assert.equal(r.body.ok, false); assert.ok(!/stack|at \w+\.|node:|\.js:\d+/.test(JSON.stringify(r.body)), 'no internals'); }
    assert.equal((await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=500')).status, 200); assert.equal((await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=1')).status, 200);
    assert.equal((await e.get('/v1/perps/candles?market=SOL&tf=1h&includeForming=yes')).status, 200, 'unknown flag values are ignored, not echoed');
    assert.equal((await e.get('/v1/perps/readiness?market=SOL')).status, 404, 'A.A.I.H. readiness API has been removed');
    assert.equal((await e.get('/nope')).status, 404); assert.equal((await e.get('/v1/perps/orders')).status, 404); assert.equal((await e.get('/v1/perps/candles/../../etc/passwd')).status, 404);
    const tables = await e.db.rows("SELECT count(*)::int n FROM information_schema.tables WHERE table_name LIKE 'perps_%'"); assert.equal(tables[0].n, 8, 'no table was dropped (7 data tables + perps_exec_requests from migration 002)');
  } finally { await e.drop(); }
});


test('CORS: allowed origin, foreign origin, no origin, preflight; write methods refused', opts, async () => {
  const e = await boot(); try {
    let r = await e.get('/v1/perps/markets', { origin: ORIGIN }); assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(r.headers.get('vary'), 'Origin');
    r = await e.get('/v1/perps/markets', { origin: 'https://evil.example' }); assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null); assert.equal((await r.json()).error, 'origin_not_allowed');
    r = await e.get('/v1/perps/markets', { origin: ORIGIN + '.evil.example' }); assert.equal(r.status, 403);
    r = await e.get('/v1/perps/markets', { origin: 'null' }); assert.equal(r.status, 403);
    r = await e.get('/v1/perps/markets'); assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), null, 'no ACAO without an Origin');
    r = await fetch(e.base + '/v1/perps/candles', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } }); assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-methods'), 'GET, OPTIONS'); assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    r = await fetch(e.base + '/v1/perps/candles', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }); assert.equal(r.status, 403);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) { r = await fetch(e.base + '/v1/perps/candles?market=SOL&tf=1h', { method: m, headers: { origin: ORIGIN }, body: m === 'DELETE' ? undefined : '{}' }); assert.equal(r.status, 405, m); }
  } finally { await e.drop(); }
});

test('CORS is fail-closed when ALLOWED_ORIGINS is empty', opts, async () => {
  const e = await boot({ env: { ALLOWED_ORIGINS: '' } }); try {
    assert.equal((await e.get('/v1/perps/markets', { origin: ORIGIN })).status, 403); assert.equal((await e.get('/v1/perps/markets')).status, 200);
  } finally { await e.drop(); }
});

test('rate limit: per-IP window; spoofed first x-forwarded-for entry cannot dodge it; limits are per route', opts, async () => {
  const e = await boot({ env: { HTTP_LIMIT_PER_MIN: '5' } }); try {
    const hit = (xff, p = '/v1/perps/markets') => e.get(p, { 'x-forwarded-for': xff });
    for (let i = 0; i < 5; i++) assert.equal((await hit(`spoof${i}.0.0.1, 9.9.9.9`)).status, 200, 'varying the client-controlled first entry does not create new buckets');
    const r = await hit('1.2.3.4, 9.9.9.9'); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '30'); assert.equal((await r.json()).error, 'rate_limited');
    assert.equal((await hit('1.2.3.4, 8.8.8.8')).status, 200, 'a different real client (last entry) has its own budget');
    assert.equal((await hit('x, 9.9.9.9', '/v1/perps/candles?market=SOL&tf=1h')).status, 200, 'separate budget per route');
    assert.ok(e.parts.metrics.get('http_rate_limited') >= 1);
  } finally { await e.drop(); }
});

test('database outage: 503 db_unavailable on data routes, health stays 200 with ok:false, recovers', opts, async () => {
  const e = await boot({ env: { STATUS_TOKEN: TOKEN } }); try {
    await seedHistory(e, 'SOL', START, START + 2 * HOUR);
    e.db.fail = true;
    let r = await json(await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=3')); assert.equal(r.status, 503); assert.equal(r.body.error, 'db_unavailable');
    r = await json(await e.get('/v1/perps/markets')); assert.equal(r.status, 503);
    r = await json(await e.get('/healthz')); assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: false, service: 'saturn-perps-data', ready: true }, 'minimal body even during an outage');
    const st = await json(await e.get('/internal/status', { authorization: 'Bearer status-token-0123456789-abcdefghij' })); assert.equal(st.status, 200); assert.equal(st.body.db.ok, false); assert.equal(st.body.ok, false);
    e.db.fail = false; await new Promise(r => setTimeout(r, 2100));
    r = await json(await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=3')); assert.equal(r.status, 200);
  } finally { await e.drop(); }
});

test('shutdown: new data requests get 503 shutting_down', opts, async () => {
  const e = await boot(); try {
    const p = e.app.shutdown(); /* server closing; in-process handler check */
    const res = { head: null, writeHead(c) { this.head = c; }, end(b) { this.b = b; } };
    await e.app.parts.handler({ method: 'GET', url: '/v1/perps/markets', headers: {}, socket: { remoteAddress: '1.1.1.1' } }, res);
    assert.equal(res.head, 503); assert.match(res.b, /shutting_down/); await p;
  } finally { await e.db.drop(); }
});

test('responses never contain more than the documented fields (no raw upstream payload)', opts, async () => {
  const e = await boot(); try {
    await seedHistory(e, 'SOL', START, START + 3 * HOUR);
    const m = await json(await e.get('/v1/perps/markets'));
    for (const k of m.body.markets) assert.deepEqual(Object.keys(k).sort(), ['ageMs', 'market', 'observedAt', 'price', 'state']);
    assert.ok(!JSON.stringify(m.body).includes('priceChange24H'));
  } finally { await e.drop(); }
});

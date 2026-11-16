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

test('healthz: shape, 200, no secrets, no stack traces', opts, async () => {
  const e = await boot(); try {
    const r = await json(await e.get('/healthz')); assert.equal(r.status, 200);
    assert.equal(r.body.service, 'saturn-perps-data'); assert.equal(r.body.ok, true); assert.equal(r.body.leader, false, 'API-only instance'); assert.equal(r.body.db.ok, true);
    assert.deepEqual(Object.keys(r.body.recorder.markets).sort(), ['BTC', 'ETH', 'SOL']);
    assert.equal(r.body.thresholds.intervalSec, 15);
    const s = JSON.stringify(r.body); for (const x of ['secret-pass', 'secret-user', 'db.internal', 'postgres://']) assert.ok(!s.includes(x), x);
    assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await e.get('/')).status, 200);
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
      ['/v1/perps/readiness', 'bad_market'], ['/v1/perps/readiness?market=XRP', 'bad_market']
    ];
    for (const [p, code] of bad) { const r = await json(await e.get(p)); assert.equal(r.status, 400, p); assert.equal(r.body.error, code, p); assert.equal(r.body.ok, false); assert.ok(!/stack|at \w+\.|node:|\.js:\d+/.test(JSON.stringify(r.body)), 'no internals'); }
    assert.equal((await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=500')).status, 200); assert.equal((await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=1')).status, 200);
    assert.equal((await e.get('/v1/perps/candles?market=SOL&tf=1h&includeForming=yes')).status, 200, 'unknown flag values are ignored, not echoed');
    assert.equal((await e.get('/nope')).status, 404); assert.equal((await e.get('/v1/perps/orders')).status, 404); assert.equal((await e.get('/v1/perps/candles/../../etc/passwd')).status, 404);
    const tables = await e.db.rows("SELECT count(*)::int n FROM information_schema.tables WHERE table_name LIKE 'perps_%'"); assert.equal(tables[0].n, 7, 'no table was dropped');
  } finally { await e.drop(); }
});

test('readiness endpoint: not ready -> ready; labelled estimate; shape', opts, async () => {
  const e = await boot(); try {
    await seedHistory(e, 'SOL', START, START + 30 * HOUR);
    let r = await json(await e.get('/v1/perps/readiness?market=SOL')); assert.equal(r.status, 200);
    assert.equal(r.body.ready, false); assert.equal(r.body.reason, 'insufficient_history'); assert.equal(r.body.required, 60); assert.equal(r.body.tf, '1h'); assert.equal(r.body.earliestReadyIsEstimate, true);
    assert.equal(r.body.validConsecutiveCandles, 30);
    const e2 = await boot(); try {
      await seedHistory(e2, 'SOL', START, START + 61 * HOUR);
      const ok = await json(await e2.get('/v1/perps/readiness?market=SOL')); assert.equal(ok.body.ready, true, JSON.stringify(ok.body)); assert.equal(ok.body.reason, 'ready'); assert.equal(ok.body.validConsecutiveCandles, 60);
      const none = await json(await e2.get('/v1/perps/readiness?market=ETH')); assert.equal(none.body.ready, false); assert.equal(none.body.reason, 'no_data');
    } finally { await e2.drop(); }
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
  const e = await boot({ env: { HTTP_LIMIT_PER_MIN: '5', READINESS_LIMIT_PER_MIN: '2' } }); try {
    const hit = (xff, p = '/v1/perps/markets') => e.get(p, { 'x-forwarded-for': xff });
    for (let i = 0; i < 5; i++) assert.equal((await hit(`spoof${i}.0.0.1, 9.9.9.9`)).status, 200, 'varying the client-controlled first entry does not create new buckets');
    const r = await hit('1.2.3.4, 9.9.9.9'); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '30'); assert.equal((await r.json()).error, 'rate_limited');
    assert.equal((await hit('1.2.3.4, 8.8.8.8')).status, 200, 'a different real client (last entry) has its own budget');
    assert.equal((await hit('x, 9.9.9.9', '/v1/perps/candles?market=SOL&tf=1h')).status, 200, 'separate budget per route');
    assert.equal((await hit('x, 7.7.7.7', '/v1/perps/readiness?market=SOL')).status, 200); assert.equal((await hit('x, 7.7.7.7', '/v1/perps/readiness?market=SOL')).status, 200); assert.equal((await hit('x, 7.7.7.7', '/v1/perps/readiness?market=SOL')).status, 429);
    assert.ok(e.parts.metrics.get('http_rate_limited') >= 2);
  } finally { await e.drop(); }
});

test('database outage: 503 db_unavailable on data routes, health stays 200 with ok:false, recovers', opts, async () => {
  const e = await boot(); try {
    await seedHistory(e, 'SOL', START, START + 2 * HOUR);
    e.db.fail = true;
    let r = await json(await e.get('/v1/perps/candles?market=SOL&tf=1h&limit=3')); assert.equal(r.status, 503); assert.equal(r.body.error, 'db_unavailable');
    r = await json(await e.get('/v1/perps/markets')); assert.equal(r.status, 503);
    r = await json(await e.get('/v1/perps/readiness?market=SOL')); assert.equal(r.status, 503);
    r = await json(await e.get('/healthz')); assert.equal(r.status, 200); assert.equal(r.body.ok, false); assert.equal(r.body.db.ok, false);
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

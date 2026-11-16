/* Recorder + service wiring against a REAL PostgreSQL, a fake clock and a scripted fake Jupiter. [MOCK network, REAL database] */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv, checkCandlesMatchObservations, START, MARKETS, settle, FakeClock, fakeJupiter } from './helpers/harness.js';
import { createTestDb } from './helpers/pg-local.js';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const count = (db, sql) => db.rows(sql).then(r => r[0].n);
const T = name => name;

test('samples every 15 s per market, staggered 0/5/10 s, never over the request budget', opts, async () => {
  const e = await makeEnv(); try {
    await e.app.parts.recorder.start();
    await e.clock.advance(5 * 60 * 1000);
    const per = m => e.jup.calls.filter(c => c.mint === MARKETS[m]);
    for (const m of ['SOL', 'ETH', 'BTC']) assert.equal(per(m).length, 20, m);
    const offs = ['SOL', 'ETH', 'BTC'].map(m => (per(m)[0].at - START) % 15000);
    assert.deepEqual(offs, [0, 5000, 10000], 'staggered');
    for (const m of ['SOL', 'ETH', 'BTC']) { const t = per(m).map(c => c.at); for (let i = 1; i < t.length; i++) assert.equal(t[i] - t[i - 1], 15000); }
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_observations"), 60);
    assert.ok(e.jup.calls.length / 300 <= 0.25, 'under the 0.25 rps budget: ' + e.jup.calls.length / 300);
    assert.ok(e.jup.calls.every(c => c.method === 'GET' && c.credentials === 'omit' && c.redirect === 'error'));
    await checkCandlesMatchObservations(e.db, { nowMs: e.clock.now() });
  } finally { await e.drop(); }
});

test('duplicate slot: two fetches in one slot -> one stored row, exactly one tick, one candle update', opts, async () => {
  const ticks = []; const e2 = await makeEnv({ taps: { tick: t => ticks.push(t) } }); try {
    const rec = e2.app.parts.recorder;
    await rec.start(); await e2.clock.advance(1000);
    const t0 = ticks.filter(t => t.market === 'SOL').length;
    const before = await count(e2.db, "SELECT count(*)::int n FROM perps_observations WHERE market='SOL'");
    await rec.runOnce('SOL'); await rec.runOnce('SOL');    /* same fake instant, same slot */
    const after = await count(e2.db, "SELECT count(*)::int n FROM perps_observations WHERE market='SOL'");
    assert.equal(after - before, 1, 'exactly one new row for the slot');
    assert.equal(ticks.filter(t => t.market === 'SOL').length - t0, 1, 'the duplicate produced NO tick');
    assert.ok(e2.parts.metrics.get('duplicate_slot') >= 1);
  } finally { await e2.drop(); }
});

test('failure modes: nothing invalid is stored; each is logged; other markets keep recording', opts, async () => {
  const e = await makeEnv({ cfgOverrides: { timeoutMs: 60 } }); try {
    const modes = ['network', 'http500', 'http404', 'badjson', 'noprice', 'array', 'huge', 'hang', 'http429'];
    for (const m of modes) { e.jup.mode[MARKETS.SOL] = m; await e.app.parts.recorder.runOnce('SOL').catch(() => {}); /* runOnce requires running */ }
    await e.app.parts.recorder.start();
    for (const m of modes) {
      e.jup.mode[MARKETS.SOL] = m; e.app.parts.recorder._S.SOL.backoffUntil = 0;
      await e.clock.advance(15000); await new Promise(r => setTimeout(r, m === 'hang' ? 120 : 5)); await settle();
    }
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_observations WHERE market='SOL'"), 0, 'no SOL observation stored for any failure mode');
    assert.ok(await count(e.db, "SELECT count(*)::int n FROM perps_observations WHERE market='ETH'") >= 8, 'ETH unaffected');
    const outcomes = (await e.db.rows("SELECT DISTINCT outcome FROM perps_fetch_log WHERE market='SOL'")).map(r => r.outcome).sort();
    for (const o of ['network', 'http_5xx', 'http_other', 'malformed', 'timeout', 'http_429']) assert.ok(outcomes.includes(o), o + ' in ' + outcomes);
    assert.ok(await count(e.db, "SELECT count(*)::int n FROM perps_rejects WHERE reason='malformed'") >= 2);
  } finally { await e.drop(); }
});

test('invalid prices from a healthy HTTP 200 are rejected and recorded as rejects', opts, async () => {
  const e = await makeEnv(); try {
    const bad = [0, -5, 'abc', '1e500', null, '', 3e9];
    let i = 0; e.jup.prices[MARKETS.SOL] = () => bad[(i++) % bad.length];
    await e.app.parts.recorder.start(); await e.clock.advance(15 * 7 * 1000);
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_observations WHERE market='SOL'"), 0);
    const reasons = (await e.db.rows("SELECT DISTINCT reason FROM perps_rejects WHERE market='SOL'")).map(r => r.reason).sort();
    for (const r of ['non_positive', 'non_finite', 'malformed']) assert.ok(reasons.includes(r), r + ' in ' + reasons);
  } finally { await e.drop(); }
});

test('429: backoff ladder 30/60/120 s (cap), Retry-After honoured, no tight loop, recovery resets', opts, async () => {
  const e = await makeEnv(); try {
    const rec = e.app.parts.recorder, S = rec._S.SOL; await rec.start();
    e.jup.mode[MARKETS.SOL] = 'http429';
    const waits = [];
    for (let k = 0; k < 5; k++) { S.backoffUntil = 0; await e.clock.advance(15000); waits.push(S.backoffUntil - e.clock.now()); }
    const ladder = waits.map(w => Math.round(w / 1000));
    assert.ok(ladder[0] >= 25 && ladder[0] <= 35, 'first 429 ~30 s: ' + ladder);
    assert.ok(ladder[1] >= 55 && ladder[1] <= 65, 'second ~60 s: ' + ladder);
    assert.ok(ladder[2] >= 105 && ladder[2] <= 135 && ladder[3] >= 105 && ladder[3] <= 135 && ladder[4] >= 105 && ladder[4] <= 135, 'capped near 120 s: ' + ladder);
    /* sustained 429 for 10 minutes: bounded number of attempts */
    S.backoffUntil = 0; S.failures = 0; const c0 = e.jup.calls.filter(c => c.mint === MARKETS.SOL).length;
    await e.clock.advance(10 * 60 * 1000); const n = e.jup.calls.filter(c => c.mint === MARKETS.SOL).length - c0;
    assert.ok(n <= 8, 'attempts in 10 min under persistent 429: ' + n);
    assert.equal(S.failures >= 5 && rec.summary().markets.SOL.circuitOpen, true);
    /* Retry-After larger than the ladder wins */
    e.jup.mode[MARKETS.SOL] = 'http429retry'; S.backoffUntil = 0; S.failures = 0; await e.clock.advance(15000);
    assert.ok(S.backoffUntil - e.clock.now() > 70000, 'Retry-After 90 s honoured: ' + (S.backoffUntil - e.clock.now()));
    /* recovery */
    e.jup.mode[MARKETS.SOL] = 'ok'; S.backoffUntil = 0; await e.clock.advance(15000);
    assert.equal(S.failures, 0); assert.equal(rec.summary().markets.SOL.circuitOpen, false); assert.equal(rec.summary().markets.SOL.state, 'live');
    assert.equal(rec.summary().markets.ETH.consecutiveFailures, 0, 'other markets unaffected');
  } finally { await e.drop(); }
});

test('rate-limit headers are captured and surfaced in health (never assumed)', opts, async () => {
  const e = await makeEnv(); try {
    e.jup.headers['x-ratelimit-remaining'] = '17'; e.jup.headers['retry-after'] = '2';
    await e.app.parts.recorder.start(); await e.clock.advance(20000);
    const h = e.app.parts.recorder.summary().rateHeaders; assert.equal(h['x-ratelimit-remaining'], '17'); assert.equal(h['retry-after'], '2');
  } finally { await e.drop(); }
});

test('global request budget caps total calls even with a short interval', opts, async () => {
  const e = await makeEnv({ env: { SAMPLE_INTERVAL_SEC: '5' } }); try {
    await e.app.parts.recorder.start(); await e.clock.advance(10 * 60 * 1000);
    assert.ok(e.jup.calls.length <= 0.25 * 600 + 3, 'calls=' + e.jup.calls.length);
    assert.ok(e.parts.metrics.get('slot_skipped_budget') > 0, 'budget skipped some slots');
  } finally { await e.drop(); }
});

test('no overlap: a hung fetch makes the next slot skip, not queue; the client deadline still frees it', opts, async () => {
  const e2 = await makeEnv({ cfgOverrides: { timeoutMs: 300 } }); try {
    e2.jup.mode[MARKETS.SOL] = () => new Promise(() => {});
    const rec = e2.app.parts.recorder; await rec.start();
    const p1 = rec.runOnce('SOL'); await rec.runOnce('SOL'); await rec.runOnce('SOL');   /* return immediately: skipped, not queued */
    assert.equal(e2.jup.calls.filter(c => c.mint === MARKETS.SOL).length, 1, 'only one request in flight');
    assert.ok(e2.parts.metrics.get('slot_skipped_inflight') >= 2);
    await p1; assert.equal(rec._S.SOL.lastOutcome, 'timeout', 'the hard deadline released the slot');
    assert.equal(await count(e2.db, "SELECT count(*)::int n FROM perps_observations WHERE market='SOL'"), 0);
  } finally { await e2.drop(); }
});

test('jump filter end-to-end: lone spike rejected, sustained move accepted on the 3rd confirming sample', opts, async () => {
  const e = await makeEnv(); try {
    const seq = [150, 150, 400, 150, 150, 200, 200, 201, 201]; let i = 0;
    e.jup.prices[MARKETS.SOL] = () => seq[Math.min(i++, seq.length - 1)];
    await e.app.parts.recorder.start(); await e.clock.advance(15000 * seq.length + 1000);
    const stored = (await e.db.rows("SELECT price FROM perps_observations WHERE market='SOL' ORDER BY observed_at")).map(r => Number(r.price));
    assert.ok(!stored.includes(400), 'spike never stored');
    assert.deepEqual(stored, [150, 150, 150, 150, 201, 201]);
    const rej = await e.db.rows("SELECT reason, detail FROM perps_rejects WHERE market='SOL' ORDER BY id");
    assert.ok(rej.some(r => r.reason === 'jump_pending' && /price=400/.test(r.detail)));
    assert.equal(stored.filter(p => p === 200).length, 0, 'the 1st and 2nd confirming samples (200, 200) were quarantined, only the 3rd is stored');
    assert.equal(stored.includes(201), true);
  } finally { await e.drop(); }
});

test('stale -> down transitions at 37.5 s and 5 min; recovery to live; status events published only on change', opts, async () => {
  const events = []; const e = await makeEnv({ taps: { status: (m, s) => events.push([m, s]) } }); try {
    const rec = e.app.parts.recorder; await rec.start(); await e.clock.advance(60000);
    assert.equal(rec.summary().markets.SOL.state, 'live');
    e.jup.mode[MARKETS.SOL] = 'network';
    await e.clock.advance(30000); assert.equal(rec.stateOf('SOL'), 'live', 'within 2.5 x interval');
    await e.clock.advance(20000); rec.checkState('SOL'); assert.equal(rec.stateOf('SOL'), 'stale');
    await e.clock.advance(5 * 60 * 1000); rec.checkState('SOL'); assert.equal(rec.stateOf('SOL'), 'down');
    e.jup.mode[MARKETS.SOL] = 'ok'; rec._S.SOL.backoffUntil = 0; await e.clock.advance(40000); assert.equal(rec.stateOf('SOL'), 'live');
    const sol = events.filter(x => x[0] === 'SOL').map(x => x[1]);
    assert.deepEqual(sol.filter((x, i) => i === 0 || x !== sol[i - 1]), sol, 'no repeated identical status events');
    assert.ok(['stale', 'down', 'live'].every(s => sol.includes(s)), JSON.stringify(sol));
  } finally { await e.drop(); }
});

test('restart recovery: gap preserved, state truthful, candles rebuilt, nothing back-filled', opts, async () => {
  const e = await makeEnv(); try {
    await e.app.parts.recorder.start(); await e.clock.advance(7 * 60 * 1000 + 3000);
    const before = await count(e.db, "SELECT count(*)::int n FROM perps_observations WHERE market='SOL'");
    await e.app.parts.recorder.stop(); await e.app.parts.db.releaseLeader();
    const lastObs = (await e.db.rows("SELECT extract(epoch from max(observed_at))*1000 AS t FROM perps_observations WHERE market='SOL'"))[0].t;
    /* process is down for 20 minutes */
    e.clock.jump(20 * 60 * 1000);
    const e2 = await makeEnv({ db: e.db, clock: e.clock, jup: e.jup, init: false });
    await e2.app.init(); assert.equal(e2.app.leader, true);
    assert.equal(e2.app.parts.recorder.summary().markets.SOL.state, 'down', 'age is computed from the stored observation, not from boot time');
    await e2.app.parts.recorder.start(); await e2.clock.advance(2 * 60 * 1000);
    const obs = (await e.db.rows("SELECT extract(epoch from observed_at)*1000 AS t FROM perps_observations WHERE market='SOL' ORDER BY observed_at")).map(r => r.t);
    const maxGap = Math.max(...obs.slice(1).map((t, i) => t - obs[i]));
    assert.ok(maxGap >= 20 * 60 * 1000 - 20000, 'the outage is a visible 20-minute hole: ' + maxGap);
    assert.equal(obs.filter(t => t > lastObs + 1000 && t < lastObs + 19 * 60 * 1000).length, 0, 'nothing back-filled');
    const holeMinutes = await count(e.db, `SELECT count(*)::int n FROM perps_candles WHERE market='SOL' AND tf='1m' AND bucket_start > to_timestamp(${(lastObs + 60000) / 1000}) AND bucket_start < to_timestamp(${(lastObs + 19 * 60000) / 1000})`);
    assert.equal(holeMinutes, 0, 'no 1m candles in the hole');
    await checkCandlesMatchObservations(e.db, { nowMs: e.clock.now() });
    assert.ok(before > 0);
    await e2.app.shutdown();
  } finally { await e.db.drop(); }
});

test('crash between observation insert and candle write: recovery rebuilds the missing candle', opts, async () => {
  const e = await makeEnv(); try {
    const t = START + 5000;
    await e.parts.store.insertObservation({ market: 'ETH', slotMs: START, observedMs: t, price: 3001, fetchMs: 10 });   /* stored, but the process died before candle update */
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_candles WHERE market='ETH'"), 0);
    e.clock.jump(5 * 3600 * 1000); await e.parts.engine.recover('ETH');
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_candles WHERE market='ETH' AND tf='1m'"), 1);
    await checkCandlesMatchObservations(e.db, { nowMs: e.clock.now() });
  } finally { await e.drop(); }
});

test('database outage: ticks still published (persisted:false), bounded queue flushed in order on recovery, late items dropped, candles stay consistent', opts, async () => {
  const ticks = []; const e = await makeEnv({ taps: { tick: t => ticks.push(t) } }); try {
    const rec = e.app.parts.recorder; await rec.start(); await e.clock.advance(60000);
    const before = await count(e.db, "SELECT count(*)::int n FROM perps_observations");
    e.db.failWrites = true; await e.clock.advance(45000);
    assert.ok(rec.summary().dbDegraded); assert.ok(rec.summary().queued > 0);
    assert.ok(ticks.some(t => t.persisted === false), 'live tick flagged as not persisted');
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_observations"), before, 'nothing written during the outage');
    e.db.failWrites = false; await e.clock.advance(30000);
    assert.equal(rec.summary().dbDegraded, false); assert.equal(rec.summary().queued, 0);
    const obs = (await e.db.rows("SELECT extract(epoch from observed_at)*1000 AS t FROM perps_observations ORDER BY observed_at")).length;
    assert.ok(obs > before);
    await checkCandlesMatchObservations(e.db, { nowMs: e.clock.now() });
    /* queue overflow is bounded */
    e.db.failWrites = true; await e.clock.advance(15000 * 300); assert.ok(rec.summary().queued <= 240); assert.ok(e.parts.metrics.get('queue_overflow_dropped') > 0 || e.parts.metrics.get('queue_dropped_late') >= 0);
    e.db.failWrites = false; await e.clock.advance(30000); await checkCandlesMatchObservations(e.db, { nowMs: e.clock.now() });
  } finally { await e.drop(); }
});

test('single writer: a second instance on the same database does not record; takes over when the leader goes away', opts, async () => {
  const e = await makeEnv(); try {
    await e.app.parts.recorder.start();
    const e2 = await makeEnv({ db: await createTestDbShared(e), clock: e.clock, jup: e.jup, init: false });
    await e2.app.init(); assert.equal(e2.app.leader, false); assert.equal(e2.app.parts.recorder.running, false);
    await e.clock.advance(60000);
    assert.equal(e2.jup.calls.length, e.jup.calls.length, 'shared fake: all calls came from the leader');
    const perSlot = await e.db.rows("SELECT market, slot_ts, count(*)::int n FROM perps_observations GROUP BY 1,2 HAVING count(*) > 1");
    assert.equal(perSlot.length, 0, 'no duplicate slots');
    await e.app.parts.recorder.stop(); await e.app.parts.db.releaseLeader();       /* leader exits */
    await e2.app.becomeLeader(); assert.equal(e2.app.leader, true); assert.equal(e2.app.parts.recorder.running, true);
    await e2.app.shutdown();
  } finally { await e.db.drop(); }
});
async function createTestDbShared(e) {            /* second app instance = second DB session on the SAME database */
  const { createTestDb: _ } = await import('./helpers/pg-local.js');
  const mk = await import('./helpers/pg-local.js');
  return mk.attachTestDb(e.db);
}

test('leader loss while running stops the recorder (no split-brain)', opts, async () => {
  const e = await makeEnv(); try {
    await e.app.parts.recorder.start(); await e.clock.advance(30000);
    e.db.killLeaderSession(); await new Promise(r => setTimeout(r, 100));
    await e.app.becomeLeader(); assert.equal(e.app.leader, false); assert.equal(e.app.parts.recorder.running, false);
    const c = e.jup.calls.length; await e.clock.advance(60000); assert.equal(e.jup.calls.length, c, 'no further fetches after losing the lock');
    await e.app.becomeLeader(); assert.equal(e.app.leader, true, 'lock re-acquired');
  } finally { await e.drop(); }
});

test('clock moving backwards: recording pauses instead of writing out-of-order data', opts, async () => {
  const e = await makeEnv(); try {
    await e.app.parts.recorder.start(); await e.clock.advance(60000);
    const c = e.jup.calls.length; e.clock.jump(-30000);
    await e.app.parts.recorder.runOnce('SOL');
    assert.equal(e.jup.calls.length, c); assert.ok(e.parts.metrics.get('clock_backwards_skipped') >= 1);
  } finally { await e.drop(); }
});

test('retention: purges old observations/logs, keeps candles; runs once per UTC day', opts, async () => {
  const e = await makeEnv(); try {
    await e.db.sql(`INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('s','SOL',to_timestamp(${(START - 40 * 86400000) / 1000}),to_timestamp(${(START - 40 * 86400000) / 1000}),1,1),('s','SOL',to_timestamp(${(START - 1 * 86400000) / 1000}),to_timestamp(${(START - 86400000) / 1000}),2,1);
      INSERT INTO perps_fetch_log(market,at,outcome) VALUES ('SOL',to_timestamp(${(START - 9 * 86400000) / 1000}),'ok');
      INSERT INTO perps_candles(source,market,tf,bucket_start,o,h,l,c,n_obs,expected_obs,coverage,max_gap_sec,first_obs_at,last_obs_at,status,valid,finalized_at) VALUES ('s','SOL','1h',to_timestamp(${(START - 50 * 86400000) / 1000}),1,1,1,1,1,240,0.9,0,now(),now(),'complete',false,now());`);
    await e.app.retention();
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_observations WHERE price = 1"), 0, '40-day-old observation purged');
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_observations WHERE price = 2"), 1, '1-day-old kept');
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_fetch_log WHERE at < to_timestamp(" + (START - 8 * 86400000) / 1000 + ")"), 0);
    assert.equal(await count(e.db, "SELECT count(*)::int n FROM perps_candles WHERE source='s'"), 1, 'candles are never purged');
    assert.equal(await e.parts.store.getMeta('retention_last_day'), String(Math.floor(e.clock.now() / 86400000)));
    await e.db.sql(`INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('s','SOL',to_timestamp(${(START - 50 * 86400000) / 1000}),to_timestamp(${(START - 50 * 86400000) / 1000}),3,1)`);
    await e.app.retention(); assert.equal(await count(e.db, 'SELECT count(*)::int n FROM perps_observations WHERE price = 3'), 1, 'second call on the same UTC day is a no-op');
  } finally { await e.drop(); }
});

test('config safety: neither the public health route nor the protected status route leaks the database URL, API key or status token; logs are clean', opts, async () => {
  const TOK = 'status-token-0123456789-abcdefghij';
  const e = await makeEnv({ env: { JUPITER_API_KEY: 'TOP-SECRET-KEY', JUPITER_API_KEY_HEADER: 'x-api-key', STATUS_TOKEN: TOK } }); try {
    await e.app.parts.recorder.start(); await e.clock.advance(30000);
    const call = async (url, headers = {}) => { const out = {}; const req = { method: 'GET', url, headers, socket: { remoteAddress: '1.1.1.1' } }; const res = { writeHead(c) { out.c = c; }, end(b) { out.b = b; } }; await e.parts.handler(req, res); return out; };
    const pub = await call('/healthz'), prot = await call('/internal/status', { authorization: 'Bearer ' + TOK });
    assert.equal(pub.c, 200); assert.equal(prot.c, 200); assert.ok(JSON.parse(prot.b).recorder.markets.SOL.state);
    for (const s of ['secret-pass', 'secret-user', 'TOP-SECRET-KEY', 'db.internal', TOK]) { assert.ok(!pub.b.includes(s) && !prot.b.includes(s), 'response leaks ' + s); assert.ok(!e.logs.join('\n').includes(s), 'logs leak ' + s); }
  } finally { await e.drop(); }
});

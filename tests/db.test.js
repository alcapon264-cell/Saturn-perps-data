/* Real PostgreSQL (psql-driver test harness). Verifies the schema, constraints, store SQL, candle runtime. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, clusterUp } from './helpers/pg-local.js';
import { migrate } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createCandleEngine } from '../src/engine.js';
import { buildCandle } from '../src/candles.js';
import { loadConfig, SOURCE } from '../src/config.js';
import { TF_SEC } from '../src/time.js';

const MIG = [{ name: '001_init.sql', sql: readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8') }];
const cfg = loadConfig({});
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);          /* aligned to every timeframe */
let db, store, now = T0;
const clock = () => now;

before(async () => { db = await createTestDb(); if (!db) return; await migrate(db, MIG); store = createStore(db); await store.ensureMarkets(); });
after(async () => { if (db) await db.drop(); });
const HAVE_PG = clusterUp();
const clean = m => db.sql(`DELETE FROM perps_candles WHERE market='${m}'; DELETE FROM perps_observations WHERE market='${m}';`);
const skip = () => HAVE_PG ? false : 'no local PostgreSQL available';

/* bulk-insert real-looking observations for [fromMs, toMs) at 15 s with a market offset (SQL generate_series; same table the recorder writes) */
const bulk = (market, fromMs, toMs, { offsetSec = 5, every = 1, price = "100 + ((g/15)::bigint % 7)" } = {}) => db.sql(
  `INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) SELECT '${SOURCE}','${market}', to_timestamp(g), to_timestamp(g + 0.25), ${price}, 40
   FROM generate_series(${fromMs / 1000 + offsetSec}, ${toMs / 1000 - 1}, 15) g WHERE ((g/15)::bigint % ${every}) = 0 ON CONFLICT DO NOTHING;`);

test('migrations: apply once, idempotent, checksum-protected, all tables present', { skip: skip() }, async () => {
  assert.deepEqual(await migrate(db, MIG), [], 'second run applies nothing');
  const t = (await db.rows("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")).map(r => r.table_name);
  for (const x of ['perps_meta', 'perps_markets', 'perps_observations', 'perps_rejects', 'perps_candles', 'perps_fetch_log', 'perps_migrations']) assert.ok(t.includes(x), x);
  await assert.rejects(migrate(db, [{ name: '001_init.sql', sql: MIG[0].sql + '\n-- edited' }]), /migration_checksum_mismatch/);
  const d2 = await createTestDb(); try {
    const bad = [{ name: '001_bad.sql', sql: 'CREATE TABLE ok_t(a int); INSERT INTO nope VALUES (1);' }];
    await assert.rejects(migrate(d2, bad)); /* failed migration must leave nothing half-applied */
    assert.equal((await d2.rows("SELECT 1 FROM information_schema.tables WHERE table_name='ok_t'")).length, 0, 'rolled back');
    assert.equal((await d2.rows('SELECT 1 FROM perps_migrations')).length, 0);
  } finally { await d2.drop(); }
});

test('schema: observation constraints (duplicate slot, non-positive price, unknown market)', { skip: skip() }, async () => {
  const o = { market: 'ETH', slotMs: T0, observedMs: T0 + 100, price: 2000, fetchMs: 12 };
  assert.equal(await store.insertObservation(o), true);
  assert.equal(await store.insertObservation({ ...o, observedMs: T0 + 900, price: 2001 }), false, 'duplicate (source,market,slot) is a no-op');
  assert.equal((await db.rows("SELECT price FROM perps_observations WHERE market='ETH' AND slot_ts=to_timestamp(" + T0 / 1000 + ')'))[0].price, 2000, 'first write wins');
  await assert.rejects(store.insertObservation({ ...o, slotMs: T0 + 15000, price: 0 }), /violates check/);
  await assert.rejects(store.insertObservation({ ...o, slotMs: T0 + 15000, price: -3 }), /violates check/);
  await db.sql("INSERT INTO perps_markets(market,mint) VALUES ('SOL','x') ON CONFLICT DO NOTHING;");
  await assert.rejects(db.sql(`INSERT INTO perps_markets(market,mint) VALUES ('DOGE','x');`), /violates check/);
});

test('schema: candle CHECK constraints enforce OHLC integrity at the storage layer', { skip: skip() }, async () => {
  const ins = (o, h, l, c, status = 'complete', valid = true, fin = status === 'complete' ? 'now()' : 'NULL', n = 5, cov = 0.9) =>
    db.sql(`INSERT INTO perps_candles(source,market,tf,bucket_start,o,h,l,c,n_obs,expected_obs,coverage,max_gap_sec,first_obs_at,last_obs_at,status,valid,finalized_at) VALUES ('s','SOL','1m',now() + (random()*1e6 || ' seconds')::interval,${o},${h},${l},${c},${n},4,${cov},10,now(),now(),'${status}',${valid},${fin});`);
  await ins(5, 6, 4, 5);
  await assert.rejects(ins(5, 4.5, 4, 5), /perps_candles_ohlc/, 'high below open');
  await assert.rejects(ins(5, 6, 5.5, 5), /perps_candles_ohlc/, 'low above open');
  await assert.rejects(ins(0, 6, 4, 5), /violates check/, 'zero price');
  await assert.rejects(ins(5, 6, 4, 5, 'forming', true), /perps_candles_valid_needs_complete/, 'forming candle cannot be valid');
  await assert.rejects(ins(5, 6, 4, 5, 'complete', true, 'NULL'), /perps_candles_final/, 'complete needs finalized_at');
  await assert.rejects(ins(5, 6, 4, 5, 'forming', false, 'now()'), /perps_candles_final/, 'forming must not have finalized_at');
  await assert.rejects(ins(5, 6, 4, 5, 'complete', true, 'now()', 0), /violates check/, 'n_obs >= 1');
  await assert.rejects(ins(5, 6, 4, 5, 'complete', true, 'now()', 5, 1.5), /violates check/, 'coverage <= 1');
  await assert.rejects(ins(5, 6, 4, 5, 'complete', true, 'now()', 5, 0), /violates check/, 'coverage > 0');
  await db.sql("DELETE FROM perps_candles WHERE source='s';");
});

test('store: observations range query, last/first, candle upsert immutability', { skip: skip() }, async () => {
  const base = T0 + 10 * HOUR; await bulk('SOL', base, base + 120000);
  const obs = await store.observations('SOL', base, base + 120000);
  assert.equal(obs.length, 8); assert.ok(obs.every((x, i) => i === 0 || x.t > obs[i - 1].t));
  assert.equal(obs[0].t, base + 5250);
  assert.equal((await store.lastObservation('SOL')).t, obs[obs.length - 1].t);
  assert.equal(await store.firstObservationMs('SOL'), obs[0].t);
  assert.equal(await store.firstObservationMs('BTC'), null);
  const k = buildCandle(obs.slice(0, 4), { startMs: base, tf: '1m', intervalSec: 15, nowMs: base + 30000, graceMs: 15000, coverageMin: 0.8 });
  assert.equal(await store.upsertCandle('SOL', k), true);
  assert.equal(await store.upsertCandle('SOL', { ...k, c: k.c, n: 4 }), true, 'forming rows can be refreshed');
  const done = buildCandle(obs.slice(0, 4), { startMs: base, tf: '1m', intervalSec: 15, nowMs: base + 90000, graceMs: 15000, coverageMin: 0.8 });
  assert.equal(await store.upsertCandle('SOL', done), true);
  const tampered = { ...done, h: done.h + 50, c: done.h + 50, valid: false };
  assert.equal(await store.upsertCandle('SOL', tampered), false, 'a COMPLETE candle cannot be rewritten');
  const row = (await store.candles('SOL', '1m', { limit: 5 }))[0]; assert.equal(row.h, done.h); assert.equal(row.status, 'complete');
});

test('store: purge is limited to allow-listed tables and deletes in batches', { skip: skip() }, async () => {
  await assert.rejects(store.purge('perps_candles', 'bucket_start', Date.now()), /purge_target_not_allowed/);
  await assert.rejects(store.purge('perps_observations; DROP TABLE x', 'observed_at', 1), /purge_target_not_allowed/);
  await db.sql(`INSERT INTO perps_fetch_log(market,at,outcome) SELECT 'SOL', to_timestamp(1000+g), 'ok' FROM generate_series(1,25) g;`);
  const n = await store.purge('perps_fetch_log', 'at', 5000 * 1000, 10);
  assert.equal(n, 25); assert.equal((await db.rows("SELECT 1 FROM perps_fetch_log WHERE at < to_timestamp(5000)")).length, 0);
});

test('store: SQL injection strings are inert (parameterised)', { skip: skip() }, async () => {
  await store.insertReject({ market: "SOL'); DROP TABLE perps_candles;--", observedMs: T0, reason: 'malformed', detail: "x'; DELETE FROM perps_observations;--" });
  assert.equal((await db.rows("SELECT count(*)::int AS n FROM perps_observations"))[0].n > 0, true);
  assert.equal((await db.rows("SELECT to_regclass('perps_candles') AS t"))[0].t, 'perps_candles');
  await assert.rejects(store.insertReject({ market: 'SOL', observedMs: T0, reason: 'not_a_reason' }), /violates check/);
});

test('engine: rebuild from observations == independent oracle, for every timeframe; idempotent; complete rows frozen', { skip: skip() }, async () => {
  await clean('ETH');
  const from = T0 + 20 * HOUR, to = from + 9 * HOUR + 40 * 60000;
  await bulk('ETH', from, to);
  now = to + 60000;
  const eng = createCandleEngine({ store, cfg, now: clock, metrics: null });
  const n1 = await eng.recover('ETH'); assert.ok(n1 > 0);
  const snap = await db.rows("SELECT tf, extract(epoch from bucket_start) AS t, o,h,l,c,n_obs,coverage,max_gap_sec,status,valid FROM perps_candles WHERE market='ETH' ORDER BY tf, bucket_start");
  const n2 = await eng.recover('ETH');
  const snap2 = await db.rows("SELECT tf, extract(epoch from bucket_start) AS t, o,h,l,c,n_obs,coverage,max_gap_sec,status,valid FROM perps_candles WHERE market='ETH' ORDER BY tf, bucket_start");
  assert.deepEqual(snap2, snap, 'second recovery changes nothing');
  assert.equal(n2, snap.filter(r => r.status === 'forming').length, 'only still-forming rows are rewritten; complete rows are untouched');
  /* oracle: raw rows pulled by plain SQL, candles computed independently here */
  const raw = (await db.rows(`SELECT extract(epoch from observed_at)*1000 AS t, price FROM perps_observations WHERE market='ETH' AND observed_at >= to_timestamp(${from / 1000}) ORDER BY observed_at`)).map(r => ({ t: Math.round(r.t), p: Number(r.price) }));
  for (const tf of Object.keys(TF_SEC)) {
    const w = TF_SEC[tf] * 1000, buckets = new Map();
    for (const r of raw) { const s = Math.floor(r.t / w) * w; (buckets.get(s) || buckets.set(s, []).get(s)).push(r); }
    const got = snap.filter(r => r.tf === tf);
    assert.equal(got.length, buckets.size, tf + ' candle count');
    for (const g of got) {
      const arr = buckets.get(Math.round(g.t * 1000)); assert.ok(arr, tf + ' bucket exists');
      assert.equal(Number(g.o), arr[0].p); assert.equal(Number(g.c), arr[arr.length - 1].p);
      assert.equal(Number(g.h), Math.max(...arr.map(x => x.p))); assert.equal(Number(g.l), Math.min(...arr.map(x => x.p)));
      assert.equal(g.n_obs, arr.length);
    }
    /* completeness status: buckets whose end+grace has passed are complete, others forming */
    for (const g of got) assert.equal(g.status, Math.round(g.t * 1000) + w + 15000 <= now ? 'complete' : 'forming', tf);
  }
  assert.equal(snap.filter(r => r.tf === '1h' && r.status === 'complete').length >= 9, true);
  /* the first (partial) hour started mid-way -> kept but NOT valid; no filler rows */
  const hours = snap.filter(r => r.tf === '1h' && r.status === 'complete');
  assert.ok(hours.every(r => r.n_obs >= 1)); assert.equal((await db.rows("SELECT 1 FROM perps_candles WHERE n_obs < 1")).length, 0);
});

test('engine: a hole in the data produces a hole in the candles (no fabrication)', { skip: skip() }, async () => {
  const from = T0 + 40 * HOUR; await bulk('BTC', from, from + 6 * HOUR);
  await db.sql(`DELETE FROM perps_observations WHERE market='BTC' AND observed_at >= to_timestamp(${(from + 2 * HOUR) / 1000}) AND observed_at < to_timestamp(${(from + 4 * HOUR) / 1000})`);
  now = from + 7 * HOUR; const eng = createCandleEngine({ store, cfg, now: clock });
  await eng.recover('BTC');
  const h = (await db.rows(`SELECT extract(epoch from bucket_start)*1000 AS s, valid FROM perps_candles WHERE market='BTC' AND tf='1h' ORDER BY bucket_start`)).map(r => Math.round(r.s));
  assert.deepEqual(h, [0, 1, 4, 5].map(i => from + i * HOUR), 'hours 2 and 3 are absent');
  const m = await db.rows(`SELECT 1 FROM perps_candles WHERE market='BTC' AND tf='1m' AND bucket_start >= to_timestamp(${(from + 2 * HOUR) / 1000}) AND bucket_start < to_timestamp(${(from + 4 * HOUR) / 1000})`);
  assert.equal(m.length, 0, 'no 1m candles inside the hole');
  const f4 = await db.rows(`SELECT n_obs, expected_obs, coverage, valid FROM perps_candles WHERE market='BTC' AND tf='4h' AND bucket_start = to_timestamp(${from / 1000})`);
  assert.ok(f4[0].coverage < 0.8 && f4[0].valid === false, '4h candle spanning the hole is kept but marked invalid');
});

test('engine: onObservation keeps forming candles current; finalizeDue closes them after bucket end + grace', { skip: skip() }, async () => {
  const base = T0 + 60 * HOUR; await db.sql("DELETE FROM perps_observations WHERE market='SOL' AND observed_at >= to_timestamp(" + base / 1000 + ')');
  const events = []; const eng = createCandleEngine({ store, cfg, now: clock, onCandle: (m, k) => events.push([k.tf, k.status]) });
  for (let i = 0; i < 4; i++) { const t = base + 5000 + i * 15000; now = t + 300; await store.insertObservation({ market: 'SOL', slotMs: base + i * 15000, observedMs: t, price: 100 + i, fetchMs: 10 }); await eng.onObservation('SOL', t); }
  const f = await store.candles('SOL', '1m', { limit: 5, beforeMs: base + 120000, includeForming: true });
  const last = f[f.length - 1]; assert.equal(last.status, 'forming'); assert.equal(last.n, 4); assert.equal(last.c, 103);
  assert.equal(events.filter(e => e[0] === '1m').length, 4); assert.ok(events.every(e => e[1] === 'forming'));
  now = base + 60000 + 14999; assert.equal(await eng.finalizeDue('SOL') >= 0, true);
  assert.equal((await store.candles('SOL', '1m', { limit: 5, beforeMs: base + 120000, includeForming: true })).pop().status, 'forming', 'still inside the grace window');
  now = base + 60000 + 15000; await eng.finalizeDue('SOL');
  const fin = (await store.candles('SOL', '1m', { limit: 5, beforeMs: base + 120000 })).pop();
  assert.equal(fin.status, 'complete'); assert.equal(fin.c, 103); assert.ok(events.some(e => e[0] === '1m' && e[1] === 'complete'));
});

test('leader lock: second session cannot take it; released/killed lock can be re-acquired', { skip: skip() }, async () => {
  const d1 = await createTestDb({ name: db.dbName + '_l' }); try {
    assert.equal(await d1.tryLeaderLock(), true);
    const s = d1.session(); assert.equal(await s.run('SELECT pg_try_advisory_lock(7351001);'), 'f', 'a second connection is refused'); s.end();
    assert.equal(await d1.leaderAlive(), true);
    d1.killLeaderSession(); await new Promise(r => setTimeout(r, 100)); assert.equal(await d1.leaderAlive(), false);
    assert.equal(await d1.tryLeaderLock(), true, 'lock is free again after the holder died');
  } finally { await d1.drop(); }
});

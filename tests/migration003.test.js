/* r120 migration 003 (view-only markets): additive, transactional, checksum-protected, preserves every SOL/ETH/BTC row, isolates view data,
 * fails atomically, and the operator rollback removes ONLY the 003 tables (after archiving them).
 * [REAL PostgreSQL 16 on a throw-away test database; no network; nothing here touches any production database] */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clusterUp, createTestDb } from './helpers/pg-local.js';
import { migrate } from '../src/db.js';
import { createStore } from '../src/store.js';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const rd = n => ({ name: n, sql: readFileSync(new URL('../migrations/' + n, import.meta.url), 'utf8') });
const M12 = [rd('001_init.sql'), rd('002_exec_idempotency.sql')], M3 = rd('003_view_only_markets.sql');
const ROLLBACK = readFileSync(new URL('../ops/003_rollback.sql', import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const CORE = ['perps_meta', 'perps_markets', 'perps_observations', 'perps_rejects', 'perps_candles', 'perps_fetch_log', 'perps_exec_requests', 'perps_migrations'];

/* md5 of every row of every pre-existing table, ordered: any rewrite, delete or insert changes it */
async function fingerprint(db) {
  const out = {};
  for (const t of CORE) { const r = await db.rows(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM ${t} x`); out[t] = r[0]; }
  out.__columns = (await db.rows("SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable, ',' ORDER BY table_name, column_name)) AS h FROM information_schema.columns WHERE table_name = ANY(ARRAY['" + CORE.join("','") + "'])"))[0].h;
  out.__constraints = (await db.rows("SELECT md5(string_agg(conname||':'||pg_get_constraintdef(oid), ',' ORDER BY conname)) AS h FROM pg_constraint WHERE conrelid::regclass::text = ANY(ARRAY['" + CORE.join("','") + "'])"))[0].h;
  return out;
}
async function seedCore(db) {
  const s = createStore(db); await s.ensureMarkets();
  for (const [m, p] of [['SOL', 150], ['ETH', 3000], ['BTC', 90000]]) for (let i = 0; i < 40; i++) await s.insertObservation({ market: m, slotMs: T0 + i * 15000, observedMs: T0 + i * 15000 + 250, price: p + (i % 5), fetchMs: 40 });
  await db.sql(`INSERT INTO perps_candles(source,market,tf,bucket_start,o,h,l,c,n_obs,expected_obs,coverage,max_gap_sec,first_obs_at,last_obs_at,status,valid,finalized_at)
    VALUES ('jupiter-perps:market-stats','SOL','1m',to_timestamp(${T0 / 1000}),150,154,150,153,4,4,1,15,to_timestamp(${T0 / 1000}),to_timestamp(${T0 / 1000 + 45}),'complete',true,now())`);
  await s.insertReject({ market: 'ETH', observedMs: T0, reason: 'malformed', detail: 'seed' });
  await s.insertFetchLog({ market: 'BTC', atMs: T0, outcome: 'ok', status: 200, ms: 40 });
  await s.setMeta('seed', 'x');
}

test('003 is additive: every SOL/ETH/BTC row, column and constraint is byte-identical after it; it applies once and is checksum-protected', opts, async () => {
  const db = await createTestDb(); try {
    await migrate(db, M12); await seedCore(db);
    const before = await fingerprint(db);
    assert.deepEqual(await migrate(db, [...M12, M3]), ['003_view_only_markets.sql']);
    const after = await fingerprint(db);
    for (const t of CORE.filter(t => t !== 'perps_migrations')) assert.deepEqual(after[t], before[t], t + ' unchanged');
    assert.equal(after.perps_migrations.n, before.perps_migrations.n + 1, 'exactly one new migration record');
    assert.equal(after.__columns, before.__columns, 'no existing column changed'); assert.equal(after.__constraints, before.__constraints, 'no existing constraint changed');
    const t = (await db.rows("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'perps_view_%' ORDER BY 1")).map(r => r.table_name);
    assert.deepEqual(t, ['perps_view_candles', 'perps_view_markets', 'perps_view_observations', 'perps_view_rejects']);
    assert.deepEqual(await migrate(db, [...M12, M3]), [], 'second run applies nothing');
    await assert.rejects(migrate(db, [...M12, { name: M3.name, sql: M3.sql + '\n-- edited' }]), /migration_checksum_mismatch/, 'an edited 003 is refused');
    assert.deepEqual((await fingerprint(db)).perps_observations, before.perps_observations);
  } finally { await db.drop(); }
});

test('003 isolation constraints: SOL/ETH/BTC can never be view markets; view rows need a verified market, a positive price and the Hyperliquid source tag', opts, async () => {
  const db = await createTestDb(); try {
    await migrate(db, [...M12, M3]);
    const t = T0 / 1000;
    for (const m of ['SOL', 'ETH', 'BTC']) await assert.rejects(db.sql(`INSERT INTO perps_view_markets(market,venue_coin,coingecko_id,verified_at) VALUES ('${m}','${m}','x-${m.toLowerCase()}',now())`), undefined, m + ' refused');
    await assert.rejects(db.sql(`INSERT INTO perps_view_markets(market,source,venue_coin,coingecko_id,verified_at) VALUES ('HYPE','jupiter-perps:market-stats','HYPE','hyperliquid',now())`), undefined, 'only the Hyperliquid source tag');
    await assert.rejects(db.sql(`INSERT INTO perps_view_markets(market,venue_coin,coingecko_id) VALUES ('HYPE','HYPE','hyperliquid')`), undefined, 'verified_at is required');
    await db.sql(`INSERT INTO perps_view_markets(market,venue_coin,coingecko_id,verified_at) VALUES ('HYPE','HYPE','hyperliquid',now())`);
    await assert.rejects(db.sql(`INSERT INTO perps_view_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('hyperliquid:allMids','ZEC',to_timestamp(${t}),to_timestamp(${t}),1,1)`), undefined, 'unverified market refused');
    await assert.rejects(db.sql(`INSERT INTO perps_view_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('hyperliquid:allMids','HYPE',to_timestamp(${t}),to_timestamp(${t}),0,1)`), undefined, 'non-positive price refused');
    await assert.rejects(db.sql(`INSERT INTO perps_view_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('jupiter-perps:market-stats','HYPE',to_timestamp(${t}),to_timestamp(${t}),1,1)`), undefined, 'Jupiter source tag refused in view tables');
    await assert.rejects(db.sql(`INSERT INTO perps_observations(source,market,slot_ts,observed_at,price,fetch_ms) VALUES ('jupiter-perps:market-stats','HYPE',to_timestamp(${t}),to_timestamp(${t}),1,1)`), undefined, 'a view market can never enter the SOL/ETH/BTC observation table');
    const vs = createStore(db, { tableSet: 'view', source: 'hyperliquid:allMids' });
    assert.ok(await vs.insertObservation({ market: 'HYPE', slotMs: T0, observedMs: T0 + 100, price: 31.5, fetchMs: 20 }));
    assert.equal(await vs.insertObservation({ market: 'HYPE', slotMs: T0, observedMs: T0 + 200, price: 31.6, fetchMs: 20 }), false, 'duplicate slot');
    await vs.insertFetchLog({ market: 'HYPE', atMs: T0, outcome: 'ok', status: 200, ms: 20 });
    assert.equal((await db.rows('SELECT 1 FROM perps_fetch_log')).length, 0, 'view fetches never enter the SOL/ETH/BTC fetch log');
    assert.equal((await db.rows('SELECT 1 FROM perps_observations')).length, 0, 'view prices never enter the SOL/ETH/BTC observations');
    assert.equal((await createStore(db).lastObservation('HYPE')), null, 'the default (SOL/ETH/BTC) store cannot see view rows');
  } finally { await db.drop(); }
});

test('003 failure handling: a migration that fails part-way leaves no 003 table and no record (transaction rolled back), and existing data is intact', opts, async () => {
  const db = await createTestDb(); try {
    await migrate(db, M12); await seedCore(db); const before = await fingerprint(db);
    const broken = { name: M3.name, sql: M3.sql + '\nINSERT INTO perps_view_markets(market) VALUES (NULL);' };
    await assert.rejects(migrate(db, [...M12, broken]));
    assert.equal((await db.rows("SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'perps_view_%'")).length, 0, 'nothing half-applied');
    assert.equal((await db.rows("SELECT 1 FROM perps_migrations WHERE name='003_view_only_markets.sql'")).length, 0);
    assert.deepEqual(await fingerprint(db), before, 'existing data untouched by the failed attempt');
    assert.deepEqual(await migrate(db, [...M12, M3]), ['003_view_only_markets.sql'], 'the real 003 then applies cleanly');
  } finally { await db.drop(); }
});

test('003 operator rollback (ops/003_rollback.sql): archives view data, removes ONLY the 003 tables and record, SOL/ETH/BTC untouched, 003 can be re-applied', opts, async () => {
  const db = await createTestDb(); try {
    await migrate(db, M12); await seedCore(db); const before = await fingerprint(db);
    await migrate(db, [...M12, M3]);
    await db.sql(`INSERT INTO perps_view_markets(market,venue_coin,coingecko_id,verified_at) VALUES ('NEAR','NEAR','near',now())`);
    await createStore(db, { tableSet: 'view', source: 'hyperliquid:allMids' }).insertObservation({ market: 'NEAR', slotMs: T0, observedMs: T0 + 1, price: 2.5, fetchMs: 9 });
    await db.sql(ROLLBACK);
    assert.equal((await db.rows("SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'perps_view_%'")).length, 0);
    assert.equal((await db.rows('SELECT 1 FROM archive_perps_view_observations')).length, 1, 'view data archived, not lost');
    assert.deepEqual(await fingerprint(db), before, 'SOL/ETH/BTC tables identical to before 003 (including the migrations ledger)');
    assert.deepEqual(await migrate(db, [...M12, M3]), ['003_view_only_markets.sql'], 're-apply works');
  } finally { await db.drop(); }
});

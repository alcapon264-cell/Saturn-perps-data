/* All SQL lives here. Parameterised only. Timestamps cross the boundary as epoch milliseconds (numbers) and are returned as epoch ms. */
import { SOURCE, MARKETS } from './config.js';
import { TF_SEC } from './time.js';

const n = x => (x == null ? null : Number(x));
const ts = ms => ms / 1000; /* to_timestamp() takes seconds */

export function createStore(db) {
  return {
    async ensureMarkets() {
      for (const [m, mint] of Object.entries(MARKETS)) await db.query('INSERT INTO perps_markets(market, mint) VALUES ($1,$2) ON CONFLICT (market) DO UPDATE SET mint = EXCLUDED.mint', [m, mint]);
    },
    /* -> true when a NEW row was written; false for a duplicate slot */
    async insertObservation({ market, slotMs, observedMs, price, fetchMs, sourceMs = null }) {
      const r = await db.query(
        'INSERT INTO perps_observations(source, market, slot_ts, observed_at, price, fetch_ms, source_ts) VALUES ($1,$2,to_timestamp($3),to_timestamp($4),$5,$6,CASE WHEN $7::float8 IS NULL THEN NULL ELSE to_timestamp($7::float8) END) ON CONFLICT (source, market, slot_ts) DO NOTHING RETURNING id',
        [SOURCE, market, ts(slotMs), ts(observedMs), String(price), Math.max(0, Math.round(fetchMs)), sourceMs == null ? null : ts(sourceMs)]);
      return r.rows.length === 1;
    },
    async insertReject({ market, observedMs, reason, detail = null }) {
      await db.query('INSERT INTO perps_rejects(source, market, observed_at, reason, detail) VALUES ($1,$2,to_timestamp($3),$4,$5)', [SOURCE, market, ts(observedMs), reason, detail == null ? null : String(detail).slice(0, 500)]);
    },
    async insertFetchLog({ market, atMs, outcome, status = null, ms = null }) {
      await db.query('INSERT INTO perps_fetch_log(market, at, outcome, http_status, ms) VALUES ($1,to_timestamp($2),$3,$4,$5)', [market, ts(atMs), outcome, status, ms == null ? null : Math.round(ms)]);
    },
    async lastObservation(market) {
      const r = await db.query('SELECT extract(epoch from observed_at)*1000 AS t, price FROM perps_observations WHERE source=$1 AND market=$2 ORDER BY observed_at DESC LIMIT 1', [SOURCE, market]);
      return r.rows[0] ? { t: n(r.rows[0].t), price: n(r.rows[0].price) } : null;
    },
    async firstObservationMs(market) {
      const r = await db.query('SELECT extract(epoch from min(observed_at))*1000 AS t FROM perps_observations WHERE source=$1 AND market=$2', [SOURCE, market]);
      return r.rows[0] && r.rows[0].t != null ? n(r.rows[0].t) : null;
    },
    /* observations in [fromMs, toMs) ascending */
    async observations(market, fromMs, toMs) {
      const r = await db.query('SELECT extract(epoch from observed_at)*1000 AS t, price FROM perps_observations WHERE source=$1 AND market=$2 AND observed_at >= to_timestamp($3) AND observed_at < to_timestamp($4) ORDER BY observed_at ASC', [SOURCE, market, ts(fromMs), ts(toMs)]);
      return r.rows.map(x => ({ t: Math.round(n(x.t)), price: n(x.price) }));
    },
    /* Insert or refresh a candle. A COMPLETE row is immutable at the SQL level (the WHERE on the update). */
    async upsertCandle(market, k) {
      const complete = k.status === 'complete';
      const r = await db.query(
        `INSERT INTO perps_candles(source, market, tf, bucket_start, o, h, l, c, n_obs, expected_obs, coverage, max_gap_sec, first_obs_at, last_obs_at, status, valid, finalized_at)
         VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12,to_timestamp($13),to_timestamp($14),$15,$16,${complete ? 'now()' : 'NULL'})
         ON CONFLICT (source, market, tf, bucket_start) DO UPDATE SET o=EXCLUDED.o, h=EXCLUDED.h, l=EXCLUDED.l, c=EXCLUDED.c, n_obs=EXCLUDED.n_obs, expected_obs=EXCLUDED.expected_obs, coverage=EXCLUDED.coverage, max_gap_sec=EXCLUDED.max_gap_sec, first_obs_at=EXCLUDED.first_obs_at, last_obs_at=EXCLUDED.last_obs_at, status=EXCLUDED.status, valid=EXCLUDED.valid, finalized_at=EXCLUDED.finalized_at
         WHERE perps_candles.status = 'forming' RETURNING 1`,
        [SOURCE, market, k.tf, ts(k.startMs), String(k.o), String(k.h), String(k.l), String(k.c), k.n, k.expected, k.coverage, k.maxGapSec, ts(k.firstObsMs), ts(k.lastObsMs), k.status, k.valid]);
      return r.rows.length === 1;
    },
    async formingCandles(market) {
      const r = await db.query("SELECT tf, extract(epoch from bucket_start)*1000 AS s FROM perps_candles WHERE source=$1 AND market=$2 AND status='forming'", [SOURCE, market]);
      return r.rows.map(x => ({ tf: x.tf, startMs: Math.round(n(x.s)) }));
    },
    async lastCompleteStartMs(market, tf) {
      const r = await db.query("SELECT extract(epoch from max(bucket_start))*1000 AS s FROM perps_candles WHERE source=$1 AND market=$2 AND tf=$3 AND status='complete'", [SOURCE, market, tf]);
      return r.rows[0] && r.rows[0].s != null ? Math.round(n(r.rows[0].s)) : null;
    },
    async candles(market, tf, { limit = 200, beforeMs = null, includeForming = false }) {
      const r = await db.query(
        `SELECT extract(epoch from bucket_start) AS t, o, h, l, c, n_obs, coverage, max_gap_sec, status, valid FROM perps_candles
         WHERE source=$1 AND market=$2 AND tf=$3 AND ($4::float8 IS NULL OR bucket_start < to_timestamp($4::float8)) AND ($5::boolean OR status='complete')
         ORDER BY bucket_start DESC LIMIT $6`, [SOURCE, market, tf, beforeMs == null ? null : ts(beforeMs), !!includeForming, limit]);
      return r.rows.reverse().map(x => ({ t: Math.round(n(x.t)), o: n(x.o), h: n(x.h), l: n(x.l), c: n(x.c), n: x.n_obs, coverage: +Number(x.coverage).toFixed(4), maxGapSec: x.max_gap_sec, status: x.status, valid: !!x.valid }));
    },
    async validCount(market, tf) {
      const r = await db.query("SELECT count(*) AS k FROM perps_candles WHERE source=$1 AND market=$2 AND tf=$3 AND status='complete' AND valid", [SOURCE, market, tf]);
      return Number(r.rows[0].k);
    },
    async getMeta(key) { const r = await db.query('SELECT value FROM perps_meta WHERE key=$1', [key]); return r.rows[0] ? r.rows[0].value : null; },
    async setMeta(key, value) { await db.query('INSERT INTO perps_meta(key,value,updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [key, String(value)]); },
    /* batched deletes so retention never holds long locks */
    async purge(table, col, olderThanMs, batch = 5000) {
      if (!['perps_observations:observed_at', 'perps_rejects:observed_at', 'perps_fetch_log:at'].includes(table + ':' + col)) throw new Error('purge_target_not_allowed');
      let total = 0;
      for (;;) {
        const r = await db.query(`WITH d AS (SELECT id FROM ${table} WHERE ${col} < to_timestamp($1) ORDER BY id LIMIT $2) DELETE FROM ${table} t USING d WHERE t.id = d.id RETURNING 1`, [ts(olderThanMs), batch]);
        total += r.rows.length; if (r.rows.length < batch) break;
      }
      return total;
    },
    async ping() { const r = await db.query('SELECT 1 AS ok'); return r.rows.length === 1; },
    /* ---- gateway idempotency (migration 002). claimExec -> true only for the FIRST request with this signature. ---- */
    async claimExec({ signature, wallet, action, msgHash }) {
      const r = await db.query("INSERT INTO perps_exec_requests(signature, wallet, action, msg_hash, state) VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (signature) DO NOTHING RETURNING signature", [signature, wallet, action, msgHash]);
      return r.rows.length === 1;
    },
    async getExec(signature) {
      const r = await db.query('SELECT signature, wallet, action, msg_hash, state, upstream_status FROM perps_exec_requests WHERE signature = $1', [signature]);
      return r.rows[0] || null;
    },
    /* state moves only out of 'pending'; a recorded outcome is never overwritten */
    async settleExec(signature, state, upstreamStatus = null) {
      if (!['submitted', 'rejected', 'unknown'].includes(state)) throw new Error('bad_exec_state');
      await db.query("UPDATE perps_exec_requests SET state = $2, upstream_status = $3, updated_at = now() WHERE signature = $1 AND state = 'pending'", [signature, state, upstreamStatus]);
    },
    async purgeExec(olderThanMs) {
      const r = await db.query('DELETE FROM perps_exec_requests WHERE created_at < to_timestamp($1) RETURNING 1', [ts(olderThanMs)]);
      return r.rows.length;
    },
    TF_SEC
  };
}

/* All SQL lives here. Parameterised only. Timestamps cross the boundary as epoch milliseconds (numbers) and are returned as epoch ms. */
import { SOURCE, MARKETS } from './config.js';
import { TF_SEC } from './time.js';

const n = x => (x == null ? null : Number(x));
const ts = ms => ms / 1000; /* to_timestamp() takes seconds */

/* r120: the same SQL can run against the view-only tables (migration 003). Table names come ONLY from this fixed list, never from input.
   Default = today's SOL/ETH/BTC tables and source tag, unchanged. */
const TABLESETS = Object.freeze({
  jlp:  Object.freeze({ obs: 'perps_observations', rej: 'perps_rejects', candles: 'perps_candles', fetchLog: true }),
  view: Object.freeze({ obs: 'perps_view_observations', rej: 'perps_view_rejects', candles: 'perps_view_candles', fetchLog: false })
});
export function createStore(db, { tableSet = 'jlp', source = SOURCE } = {}) {
  const T = TABLESETS[tableSet]; if (!T) throw new Error('unknown_table_set');
  const SRC = source;
  return {
    async ensureMarkets() {
      for (const [m, mint] of Object.entries(MARKETS)) await db.query('INSERT INTO perps_markets(market, mint) VALUES ($1,$2) ON CONFLICT (market) DO UPDATE SET mint = EXCLUDED.mint', [m, mint]);
    },
    /* -> true when a NEW row was written; false for a duplicate slot */
    async insertObservation({ market, slotMs, observedMs, price, fetchMs, sourceMs = null }) {
      const r = await db.query(
        'INSERT INTO ' + T.obs + '(source, market, slot_ts, observed_at, price, fetch_ms, source_ts) VALUES ($1,$2,to_timestamp($3),to_timestamp($4),$5,$6,CASE WHEN $7::float8 IS NULL THEN NULL ELSE to_timestamp($7::float8) END) ON CONFLICT (source, market, slot_ts) DO NOTHING RETURNING id',
        [SRC, market, ts(slotMs), ts(observedMs), String(price), Math.max(0, Math.round(fetchMs)), sourceMs == null ? null : ts(sourceMs)]);
      return r.rows.length === 1;
    },
    async insertReject({ market, observedMs, reason, detail = null }) {
      await db.query('INSERT INTO ' + T.rej + '(source, market, observed_at, reason, detail) VALUES ($1,$2,to_timestamp($3),$4,$5)', [SRC, market, ts(observedMs), reason, detail == null ? null : String(detail).slice(0, 500)]);
    },
    async insertFetchLog({ market, atMs, outcome, status = null, ms = null }) {
      if (!T.fetchLog) return;   /* view-only fetches are counted in metrics only, never mixed into the SOL/ETH/BTC fetch log */
      await db.query('INSERT INTO perps_fetch_log(market, at, outcome, http_status, ms) VALUES ($1,to_timestamp($2),$3,$4,$5)', [market, ts(atMs), outcome, status, ms == null ? null : Math.round(ms)]);
    },
    async lastObservation(market) {
      const r = await db.query('SELECT extract(epoch from observed_at)*1000 AS t, price FROM ' + T.obs + ' WHERE source=$1 AND market=$2 ORDER BY observed_at DESC LIMIT 1', [SRC, market]);
      return r.rows[0] ? { t: n(r.rows[0].t), price: n(r.rows[0].price) } : null;
    },
    /* r126: the single real observation closest to targetMs, within +-tolMs (null if none). Same market, same source, nothing interpolated. */
    async observationNear(market, targetMs, tolMs) {
      const r = await db.query('SELECT extract(epoch from observed_at)*1000 AS t, price FROM ' + T.obs + ' WHERE source=$1 AND market=$2 AND observed_at BETWEEN to_timestamp($3) AND to_timestamp($4) ORDER BY abs(extract(epoch from observed_at) - $5) ASC LIMIT 1', [SRC, market, ts(targetMs - tolMs), ts(targetMs + tolMs), targetMs / 1000]);
      return r.rows[0] ? { t: n(r.rows[0].t), price: n(r.rows[0].price) } : null;
    },
    async firstObservationMs(market) {
      const r = await db.query('SELECT extract(epoch from min(observed_at))*1000 AS t FROM ' + T.obs + ' WHERE source=$1 AND market=$2', [SRC, market]);
      return r.rows[0] && r.rows[0].t != null ? n(r.rows[0].t) : null;
    },
    /* observations in [fromMs, toMs) ascending */
    async observations(market, fromMs, toMs) {
      const r = await db.query('SELECT extract(epoch from observed_at)*1000 AS t, price FROM ' + T.obs + ' WHERE source=$1 AND market=$2 AND observed_at >= to_timestamp($3) AND observed_at < to_timestamp($4) ORDER BY observed_at ASC', [SRC, market, ts(fromMs), ts(toMs)]);
      return r.rows.map(x => ({ t: Math.round(n(x.t)), price: n(x.price) }));
    },
    /* Insert or refresh a candle. A COMPLETE row is immutable at the SQL level (the WHERE on the update). */
    async upsertCandle(market, k) {
      const complete = k.status === 'complete';
      const r = await db.query(
        `INSERT INTO ${T.candles}(source, market, tf, bucket_start, o, h, l, c, n_obs, expected_obs, coverage, max_gap_sec, first_obs_at, last_obs_at, status, valid, finalized_at)
         VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12,to_timestamp($13),to_timestamp($14),$15,$16,${complete ? 'now()' : 'NULL'})
         ON CONFLICT (source, market, tf, bucket_start) DO UPDATE SET o=EXCLUDED.o, h=EXCLUDED.h, l=EXCLUDED.l, c=EXCLUDED.c, n_obs=EXCLUDED.n_obs, expected_obs=EXCLUDED.expected_obs, coverage=EXCLUDED.coverage, max_gap_sec=EXCLUDED.max_gap_sec, first_obs_at=EXCLUDED.first_obs_at, last_obs_at=EXCLUDED.last_obs_at, status=EXCLUDED.status, valid=EXCLUDED.valid, finalized_at=EXCLUDED.finalized_at
         WHERE ${T.candles}.status = 'forming' RETURNING 1`,
        [SRC, market, k.tf, ts(k.startMs), String(k.o), String(k.h), String(k.l), String(k.c), k.n, k.expected, k.coverage, k.maxGapSec, ts(k.firstObsMs), ts(k.lastObsMs), k.status, k.valid]);
      return r.rows.length === 1;
    },
    async formingCandles(market) {
      const r = await db.query("SELECT tf, extract(epoch from bucket_start)*1000 AS s FROM " + T.candles + " WHERE source=$1 AND market=$2 AND status='forming'", [SRC, market]);
      return r.rows.map(x => ({ tf: x.tf, startMs: Math.round(n(x.s)) }));
    },
    async lastCompleteStartMs(market, tf) {
      const r = await db.query("SELECT extract(epoch from max(bucket_start))*1000 AS s FROM " + T.candles + " WHERE source=$1 AND market=$2 AND tf=$3 AND status='complete'", [SRC, market, tf]);
      return r.rows[0] && r.rows[0].s != null ? Math.round(n(r.rows[0].s)) : null;
    },
    async candles(market, tf, { limit = 200, beforeMs = null, includeForming = false }) {
      const r = await db.query(
        `SELECT extract(epoch from bucket_start) AS t, o, h, l, c, n_obs, coverage, max_gap_sec, status, valid FROM ${T.candles}
         WHERE source=$1 AND market=$2 AND tf=$3 AND ($4::float8 IS NULL OR bucket_start < to_timestamp($4::float8)) AND ($5::boolean OR status='complete')
         ORDER BY bucket_start DESC LIMIT $6`, [SRC, market, tf, beforeMs == null ? null : ts(beforeMs), !!includeForming, limit]);
      return r.rows.reverse().map(x => ({ t: Math.round(n(x.t)), o: n(x.o), h: n(x.h), l: n(x.l), c: n(x.c), n: x.n_obs, coverage: +Number(x.coverage).toFixed(4), maxGapSec: x.max_gap_sec, status: x.status, valid: !!x.valid }));
    },
    async validCount(market, tf) {
      const r = await db.query("SELECT count(*) AS k FROM " + T.candles + " WHERE source=$1 AND market=$2 AND tf=$3 AND status='complete' AND valid", [SRC, market, tf]);
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
    /* ---- r128 Hyperliquid relay (migration 004). No signatures, keys or raw IPs are ever stored. ---- */
    async hlClaim(r) {
      const v = [r.id, r.user_addr, r.signer, r.action_type, r.market ?? null, r.asset ?? null, r.is_buy ?? null, r.size ?? null, r.price ?? null, r.reduce_only ?? null, r.tif ?? null, r.cloid ?? null, r.notional_usd ?? null, r.amount_usd ?? null, r.ip_hash ?? null];
      try {
        const x = await db.query("INSERT INTO perps_hl_requests(id,user_addr,signer,action_type,market,asset,is_buy,size,price,reduce_only,tif,cloid,notional_usd,amount_usd,ip_hash,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending') ON CONFLICT (id) DO NOTHING RETURNING id", v);
        if (x.rows.length) return { fresh: true };
        const p = await db.query('SELECT state, reason, response FROM perps_hl_requests WHERE id = $1', [r.id]);
        return { fresh: false, prior: p.rows[0] || { state: 'unknown' } };
      } catch (e) { if (/perps_hl_user_cloid|duplicate key/i.test(String(e && e.message))) return { fresh: true, cloidTaken: true }; throw e; }
    },
    async hlSettle(id, state, { upstream = null, latency = null, reason = null, response = null } = {}) {
      if (!['submitted', 'rejected', 'unknown', 'refused'].includes(state)) throw new Error('bad_hl_state');
      let resp = response == null ? null : JSON.stringify(response); if (resp && resp.length > 3900) resp = null;
      await db.query("UPDATE perps_hl_requests SET state = $2, upstream_status = $3, latency_ms = $4, reason = $5, response = $6::jsonb, updated_at = now() WHERE id = $1 AND state = 'pending'", [id, state, upstream, latency, reason == null ? null : String(reason).slice(0, 200), resp]);
    },
    async hlRecord(r) {
      await db.query("INSERT INTO perps_hl_requests(id,user_addr,signer,action_type,market,state,reason,ip_hash) VALUES ($1,$2,$3,$4,$5,'refused',$6,$7) ON CONFLICT (id) DO NOTHING", [r.id, r.user_addr, r.signer, r.action_type, r.market ?? null, String(r.reason || '').slice(0, 200), r.ip_hash ?? null]);
    },
    /* ---- r129 pending funding transfers (migration 005) ---- */
    async hlFundingAdd({ tx_hash, user_addr, amount_usd }) {
      const r = await db.query("INSERT INTO perps_hl_funding(tx_hash,user_addr,amount_usd,state) VALUES ($1,$2,$3,'pending') ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash", [tx_hash, user_addr, amount_usd]);
      return r.rows.length === 1;
    },
    async hlFundingList(user_addr) {
      const r = await db.query("SELECT tx_hash, amount_usd, state, ledger_hash, extract(epoch from created_at)*1000 AS t FROM perps_hl_funding WHERE user_addr = $1 AND created_at > now() - interval '30 days' ORDER BY created_at", [user_addr]);
      return r.rows.map(x => ({ tx_hash: x.tx_hash, amount: Number(x.amount_usd), state: x.state, ledger_hash: x.ledger_hash, t: Number(x.t) }));
    },
    async hlFundingCredit(tx_hash, ledger_hash) {
      try { const r = await db.query("UPDATE perps_hl_funding SET state = 'credited', ledger_hash = $2, credited_at = now() WHERE tx_hash = $1 AND state = 'pending' RETURNING tx_hash", [tx_hash, ledger_hash]); return r.rows.length === 1; }
      catch (e) { if (/duplicate key/i.test(String(e && e.message))) return false; throw e; }
    },
    async hlPurge(olderThanMs) {
      const r = await db.query('DELETE FROM perps_hl_requests WHERE created_at < to_timestamp($1) RETURNING 1', [ts(olderThanMs)]);
      return r.rows.length;
    },
    async purgeExec(olderThanMs) {
      const r = await db.query('DELETE FROM perps_exec_requests WHERE created_at < to_timestamp($1) RETURNING 1', [ts(olderThanMs)]);
      return r.rows.length;
    },
    TF_SEC
  };
}

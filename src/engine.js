/* Candle runtime: keeps `forming` candles current, finalises closed buckets, and rebuilds from stored observations after a restart.
 * Candles are only ever a function of rows in perps_observations. Complete candles are immutable (enforced in SQL as well). */
import { TFS, TF_SEC, bucketStartMs, bucketEndMs } from './time.js';
import { buildCandle, ohlcOk, groupByBucket } from './candles.js';
import { SOURCE } from './config.js';

export function createCandleEngine({ store, cfg, now = Date.now, metrics, onCandle = () => {} }) {
  const graceMs = cfg.intervalSec * 1000;
  const opts = (startMs, tf, nowMs) => ({ startMs, tf, intervalSec: cfg.intervalSec, nowMs, graceMs, coverageMin: cfg.coverageMin, sourceTag: SOURCE });

  async function write(market, k) {
    if (!ohlcOk(k)) { metrics?.inc('candle_ohlc_rejected'); return false; }
    const wrote = await store.upsertCandle(market, k);
    if (wrote) onCandle(market, k);
    return wrote;
  }

  /* called after a NEW observation was stored */
  async function onObservation(market, observedMs) {
    const t = now();
    for (const tf of TFS) {
      const s = bucketStartMs(observedMs, tf);
      const obs = await store.observations(market, s, bucketEndMs(s, tf));
      const k = buildCandle(obs, opts(s, tf, t));
      if (k) await write(market, k);
    }
  }

  /* finalise every forming candle whose bucket (plus one sample of grace) has elapsed */
  async function finalizeDue(market) {
    const t = now(); let n = 0;
    for (const f of await store.formingCandles(market)) {
      if (t < bucketEndMs(f.startMs, f.tf) + graceMs) continue;
      const obs = await store.observations(market, f.startMs, bucketEndMs(f.startMs, f.tf));
      const k = buildCandle(obs, opts(f.startMs, f.tf, t));
      if (k && k.status === 'complete' && await write(market, k)) n++;
    }
    return n;
  }

  /* Restart recovery: rebuild forming + never-written buckets from stored observations. Idempotent. */
  async function recover(market) {
    const t = now(), floor = t - cfg.retention.observationsDays * 86400000;
    const since = {};
    for (const tf of TFS) { const last = await store.lastCompleteStartMs(market, tf); since[tf] = last == null ? floor : last + TF_SEC[tf] * 1000; }
    const from = Math.max(floor, Math.min(...Object.values(since)));
    const obs = await store.observations(market, from, t + 1);
    let rebuilt = 0;
    for (const tf of TFS) {
      for (const [s, arr] of groupByBucket(obs.filter(o => o.t >= since[tf]), tf)) {
        const k = buildCandle(arr, opts(s, tf, t));
        if (k && await write(market, k)) rebuilt++;
      }
    }
    metrics?.inc('candles_recovered', rebuilt);
    return rebuilt;
  }

  return Object.freeze({ onObservation, finalizeDue, recover });
}

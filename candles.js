/* Candle engine: PURE functions. Candles are derived only from recorded observations; nothing is interpolated or filled. */
import { TF_SEC, bucketStartMs, bucketEndMs } from './time.js';

/* Validity rule (S0-approved): complete AND coverage >= coverageMin AND maxGap <= max(4*interval, tf/6).
 * At 15 s sampling this is 60 s (1m, 5m), 150 s (15m), 600 s (1h), 2400 s (4h). */
export function maxGapAllowedSec(tf, intervalSec) { return Math.max(4 * intervalSec, TF_SEC[tf] / 6); }

/* obs: [{t: observedAt ms, price: number}] sorted ascending, all inside [startMs, endMs). Returns a candle or null (no observations => no candle). */
export function buildCandle(obs, { startMs, tf, intervalSec, nowMs, graceMs, coverageMin = 0.8, sourceTag }) {
  if (!obs || obs.length === 0) return null;
  const endMs = bucketEndMs(startMs, tf);
  let o = obs[0].price, c = obs[obs.length - 1].price, h = -Infinity, l = Infinity, maxGap = obs[0].t - startMs;
  for (let i = 0; i < obs.length; i++) {
    const p = obs[i].price; if (p > h) h = p; if (p < l) l = p;
    if (i > 0) { const g = obs[i].t - obs[i - 1].t; if (g > maxGap) maxGap = g; }
  }
  const tail = endMs - obs[obs.length - 1].t; if (tail > maxGap) maxGap = tail;
  const expected = Math.max(1, Math.round(TF_SEC[tf] / intervalSec));
  const coverage = Math.min(1, obs.length / expected);
  const closed = nowMs >= endMs + graceMs;
  const maxGapSec = Math.ceil(maxGap / 1000);
  const complete = closed;
  const valid = complete && coverage >= coverageMin && maxGapSec <= maxGapAllowedSec(tf, intervalSec);
  return { tf, startMs, o, h, l, c, n: obs.length, expected, coverage, maxGapSec, firstObsMs: obs[0].t, lastObsMs: obs[obs.length - 1].t, status: complete ? 'complete' : 'forming', valid, sourceTag };
}

/* OHLC integrity check applied before every write. */
export function ohlcOk(k) {
  return [k.o, k.h, k.l, k.c].every(x => Number.isFinite(x) && x > 0) && k.h >= k.o && k.h >= k.c && k.h >= k.l && k.l <= k.o && k.l <= k.c;
}

/* Group ascending observations into buckets for one timeframe. -> Map(startMs -> obs[]) */
export function groupByBucket(obs, tf) {
  const m = new Map();
  for (const x of obs) { const s = bucketStartMs(x.t, tf); let a = m.get(s); if (!a) m.set(s, a = []); a.push(x); }
  return m;
}

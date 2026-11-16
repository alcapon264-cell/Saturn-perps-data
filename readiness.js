/* A.A.I.H. readiness: the most recent `required` hourly buckets must ALL exist, be complete and valid, and the newest must not be stale.
 * The client keeps its own validation (the A.A.I.H. engine's checks are not relaxed); when they disagree the client wins. */
import { TF_SEC } from './time.js';
import { maxGapAllowedSec } from './candles.js';

const HOUR = 3600000;

export async function computeReadiness({ store, cfg, market, now, marketState }) {
  const t = now();
  const required = cfg.readinessRequired;
  const graceMs = cfg.intervalSec * 1000;
  const expectedLatest = Math.floor((t - graceMs) / HOUR) * HOUR - HOUR; /* newest bucket that should be complete by now */
  const windowStart = expectedLatest - (required - 1) * HOUR;
  const first = await store.firstObservationMs(market);
  /* first hour that can possibly be valid: the hour containing the first observation if recording began within the allowed gap of its start, else the next hour */
  const firstHour = first == null ? null : Math.floor(first / HOUR) * HOUR;
  const firstUsable = first == null ? null : (first - firstHour <= maxGapAllowedSec('1h', cfg.intervalSec) * 1000 ? firstHour : firstHour + HOUR);
  const out = { market, tf: '1h', required, validConsecutiveCandles: 0, ready: false, reason: 'no_data', latestCandleAgeSec: null, earliestReadyAt: null, earliestReadyIsEstimate: true };
  if (first == null) return out;
  const rows = await store.completeRange(market, '1h', windowStart, expectedLatest);
  const byStart = new Map(rows.map(r => [r.startMs, r.valid]));
  let consecutive = 0; for (let s = expectedLatest; byStart.get(s) === true; s -= HOUR) consecutive++;
  out.validConsecutiveCandles = consecutive;
  const newest = await store.newestComplete(market, '1h');
  out.latestCandleAgeSec = newest == null ? null : Math.max(0, Math.round((t - newest) / 1000));
  const bad = []; /* buckets in the window that are missing or invalid */
  for (let s = windowStart; s <= expectedLatest; s += HOUR) if (byStart.get(s) !== true) bad.push(s);
  if (marketState === 'down') { out.reason = 'recorder_down'; return out; }
  if (bad.length === 0) {
    const ageMs = t - newest;
    if (ageMs > 2.5 * TF_SEC['1h'] * 1000) { out.reason = 'stale'; return out; }
    out.ready = true; out.reason = 'ready'; return out;
  }
  /* classify why not */
  if (firstUsable > windowStart) {
    out.reason = 'insufficient_history';
    /* estimate: first usable hour plus `required` hours, assuming no further gaps */
    out.earliestReadyAt = Math.round((firstUsable + required * HOUR + graceMs) / 1000);
    return out;
  }
  if (newest == null || t - newest > 2.5 * HOUR) { out.reason = 'stale'; return out; }
  out.reason = 'has_gaps';
  out.earliestReadyAt = Math.round((Math.max(...bad) + (required + 1) * HOUR + graceMs) / 1000);
  return out;
}

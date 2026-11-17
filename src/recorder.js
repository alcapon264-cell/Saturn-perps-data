/* Recorder: samples Jupiter /market-stats per market on a fixed cadence, validates, stores, and announces NEW accepted observations only.
 * It never back-fills: a missed slot stays missed. It never retries in a tight loop: failures back off; a global token bucket caps request rate. */
import { MARKETS, MARKET_KEYS, SOURCE } from './config.js';
import { slotMs, bucketEndMs } from './time.js';
import { parseMarketStats, createJumpFilter, checkPlausible } from './validate.js';

export function createRecorder({ jupiter, store, cfg, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, rand = Math.random, metrics, log = () => {}, onTick = () => {}, onObservationStored = async () => {}, onStateChange = () => {} }) {
  const intervalMs = cfg.intervalSec * 1000;
  const S = Object.fromEntries(MARKET_KEYS.map((m, i) => [m, {
    market: m, idx: i, inFlight: null, failures: 0, rejects: 0, backoffUntil: 0, timer: null, nextAt: 0,
    lastAcceptedMs: null, lastPrice: null, lastAttemptMs: null, lastOutcome: null, lastStatus: null, seq: 0, flat: 0, maxFlat: 0, lastChangeMs: null, lastState: 'no_data',
    filter: createJumpFilter({ jumpPct: cfg.jumpPct, confirm: cfg.jumpConfirm, confirmTolPct: cfg.confirmTolPct })
  }]));
  let maxClock = 0;
  let running = false, tokens = 2, tokenAt = now(), lastRate = {}, dbDegraded = false;
  const queue = []; const QUEUE_MAX = 240;
  let flushing = null;

  const take = () => { const t = now(); tokens = Math.min(2, tokens + (t - tokenAt) / 1000 * cfg.maxRps); tokenAt = t; if (tokens >= 1) { tokens -= 1; return true; } return false; };

  function stateOf(m, t = now()) {
    const s = S[m]; if (s.lastAcceptedMs == null) return 'no_data';
    const age = t - s.lastAcceptedMs;
    if (age <= cfg.staleMult * intervalMs) return 'live';
    return age <= cfg.downSec * 1000 ? 'stale' : 'down';
  }

  function backoff(s, res) {
    const k = s.failures; /* consecutive failures including this one */
    const ladder = Math.min(intervalMs * Math.pow(2, res.outcome === 'http_429' ? k : k - 1), 8 * intervalMs);
    let wait = Math.max(ladder, res.retryAfterMs || 0);
    wait = Math.min(wait, cfg.backoffMaxMs) * (0.9 + rand() * 0.2);
    s.backoffUntil = now() + wait;
    return wait;
  }

  function flushQueue() {
    if (flushing) return flushing;
    flushing = (async () => {
    while (queue.length) {
      const q = queue[0];
      /* an observation whose 1-minute bucket has already been finalised is dropped, so candles stay a pure function of stored rows */
      if (now() >= bucketEndMs(Math.floor(q.observedMs / 60000) * 60000, '1m') + intervalMs) { queue.shift(); metrics?.inc('queue_dropped_late'); continue; }
      let inserted; try { inserted = await store.insertObservation(q); } catch { return false; }
      queue.shift(); metrics?.inc('queue_flushed');
      if (inserted) { try { await onObservationStored(q.market, q.observedMs); } catch { metrics?.inc('candle_update_errors'); } }
    }
    dbDegraded = false; return true;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function runOnce(m) {
    const s = S[m]; if (!running) return;
    { const c = now(); if (c < maxClock - 2000) { metrics?.inc('clock_backwards_skipped'); return; } if (c > maxClock) maxClock = c; }
    if (s.inFlight) { metrics?.inc('slot_skipped_inflight'); return; }
    if (now() < s.backoffUntil) { metrics?.inc('slot_skipped_backoff'); return; }
    if (!take()) { metrics?.inc('slot_skipped_budget'); return; }
    s.inFlight = (async () => {
      const t0 = now(); s.lastAttemptMs = t0;
      const res = await jupiter(MARKETS[m]);
      const observedMs = now();
      if (res.rateHeaders && Object.keys(res.rateHeaders).length) lastRate = { ...lastRate, ...res.rateHeaders, _at: observedMs };
      metrics?.observe('fetch_ms', res.ms);
      store.insertFetchLog({ market: m, atMs: observedMs, outcome: res.ok ? 'ok' : res.outcome, status: res.status ?? null, ms: res.ms }).catch(() => metrics?.inc('fetch_log_errors'));
      s.lastOutcome = res.ok ? 'ok' : res.outcome; s.lastStatus = res.status ?? null;
      if (!res.ok) {
        s.failures++; metrics?.inc('fetch_' + res.outcome);
        if (res.outcome === 'malformed') { s.rejects++; store.insertReject({ market: m, observedMs, reason: 'malformed', detail: res.detail || 'malformed_response' }).catch(() => {}); }
        const wait = backoff(s, res); log('fetch_failed', m, res.outcome, 'backoff_ms=' + Math.round(wait));
        return;
      }
      s.failures = 0;
      const p = parseMarketStats(res.json, { maxPrice: cfg.maxPrice });
      if (!p.ok) { s.rejects++; metrics?.inc('reject_' + p.reason); store.insertReject({ market: m, observedMs, reason: p.reason, detail: p.detail }).catch(() => {}); return; }
      const pl = checkPlausible(p.price, cfg.priceRange && cfg.priceRange[m]);
      if (!pl.ok) { s.rejects++; metrics?.inc('reject_implausible'); store.insertReject({ market: m, observedMs, reason: 'implausible', detail: pl.detail + ' price=' + p.price }).catch(() => {}); return; }
      const j = s.filter.check(p.price, observedMs);
      if (!j.accept) { s.rejects++; metrics?.inc('reject_' + j.reason); store.insertReject({ market: m, observedMs, reason: j.reason, detail: 'price=' + p.price + ' pending=' + j.pending }).catch(() => {}); return; }
      s.rejects = 0;
      const obs = { market: m, slotMs: slotMs(observedMs, cfg.intervalSec), observedMs, price: p.price, fetchMs: res.ms };
      let inserted = null, persisted = true, callbackHandled = false;
      try {
        if (queue.length) {
          /* Never bypass an older queued observation, even when its flush attempt fails. */
          if (queue.length >= QUEUE_MAX) { queue.shift(); metrics?.inc('queue_overflow_dropped'); }
          queue.push(obs);
          const flushed = await flushQueue();
          persisted = flushed && !queue.includes(obs);
          callbackHandled = persisted; /* flushQueue already emitted the candle update */
          inserted = true; /* queued observations remain accepted and are announced as unpersisted */
        } else {
          inserted = await store.insertObservation(obs); dbDegraded = false;
        }
      } catch (e) {
        persisted = false; dbDegraded = true; metrics?.inc('db_write_errors');
        if (queue.length >= QUEUE_MAX) { queue.shift(); metrics?.inc('queue_overflow_dropped'); }
        queue.push(obs); inserted = true;
      }
      if (!inserted) { metrics?.inc('duplicate_slot'); return; }
      const prev = s.lastPrice; s.lastAcceptedMs = observedMs; s.lastPrice = p.price; s.seq++; s.flat = prev === p.price ? s.flat + 1 : 0; if (s.flat > s.maxFlat) s.maxFlat = s.flat; if (prev !== p.price) s.lastChangeMs = observedMs;
      metrics?.inc('observations_accepted');
      onTick({ market: m, price: p.price, observedAt: Math.floor(observedMs / 1000), observedMs, seq: s.seq, persisted });
      if (persisted && !callbackHandled) { try { await onObservationStored(m, observedMs); } catch (e) { metrics?.inc('candle_update_errors'); log('candle_update_failed', m, e && e.message); } }
    })().catch(e => { metrics?.inc('recorder_errors'); log('recorder_error', m, e && e.message); }).finally(() => { s.inFlight = null; checkState(m); });
    return s.inFlight;
  }

  function checkState(m) { const st = stateOf(m); const s = S[m]; if (st !== s.lastState) { const from = s.lastState; s.lastState = st; onStateChange(m, st, from); } }

  function schedule(m) {
    if (!running) return; const s = S[m];
    const t = now(); let next = slotMs(t, cfg.intervalSec) + Math.floor(s.idx * intervalMs / MARKET_KEYS.length);
    while (next <= t) next += intervalMs;
    s.nextAt = next;
    s.timer = setTimeoutImpl(() => { s.timer = null; if (!running) return; runOnce(m); schedule(m); }, next - t);
    s.timer?.unref?.();
  }

  /* Seed memory from the last stored observation so state/age are truthful after a restart. */
  async function seed() {
    for (const m of MARKET_KEYS) {
      const last = await store.lastObservation(m).catch(() => null); if (!last) continue;
      const s = S[m]; s.lastAcceptedMs = last.t; s.lastPrice = last.price;
      if (now() - last.t <= 10 * 60 * 1000) s.filter.seed(last.price, last.t); /* an old baseline is not trusted for the jump filter */
      s.lastState = stateOf(m);
    }
  }

  async function start() { if (running) return; await seed(); running = true; for (const m of MARKET_KEYS) schedule(m); }
  async function stop() {
    running = false;
    for (const m of MARKET_KEYS) { const s = S[m]; if (s.timer) { clearTimeoutImpl(s.timer); s.timer = null; } }
    await Promise.allSettled(MARKET_KEYS.map(m => S[m].inFlight));
  }
  const summary = () => ({
    running, intervalSec: cfg.intervalSec, dbDegraded, queued: queue.length, rateHeaders: lastRate,
    markets: Object.fromEntries(MARKET_KEYS.map(m => { const s = S[m], t = now(); return [m, {
      state: stateOf(m, t), lastObservationAt: s.lastAcceptedMs == null ? null : Math.floor(s.lastAcceptedMs / 1000), ageMs: s.lastAcceptedMs == null ? null : t - s.lastAcceptedMs,
      price: s.lastPrice, consecutiveFailures: s.failures, consecutiveRejects: s.rejects, circuitOpen: s.failures >= 5, suspectFlat: s.flat >= 20, unchangedRun: s.flat, maxUnchangedRun: s.maxFlat, lastPriceChangeAt: s.lastChangeMs == null ? null : Math.floor(s.lastChangeMs / 1000),
      lastOutcome: s.lastOutcome, lastHttpStatus: s.lastStatus, backoffMs: Math.max(0, s.backoffUntil - t), seq: s.seq, jumpPending: s.filter.pendingCount }]; }))
  });
  return Object.freeze({ start, stop, runOnce, summary, stateOf, checkState, flushQueue, seed, get running() { return running; }, _S: S, _queue: queue, SOURCE });
}

/* Wiring. Everything environment-specific is injected so the whole service runs offline in tests. */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { MARKET_KEYS, SOURCE } from './config.js';
import { createMetrics } from './metrics.js';
import { createLimiter, clientIp } from './limits.js';
import { createStore } from './store.js';
import { createJupiterClient } from './jupiter.js';
import { createCandleEngine } from './engine.js';
import { createRecorder } from './recorder.js';
import { createHttpHandler } from './http.js';
import { createHub } from './ws.js';
import { computeReadiness } from './readiness.js';
import { migrate } from './db.js';

export function createApp({ cfg, db, readerDb = null, fetchImpl = globalThis.fetch, WebSocketServer, migrationFiles = [], now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, rand = Math.random, taps = {}, log = (...a) => console.log('[saturn-perps-data]', ...a), jupiterBase } = {}) {
  const metrics = createMetrics();
  const store = createStore(db);
  const readStore = createStore(readerDb || db);
  const epoch = randomBytes(6).toString('hex');
  const startedAt = now();
  let shuttingDown = false, ready = false, leader = false, lastInitError = null;

  const jupiter = createJupiterClient({ fetchImpl, timeoutMs: cfg.timeoutMs, now, keyHeader: cfg.jupiterKeyHeader, key: cfg.jupiterKey, metrics, ...(jupiterBase ? { base: jupiterBase } : {}) });
  const hub = createHub({ cfg, now, metrics, epoch, snapshot: m => marketView(m), setIntervalImpl, clearIntervalImpl });
  const engine = createCandleEngine({ store, cfg, now, metrics, onCandle: (m, k) => hub.publishCandle(m, k) });
  const recorder = createRecorder({
    jupiter, store, cfg, now, setTimeoutImpl, clearTimeoutImpl, rand, metrics, log,
    onTick: t => { hub.publishTick(t); taps.tick?.(t); },
    onObservationStored: (m, t) => engine.onObservation(m, t),
    onStateChange: (m, st) => { const age = recorder.summary().markets[m].ageMs; hub.publishStatus(m, st, age); taps.status?.(m, st, age); }
  });

  const stateFromAge = ageMs => ageMs == null ? 'no_data' : ageMs <= cfg.staleMult * cfg.intervalSec * 1000 ? 'live' : ageMs <= cfg.downSec * 1000 ? 'stale' : 'down';
  async function marketView(m) {
    let last; try { last = await readStore.lastObservation(m); } catch (e) { const x = new Error('db_unavailable'); x.dbUnavailable = true; throw x; }
    if (!last) return { market: m, price: null, observedAt: null, ageMs: null, state: 'no_data' };
    const ageMs = Math.max(0, now() - last.t), state = stateFromAge(ageMs);
    return { market: m, price: state === 'down' ? null : last.price, observedAt: Math.floor(last.t / 1000), ageMs, state };
  }
  const marketsView = async () => Promise.all(MARKET_KEYS.map(marketView));

  const limiter = createLimiter({ now });
  const handler = createHttpHandler({
    cfg, store: readStore, limiter, now, metrics, isShuttingDown: () => shuttingDown,
    getMarketsView: marketsView,
    getReadiness: async m => { try { const v = await marketView(m); return await computeReadiness({ store: readStore, cfg, market: m, now, marketState: v.state === 'no_data' ? 'no_data' : v.state }); } catch (e) { if (e && e.dbUnavailable) throw e; const x = new Error('db_unavailable'); x.dbUnavailable = true; throw x; } },
    /* PUBLIC: minimal liveness only. Nothing operational, nothing about markets, queues, thresholds or versions. */
    getHealth: async () => {
      let dbOk = false; try { dbOk = await store.ping(); } catch { dbOk = false; }
      return { ok: dbOk && ready && !shuttingDown, service: 'saturn-perps-data', ready };
    },
    /* PROTECTED (bearer token, disabled when STATUS_TOKEN is unset): the detailed operational view. */
    getStatus: async () => {
      let dbOk = false; try { dbOk = await store.ping(); } catch { dbOk = false; }
      return { ok: dbOk && ready && !shuttingDown, service: 'saturn-perps-data', version: 1, epoch, serverTime: Math.floor(now() / 1000), uptimeSec: Math.floor((now() - startedAt) / 1000), source: SOURCE,
        ready, leader, db: { ok: dbOk }, lastInitError, recorder: recorder.summary(), ws: hub.stats(),
        thresholds: { intervalSec: cfg.intervalSec, coverageMin: cfg.coverageMin, jumpPct: cfg.jumpPct, jumpConfirm: cfg.jumpConfirm, readinessRequired: cfg.readinessRequired }, metrics: metrics.snapshot() };
    }
  });

  const server = http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.ws.maxPayload });
  const ipConns = new Map();
  server.on('upgrade', (req, socket, head) => {
    const ip = clientIp(req, cfg.http.trustedProxyHops), o = req.headers.origin;
    const bad = req.url !== '/perps/live' || (o && !cfg.allowedOrigins.has(o)) || shuttingDown || (ipConns.get(ip) || 0) >= cfg.ws.maxConnPerIp || limiter(ip + '|ws-upgrade', 30);
    if (bad) { metrics.inc('ws_upgrade_refused'); socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, c => {
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
      c.on('close', () => { const n = (ipConns.get(ip) || 1) - 1; n ? ipConns.set(ip, n) : ipConns.delete(ip); });
      hub.attach(c, { ip });
    });
  });

  const timers = [];
  let pending = 0; const waiters = [];
  const done = () => { pending--; if (pending === 0) while (waiters.length) waiters.shift()(); };
  const every = (fn, ms) => { const t = setIntervalImpl(() => { pending++; Promise.resolve().then(fn).catch(e => log('timer_error', e && e.message)).finally(done); }, ms); t.unref?.(); timers.push(t); return t; };
  /* resolves when no background timer job is running (used by tests with a fake clock) */
  const idle = () => new Promise(r => { const chk = () => { const busy = pending > 0 || Object.values(recorder._S).some(s => s.inFlight); if (!busy) r(); else setTimeout(chk, 2); }; chk(); });

  async function becomeLeader() {
    if (!cfg.recorderEnabled) return;
    if (leader) { if (!(await db.leaderAlive())) { leader = false; metrics.inc('leader_lost'); await recorder.stop(); log('leader lock lost; recorder stopped'); } return; }
    if (!(await db.tryLeaderLock())) return;
    leader = true; metrics.inc('leader_acquired');
    for (const m of MARKET_KEYS) { await engine.recover(m); }
    await recorder.start(); log('leader: recorder started');
  }

  async function init() {
    await migrate(db, migrationFiles);
    await store.ensureMarkets();
    await becomeLeader();
    ready = true; lastInitError = null;
  }
  let initTimer = null;
  async function initWithRetry() {
    try { await init(); } catch (e) { lastInitError = String(e && e.message || e).slice(0, 200); metrics.inc('init_errors'); log('init failed, will retry:', lastInitError); if (!shuttingDown) { initTimer = setTimeoutImpl(initWithRetry, 10000); initTimer?.unref?.(); } }
  }

  async function retention() {
    const t = now(), day = Math.floor(t / 86400000);
    if (await store.getMeta('retention_last_day') === String(day)) return;
    const o = await store.purge('perps_observations', 'observed_at', t - cfg.retention.observationsDays * 86400000);
    const r = await store.purge('perps_rejects', 'observed_at', t - cfg.retention.logDays * 86400000);
    const f = await store.purge('perps_fetch_log', 'at', t - cfg.retention.logDays * 86400000);
    await store.setMeta('retention_last_day', day); log('retention', { observations: o, rejects: r, fetchLog: f });
  }

  async function start({ port = cfg.port, host = '0.0.0.0' } = {}) {
    await new Promise(r => server.listen(port, host, r));
    log('listening on ' + server.address().port);
    await initWithRetry();
    every(() => ready && becomeLeader(), 15000);
    every(async () => { if (!leader) return; for (const m of MARKET_KEYS) { await engine.finalizeDue(m); recorder.checkState(m); } }, Math.max(1000, cfg.intervalSec * 1000));
    every(() => hub.heartbeat(), cfg.ws.heartbeatMs);
    every(() => leader && retention(), 3600000);
    return server.address().port;
  }

  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    timers.forEach(t => clearIntervalImpl(t)); if (initTimer) clearTimeoutImpl(initTimer);
    await recorder.stop().catch(() => {});
    hub.closeAll();
    await new Promise(r => server.close(() => r()));
    await db.close().catch(() => {}); if (readerDb) await readerDb.close().catch(() => {});
  }

  return { server, wss, start, shutdown, init, idle, retention, parts: { cfg, db, store, recorder, engine, hub, metrics, limiter, handler }, get leader() { return leader; }, get ready() { return ready; }, becomeLeader };
}

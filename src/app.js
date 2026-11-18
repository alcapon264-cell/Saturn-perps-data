/* Wiring. Everything environment-specific is injected so the whole service runs offline in tests. */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { MARKET_KEYS, MARKETS, MARKET_META, SOURCE, VIEW_SOURCE } from './config.js';
import { createMetrics } from './metrics.js';
import { createLimiter, clientIp } from './limits.js';
import { createStore } from './store.js';
import { createJupiterClient, createJupiterGateway, createTokenIcons } from './jupiter.js';
import { createGateway } from './gateway.js';
import { CUSTODY } from './perps-program.js';
import { createCandleEngine } from './engine.js';
import { createRecorder } from './recorder.js';
import { createHttpHandler } from './http.js';
import { createHub } from './ws.js';
import { migrate } from './db.js';
import { createViewMarkets } from './view.js';
import { toContract } from './markets.js';
import { createHlGateway } from './hl-exec.js';

export function createApp({ cfg, db, readerDb = null, fetchImpl = globalThis.fetch, iconFetchImpl = fetchImpl, viewFetchImpl = fetchImpl, hlFetchImpl = null, WebSocketServer, migrationFiles = [], now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, rand = Math.random, taps = {}, log = (...a) => console.log('[saturn-perps-data]', ...a), jupiterBase } = {}) {
  const metrics = createMetrics();
  const store = createStore(db);
  const readStore = createStore(readerDb || db);
  const epoch = randomBytes(6).toString('hex');
  const startedAt = now();
  let shuttingDown = false, ready = false, leader = false, lastInitError = null;

  const jupiter = createJupiterClient({ fetchImpl, timeoutMs: cfg.timeoutMs, now, keyHeader: cfg.jupiterKeyHeader, key: cfg.jupiterKey, metrics, ...(jupiterBase ? { base: jupiterBase } : {}) });
  /* r120: view-only markets run in their own pipeline (src/view.js); the hub only learns which extra keys may be subscribed and their source tag */
  let view = null;
  const hub = createHub({ cfg, now, metrics, epoch, snapshot: m => view && view.isViewMarket(m) ? viewSnapshot(m) : marketView(m), setIntervalImpl, clearIntervalImpl,
    extraMarkets: () => view ? view.visibleKeys() : [], sourceFor: m => view && view.isViewMarket(m) ? VIEW_SOURCE : SOURCE });
  view = createViewMarkets({ cfg, db, readerDb, fetchImpl: viewFetchImpl, now, setTimeoutImpl, clearTimeoutImpl, rand, metrics, log, hub, coreIconFallback: m => icons.get(MARKET_KEYS.map(k => MARKETS[k])).get(MARKETS[m]) || null });
  async function viewSnapshot(m) { const rows = await view.marketsView(); const r = rows.find(x => x.market === m); return r ? { market: m, price: r.price, observedAt: r.observedAt, ageMs: r.ageMs, state: r.state } : null; }
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
  /* r118: real 24 h statistics from this service's OWN recorded hourly candles (complete AND valid, plus the forming hour).
   * Returned only when at least 20 of the last 24 hours are covered; otherwise null. Nothing is estimated or filled.
   * Volume and open interest are NOT recorded by this service, so they are always null (never invented). */
  const statsCache = new Map();
  async function stats24h(m) {
    const c = statsCache.get(m); if (c && now() - c.at < 60000) return c.v;
    let v = null;
    try {
      const rows = await readStore.candles(m, '1h', { limit: 25, includeForming: true });
      const from = Math.floor(now() / 1000) - 24 * 3600;
      const win = rows.filter(k => k.t >= from - 3600 && (k.status === 'forming' || k.valid));
      if (win.length >= 20) {
        const open = win[0].o, last = win[win.length - 1].c;
        let high = -Infinity, low = Infinity; for (const k of win) { if (k.h > high) high = k.h; if (k.l < low) low = k.l; }
        if (open > 0 && Number.isFinite(high) && Number.isFinite(low)) v = { open, high, low, last, changePct: +((last - open) / open * 100).toFixed(4), hours: win.length, from: win[0].t, basis: 'saturn_sampled_1h' };
      }
      /* r126: when the hourly history has gaps (the free Render plan sleeps when idle), the 24 h change is still computed from two REAL observations:
       * the latest one and the one recorded closest to exactly 24 h earlier (accepted only within +-30 min). High/low need the full hourly history, so they stay null. */
      if (!v) {
        const last = await readStore.lastObservation(m);
        if (last && now() - last.t <= cfg.downSec * 1000) {
          const ref = await readStore.observationNear(m, last.t - 24 * 3600 * 1000, 30 * 60 * 1000);
          if (ref && ref.price > 0) v = { open: ref.price, high: null, low: null, last: last.price, changePct: +((last.price - ref.price) / ref.price * 100).toFixed(4), hours: null, from: Math.floor(ref.t / 1000), basis: 'saturn_observation_24h' };
        }
      }
    } catch { v = null; }
    statsCache.set(m, { at: now(), v }); return v;
  }
  /* r118: the market list is the single source of truth for the app: every market configured here appears automatically.
   * executable = a Jupiter Perps custody account exists for it (perps-program.js CUSTODY); otherwise it is view-only. */
  /* r120: each market's official token icon (Jupiter Tokens API V2, server-side, cached). null when the token has none. */
  const icons = createTokenIcons({ fetchImpl: iconFetchImpl, now, keyHeader: cfg.jupiterKeyHeader, key: cfg.jupiterKey, log });
  /* r120 final: every logo is served from this service's own cache (/v1/perps/logos/<KEY>); the app never loads a third-party image URL */
  const marketsView = async () => { icons.get(MARKET_KEYS.map(m => MARKETS[m])); return Promise.all(MARKET_KEYS.map(async m => ({ icon: (await view.coreLogoUrl(m).catch(() => null)) ? '/v1/perps/logos/' + m : null, ...(await marketView(m)), symbol: m + '-PERP', mint: MARKETS[m], name: (MARKET_META[m] || {}).name || null, category: (MARKET_META[m] || {}).category || null, maxLeverage: (MARKET_META[m] || {}).maxLeverage || null, executable: !!CUSTODY[m], stats24h: await stats24h(m), volume24h: null, openInterest: null }))); };

  const limiter = createLimiter({ now });
  /* Perps gateway: positions via Jupiter, live price from this service's own recorder, execution routes off unless explicitly enabled. Writes (idempotency rows) use the primary role. */
  const gwUpstream = createJupiterGateway({ fetchImpl, now, keyHeader: cfg.jupiterKeyHeader, key: cfg.jupiterKey, ...(jupiterBase ? { base: jupiterBase } : {}) });
  const gateway = cfg.gateway ? createGateway({ cfg, store, upstream: gwUpstream, limiter, now, metrics, getLivePrice: marketView }) : null;
  /* r128: Hyperliquid mainnet relay; its own module, its own table (migration 004). Never touches the Jupiter gateway or the recorder. */
  const hlGateway = cfg.hl ? createHlGateway({ cfg, store, limiter, now, fetchImpl: hlFetchImpl || viewFetchImpl, metrics, log }) : null;
  const handler = createHttpHandler({
    cfg, store: readStore, limiter, now, metrics, gateway, hlGateway, isShuttingDown: () => shuttingDown,
    /* r124: one contract for all 11 markets (src/markets.js) */
    getMarketsView: async () => [...(await marketsView()), ...(await view.marketsView().catch(() => []))].map(toContract).filter(Boolean)
      /* r128: a Hyperliquid market stops being "view only" ONLY when real-money Hyperliquid execution is fully enabled (code + env) AND the market is in
       * HL_VERIFIED_MARKETS. executable stays false: that flag means the Jupiter/Solana path, which these markets never use. */
      .map(r => r.provider === 'hyperliquid' && cfg.hl && cfg.hl.enabled && cfg.hl.verifiedMarkets.includes(r.market) ? { ...r, viewOnly: false } : r),
    view,
    /* PUBLIC: minimal liveness only. Nothing operational, nothing about markets, queues, thresholds or versions. */
    getHealth: async () => {
      let dbOk = false; try { dbOk = await store.ping(); } catch { dbOk = false; }
      return { ok: dbOk && ready && !shuttingDown, service: 'saturn-perps-data', ready };
    },
    /* PROTECTED (bearer token, disabled when STATUS_TOKEN is unset): the detailed operational view. */
    getStatus: async () => {
      let dbOk = false; try { dbOk = await store.ping(); } catch { dbOk = false; }
      return { ok: dbOk && ready && !shuttingDown, service: 'saturn-perps-data', version: 1, commit: cfg.buildCommit || null, epoch, serverTime: Math.floor(now() / 1000), uptimeSec: Math.floor((now() - startedAt) / 1000), source: SOURCE,
        ready, leader, db: { ok: dbOk }, lastInitError, recorder: recorder.summary(), view: { enabled: view.enabled, markets: view.KEYS, verification: view.Q, recorder: view.recorder.summary() }, ws: hub.stats(),
        thresholds: { intervalSec: cfg.intervalSec, coverageMin: cfg.coverageMin, jumpPct: cfg.jumpPct, jumpConfirm: cfg.jumpConfirm }, metrics: metrics.snapshot() };
    }
  });

  const server = http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.ws.maxPayload });
  const ipConns = new Map();
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});   /* a reset during the handshake must not surface as an uncaught 'error' event */
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
  const idle = () => new Promise(r => { const chk = () => { const busy = pending > 0 || Object.values(recorder._S).some(s => s.inFlight) || view.inFlight; if (!busy) r(); else setTimeout(chk, 2); }; chk(); });

  async function becomeLeader() {
    if (!cfg.recorderEnabled) return;
    if (leader) { if (!(await db.leaderAlive())) { leader = false; metrics.inc('leader_lost'); await recorder.stop(); await view.stopLeader().catch(() => {}); log('leader lock lost; recorder stopped'); } return; }
    if (!(await db.tryLeaderLock())) return;
    leader = true; metrics.inc('leader_acquired');
    for (const m of MARKET_KEYS) { await engine.recover(m); }
    await recorder.start(); log('leader: recorder started');
    await view.startLeader().catch(e => log('view: start failed', e && e.message));   /* a view-only failure never affects the SOL/ETH/BTC recorder */
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
    const x = await store.purgeExec(t - 30 * 86400000).catch(() => 0);
    const hx = await store.hlPurge(t - 90 * 86400000).catch(() => 0); if (hx) log('retention hl', hx);
    const vr = await view.retention().catch(() => null); if (vr) log('retention view', vr);
    await store.setMeta('retention_last_day', day); log('retention', { observations: o, rejects: r, fetchLog: f, execRequests: x });
  }

  async function start({ port = cfg.port, host = '0.0.0.0' } = {}) {
    await new Promise(r => server.listen(port, host, r));
    log('listening on ' + server.address().port);
    await initWithRetry();
    every(() => ready && becomeLeader(), 15000);
    every(async () => { if (!leader) return; for (const m of MARKET_KEYS) { await engine.finalizeDue(m); recorder.checkState(m); } }, Math.max(1000, cfg.intervalSec * 1000));
    every(() => leader && view.tick(), Math.max(1000, cfg.intervalSec * 1000));
    every(() => hub.heartbeat(), cfg.ws.heartbeatMs);
    every(() => leader && retention(), 3600000);
    return server.address().port;
  }

  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    timers.forEach(t => clearIntervalImpl(t)); if (initTimer) clearTimeoutImpl(initTimer);
    await recorder.stop().catch(() => {}); await view.stopLeader().catch(() => {});
    hub.closeAll();
    await new Promise(r => server.close(() => r()));
    await db.close().catch(() => {}); if (readerDb) await readerDb.close().catch(() => {});
  }

  return { server, wss, start, shutdown, init, idle, retention, parts: { cfg, db, store, recorder, engine, hub, metrics, limiter, handler, gateway, hlGateway, icons, view }, get leader() { return leader; }, get ready() { return ready; }, becomeLeader };
}

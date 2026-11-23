/* Wiring. Everything environment-specific is injected so the whole service runs offline in tests. */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { MARKET_KEYS, MARKETS, MARKET_META, SOURCE, VIEW_SOURCE, VIEW_MARKET_TABLE } from './config.js';
import { createHlWsFeed } from './hl-ws.js';
import { createTokLive } from './tok-live.js';
import { createTokMeta } from './tok-meta.js';
import { createStocks } from './stocks.js';
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
import { toContract, REGISTRY } from './markets.js';
import { createPythClient } from './pyth.js';
import { createPmData } from './pm-data.js';
import { createPmWalletVerifier } from './pm-wallet.js';
import { createPmTrade } from './pm-trade.js';
import { createHlGateway } from './hl-exec.js';

export function createApp({ cfg, db, readerDb = null, fetchImpl = globalThis.fetch, iconFetchImpl = fetchImpl, viewFetchImpl = fetchImpl, hlFetchImpl = null, pythFetchImpl = null, pmFetchImpl = null, WebSocketServer, WebSocketClient = null, hlWsUrl = undefined, tokLiveUrls = undefined, migrationFiles = [], now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, rand = Math.random, taps = {}, log = (...a) => console.log('[saturn-perps-data]', ...a), jupiterBase } = {}) {
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
  /* r144: Hyperliquid WebSocket feed for the view markets (replaces REST polling that Hyperliquid answers with 429 from Render's shared IP) */
  const hlWs = WebSocketClient && cfg.view && cfg.view.markets.length && process.env.HL_WS !== '0' ? createHlWsFeed({ WebSocketImpl: WebSocketClient, ...(hlWsUrl ? { url: hlWsUrl } : {}), now, setTimeoutImpl, clearTimeoutImpl, setIntervalImpl, clearIntervalImpl, log, metrics,
    sets: [...new Set(cfg.view.markets.map(m => VIEW_MARKET_TABLE[m] && VIEW_MARKET_TABLE[m].dex).filter(d => d != null))].flatMap(dex => {
      /* r183: Hyperliquid streamed contexts (oracle, 24 h change, volume) for only the first ~10 coins of one connection, so every market after
       * that had no price check, no change and no volume. Coins are now spread over several connections of at most 8 each; only the first
       * connection of a market set also carries allMids (the big all-prices message), so the extra connections cost almost nothing. */
      const coins = cfg.view.markets.filter(m => VIEW_MARKET_TABLE[m] && VIEW_MARKET_TABLE[m].dex === dex).flatMap(m => VIEW_MARKET_TABLE[m].venueCoins), out = [];
      for (let i = 0; i < coins.length; i += 8) out.push({ dex, coins: coins.slice(i, i + 8), mids: i === 0 });
      return out; }) }) : null;
  /* r144.3 LIVE PRICES: Hyperliquid's socket pushes every coin's mid price several times a second. The latest one per market is published to the
     app's Perps socket at most once a second (and only when it changed), and /v1/pm/px serves the Up/Down coins. The 15 s recorded samples and
     candles are unchanged; while the live feed is fresh the hub shows the live price instead of the slower sample. Display only — trading
     quotes still come from each venue at order time. */
  const liveLast = new Map(), liveSent = new Map(); let pxLive = { at: 0, m: {} };
  const PX_COINS = Object.freeze({ btc: 'BTC', eth: 'ETH', sol: 'SOL', xrp: 'XRP', doge: 'DOGE', bnb: 'BNB', hype: 'HYPE' });
  if (hlWs) hlWs.onMids((dex, mids, at) => {
    if (dex === '') { const m = {}; for (const [k, c] of Object.entries(PX_COINS)) { const p = Number(mids[c]); if (p > 0 && Number.isFinite(p)) m[k] = p; } pxLive = { at, m }; }
    const inRange = (p, r) => !r || (p >= r[0] && p <= r[1]);
    if (dex === '') for (const m of MARKET_KEYS) { const p = Number(mids[m]); if (p > 0 && Number.isFinite(p) && inRange(p, cfg.priceRange && cfg.priceRange[m])) liveLast.set(m, { price: p, at }); }
    for (const m of (cfg.view ? cfg.view.markets : [])) { const T = VIEW_MARKET_TABLE[m]; if (!T || T.dex !== dex || !view) continue; const q = view.Q[m]; const coin = q && q.coin || T.venueCoins.find(c => mids[c] != null);
      const p = coin ? Number(mids[coin]) : NaN; if (p > 0 && Number.isFinite(p) && inRange(p, T.range)) liveLast.set(m, { price: p, at }); }
  });
  /* r184 diagnostics: every 5 min, what the Hyperliquid socket really delivers (connections, contexts) — visible in Render logs */
  const diagTimer = hlWs ? setIntervalImpl(() => { try { log('hl-ws stats ' + JSON.stringify(hlWs.stats().map(c => [c.dex, c.open ? 1 : 0, c.ctx, c.midsAgeMs == null ? null : Math.round(c.midsAgeMs / 1000), c.lastErr ? String(c.lastErr).slice(0, 40) : null])) + ' ctxOk=' + (view ? view.KEYS.filter(m => view.Q[m] && view.Q[m].ctx && now() - view.Q[m].ctx.at < 180000).length : 0) + '/' + (view ? view.KEYS.length : 0)); } catch {} }, 300000) : null;
  if (diagTimer && diagTimer.unref) diagTimer.unref();
  const liveTimer = hlWs ? setIntervalImpl(() => { const t = now();
    for (const [m, x] of liveLast) { if (t - x.at > 5000) continue; const s = liveSent.get(m); if (s && s.price === x.price) continue;
      if (view && view.isViewMarket(m)) { try { if (!view.quality(m, view.Q[m], view.recorder.summary()).ok) continue; } catch { continue; } }
      liveSent.set(m, { price: x.price, at: x.at }); hub.publishTick({ market: m, price: x.price, observedAt: Math.floor(x.at / 1000) }, { live: true }); metrics.inc('live_ticks'); }
  }, 1000) : null; if (liveTimer && liveTimer.unref) liveTimer.unref();
  const liveFor = m => { const x = liveSent.get(m); return x && now() - x.at <= 5000 ? x : null; };
  /* r180 logo sources for view markets CoinGecko cannot serve us (it answers Render's IP with 429). Fixed in code; nothing comes from a client. */
  const TW = (k, path) => [k, { tw: path }], ETHA = a => 'ethereum/assets/' + a;
  const VIEW_LOGO = Object.freeze(Object.fromEntries([
    TW('DOGE', 'doge/info'), TW('XRP', 'ripple/info'), TW('SUI', 'sui/info'), TW('AVAX', 'avalanchec/info'), TW('LTC', 'litecoin/info'), TW('ADA', 'cardano/info'),
    TW('TRX', 'tron/info'), TW('DOT', 'polkadot/info'), TW('BCH', 'bitcoincash/info'), TW('APT', 'aptos/info'), TW('SEI', 'sei/info'),
    TW('ARB', 'arbitrum/info'), TW('OP', 'optimism/info'),
    TW('LINK', ETHA('0x514910771AF9Ca656af840dff83E8264EcF986CA')), TW('UNI', ETHA('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984')), TW('AAVE', ETHA('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9')),
    TW('ENA', ETHA('0x57e114B691Db790C35207b2e685D4A43181e6061')), TW('ONDO', ETHA('0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3')), TW('WLD', ETHA('0x163f8C2467924be0ae7B5347228CABF260318753')),
    ['WIF', { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' }], ['TRUMP', { mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN' }],
    ['PENGU', { mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv' }], ['FARTCOIN', { mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' }],
    ['PUMP', { mint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn' }], ['TIA', { cr: 'celestia/images/celestia.png' }], ['INJ', { cr: 'injective/images/inj.png' }],
    ...['TSLA', 'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'COIN', 'HOOD', 'PLTR', 'MSTR', 'AMD', 'NFLX'].map(k => [k, { stock: k }])
  ]));
  const ICON_MINTS = [...MARKET_KEYS.map(k => MARKETS[k]), ...Object.values(VIEW_LOGO).filter(f => f.mint).map(f => f.mint)];
  const stocksRef = { v: null };
  view = createViewMarkets({ hlWs, cfg, db, readerDb, fetchImpl: viewFetchImpl, now, setTimeoutImpl, clearTimeoutImpl, rand, metrics, log, hub, coreIconFallback: m => icons.get(ICON_MINTS).get(MARKETS[m]) || null,
    viewIconFallback: m => { const f = VIEW_LOGO[m]; if (!f) return null;
      if (f.mint) return icons.get(ICON_MINTS).get(f.mint) || null;
      if (f.tw) return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/' + f.tw + '/logo.png';
      if (f.cr) return 'https://raw.githubusercontent.com/cosmos/chain-registry/master/' + f.cr;
      if (f.stock) return stocksRef.v ? stocksRef.v.iconFor(f.stock) : null;
      return null; } });
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
  const pyth = createPythClient({ fetchImpl: pythFetchImpl || viewFetchImpl });
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
      /* r135: Saturn has holes (free plan slept) -> the 24 h open/high/low from Pyth's hourly oracle candles (one of Jupiter Perps' oracles), last = Saturn's own price */
      if (!v && pyth) {
        const last = await readStore.lastObservation(m), hour = 3600, end = Math.floor(now() / 1000 / hour) * hour;
        if (last && now() - last.t <= cfg.downSec * 1000) {
          const r = await pyth.history(m, '1h', end - 24 * hour, end - 1).catch(() => null), done = r && r.ok ? r.candles.filter(k => k.t >= end - 24 * hour && k.t < end) : [];
          if (done.length === 24) { const open = done[0].o; let high = Math.max(last.price, ...done.map(k => k.h)), low = Math.min(last.price, ...done.map(k => k.l));
            v = { open, high, low, last: last.price, changePct: +((last.price - open) / open * 100).toFixed(4), hours: 24, from: done[0].t, basis: 'pyth_oracle_1h' }; }
        }
      }
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
  const marketsView = async () => { icons.get(ICON_MINTS);   /* r181: one icon set everywhere, so the view-market mints load too */ return Promise.all(MARKET_KEYS.map(async m => ({ icon: (await view.coreLogoUrl(m).catch(() => null)) ? '/v1/perps/logos/' + m : null, ...(await marketView(m)), symbol: m + '-PERP', mint: MARKETS[m], name: (MARKET_META[m] || {}).name || null, category: (MARKET_META[m] || {}).category || null, maxLeverage: (MARKET_META[m] || {}).maxLeverage || null, executable: !!CUSTODY[m], stats24h: await stats24h(m), volume24h: null, openInterest: null }))); };

  const limiter = createLimiter({ now });
  /* Perps gateway: positions via Jupiter, live price from this service's own recorder, execution routes off unless explicitly enabled. Writes (idempotency rows) use the primary role. */
  const gwUpstream = createJupiterGateway({ fetchImpl, now, keyHeader: cfg.jupiterKeyHeader, key: cfg.jupiterKey, ...(jupiterBase ? { base: jupiterBase } : {}) });
  const gateway = cfg.gateway ? createGateway({ cfg, store, upstream: gwUpstream, limiter, now, metrics, getLivePrice: marketView }) : null;
  /* r128: Hyperliquid mainnet relay; its own module, its own table (migration 004). Never touches the Jupiter gateway or the recorder. */
  const hlGateway = cfg.hl ? createHlGateway({ cfg, store, limiter, now, fetchImpl: hlFetchImpl || viewFetchImpl, metrics, log }) : null;
  /* r132: the TRUE execution status of every market, from this service's own switches + the venue's live metadata (Hyperliquid mainnet discovery,
   * cached 60 s by the relay). executable === execution.ready; a blocker names exactly what is missing. */
  async function executionFor() {
    let disc = null, discErr = null;
    if (hlGateway && cfg.hl && cfg.hl.enabled) { try { disc = new Map((await hlGateway.markets()).map(x => [x.market, x])); } catch (e) { discErr = 'hyperliquid_unreachable'; } }
    const G = cfg.gateway;
    return r => {
      if (r.provider === 'jupiter-perps') {
        const blocker = !CUSTODY[r.market] ? 'no_jupiter_custody' : !G ? 'gateway_not_configured' : !G.executionEnabled ? (G.executionRequested ? 'execution_contract_unverified' : 'PERPS_EXECUTION_ENABLED_off') : null;
        return { ...r, execution: { adapter: 'jupiter-perps-solana', network: 'solana-mainnet', venueAssetId: CUSTODY[r.market] || null, venueCoin: r.market, collateral: 'USDC, SOL, ETH, BTC (Solana)', marginMode: 'isolated', maxLeverage: r.maxLeverage ?? null, ready: !blocker, blocker } };
      }
      const H = cfg.hl, d = disc && disc.get(r.market);
      const blocker = !H || !H.requested ? 'HL_EXECUTION_ENABLED_off' : !H.enabled ? 'HL_EXECUTE_VERIFIED_off' : !H.verifiedMarkets.includes(r.market) ? 'not_in_HL_VERIFIED_MARKETS'
        : discErr || !d ? (discErr || 'hyperliquid_unreachable') : !d.listed ? (d.blocker || 'not_listed_on_hyperliquid') : null;
      return { ...r, maxLeverage: d && d.listed ? d.maxLeverage : r.maxLeverage, venueCoin: d && d.coin || r.venueCoin,
        execution: { adapter: 'hyperliquid-relay', network: 'hyperliquid-mainnet', venueAssetId: d && d.listed ? d.asset : null, venueCoin: d && d.coin || null, collateral: 'USDC (Hyperliquid' + (r.venue === 'hyperliquid:xyz' ? ', Trade.xyz balance' : '') + '; funded from the Saturn Wallet on Arbitrum One)',
          marginMode: d && d.listed ? (d.onlyIsolated ? 'isolated' : 'cross') : null, maxLeverage: d && d.listed ? Math.min(d.maxLeverage, H ? H.maxLeverage : d.maxLeverage) : null, ready: !blocker, blocker } };
    };
  }
  const pmTrade = createPmTrade({ env: cfg.pmEnv || process.env, fetchImpl: pmFetchImpl || viewFetchImpl, limiter, now, metrics, log });   /* r143 Prediction trading support (no orders server-side) */
  const pm = createPmData({ fetchImpl: pmFetchImpl || viewFetchImpl, limiter, now, metrics, log, tradingState: pmTrade });   /* r137 Prediction data */
  const pmWallet = createPmWalletVerifier({ fetchImpl: viewFetchImpl, rpcUrl: cfg.polygonRpcUrl });
  const tokLiveRef = { v: null };
  const stocks = stocksRef.v = createStocks({ fetchImpl: iconFetchImpl, now, keyHeader: cfg.jupiterKeyHeader, key: cfg.jupiterKey, log, setTimeoutImpl, clearTimeoutImpl, setIntervalImpl, clearIntervalImpl });
  const tokMeta = createTokMeta({ fetchImpl: viewFetchImpl, now, tok: () => tokLiveRef.v });
  const handler = createHttpHandler({
    cfg, store: readStore, limiter, now, metrics, gateway, hlGateway, pyth, pm, pmWallet, pmTrade, isShuttingDown: () => shuttingDown,
    livePx: () => (now() - pxLive.at <= 5000 ? { at: pxLive.at, prices: pxLive.m, source: 'hyperliquid:allMids' } : null),
    /* r124: one contract for all 11 markets (src/markets.js) */
    /* r128: a Hyperliquid market stops being "view only" ONLY when real-money Hyperliquid execution is fully enabled (code + env) AND the market is in
     * HL_VERIFIED_MARKETS. r132: every row also carries its computed `execution`; toContract() derives `executable` from it (Hyperliquid) or keeps
     * the custody rule (SOL/ETH/BTC, unchanged), so the published flag is the real readiness of the whole path. */
    getMarketsView: async () => { const ex = await executionFor();
      return [...(await marketsView()), ...(await view.marketsView().catch(() => []))].map(r => r && REGISTRY[r.market] ? ex({ ...r, provider: REGISTRY[r.market].provider, venue: REGISTRY[r.market].venue }) : r).map(toContract).filter(Boolean)
        .map(r => r.provider === 'hyperliquid' && cfg.hl && cfg.hl.enabled && cfg.hl.verifiedMarkets.includes(r.market) ? { ...r, viewOnly: false } : r)
        /* r144.3: a market that has a price gets the live (<= 5 s old) one; a market without a price (unavailable / unverified) stays without */
        .map(r => { const x = r && r.price != null ? liveFor(r.market) : null; return x ? { ...r, price: x.price, observedAt: Math.floor(x.at / 1000), ageMs: Math.max(0, now() - x.at), state: 'live', livePrice: true } : r; }); },
    view,
    /* PUBLIC: minimal liveness only. Nothing operational, nothing about markets, queues, thresholds or versions. */
    getHealth: async () => {
      let dbOk = false; try { dbOk = await store.ping(); } catch { dbOk = false; }
      return { ok: dbOk && ready && !shuttingDown, service: 'saturn-perps-data', ready };
    },
    /* PROTECTED (bearer token, disabled when STATUS_TOKEN is unset): the detailed operational view. */
    stocksApi: async () => { const r = await stocks.get(); return [r.ok ? 200 : 503, r]; },
    tokApi: async (path, q) => {
      const tl = tokLiveRef.v; if (!tl) return [503, { ok: false, error: 'unavailable' }];
      if (path === '/v1/tok/trader') { const w = String(q.get('w') || ''); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return [400, { ok: false, error: 'bad_wallet' }];
        return [200, { ok: true, recording: tl.recording(), since: Math.floor(tl.recSince() / 1000), trades: tl.walletTrades(w) }]; }
      if (path === '/v1/tok/feed') { const kind = String(q.get('kind') || ''); if (kind !== 'new' && kind !== 'hot') return [400, { ok: false, error: 'bad_kind' }];
        const list = tl.feed(kind); let pics = {}; try { pics = (await tokMeta.resolve(list.map(x => x.mint))).meta || {}; } catch {}
        return [200, { ok: true, kind, recording: tl.recording(), at: Math.floor(now() / 1000), tokens: list.map(x => ({ ...x, name: x.name || (pics[x.mint] && pics[x.mint].name) || null, symbol: x.symbol || (pics[x.mint] && pics[x.mint].symbol) || null, image: pics[x.mint] && pics[x.mint].image || null })) }]; }
      if (path === '/v1/tok/candles') { const m = String(q.get('mint') || ''); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) return [400, { ok: false, error: 'bad_mint' }];
        const tf = Number(q.get('tf') || 1); if (![1, 5, 15, 60, 300, 900, 3600].includes(tf)) return [400, { ok: false, error: 'bad_tf' }];
        return [200, { ok: true, mint: m, tf, unit: 'sol', recording: tl.recording(), since: Math.floor(tl.recSince() / 1000), candles: tl.candles(m, tf) }]; }
      const ms = String(q.get('m') || '').split(',').filter(Boolean).slice(0, 50); if (!ms.length) return [400, { ok: false, error: 'no_mints' }];
      return [200, { ok: true, ...(await tokMeta.resolve(ms)) }];
    },
    getStatus: async () => {
      let dbOk = false; try { dbOk = await store.ping(); } catch { dbOk = false; }
      return { ok: dbOk && ready && !shuttingDown, service: 'saturn-perps-data', version: 1, commit: cfg.buildCommit || null, epoch, serverTime: Math.floor(now() / 1000), uptimeSec: Math.floor((now() - startedAt) / 1000), source: SOURCE,
        ready, leader, db: { ok: dbOk }, lastInitError, recorder: recorder.summary(), view: { enabled: view.enabled, markets: view.KEYS, hlWs: hlWs ? hlWs.stats() : null, verification: view.Q, recorder: view.recorder.summary() }, ws: hub.stats(),
        thresholds: { intervalSec: cfg.intervalSec, coverageMin: cfg.coverageMin, jumpPct: cfg.jumpPct, jumpConfirm: cfg.jumpConfirm }, metrics: metrics.snapshot() };
    }
  });

  const server = http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.ws.maxPayload });
  /* r158: Discover token list live prices (src/tok-live.js) on its own path; TOK_LIVE=0 turns it off */
  const tokLive = WebSocketClient && process.env.TOK_LIVE !== '0' ? createTokLive({ WebSocketImpl: WebSocketClient, ...(tokLiveUrls ? { urls: tokLiveUrls } : {}),
    upstreams: String(process.env.TOK_LIVE_UPSTREAMS || 'pumpapi').split(',').map(x => x.trim()), now, setTimeoutImpl, clearTimeoutImpl, setIntervalImpl, clearIntervalImpl, log, metrics, record: process.env.TOK_RECORD !== '0' }) : null;
  tokLiveRef.v = tokLive;
  const tokWss = tokLive ? new WebSocketServer({ noServer: true, maxPayload: 4096 }) : null;
  const stkWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const ipConns = new Map();
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});   /* a reset during the handshake must not surface as an uncaught 'error' event */
    const ip = clientIp(req, cfg.http.trustedProxyHops), o = req.headers.origin;
    const tok = req.url === '/tokens/live' && !!tokWss;
    const stk = req.url === '/stocks/live';
    const bad = (req.url !== '/perps/live' && !tok && !stk) || (o && !cfg.allowedOrigins.has(o)) || shuttingDown || (ipConns.get(ip) || 0) >= cfg.ws.maxConnPerIp || limiter(ip + '|ws-upgrade', 30);
    if (bad) { metrics.inc('ws_upgrade_refused'); socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    (stk ? stkWss : tok ? tokWss : wss).handleUpgrade(req, socket, head, c => {
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
      c.on('close', () => { const n = (ipConns.get(ip) || 1) - 1; n ? ipConns.set(ip, n) : ipConns.delete(ip); });
      if (stk) stocks.attach(c); else if (tok) tokLive.attach(c, { ip }); else hub.attach(c, { ip });
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
    if (hlWs) { hlWs.start(); for (let i = 0; i < 25 && !hlWs.mids(''); i++) await new Promise(r => { const t = setTimeout(r, 200); if (t.unref) t.unref(); }); }   /* real time: this waits for the network, not for the app clock */   /* r144: give the socket up to 5 s so the first price is not a REST call */
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
    if (tokLive) tokLive.start();
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
    await recorder.stop().catch(() => {}); await view.stopLeader().catch(() => {}); try { hlWs && hlWs.stop(); } catch {} try { tokLive && tokLive.stop(); } catch {} try { stocks.stop(); } catch {} if (liveTimer) clearIntervalImpl(liveTimer);
    hub.closeAll();
    await new Promise(r => server.close(() => r()));
    await db.close().catch(() => {}); if (readerDb) await readerDb.close().catch(() => {});
  }

  return { server, wss, start, shutdown, init, idle, retention, parts: { cfg, db, store, recorder, engine, hub, metrics, limiter, handler, gateway, hlGateway, icons, view, pm, hlWs, tokLive }, get leader() { return leader; }, get ready() { return ready; }, becomeLeader };
}

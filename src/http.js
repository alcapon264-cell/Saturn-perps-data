/* HTTP API. Market data routes are GET-only. The only routes that accept POST are the Perps gateway routes under /v1/perps/jup/,
 * which are handled entirely by src/gateway.js (and are disabled unless execution is explicitly enabled). No admin endpoint, no user-supplied host/mint/SQL. */
import { MARKET_KEYS, SOURCE, VIEW_SOURCE } from './config.js';
import { TFS, isTf, TF_SEC } from './time.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clientIp } from './limits.js';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function createHttpHandler({ cfg, store, limiter, now, metrics, getHealth, getStatus, getMarketsView, gateway = null, hlGateway = null, pyth = null, pm = null, pmWallet = null, pmTrade = null, view = null, isShuttingDown = () => false, livePx = null, tokApi = null, stocksApi = null }) {
  const cache = new Map(); /* key -> {at, v} ; plus in-flight de-duplication */
  const inflight = new Map();
  async function cached(key, ttlMs, fn) {
    const t = now(); const c = cache.get(key);
    if (c && t - c.at < ttlMs) return c.v;
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve().then(fn).then(v => { cache.set(key, { at: now(), v }); if (cache.size > 500) cache.delete(cache.keys().next().value); return v; }).finally(() => inflight.delete(key));
    inflight.set(key, p); return p;
  }

  const send = (res, code, obj, extra = {}) => { res.writeHead(code, { ...HEADERS, ...extra }); res.end(JSON.stringify(obj)); };
  const err = (res, code, error, extra) => send(res, code, { ok: false, error }, extra);

  return async function handle(req, res) {
    try {
      metrics?.inc('http_requests');
      const origin = req.headers.origin; const cors = {};
      if (origin) {
        if (!cfg.allowedOrigins.has(origin)) return err(res, 403, 'origin_not_allowed');
        cors['access-control-allow-origin'] = origin; cors.vary = 'Origin';
      }
      let url; try { url = new URL(req.url || '/', 'http://localhost'); } catch { return err(res, 400, 'bad_request', cors); }
      const path = url.pathname, q = url.searchParams;
      const isGw = !!gateway && path.startsWith('/v1/perps/jup/');
      const isHl = !!hlGateway && path.startsWith('/v1/perps/hl/');   /* r128 Hyperliquid relay: src/hl-exec.js */
      const isPmx = !!pmTrade && path.startsWith('/v1/pm/x/');   /* r143 Prediction trading support: src/pm-trade.js (builder signing for wallet setup only; no orders) */
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': isGw || isHl || isPmx ? 'GET, POST, OPTIONS' : 'GET, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600' }); return res.end(); }
      const ip = clientIp(req, cfg.http.trustedProxyHops);
      if (isGw) {
        if (isShuttingDown()) return err(res, 503, 'shutting_down', cors);
        const [code, body, extra] = await gateway.handle(req, path, q, ip);
        return send(res, code, body, { ...cors, ...(extra || {}) });
      }
      if (isHl) {
        if (isShuttingDown()) return err(res, 503, 'shutting_down', cors);
        const [code, body, extra] = await hlGateway.handle(req, path, q, ip);
        return send(res, code, body, { ...cors, ...(extra || {}) });
      }
      if (isPmx) {
        if (isShuttingDown()) return err(res, 503, 'shutting_down', cors);
        const [code, body] = await pmTrade.handle(req, path, q, ip);
        return send(res, code, body, { ...cors, 'cache-control': 'no-store' });
      }
      if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', cors);
      if (path === '/v1/pm/wallet/status') {
        if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', cors);
        if (!pmWallet) return err(res, 503, 'wallet_verifier_unavailable', cors);
        if (limiter(ip + '|pm-wallet-status', 12)) return err(res, 429, 'rate_limited', { ...cors, 'retry-after': '60' });
        if (isShuttingDown()) return err(res, 503, 'shutting_down', cors);
        const result = await pmWallet.verify();
        return send(res, 200, { ok: true, wallet: result }, { ...cors, 'cache-control': 'no-store' });
      }
      /* r144.3 live coin prices for Prediction Up/Down (Hyperliquid mids pushed to this server; <= 5 s old or 503). Tiny, never cached. */
      if (path === '/v1/pm/px') {
        if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', cors);
        if (limiter(ip + '|pm-px', 150)) return err(res, 429, 'rate_limited', cors);
        const v = livePx ? livePx() : null; if (!v) return send(res, 503, { ok: false, error: 'live_prices_unavailable' }, { ...cors, 'cache-control': 'no-store' });
        return send(res, 200, { ok: true, ...v }, { ...cors, 'cache-control': 'no-store' });
      }
      if (pm && path.startsWith('/v1/pm/')) {   /* r137 Saturn Prediction: read-only Polymarket data (src/pm-data.js) */
        if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', cors);
        const [code, body] = await pm.handle(path, q, ip);
        return send(res, code, body, { ...cors, 'cache-control': code === 200 ? 'public, max-age=10' : 'no-store' });
      }

      /* r166 trader activity recorded from the live stream + token names/pictures (src/tok-live.js, src/tok-meta.js). Read-only. */
      if (stocksApi && path === '/v1/stocks') {
        if (limiter(ip + '|stocks', 120)) return err(res, 429, 'rate_limited', { ...cors, 'retry-after': '30' });
        const [code, body] = await stocksApi();
        return send(res, code, body, { ...cors, 'cache-control': code === 200 ? 'public, max-age=10' : 'no-store' });
      }
      if (tokApi && (path === '/v1/tok/trader' || path === '/v1/tok/meta' || path === '/v1/tok/candles' || path === '/v1/tok/feed')) {
        if (limiter(ip + '|tok-api', 120)) return err(res, 429, 'rate_limited', { ...cors, 'retry-after': '30' });
        const [code, body] = await tokApi(path, q);
        return send(res, code, body, { ...cors, 'cache-control': code === 200 ? (path === '/v1/tok/candles' || path === '/v1/tok/feed' ? 'public, max-age=1' : 'public, max-age=5') : 'no-store' });
      }
      if (path === '/healthz' || path === '/') {
        if (limiter(ip + '|health', 120)) return err(res, 429, 'rate_limited', cors);
        return send(res, 200, await getHealth(), cors);
      }
      if (path === '/internal/status') {
        /* Disabled unless STATUS_TOKEN is configured. Never callable from a browser page (no CORS, Origin refused). Constant-time token check. */
        if (!cfg.statusToken) return err(res, 404, 'not_found');
        if (origin) return err(res, 403, 'origin_not_allowed');
        if (limiter(ip + '|status-attempt', 10)) { metrics?.inc('status_rate_limited'); return err(res, 429, 'rate_limited', { 'retry-after': '60' }); }
        const m = /^Bearer (\S{1,512})$/.exec(String(req.headers.authorization || ''));
        const dig = x => createHash('sha256').update(String(x)).digest();
        if (!m || !timingSafeEqual(dig(m[1]), dig(cfg.statusToken))) { metrics?.inc('status_unauthorized'); return err(res, 401, 'unauthorized'); }
        return send(res, 200, await getStatus());
      }
      /* r120: market logos, served from this service's cache (the app never loads logo images from third parties). Fixed key set, GET only. */
      const lm = /^\/v1\/perps\/logos\/([A-Z0-9]{2,12})$/.exec(path);
      if (lm && view) {
        if (isShuttingDown()) return err(res, 503, 'shutting_down', cors);
        if (limiter(ip + '|logos', 240)) return err(res, 429, 'rate_limited', { ...cors, 'retry-after': '30' });
        if (!MARKET_KEYS.includes(lm[1]) && !view.isViewMarket(lm[1])) return err(res, 404, 'not_found', cors);
        const img = await view.logo(lm[1]).catch(() => null);
        if (!img) return err(res, 404, 'no_logo', cors);
        res.writeHead(200, { ...cors, 'content-type': img.type, 'content-length': String(img.bytes.length), 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cross-origin-resource-policy': 'cross-origin' });
        return res.end(Buffer.from(img.bytes));
      }
      const isRead = path === '/v1/perps/markets' || path === '/v1/perps/candles';
      if (!isRead) return err(res, 404, 'not_found', cors);
      if (isShuttingDown()) return err(res, 503, 'shutting_down', cors);
      const max = cfg.http.ipLimitPerMin;
      if (limiter(ip + '|' + path, max)) { metrics?.inc('http_rate_limited'); return err(res, 429, 'rate_limited', { ...cors, 'retry-after': '30' }); }

      if (path === '/v1/perps/markets') {
        const v = await cached('markets', 1000, getMarketsView);
        return send(res, 200, { ok: true, source: SOURCE, timeBasis: 'receive_time', serverTime: Math.floor(now() / 1000), markets: v, build: { commit: cfg.buildCommit || null, viewMarketsConfigured: !!(cfg.view && cfg.view.markets.length), crossCheckConfigured: !!(cfg.view && cfg.view.coingeckoKey) }, ...(v.some(x => x.viewOnly) ? { attribution: { viewOnlyPrices: 'Hyperliquid', crossCheck: 'CoinGecko', text: 'View-only prices from Hyperliquid · checked with CoinGecko' } } : {}) }, cors);
      }

      const market = String(q.get('market') || '').toUpperCase();
      /* r120: a view-only market is read from ITS OWN tables (perps_view_*); SOL/ETH/BTC candles are never mixed with it */
      const isView = !MARKET_KEYS.includes(market) && !!view && (await view.visibleKeys().catch(() => [])).includes(market);
      if (!MARKET_KEYS.includes(market) && !isView) return err(res, 400, 'bad_market', cors);
      const cstore = isView ? view.readStore : store;

      /* /v1/perps/candles */
      const tf = q.get('tf');
      if (!isTf(tf)) return err(res, 400, 'bad_tf', cors);
      let limit = 200; if (q.has('limit')) { const s = q.get('limit'); if (!/^\d{1,3}$/.test(s)) return err(res, 400, 'bad_limit', cors); limit = Number(s); if (limit < 1 || limit > 500) return err(res, 400, 'bad_limit', cors); }
      let beforeMs = null; if (q.has('before')) { const s = q.get('before'); if (!/^\d{1,12}$/.test(s)) return err(res, 400, 'bad_before', cors); beforeMs = Number(s) * 1000; }
      const includeForming = q.get('includeForming') === '1';
      const key = ['c', isView ? 'v' : 'j', market, tf, limit, beforeMs, includeForming].join('|');
      /* r133: a Hyperliquid market's chart comes from Hyperliquid's own candles (continuous, same venue as its price); Saturn's recorded candles
       * are the fallback when Hyperliquid cannot be reached. SOL/ETH/BTC are unchanged. */
      const vc = isView && typeof view.venueCandles === 'function' ? await view.venueCandles(market, tf, { limit, beforeMs, includeForming }).catch(() => null) : null;
      if (vc && vc.length) return send(res, 200, { ok: true, market, tf, source: 'hyperliquid:candleSnapshot', viewOnly: true, basis: 'venue', serverTime: Math.floor(now() / 1000), candles: vc,
        meta: { timeBasis: 'venue_bucket', firstObservationAt: null, validCount: vc.filter(c => c.status === 'complete').length, returned: vc.length } }, cors);
      const data = await cached(key, 2000, async () => {
        try {
          const [candles, first, validCount] = await Promise.all([cstore.candles(market, tf, { limit, beforeMs, includeForming }), cstore.firstObservationMs(market), cstore.validCount(market, tf)]);
          return { candles, first, validCount };
        } catch (e) { e.dbUnavailable = true; throw e; }   /* parameters were validated above, so a failure here is the database */
      });
      /* r135: SOL/ETH/BTC buckets Saturn did not record (free plan asleep) are filled from Pyth's oracle candles (one of Jupiter Perps' own oracles),
       * each labelled src:'pyth'. Saturn's own candles are never replaced. Only inside the requested window, only completed buckets. */
      let candles = data.candles, filled = 0;
      if (!isView && pyth && beforeMs == null) {
        const step = TF_SEC[tf], end = Math.floor(now() / 1000 / step) * step, start = end - limit * step;
        const fill = await cached('pyth|' + market + '|' + tf + '|' + limit + '|' + end, 30000, async () => { const r = await pyth.history(market, tf, start, end - 1).catch(() => null); return r && r.ok ? r.candles : []; }).catch(() => []);
        if (fill.length) {
          const have = new Set(candles.filter(c => c.status === 'complete' || c.status === 'forming').map(c => c.t));
          const add = fill.filter(k => k.t >= start && k.t < end && !have.has(k.t)).map(k => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, n: null, coverage: null, maxGapSec: null, status: 'complete', valid: true, src: 'pyth' }));
          if (add.length) { filled = add.length; candles = [...candles, ...add].sort((a, b) => a.t - b.t); while (candles.length > limit + (includeForming ? 1 : 0)) candles.shift(); }
        }
      }
      return send(res, 200, {
        ok: true, market, tf, source: isView ? VIEW_SOURCE : SOURCE, ...(filled ? { filled: { source: 'pyth-benchmarks', count: filled } } : {}), ...(isView ? { viewOnly: true } : {}), basis: 'sampled', sampleIntervalSec: cfg.intervalSec, serverTime: Math.floor(now() / 1000),
        candles, meta: { timeBasis: 'receive_time', firstObservationAt: data.first == null ? null : Math.floor(data.first / 1000), validCount: data.validCount, returned: candles.length }
      }, cors);
    } catch (e) {
      metrics?.inc('http_errors');
      return err(res, e && e.dbUnavailable ? 503 : 500, e && e.dbUnavailable ? 'db_unavailable' : 'server_error');
    }
  };
}

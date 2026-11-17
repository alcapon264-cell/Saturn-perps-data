/* HTTP API. Market data routes are GET-only. The only routes that accept POST are the Perps gateway routes under /v1/perps/jup/,
 * which are handled entirely by src/gateway.js (and are disabled unless execution is explicitly enabled). No admin endpoint, no user-supplied host/mint/SQL. */
import { MARKET_KEYS, SOURCE, VIEW_SOURCE } from './config.js';
import { TFS, isTf } from './time.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clientIp } from './limits.js';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function createHttpHandler({ cfg, store, limiter, now, metrics, getHealth, getStatus, getMarketsView, gateway = null, view = null, isShuttingDown = () => false }) {
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
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': isGw ? 'GET, POST, OPTIONS' : 'GET, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600' }); return res.end(); }
      const ip = clientIp(req, cfg.http.trustedProxyHops);
      if (isGw) {
        if (isShuttingDown()) return err(res, 503, 'shutting_down', cors);
        const [code, body, extra] = await gateway.handle(req, path, q, ip);
        return send(res, code, body, { ...cors, ...(extra || {}) });
      }
      if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', cors);

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
        return send(res, 200, { ok: true, source: SOURCE, timeBasis: 'receive_time', serverTime: Math.floor(now() / 1000), markets: v, ...(v.some(x => x.viewOnly) ? { attribution: { viewOnlyPrices: 'Hyperliquid', crossCheck: 'CoinGecko', text: 'View-only prices from Hyperliquid · checked with CoinGecko' } } : {}) }, cors);
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
      const data = await cached(key, 2000, async () => {
        try {
          const [candles, first, validCount] = await Promise.all([cstore.candles(market, tf, { limit, beforeMs, includeForming }), cstore.firstObservationMs(market), cstore.validCount(market, tf)]);
          return { candles, first, validCount };
        } catch (e) { e.dbUnavailable = true; throw e; }   /* parameters were validated above, so a failure here is the database */
      });
      return send(res, 200, {
        ok: true, market, tf, source: isView ? VIEW_SOURCE : SOURCE, ...(isView ? { viewOnly: true } : {}), basis: 'sampled', sampleIntervalSec: cfg.intervalSec, serverTime: Math.floor(now() / 1000),
        candles: data.candles, meta: { timeBasis: 'receive_time', firstObservationAt: data.first == null ? null : Math.floor(data.first / 1000), validCount: data.validCount, returned: data.candles.length }
      }, cors);
    } catch (e) {
      metrics?.inc('http_errors');
      return err(res, e && e.dbUnavailable ? 503 : 500, e && e.dbUnavailable ? 'db_unavailable' : 'server_error');
    }
  };
}

/* r120 FREE data sources for VIEW-ONLY markets. Read-only. Fixed hosts and paths, no cookies, no redirects, bounded bodies, hard deadlines.
 *   Hyperliquid public info API  POST https://api.hyperliquid.xyz/info  {"type":"meta"} | {"type":"allMids"}   (no key, no cost)
 *   CoinGecko Demo API           GET  https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=...  (free key, header only)
 *   Logo images                  GET  from a fixed allow-list of image hosts (CoinGecko image CDN, Jupiter, the Solana token list)
 * Nothing here can sign, trade or reach any execution endpoint. Keys are sent in a header only and never appear in URLs, logs or responses. */

export const HL_HOST = 'api.hyperliquid.xyz';
export const HL_BASE = 'https://api.hyperliquid.xyz';
export const CG_HOST = 'api.coingecko.com';
export const CG_BASE = 'https://api.coingecko.com/api/v3';
export const LOGO_HOSTS = Object.freeze(['coin-images.coingecko.com', 'assets.coingecko.com', 'static.jup.ag', 'raw.githubusercontent.com']);
const DEC = /^\d{1,15}(\.\d{1,18})?$/;

async function bounded(fetchImpl, url, init, { timeoutMs, maxBody, binary = false }) {
  const ac = new AbortController(); let timer;
  const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error('deadline'), { deadline: true })); }, timeoutMs); }); deadline.catch(() => {});
  const within = p => Promise.race([p, deadline]);
  const t0 = Date.now();
  try {
    const res = await within(fetchImpl(url, { ...init, signal: ac.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }));
    const status = res.status; const hget = k => (res.headers && res.headers.get ? res.headers.get(k) : null);
    if (status === 429) return { ok: false, outcome: 'http_429', status };
    if (status >= 500) return { ok: false, outcome: 'http_5xx', status };
    if (!res.ok) return { ok: false, outcome: 'http_other', status };
    const len = Number(hget('content-length')); if (Number.isFinite(len) && len > maxBody) return { ok: false, outcome: 'malformed', detail: 'body_too_large', status };
    if (binary) {
      const buf = new Uint8Array(await within(res.arrayBuffer()));
      if (buf.length > maxBody) return { ok: false, outcome: 'malformed', detail: 'body_too_large', status };
      return { ok: true, status, bytes: buf, type: String(hget('content-type') || '').split(';')[0].trim().toLowerCase(), ms: Date.now() - t0 };
    }
    const text = await within(res.text());
    if (text.length > maxBody) return { ok: false, outcome: 'malformed', detail: 'body_too_large', status };
    let json; try { json = JSON.parse(text); } catch { return { ok: false, outcome: 'malformed', detail: 'invalid_json', status }; }
    return { ok: true, status, json, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, outcome: (e && e.deadline) || ac.signal.aborted ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

const COIN = /^([a-z]{1,8}:)?[A-Za-z0-9]{1,20}$/;
const DEXES = Object.freeze(['', 'xyz']);   /* '' = main perps; 'xyz' = Trade.xyz HIP-3 equities. No other market set can be requested. */
const qualify = (dex, name) => (dex && !name.includes(':') ? dex + ':' + name : name);
const dec = v => (typeof v === 'string' && DEC.test(v) ? Number(v) : null);
export function createHyperliquidClient({ fetchImpl = globalThis.fetch, base = HL_BASE, timeoutMs = 8000 } = {}) {
  const u = new URL(base); if (u.protocol !== 'https:' || u.hostname !== HL_HOST) throw new Error('hyperliquid_base_not_allowed');
  const info = (type, dex, maxBody) => {
    if (!DEXES.includes(dex)) throw new Error('dex_not_allowed');
    const body = dex ? { type, dex } : { type };
    return bounded(fetchImpl, base + '/info', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }, { timeoutMs, maxBody });
  };
  return Object.freeze({
    /* -> {ok:true, coins: Map(name -> {delisted})}  the perp universe of one market set, exactly as Hyperliquid names it */
    async meta(dex = '') {
      const r = await info('meta', dex, 2 * 1024 * 1024); if (!r.ok) return r;
      const U = r.json && Array.isArray(r.json.universe) ? r.json.universe : null;
      if (!U || U.length === 0 || U.length > 5000) return { ok: false, outcome: 'malformed', detail: 'no_universe' };
      const coins = new Map(); for (const a of U) { if (!a || typeof a.name !== 'string' || !COIN.test(a.name)) continue; coins.set(qualify(dex, a.name), { delisted: a.isDelisted === true }); }
      return { ok: true, coins };
    },
    /* -> {ok:true, coins: Map(name -> {delisted, midPx, markPx, oraclePx, prevDayPx, dayNtlVlm, openInterest})}  listing + the venue's own oracle, previous-day
     *    price, r132: 24 h notional volume (USD) and open interest (in coins), exactly as Hyperliquid publishes them */
    async metaAndAssetCtxs(dex = '') {
      const r = await info('metaAndAssetCtxs', dex, 4 * 1024 * 1024); if (!r.ok) return r;
      const j = r.json; const U = Array.isArray(j) && j[0] && Array.isArray(j[0].universe) ? j[0].universe : null, C = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : null;
      if (!U || !C || U.length !== C.length || U.length === 0 || U.length > 5000) return { ok: false, outcome: 'malformed', detail: 'bad_ctxs' };
      const coins = new Map();
      U.forEach((a, i) => { if (!a || typeof a.name !== 'string' || !COIN.test(a.name)) return; const c = C[i] || {};
        coins.set(qualify(dex, a.name), { delisted: a.isDelisted === true, midPx: dec(c.midPx), markPx: dec(c.markPx), oraclePx: dec(c.oraclePx), prevDayPx: dec(c.prevDayPx), dayNtlVlm: dec(c.dayNtlVlm), openInterest: dec(c.openInterest) }); });
      return { ok: true, coins };
    },
    /* r132/r133 -> {ok:true, candles:[{t,o,h,l,c,v}]}  the venue's own candles for ONE coin (Hyperliquid candleSnapshot), oldest first, t in ms */
    async candles1h(coin, startTime, endTime) { return this.candles(coin, '1h', startTime, endTime); },
    async candles(coin, interval, startTime, endTime) {
      const IV = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
      if (typeof coin !== 'string' || !COIN.test(coin) || !IV[interval] || !Number.isInteger(startTime) || !Number.isInteger(endTime) || endTime <= startTime || (endTime - startTime) / IV[interval] > 5000) throw new Error('bad_candle_request');
      const r = await bounded(fetchImpl, base + '/info', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }) }, { timeoutMs, maxBody: 2 * 1024 * 1024 });
      if (!r.ok) return r;
      if (!Array.isArray(r.json) || r.json.length > 5000) return { ok: false, outcome: 'malformed', detail: 'candles_not_array' };
      const out = [];
      for (const k of r.json) { const o = dec(k && k.o), h = dec(k && k.h), l = dec(k && k.l), c = dec(k && k.c), v = dec(k && k.v);
        if (!k || !Number.isInteger(k.t) || !(o > 0 && h > 0 && l > 0 && c > 0) || h < l || v == null) return { ok: false, outcome: 'malformed', detail: 'bad_candle' };
        out.push({ t: k.t, o, h, l, c, v }); }
      out.sort((a, b) => a.t - b.t); return { ok: true, candles: out };
    },
    /* -> {ok:true, mids: {COIN: '123.45'}, ms}  one request for every market of one market set */
    async allMids(dex = '') {
      const r = await info('allMids', dex, 512 * 1024); if (!r.ok) return r;
      const j = r.json; if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, outcome: 'malformed', detail: 'mids_not_object' };
      const mids = {}; for (const [k, v] of Object.entries(j)) if ((COIN.test(k) || /^@\d{1,6}$/.test(k)) && typeof v === 'string') mids[qualify(dex, k)] = v;
      return { ok: true, mids, ms: r.ms };
    }
  });
}

export function createCoinGeckoClient({ fetchImpl = globalThis.fetch, base = CG_BASE, key = '', keyHeader = 'x-cg-demo-api-key', timeoutMs = 8000 } = {}) {
  const u = new URL(base); if (u.protocol !== 'https:' || u.hostname !== CG_HOST) throw new Error('coingecko_base_not_allowed');
  /* r125: the key is optional. Without it the PUBLIC endpoint is used (identity check + logos only, a few calls a day). */
  return Object.freeze({
    /* ONE request for all ids. -> {ok:true, rows: Map(id -> {id, symbol, name, image, price, updatedMs})} */
    async markets(ids) {
      const list = [...new Set(ids)].filter(x => /^[a-z0-9-]{2,64}$/.test(x)).slice(0, 50);
      if (!list.length) return { ok: false, outcome: 'malformed', detail: 'no_ids' };
      const url = base + '/coins/markets?vs_currency=usd&ids=' + encodeURIComponent(list.join(',')) + '&per_page=50&page=1&sparkline=false';
      const r = await bounded(fetchImpl, url, { method: 'GET', headers: key ? { accept: 'application/json', [keyHeader]: key } : { accept: 'application/json' } }, { timeoutMs, maxBody: 512 * 1024 });
      if (!r.ok) return r;
      if (!Array.isArray(r.json)) return { ok: false, outcome: 'malformed', detail: 'not_array' };
      const rows = new Map();
      for (const x of r.json) {
        if (!x || typeof x.id !== 'string' || !list.includes(x.id)) continue;
        const price = typeof x.current_price === 'number' && Number.isFinite(x.current_price) && x.current_price > 0 ? x.current_price : null;
        const updatedMs = typeof x.last_updated === 'string' ? Date.parse(x.last_updated) : NaN;
        rows.set(x.id, { id: x.id, symbol: typeof x.symbol === 'string' ? x.symbol : '', name: typeof x.name === 'string' ? x.name : '', image: typeof x.image === 'string' ? x.image : null, price, updatedMs: Number.isFinite(updatedMs) ? updatedMs : null });
      }
      return { ok: true, rows };
    }
  });
}

/* Logo image download from the allow-listed hosts only. PNG / JPEG / WEBP / GIF, checked by magic bytes; SVG is refused (it can carry script). */
export function logoUrlAllowed(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && LOGO_HOSTS.includes(u.hostname) && !u.username && !u.password && (u.port === '' || u.port === '443'); } catch { return false; }
}
export function sniffImage(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return null;
}
/* r180: anyHost = a URL the service itself took from a trusted listing (Jupiter's verified token list); still https only, no credentials, port 443,
 * bounded size, and the bytes must sniff as an image */
const httpsPlain = url => { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443'); } catch { return false; } };
export async function fetchLogo(fetchImpl, url, { timeoutMs = 8000, maxBytes = 256 * 1024, anyHost = false } = {}) {
  if (!(anyHost ? httpsPlain(url) : logoUrlAllowed(url))) return { ok: false, outcome: 'host_not_allowed' };
  const r = await bounded(fetchImpl, url, { method: 'GET', headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' } }, { timeoutMs, maxBody: maxBytes, binary: true });
  if (!r.ok) return r;
  const type = sniffImage(r.bytes);
  if (!type) return { ok: false, outcome: 'not_an_image' };
  return { ok: true, bytes: r.bytes, type };
}

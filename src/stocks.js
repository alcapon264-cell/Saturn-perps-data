/* r174 Stocks: tokenized US stocks and ETFs on Solana (xStocks by Backed), read-only.
 * One server-side GET to Jupiter Tokens API V2 /search (fixed host, the existing server-side API key; never sent to browsers),
 * then strict filtering so only the real xStocks pass: Jupiter-verified, mint starts with "Xs" (the issuer's mint prefix),
 * symbol exactly "<TICKER>x", name ends with "xStock". Anything else (look-alike tokens with the same symbol) is dropped.
 * Cached for 20 s; a failure keeps the last good list (marked stale). No prices are invented: a stock without a live price is left out. */
import { TOKENS_BASE, TOKENS_HOST, iconOk } from './jupiter.js';

export const STOCKS = Object.freeze([
  ['NVDA', 'equity'], ['AAPL', 'equity'], ['MSFT', 'equity'], ['GOOGL', 'equity'], ['AMZN', 'equity'], ['META', 'equity'], ['TSLA', 'equity'],
  ['AVGO', 'equity'], ['NFLX', 'equity'], ['AMD', 'equity'], ['PLTR', 'equity'], ['COIN', 'equity'], ['MSTR', 'equity'], ['HOOD', 'equity'],
  ['CRCL', 'equity'], ['ORCL', 'equity'], ['CRM', 'equity'], ['INTC', 'equity'], ['JPM', 'equity'], ['V', 'equity'], ['MA', 'equity'],
  ['WMT', 'equity'], ['KO', 'equity'], ['PEP', 'equity'], ['MCD', 'equity'], ['JNJ', 'equity'], ['LLY', 'equity'], ['XOM', 'equity'],
  ['UNH', 'equity'], ['ABBV', 'equity'], ['GME', 'equity'], ['CSCO', 'equity'], ['IBM', 'equity'], ['ACN', 'equity'], ['BAC', 'equity'],
  ['SPY', 'etf'], ['QQQ', 'etf'], ['VTI', 'etf'], ['TQQQ', 'etf'], ['GLD', 'etf'], ['TBLL', 'etf'], ['IWM', 'etf']
]);
const MAX_BODY = 1024 * 1024;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

export function pickStocks(arr, list = STOCKS) {
  const want = new Map(list.map(([t, k]) => [(t + 'x').toLowerCase(), { t, k }])), best = new Map();
  for (const x of Array.isArray(arr) ? arr : []) {
    if (!x || typeof x.id !== 'string' || !/^Xs[1-9A-HJ-NP-Za-km-z]{30,42}$/.test(x.id)) continue;
    if (x.isVerified !== true || typeof x.symbol !== 'string' || typeof x.name !== 'string' || !/xStock$/i.test(x.name.trim())) continue;
    const w = want.get(x.symbol.toLowerCase()); if (!w) continue;
    const price = num(x.usdPrice); if (!(price > 0)) continue;
    const liq = num(x.liquidity) || 0, o = best.get(w.t);
    if (o && o.liq >= liq) continue;
    const ch = x.stats24h && num(x.stats24h.priceChange);
    best.set(w.t, { mint: x.id, ticker: w.t, symbol: x.symbol, name: x.name.trim().replace(/\s*xStock$/i, '').slice(0, 60), kind: w.k,
      icon: iconOk(x.icon) ? x.icon : null, price, chg24: ch == null ? null : ch, liq, vol24: x.stats24h ? (num(x.stats24h.buyVolume) || 0) + (num(x.stats24h.sellVolume) || 0) : null,
      holders: num(x.holderCount) });
  }
  const order = new Map(list.map(([t], i) => [t, i]));
  return [...best.values()].sort((a, b) => order.get(a.ticker) - order.get(b.ticker)).map(({ liq, ...r }) => r);
}

export function createStocks({ fetchImpl = globalThis.fetch, base = TOKENS_BASE, keyHeader = '', key = '', now = Date.now, ttlMs = 30000, timeoutMs = 8000, log = () => {} } = {}) {
  const u = new URL(base); if (u.protocol !== 'https:' || u.hostname !== TOKENS_HOST) throw new Error('tokens_base_not_allowed');
  const headers = { accept: 'application/json' }; if (keyHeader && key) headers[keyHeader] = key;
  let last = null, at = 0, inflight = null, err = null;
  async function load() {
    const ac = new AbortController(); let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error('deadline')); }, timeoutMs); }); deadline.catch(() => {});
    try {
      const q = STOCKS.map(([t]) => t + 'x').join(',');
      const res = await Promise.race([fetchImpl(base + '/search?query=' + encodeURIComponent(q), { method: 'GET', headers, signal: ac.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }), deadline]);
      if (!res || !res.ok) throw new Error('http_' + (res && res.status));
      const text = await Promise.race([res.text(), deadline]); if (text.length > MAX_BODY) throw new Error('body_too_large');
      const list = pickStocks(JSON.parse(text)); if (!list.length) throw new Error('no_stocks');
      last = list; at = now(); err = null;
    } finally { clearTimeout(timer); }
  }
  async function get() {
    if (!last || now() - at >= ttlMs) {
      if (!inflight) inflight = load().catch(e => { err = e && e.message; log('stocks_failed', err); }).finally(() => { inflight = null; });
      if (!last) await inflight;
    }
    if (!last) return { ok: false, error: 'unavailable' };
    return { ok: true, at: Math.floor(at / 1000), stale: now() - at > ttlMs * 6, source: 'jupiter', stocks: last };
  }
  return Object.freeze({ get });
}

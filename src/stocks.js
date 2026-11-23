/* r175 Stocks: tokenized US stocks and ETFs on Solana (xStocks by Backed), read-only, plus a live price socket.
 * - Discovery (every 12 h): DexScreener search per ticker (public, no key) gives candidate mints; only "Xs…" issuer mints whose symbol is
 *   exactly "<TICKER>x" and whose name ends with "xStock" are kept. ONE Jupiter Tokens API call (server-side key, by mint) then confirms
 *   each is Jupiter-verified; unverified mints are dropped. Known-good mints are seeded so the list survives a failed discovery.
 * - Prices (every 5 s while anyone watches, else on request every 20 s): DexScreener /tokens/v1 by mint, the deepest pool's USD price and 24 h change.
 * - Live: browsers connect to /stocks/live and get a snapshot, then only the stocks whose price changed. Nothing is invented: no live price -> not listed. */
import { TOKENS_BASE, TOKENS_HOST, iconOk } from './jupiter.js';

export const DEX_HOST = 'api.dexscreener.com';
export const STOCKS = Object.freeze([
  ['NVDA', 'equity'], ['AAPL', 'equity'], ['MSFT', 'equity'], ['GOOGL', 'equity'], ['AMZN', 'equity'], ['META', 'equity'], ['TSLA', 'equity'],
  ['AVGO', 'equity'], ['NFLX', 'equity'], ['AMD', 'equity'], ['PLTR', 'equity'], ['COIN', 'equity'], ['MSTR', 'equity'], ['HOOD', 'equity'],
  ['CRCL', 'equity'], ['ORCL', 'equity'], ['CRM', 'equity'], ['INTC', 'equity'], ['JPM', 'equity'], ['V', 'equity'], ['MA', 'equity'],
  ['WMT', 'equity'], ['KO', 'equity'], ['MCD', 'equity'], ['LLY', 'equity'], ['XOM', 'equity'], ['UNH', 'equity'], ['GME', 'equity'],
  ['CSCO', 'equity'], ['IBM', 'equity'], ['BAC', 'equity'],
  ['SPY', 'etf'], ['QQQ', 'etf'], ['VTI', 'etf'], ['TQQQ', 'etf'], ['GLD', 'etf'], ['TBLL', 'etf']
]);
/* verified from public sources (Solflare / Coinbase / Phantom pages for the issuer's tokens) */
export const SEED = Object.freeze({ AAPL: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', GOOGL: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', SPY: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' });
const XS = /^Xs[1-9A-HJ-NP-Za-km-z]{30,42}$/;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const clean = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) : '';

/* DexScreener search result -> best Xs mint for that ticker (or null) */
export function pickFromSearch(json, ticker) {
  const sym = (ticker + 'x').toLowerCase(); let best = null;
  for (const p of (json && Array.isArray(json.pairs) ? json.pairs : [])) {
    if (!p || p.chainId !== 'solana') continue;
    for (const t of [p.baseToken, p.quoteToken]) {
      if (!t || !XS.test(t.address || '') || String(t.symbol || '').toLowerCase() !== sym || !/xStock$/i.test(String(t.name || '').trim())) continue;
      const liq = num(p.liquidity && p.liquidity.usd) || 0;
      if (!best || liq > best.liq) best = { mint: t.address, name: clean(t.name).replace(/\s*xStock$/i, ''), liq };
    }
  }
  return best;
}
/* DexScreener /tokens/v1 result -> mint -> {price, chg24, icon} from the deepest pool where the mint is the base token */
export function pricesFrom(arr) {
  const out = new Map();
  for (const p of (Array.isArray(arr) ? arr : [])) {
    const m = p && p.baseToken && p.baseToken.address; if (!p || p.chainId !== 'solana' || !XS.test(m || '')) continue;
    const price = num(p.priceUsd), liq = num(p.liquidity && p.liquidity.usd) || 0; if (!(price > 0)) continue;
    const o = out.get(m); if (o && o.liq >= liq) continue;
    const ch = p.priceChange ? num(p.priceChange.h24) : null, img = p.info && p.info.imageUrl;
    out.set(m, { price, chg24: ch, icon: iconOk(img) ? img : null, liq, vol24: p.volume ? num(p.volume.h24) : null });
  }
  return out;
}

export function createStocks({ fetchImpl = globalThis.fetch, jupBase = TOKENS_BASE, keyHeader = '', key = '', now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, log = () => {}, discoverMs = 12 * 3600e3, priceMs = 20000, livePriceMs = 5000, timeoutMs = 8000 } = {}) {
  const ju = new URL(jupBase); if (ju.protocol !== 'https:' || ju.hostname !== TOKENS_HOST) throw new Error('tokens_base_not_allowed');
  const kind = new Map(STOCKS), order = new Map(STOCKS.map(([t], i) => [t, i]));
  let mints = new Map(Object.entries(SEED).map(([t, m]) => [t, { mint: m, name: '' }]));   /* ticker -> {mint,name} (verified) */
  let icons = new Map(), names = new Map(), px = new Map(), pxAt = 0, discAt = 0, discNext = 0, discBusy = null, pxBusy = null, err = null;
  async function getJson(url, headers = {}) {
    const u = new URL(url); if (u.protocol !== 'https:' || (u.hostname !== DEX_HOST && u.hostname !== TOKENS_HOST)) throw new Error('host_not_allowed');
    const ac = new AbortController(); let timer; const dl = new Promise((_, rej) => { timer = setTimeoutImpl(() => { ac.abort(); rej(new Error('deadline')); }, timeoutMs); }); dl.catch(() => {});
    try {
      const r = await Promise.race([fetchImpl(u.href, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal: ac.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }), dl]);
      if (!r || !r.ok) throw Object.assign(new Error('http_' + (r && r.status)), { status: r && r.status });
      const t = await Promise.race([r.text(), dl]); if (t.length > 2e6) throw new Error('body_too_large'); return JSON.parse(t);
    } finally { clearTimeoutImpl(timer); }
  }
  const sleep = ms => new Promise(r => setTimeoutImpl(r, ms));
  async function discover() {
    const cand = new Map();
    for (const [t] of STOCKS) {
      try { const b = pickFromSearch(await getJson('https://' + DEX_HOST + '/latest/dex/search?q=' + encodeURIComponent(t + 'x')), t); if (b) cand.set(t, b); } catch (e) { if (e && e.status === 429) await sleep(5000); }
      await sleep(250);
    }
    if (!cand.size) throw new Error('no_candidates');
    const headers = keyHeader && key ? { [keyHeader]: key } : {};
    const ms = [...new Set([...cand.values()].map(c => c.mint))];
    /* r182: the Jupiter key is shared with token pictures, so a 429 here is common right after a restart: retry a few times before giving up */
    let arr = null;
    for (let i = 0; i < 4 && arr == null; i++) { try { arr = await getJson(ju.href.replace(/\/$/, '') + '/search?query=' + encodeURIComponent(ms.join(',')), headers); } catch (e) { if (i === 3 || !(e && e.status === 429)) throw e; await sleep(4000 * (i + 1)); } }
    const vs = (Array.isArray(arr) ? arr : []).filter(x => x && x.isVerified === true && typeof x.id === 'string'), ok = new Set(vs.map(x => x.id));
    for (const x of vs) if (iconOk(x.icon)) icons.set(x.id, x.icon);
    const next = new Map([...mints].filter(([t, v]) => SEED[t] === v.mint));
    for (const [t, c] of cand) if (ok.has(c.mint) || SEED[t] === c.mint) next.set(t, { mint: c.mint, name: c.name });
    const dropped = [...cand].filter(([t, c]) => !next.has(t) || next.get(t).mint !== c.mint).map(([t]) => t);
    if (dropped.length) log('stocks_unverified', dropped.join(','));
    mints = next; discAt = now(); log('stocks_discovered', mints.size);
  }
  function kickDiscover() {
    if (discBusy || now() < discNext || (discAt && now() - discAt < discoverMs)) return discBusy;
    discBusy = discover().catch(e => { err = e && e.message; discNext = now() + (e && e.status === 429 ? 2 * 60e3 : 3 * 60e3); log('stocks_discover_failed', err); })
      .finally(() => { discBusy = null; });
    return discBusy;
  }
  async function refreshPrices() {
    const ms = [...mints.values()].map(v => v.mint); const next = new Map();
    for (let i = 0; i < ms.length; i += 30) { const part = pricesFrom(await getJson('https://' + DEX_HOST + '/tokens/v1/solana/' + ms.slice(i, i + 30).join(','))); part.forEach((v, k) => next.set(k, v)); }
    if (!next.size) throw new Error('no_prices');
    const changed = [];
    for (const [m, v] of next) { const o = px.get(m); if (!o || o.price !== v.price || o.chg24 !== v.chg24) changed.push(m); }
    px = next; pxAt = now(); err = null; return changed;
  }
  function kickPrices() { if (!pxBusy) pxBusy = refreshPrices().catch(e => { err = e && e.message; log('stocks_prices_failed', err); return []; }).finally(() => { pxBusy = null; }); return pxBusy; }
  function rowOf(t, v) { const p = px.get(v.mint); if (!p) return null;
    return { mint: v.mint, ticker: t, symbol: t + 'x', name: v.name || names.get(t) || t, kind: kind.get(t) || 'equity', icon: icons.get(v.mint) || p.icon, price: p.price, chg24: p.chg24, vol24: p.vol24 }; }
  function list() { return [...mints].map(([t, v]) => rowOf(t, v)).filter(Boolean).sort((a, b) => order.get(a.ticker) - order.get(b.ticker)); }
  async function get() {
    kickDiscover();
    if (!px.size) { if (discBusy && mints.size <= Object.keys(SEED).length) await Promise.race([discBusy, sleep(6000)]); await kickPrices(); }
    else if (now() - pxAt >= priceMs) kickPrices();
    const l = list(); if (!l.length) return { ok: false, error: 'unavailable' };
    return { ok: true, at: Math.floor(pxAt / 1000), stale: now() - pxAt > 120000, stocks: l };
  }
  /* ---- live socket ---- */
  const clients = new Set(); let loop = null;
  function startLoop() { if (loop) return; loop = setIntervalImpl(async () => {
    if (!clients.size) { clearIntervalImpl(loop); loop = null; return; }
    kickDiscover(); const ch = await kickPrices(); if (!ch.length) return;
    const by = new Map(list().map(r => [r.mint, r])), msg = JSON.stringify({ type: 'px', at: Math.floor(pxAt / 1000), rows: ch.map(m => by.get(m)).filter(Boolean).map(r => ({ mint: r.mint, price: r.price, chg24: r.chg24 })) });
    for (const ws of clients) { if (ws.readyState === 1 && (ws.bufferedAmount || 0) < 256 * 1024) { try { ws.send(msg); } catch {} } }
  }, livePriceMs); }
  function attach(ws) {
    clients.add(ws); startLoop();
    ws.on('message', () => {}); ws.on('close', () => clients.delete(ws)); ws.on('error', () => clients.delete(ws));
    get().then(r => { if (ws.readyState === 1) try { ws.send(JSON.stringify(r.ok ? { type: 'snap', at: r.at, stocks: r.stocks } : { type: 'err' })); } catch {} });
  }
  function stop() { if (loop) clearIntervalImpl(loop); loop = null; for (const ws of clients) { try { ws.close(); } catch {} } clients.clear(); }
  /* r180: the verified xStock picture for a ticker (used as the logo of the same company's perps market); starts discovery if needed */
  function iconFor(ticker) { kickDiscover(); const v = mints.get(String(ticker || '').toUpperCase()); if (!v) return null; const p = px.get(v.mint); return icons.get(v.mint) || (p && p.icon) || null; }
  return Object.freeze({ get, attach, stop, iconFor, _list: list, _discover: discover, stats: () => ({ clients: clients.size, mints: mints.size, prices: px.size, err }) });
}

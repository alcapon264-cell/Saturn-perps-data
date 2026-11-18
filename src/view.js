/* r121 VIEW-ONLY markets: HYPE, ZEC, JUP, NEAR, BNB (crypto) and SNDK, SPCX, SKHYNIX (equities). A separate pipeline from the SOL/ETH/BTC recorder:
 *   own config (cfg.view), own fetcher, own source tag ('hyperliquid:allMids'), own tables (perps_view_*), own validation, own budget.
 *   Prices: Hyperliquid allMids, ONE request per market set ('' main perps, 'xyz' Trade.xyz HIP-3 equities) per 15 s slot.
 *   Listing + oracle price + previous-day price: metaAndAssetCtxs per market set every 60 s.
 *   Cross-check: crypto against CoinGecko (one batched call per 5 min, monthly cap); equities against their own oracle price.
 * Nothing here can reach the execution gateway: view markets are not in MARKETS or CUSTODY, and the gateway refuses them by name.
 *
 * EVERY configured market is always LISTED (identity: symbol, name, category, logo). Its PRICE is shown only while:
 *   1. the exact coin is listed and not delisted on Hyperliquid,
 *   2. (crypto) the CoinGecko id resolves to the expected symbol and name,
 *   3. a cross-check succeeded within 20 min and differed by <= mismatchPct,
 *   4. the recorder's price is live/stale and not frozen.
 * Otherwise price is null and `status` says why ('Price unavailable' in the app). Nothing is estimated. */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VIEW_MARKET_TABLE, VIEW_SOURCE, MARKET_KEYS } from './config.js';
import { createStore } from './store.js';
import { createCandleEngine } from './engine.js';
import { createRecorder } from './recorder.js';
import { createHyperliquidClient, createCoinGeckoClient, fetchLogo, logoUrlAllowed, sniffImage } from './viewsources.js';

const CORE_CG = Object.freeze({ SOL: { id: 'solana', symbol: 'sol', name: 'Solana' }, ETH: { id: 'ethereum', symbol: 'eth', name: 'Ethereum' }, BTC: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' } });
const STATE_KEY = 'view_state_v2';

/* r123 logo policy: a logo file shipped with the service is served ONLY if it is declared in assets/official-logos/SOURCES.json
 * with the official page it was downloaded from and its sha256, and the file matches that hash. Undeclared files (for example the
 * R121 screenshot cut-outs in assets/logos/) are never read. Without a declared file, the verified remote image is used
 * (CoinGecko image of the verified id; for SOL/ETH/BTC also the Jupiter token icon), otherwise no logo (the app shows a plain disc). */
export function loadBundledLogos(keys, dir = new URL('../assets/official-logos/', import.meta.url)) {
  const out = new Map();
  let list = [];
  try { const j = JSON.parse(readFileSync(new URL('SOURCES.json', dir), 'utf8')); list = Array.isArray(j) ? j : []; } catch { return out; }
  for (const e of list) {
    if (!e || typeof e !== 'object' || !keys.includes(e.market) || !/^[A-Z0-9]{2,12}$/.test(e.market)) continue;
    if (typeof e.source !== 'string' || !/^https:\/\/[^\s]+$/.test(e.source) || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) continue;
    const f = new URL(e.market + '.png', dir); if (!existsSync(f)) continue;
    const b = new Uint8Array(readFileSync(f)); const type = sniffImage(b);
    if (!type || b.length > 256 * 1024 || createHash('sha256').update(b).digest('hex') !== e.sha256) continue;
    out.set(e.market, { bytes: b, type, bundled: true, source: e.source });
  }
  return out;
}

export function createViewMarkets({ cfg, db, readerDb = null, fetchImpl = globalThis.fetch, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, rand = Math.random, metrics, log = () => {}, hub = null, coreIconFallback = () => null, bundledLogos = null }) {
  const V = cfg.view; const KEYS = Object.freeze([...(V ? V.markets : [])]);
  const enabled = KEYS.length > 0;
  const T = m => VIEW_MARKET_TABLE[m];
  const DEXES = [...new Set(KEYS.map(m => T(m).dex))];
  const store = createStore(db, { tableSet: 'view', source: VIEW_SOURCE });
  const readStore = createStore(readerDb || db, { tableSet: 'view', source: VIEW_SOURCE });
  const hl = createHyperliquidClient({ fetchImpl, base: V ? V.hyperliquidBase : undefined, timeoutMs: cfg.timeoutMs });
  /* r125: CoinGecko is optional. With a key: price cross-check every 5 min. Without: the public endpoint only verifies coin identity and supplies logos (every 6 h),
   * and every market's price is checked against its own Hyperliquid oracle price. Nothing on Render is required for the catalogue to work. */
  const keyed = !!(V && V.coingeckoKey);
  const cg = V ? createCoinGeckoClient({ fetchImpl, key: V.coingeckoKey || '', timeoutMs: cfg.timeoutMs }) : null;
  const CHK = m => T(m).check === 'coingecko' && keyed ? 'coingecko' : 'oracle';
  const CG_EVERY = () => keyed ? V.crossCheckMs : 6 * 3600 * 1000;
  const LOGO_KEYS = [...MARKET_KEYS, ...Object.keys(VIEW_MARKET_TABLE)];
  /* r124: the manifest may live in assets/official-logos/ or assets/logos/; either way only DECLARED, hash-matching files are served */
  const BUNDLED = bundledLogos || new Map([...loadBundledLogos(LOGO_KEYS, new URL('../assets/logos/', import.meta.url)), ...loadBundledLogos(LOGO_KEYS)]);

  /* per-market verification + quality (memory on the leader, mirrored to perps_meta for API-only instances) */
  const Q = Object.fromEntries(KEYS.map(m => [m, { listed: null, listedReason: 'not_checked', coin: null, idOk: T(m).check === 'coingecko' ? null : true, idReason: null,
    checkAt: null, diffPct: null, mismatch: false, logoUrl: null, ctx: null }]));
  const coreLogo = {};
  let lastMids = null, midsInflight = null, lastCtxAt = 0, lastCheckAt = 0, leader = false;

  /* ---- Hyperliquid prices: one allMids per market set, shared by every market ---- */
  async function mids() {
    const t = now();
    if (lastMids && t - lastMids.at < V.minMidsGapMs) return lastMids.r;
    if (midsInflight) return midsInflight;
    midsInflight = (async () => {
      const all = {}; let ok = true, bad = null, ms = 0;
      for (const d of DEXES) { const r = await hl.allMids(d); metrics?.inc('view_allmids_' + (r.ok ? 'ok' : r.outcome)); if (!r.ok) { ok = false; bad = r; break; } Object.assign(all, r.mids); ms = Math.max(ms, r.ms || 0); }
      const r = ok ? { ok: true, mids: all, ms } : bad; lastMids = { at: now(), r }; return r;
    })().finally(() => { midsInflight = null; });
    return midsInflight;
  }
  async function fetchFor(m) {
    const r = await mids(); if (!r.ok) return r;
    const coin = Q[m].coin;
    if (!coin || !Object.prototype.hasOwnProperty.call(r.mids, coin)) return { ok: false, outcome: 'malformed', detail: 'not_listed', ms: r.ms };
    return { ok: true, json: { price: r.mids[coin] }, ms: r.ms };
  }

  /* ---- listing + oracle + previous-day price (every 60 s) ---- */
  async function readContexts() {
    lastCtxAt = now();
    for (const d of DEXES) {
      const r = await hl.metaAndAssetCtxs(d);
      if (!r.ok) { metrics?.inc('view_ctx_failed'); log('view: hyperliquid contexts failed', d || 'main', r.outcome); continue; }   /* keep the previous result: an unreachable venue is not proof of delisting */
      for (const m of KEYS.filter(k => T(k).dex === d)) {
        const q = Q[m]; const name = T(m).venueCoins.find(c => r.coins.has(c) && !r.coins.get(c).delisted) || T(m).venueCoins.find(c => r.coins.has(c));
        const c = name ? r.coins.get(name) : null;
        q.listed = !!c && !c.delisted; q.listedReason = !c ? 'not_listed_on_hyperliquid' : c.delisted ? 'delisted_on_hyperliquid' : null;
        q.coin = q.listed ? name : null; q.ctx = c ? { oraclePx: c.oraclePx, prevDayPx: c.prevDayPx, midPx: c.midPx, markPx: c.markPx, dayNtlVlm: c.dayNtlVlm, openInterest: c.openInterest, at: now() } : null;
        if (q.listed) await upsertMarket(m, name).catch(e => log('view: market row failed', m, e && e.message));
        if (q.listed && CHK(m) === 'oracle') oracleCheck(m, c);
      }
    }
  }
  function oracleCheck(m, c) {
    const q = Q[m]; const mid = c.midPx > 0 ? c.midPx : null;
    if (!(mid > 0) || !(c.oraclePx > 0)) { metrics?.inc('view_oracle_inconclusive'); return; }
    q.diffPct = +(Math.abs(mid - c.oraclePx) / c.oraclePx * 100).toFixed(3); q.mismatch = q.diffPct > V.mismatchPct; q.checkAt = now();
    if (q.mismatch) { metrics?.inc('view_oracle_mismatch'); log('view: oracle disagreement', m, 'diffPct=' + q.diffPct); }
  }
  async function upsertMarket(m, coin) {
    await db.query("INSERT INTO perps_view_markets(market, source, venue_coin, coingecko_id, verified_at, enabled) VALUES ($1,$2,$3,$4,to_timestamp($5),true) ON CONFLICT (market) DO UPDATE SET verified_at = EXCLUDED.verified_at, venue_coin = EXCLUDED.venue_coin",
      [m, VIEW_SOURCE, coin, T(m).coingeckoId || null, now() / 1000]);
  }

  /* ---- CoinGecko (crypto only): id check + price cross-check + logo URL, ONE request, under a monthly cap ---- */
  const monthKey = () => { const d = new Date(now()); return 'coingecko_calls:' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
  async function spendCoinGecko() {
    const r = await db.query("INSERT INTO perps_meta(key, value, updated_at) VALUES ($1, '1', now()) ON CONFLICT (key) DO UPDATE SET value = (perps_meta.value::int + 1)::text, updated_at = now() WHERE perps_meta.value::int < $2 RETURNING value", [monthKey(), V.coingeckoMonthlyCap]);
    return r.rows.length > 0;
  }
  async function crossCheck() {
    if (!cg) return false;
    lastCheckAt = now();
    const CK = KEYS.filter(m => T(m).check === 'coingecko');
    if (!(await spendCoinGecko().catch(() => false))) { metrics?.inc('view_coingecko_cap_reached'); log('view: CoinGecko monthly cap reached; cross-checks paused until next month'); return false; }
    const r = await cg.markets([...CK.map(m => T(m).coingeckoId), ...Object.values(CORE_CG).map(x => x.id)]);
    if (!r.ok) { metrics?.inc('view_coingecko_' + r.outcome); log('view: CoinGecko check failed', r.outcome, r.status || ''); return false; }
    for (const [m, x] of Object.entries(CORE_CG)) { const row = r.rows.get(x.id); coreLogo[m] = row && row.symbol === x.symbol && row.name === x.name && logoUrlAllowed(row.image) ? row.image : (coreLogo[m] || null); }
    const hm = lastMids && lastMids.r.ok && now() - lastMids.at < 60000 ? lastMids.r.mids : ((await mids()).mids || null);
    for (const m of CK) {
      const d = T(m), row = r.rows.get(d.coingeckoId), q = Q[m];
      if (!row) { q.idOk = false; q.idReason = 'coingecko_id_not_found'; continue; }
      if (row.symbol !== d.cgSymbol || row.name !== d.cgName) { q.idOk = false; q.idReason = 'coingecko_id_mismatch'; metrics?.inc('view_id_mismatch'); continue; }
      q.idOk = true; q.idReason = null;
      if (logoUrlAllowed(row.image)) q.logoUrl = row.image;
      if (!keyed) continue;   /* public endpoint: identity + logo only; the price check is the oracle check */
      const hp = hm && q.coin && typeof hm[q.coin] === 'string' ? Number(hm[q.coin]) : NaN;
      const fresh = row.updatedMs != null && now() - row.updatedMs <= 30 * 60 * 1000 && row.updatedMs <= now() + 2 * 60 * 1000;   /* r124: a timestamp from the future is not trusted either */
      if (!(row.price > 0) || !(hp > 0) || !fresh) { metrics?.inc('view_crosscheck_inconclusive'); continue; }   /* inconclusive: checkAt not advanced, so it expires */
      q.diffPct = +(Math.abs(hp - row.price) / row.price * 100).toFixed(3); q.mismatch = q.diffPct > V.mismatchPct; q.checkAt = now();
      if (q.mismatch) { metrics?.inc('view_crosscheck_mismatch'); log('view: cross-check mismatch', m, 'diffPct=' + q.diffPct); }
    }
    return true;
  }

  /* ---- what may be shown ---- */
  const verified = (q) => !!q && q.listed === true && q.idOk !== false;
  function quality(m, q, summary, t = now()) {
    if (!q) return { ok: false, reason: 'not_checked' };
    if (q.listed !== true) return { ok: false, reason: q.listedReason || 'not_checked' };
    if (q.idOk === false || (CHK(m) === 'coingecko' && q.idOk !== true)) return { ok: false, reason: q.idReason || 'not_checked' };
    if (q.checkAt == null || t - q.checkAt > V.crossCheckMaxAgeMs) return { ok: false, reason: 'not_cross_checked' };
    if (q.mismatch) return { ok: false, reason: 'sources_disagree' };
    const s = summary && summary.markets && summary.markets[m];
    if (s && (s.unchangedRun || 0) >= Math.ceil(V.frozenMs / (cfg.intervalSec * 1000))) return { ok: false, reason: 'price_frozen' };
    return { ok: true, reason: null };
  }
  /* recording pauses while unlisted, while the id is wrong or unchecked, or while sources disagree, so a wrong feed never reaches the candles */
  const gate = m => { const q = Q[m]; return !!q && q.listed === true && !!q.coin && q.idOk !== false && !q.mismatch; };

  const engine = createCandleEngine({ store, cfg, now, metrics, onCandle: (m, k) => hub && hub.publishCandle(m, k), sourceTag: VIEW_SOURCE });
  const priceRange = Object.fromEntries(KEYS.map(m => [m, T(m).range]));
  const recorder = createRecorder({
    jupiter: null, store, cfg, marketKeys: KEYS, fetchFor, source: VIEW_SOURCE, priceRange, stagger: false, budget: () => true, gate,
    now, setTimeoutImpl, clearTimeoutImpl, rand, metrics, log,
    onTick: t => { if (hub && quality(t.market, Q[t.market], recorder.summary()).ok) hub.publishTick(t); },
    onObservationStored: (m, t) => engine.onObservation(m, t),
    onStateChange: (m, st) => { if (hub) hub.publishStatus(m, st, recorder.summary().markets[m].ageMs); }
  });

  /* ---- shared state for API-only instances ---- */
  async function saveState() {
    const s = recorder.summary();
    const v = JSON.stringify({ at: now(), q: Q, coreLogo, rec: Object.fromEntries(KEYS.map(m => [m, { unchangedRun: s.markets[m].unchangedRun, lastObservationAt: s.markets[m].lastObservationAt }])) });
    await db.query('INSERT INTO perps_meta(key,value,updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [STATE_KEY, v]);
  }
  let remote = { at: 0, v: null };
  async function sharedState() {
    if (leader) return { q: Q, coreLogo, rec: recorder.summary() };
    if (now() - remote.at > 15000) {
      let v = null; try { const r = await (readerDb || db).query('SELECT value FROM perps_meta WHERE key=$1', [STATE_KEY]); v = r.rows[0] ? JSON.parse(r.rows[0].value) : null; } catch { v = null; }
      remote = { at: now(), v };
    }
    const v = remote.v; if (!v || now() - v.at > 30 * 60 * 1000) return { q: {}, coreLogo: {}, rec: { markets: {} } };
    return { q: v.q || {}, coreLogo: v.coreLogo || {}, rec: { markets: v.rec || {} } };
  }

  /* ---- statistics ---- */
  async function history(m) {
    let first = null; try { first = await readStore.firstObservationMs(m); } catch { return { state: 'unavailable', hours: 0 }; }
    if (first == null) return { state: 'collecting', hours: 0 };
    const hours = Math.floor((now() - first) / 3600000);
    return { state: hours >= 24 ? 'ready' : 'collecting', hours: Math.min(hours, 24) };
  }
  /* Saturn's own 24 h high/low/change: only when every one of the last 24 hourly candles is valid */
  async function stats24h(m, hist) {
    if (hist.state !== 'ready') return null;
    try {
      const rows = await readStore.candles(m, '1h', { limit: 25, includeForming: true });
      const from = Math.floor(now() / 1000) - 24 * 3600;
      const win = rows.filter(k => k.t >= from - 3600 && (k.status === 'forming' || k.valid));
      if (win.length < 24) return null;
      const open = win[0].o, last = win[win.length - 1].c; let high = -Infinity, low = Infinity; for (const k of win) { if (k.h > high) high = k.h; if (k.l < low) low = k.l; }
      return open > 0 ? { open, high, low, last, changePct: +((last - open) / open * 100).toFixed(4), hours: win.length, from: win[0].t, basis: 'saturn_sampled_1h' } : null;
    } catch { return null; }
  }
  /* until Saturn has its own 24 h: the venue's own previous-day reference price (metaAndAssetCtxs.prevDayPx), when fresh. A real figure from the source, never estimated. */
  function sourceChange(q, price, t = now()) {
    const c = q && q.ctx; if (!c || !(c.prevDayPx > 0) || !(price > 0) || t - c.at > V.ctxMaxAgeMs) return null;
    return { changePct: +((price - c.prevDayPx) / c.prevDayPx * 100).toFixed(4), reference: c.prevDayPx, basis: 'hyperliquid_prevDayPx' };
  }
  /* r132: until Saturn's own 24 hourly candles exist, 24 h high/low/open from the SAME venue that prices the market (Hyperliquid candleSnapshot 1 h).
   * Real venue candles only, never estimated; needs 24 complete hours; attributed with basis 'hyperliquid_candles_1h'. Cached 5 min per market. */
  const venueStatsCache = new Map();
  async function venueStats24h(m, coin, price, t = now()) {
    if (!coin || !(price > 0)) return null;
    const c = venueStatsCache.get(m); if (c && t - c.at < 300000) return c.v;
    let v = null;
    try {
      const hour = 3600000, end = Math.floor(t / hour) * hour, r = await hl.candles1h(coin, end - 24 * hour, t);
      if (r.ok) {
        const done = r.candles.filter(k => k.t >= end - 24 * hour && k.t < end);
        const ok = done.length === 24 && done.every((k, i) => k.t === end - (24 - i) * hour);
        if (ok) { const open = done[0].o; let high = Math.max(...done.map(k => k.h)), low = Math.min(...done.map(k => k.l)); high = Math.max(high, price); low = Math.min(low, price);
          v = { open, high, low, last: price, changePct: +((price - open) / open * 100).toFixed(4), hours: 24, from: Math.floor(done[0].t / 1000), basis: 'hyperliquid_candles_1h' }; }
      } else metrics?.inc('view_venue_candles_' + r.outcome);
    } catch { v = null; }
    venueStatsCache.set(m, { at: t, v }); return v;
  }
  /* r133: chart candles for a view market from the SAME venue that prices it (Hyperliquid candleSnapshot): continuous history even while this
   * service was asleep. Shape = the store's candle rows; the still-open bucket is returned only as status 'forming'. Cached 20 s. null = unavailable. */
  const venueCandleCache = new Map();
  const TFMS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
  async function venueCandles(m, tf, { limit = 200, beforeMs = null, includeForming = false } = {}, t = now()) {
    const step = TFMS[tf]; if (!step || !KEYS.includes(m)) return null;
    const st = leader ? null : await sharedState(), q = leader ? Q[m] : (st.q[m] || null), coin = q && q.coin; if (!coin) return null;
    const ck = [m, tf, limit, beforeMs, includeForming].join('|'), c = venueCandleCache.get(ck); if (c && t - c.at < 20000) return c.v;
    let v = null;
    try {
      const end = beforeMs != null ? Math.min(beforeMs, t) : t, open = Math.floor(t / step) * step, start = Math.floor(end / step) * step - (limit + 1) * step;
      const r = await hl.candles(coin, tf, start, end);
      if (r.ok) v = r.candles.filter(k => k.t % step === 0 && (beforeMs == null || k.t < beforeMs) && (includeForming || k.t < open)).slice(-limit)
        .map(k => ({ t: k.t / 1000, o: k.o, h: k.h, l: k.l, c: k.c, n: null, coverage: 1, maxGapSec: 0, status: k.t >= open ? 'forming' : 'complete', valid: true }));
      else metrics?.inc('view_venue_candles_' + r.outcome);
    } catch { v = null; }
    venueCandleCache.set(ck, { at: t, v }); if (venueCandleCache.size > 400) venueCandleCache.delete(venueCandleCache.keys().next().value);
    return v;
  }
  /* r132: the venue's own 24 h notional volume and open interest (USD), only from a fresh context read */
  function venueVolume(q, price, t = now()) {
    const c = q && q.ctx; if (!c || t - c.at > V.ctxMaxAgeMs) return { volume24h: null, openInterest: null };
    const px = c.markPx > 0 ? c.markPx : price;
    return { volume24h: c.dayNtlVlm != null && c.dayNtlVlm >= 0 ? c.dayNtlVlm : null, openInterest: c.openInterest != null && c.openInterest >= 0 && px > 0 ? +(c.openInterest * px).toFixed(2) : null };
  }
  const stateFromAge = ageMs => ageMs == null ? 'no_data' : ageMs <= cfg.staleMult * cfg.intervalSec * 1000 ? 'live' : ageMs <= cfg.downSec * 1000 ? 'stale' : 'down';
  const hasLogo = async m => BUNDLED.has(m) || !!(await logoUrl(m));

  /* the rows appended to /v1/perps/markets: EVERY configured view market (identity always; price only when reliable). Always executable:false. */
  async function marketsView() {
    if (!enabled) return [];
    const st = await sharedState(); const out = [];
    for (const m of KEYS) {
      const q = leader ? Q[m] : (st.q[m] || null); if (!leader && q) Object.assign(Q[m], q);
      let last = null; try { last = await readStore.lastObservation(m); } catch { last = null; }
      const ageMs = last ? Math.max(0, now() - last.t) : null, state = stateFromAge(ageMs);
      const qual = quality(m, q, st.rec);
      const show = qual.ok && !!last && state !== 'down';
      const hist = show ? await history(m) : { state: 'collecting', hours: 0 };
      const own = show ? await stats24h(m, hist) : null;
      const s24 = own || (show ? await venueStats24h(m, q && q.coin, last.price) : null), vol = show ? venueVolume(q, last.price) : { volume24h: null, openInterest: null };
      out.push({
        icon: (await hasLogo(m)) ? '/v1/perps/logos/' + m : null,
        market: m, price: show ? last.price : null, observedAt: show ? Math.floor(last.t / 1000) : null, ageMs: show ? ageMs : null, state: show ? state : 'unavailable',
        status: show ? 'ok' : (qual.reason || (last ? 'stale' : 'no_data')),
        symbol: m + '-PERP', mint: null, name: T(m).name, category: T(m).category, maxLeverage: null, executable: false, viewOnly: true,
        source: VIEW_SOURCE, venue: T(m).dex ? 'hyperliquid:' + T(m).dex : 'hyperliquid', venueCoin: q && q.coin || null,
        crossCheck: { source: CHK(m) === 'oracle' ? 'hyperliquid-oracle' : 'coingecko', ok: qual.ok, reason: qual.reason, diffPct: q && q.diffPct != null ? q.diffPct : null, checkedAt: q && q.checkAt ? Math.floor(q.checkAt / 1000) : null },
        history: hist, stats24h: s24, change24h: show && !s24 ? sourceChange(q, last.price) : null, volume24h: vol.volume24h, openInterest: vol.openInterest
      });
    }
    return out;
  }
  const visibleKeys = async () => { if (!enabled) return []; const st = await sharedState(); return KEYS.filter(m => verified(leader ? Q[m] : st.q[m])); };
  const isViewMarket = m => KEYS.includes(m);
  async function logoUrl(m) {
    const st = await sharedState();
    if (MARKET_KEYS.includes(m)) { const a = st.coreLogo[m]; if (a && logoUrlAllowed(a)) return a; const b = coreIconFallback(m); return b && logoUrlAllowed(b) ? b : null; }
    if (isViewMarket(m)) { const q = leader ? Q[m] : st.q[m]; return q && q.idOk === true && q.logoUrl && logoUrlAllowed(q.logoUrl) ? q.logoUrl : null; }
    return null;
  }
  const coreLogoUrl = async m => (BUNDLED.has(m) ? 'bundled' : await logoUrl(m));

  /* ---- logos: the file shipped with the service first; otherwise the verified remote image, fetched at most once per 24 h ---- */
  const logos = new Map();
  async function logo(m) {
    if (BUNDLED.has(m)) return BUNDLED.get(m);
    const url = await logoUrl(m); if (!url) return null;
    const c = logos.get(m); if (c && c.url === url && c.v !== undefined && now() - c.at < 24 * 3600 * 1000) return c.v;
    if (c && c.p) return c.p;
    const p = fetchLogo(fetchImpl, url, { timeoutMs: cfg.timeoutMs }).then(r => { const v = r.ok ? { bytes: r.bytes, type: r.type } : null; logos.set(m, { url, at: now(), v }); metrics?.inc('logo_fetch_' + (r.ok ? 'ok' : r.outcome)); return v; });
    logos.set(m, { url, at: 0, p }); return p;
  }

  /* ---- lifecycle (leader only) ---- */
  async function startLeader() {
    if (!enabled) return;
    leader = true;
    log('view: markets ' + KEYS.join(',') + '; price check: ' + (keyed ? 'CoinGecko (crypto) + oracle (stocks)' : 'Hyperliquid oracle (no CoinGecko key)'));
    await readContexts().catch(e => log('view: contexts failed', e && e.message));
    await crossCheck().catch(e => log('view: cross-check failed', e && e.message));
    for (const m of KEYS) if (Q[m].listed) await engine.recover(m).catch(() => {});
    await recorder.start(); await saveState().catch(() => {});
    log('view: recorder started; listed:', KEYS.filter(m => Q[m].listed).join(',') || '(none)');
  }
  async function stopLeader() { leader = false; await recorder.stop(); }
  async function tick() {
    if (!leader) return;
    const t = now();
    if (t - lastCtxAt >= V.ctxMs) await readContexts().catch(() => {});
    if (cg && t - lastCheckAt >= CG_EVERY()) await crossCheck().catch(() => {});
    for (const m of KEYS) { await engine.finalizeDue(m); recorder.checkState(m); }
    await saveState().catch(() => {});
  }
  async function retention() {
    const cut = now() - cfg.retention.observationsDays * 86400000, cutLog = now() - cfg.retention.logDays * 86400000;
    const o = await db.query('DELETE FROM perps_view_observations WHERE observed_at < to_timestamp($1) RETURNING 1', [cut / 1000]);
    const r = await db.query('DELETE FROM perps_view_rejects WHERE observed_at < to_timestamp($1) RETURNING 1', [cutLog / 1000]);
    return { observations: o.rows.length, rejects: r.rows.length };
  }

  return Object.freeze({ enabled, KEYS, coreLogoUrl, store, readStore, recorder, engine, startLeader, stopLeader, tick, retention, marketsView, venueCandles, visibleKeys, isViewMarket, logo, readContexts, crossCheck, quality, Q, BUNDLED,
    get inFlight() { return Object.values(recorder._S).some(s => s.inFlight) || !!midsInflight; } });
}

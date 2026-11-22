/* r137 Saturn Prediction — READ-ONLY Polymarket data service (no keys, no signing, no orders).
 * Sources (all public, official Polymarket APIs):
 *   Gamma   https://gamma-api.polymarket.com   discovery, market metadata (events, markets, public-search)
 *   CLOB    https://clob.polymarket.com        live order books and best prices (/book, /price)
 *   Data    https://data-api.polymarket.com    probability history (/v2/prices-history)
 * Everything returned to the app is Polymarket's own data, normalised. Quotes are computed by walking the REAL order book; the only
 * estimate is Polymarket's taker fee (its published category rate x shares x p x (1-p)), and it is labelled as an estimate.
 * Routes (GET only):  /v1/pm/status · /v1/pm/updown?asset=&interval= · /v1/pm/positions?user= · /v1/pm/feed?cat=&offset=&tag= · /v1/pm/tags?cat= · /v1/pm/event?slug= · /v1/pm/search?q= · /v1/pm/market?slug= · /v1/pm/history?token=&range= · /v1/pm/quote?slug=&outcome=&usd=
 * Trading is NOT implemented here: execution needs a Polymarket Builder account and a per-user Deposit Wallet (Polygon, pUSD). */
export const PM_HOSTS = Object.freeze(['gamma-api.polymarket.com', 'clob.polymarket.com', 'data-api.polymarket.com']);
/* r143: crypto Up/Down windows. Slug pattern `{asset}-updown-{5m|15m}-{window start, unix s}` (one event per window). */
export const UPDOWN = Object.freeze({ assets: ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype'], intervals: { '5m': 300, '15m': 900 } });
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com', DATA = 'https://data-api.polymarket.com';

/* Polymarket's published taker fee rates by market category (docs.polymarket.com/trading/fees). Used ONLY for the labelled fee estimate. */
export const PM_FEE_RATES = Object.freeze({ crypto: 0.07, sports: 0.05, politics: 0.04, finance: 0.04, tech: 0.04, mentions: 0.04, economics: 0.05, culture: 0.05, weather: 0.05, geopolitics: 0, other: 0.05 });
/* r142: Saturn Prediction categories (the tab strip) -> Polymarket tag slugs, tried in order until one returns markets.
 * trending/breaking/new are SORTS over all open events; the rest are tag filters. Polymarket's own section names. */
export const PM_CATEGORIES = Object.freeze({
  trending: [null], breaking: [null], new: [null], live: [null],
  politics: ['politics'], sports: ['sports'], crypto: ['crypto'], esports: ['esports'], finance: ['finance'], geopolitics: ['geopolitics', 'world'],
  tech: ['tech', 'technology', 'ai'], culture: ['pop-culture', 'culture'], economy: ['economy', 'business'], weather: ['weather', 'climate'],
  elections: ['elections', 'world-elections'], mentions: ['mentions']
});
const SORT_OF = c => (c === 'breaking' || c === 'new' || c === 'live') ? c : 'trending';
/* Gamma's JSON field names (docs.polymarket.com Event schema): volume24hr, startDate, creationDate. r139 logs showed `volume_24hr` -> HTTP 422. */
const ORDER_FIELDS = Object.freeze({ trending: ['volume24hr', null], breaking: ['volume24hr', null], live: ['volume24hr', null], new: ['startDate', 'creationDate', null] });
/* r142 audit: bucket_seconds is NOT sent. Polymarket (docs: /v2/prices-history) serves an explicit width exactly or returns an EMPTY page when that
 * resolution has expired, and widths other than 10800/43200 cap `max` at 30 days. Omitted, the server picks a width that really covers the window
 * (1d: 60 s, 1w: 300 s, 1m: 1800 s, max: 43200 s). */
const RANGES = Object.freeze({ '1d': ['1d'], '1w': ['1w'], '1m': ['1m'], all: ['max'] });
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/, TOKEN = /^[0-9]{6,90}$/, ADDR = /^0x[0-9a-fA-F]{40}$/;
/* outcome ids: decimal uint256 strings (hex ids are converted) */
const tokId = v => { const x = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''; if (TOKEN.test(x)) return x; if (/^0x[0-9a-fA-F]{1,64}$/.test(x)) { try { const d = BigInt(x).toString(); return TOKEN.test(d) ? d : null; } catch { return null; } } return null; };
const num = v => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const arr = v => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; } } return null; };
const str = (v, max = 400) => typeof v === 'string' ? v.slice(0, max) : null;
const iso = v => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const url = v => typeof v === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(v) ? v : null;

function feeCategory(tags) {
  const s = new Set((tags || []).map(t => String((t && (t.slug || t.label)) || t || '').toLowerCase()));
  for (const k of ['crypto', 'sports', 'politics', 'geopolitics', 'finance', 'economics', 'tech', 'culture', 'weather', 'mentions']) if (s.has(k)) return k;
  if (s.has('economy') || s.has('business')) return 'economics';
  if (s.has('technology') || s.has('ai')) return 'tech';
  return 'other';
}

function feeOf(m, cat) {
  const fs = m && m.feeSchedule && typeof m.feeSchedule === 'object' ? m.feeSchedule : null, r = fs ? num(fs.rate) : null, ex = fs ? num(fs.exponent) : null;
  if (m && m.feesEnabled === false) return { feeRate: 0, feeExponent: 1, feeSource: 'market:feesEnabled=false', feeCategory: cat };
  if (r != null && r >= 0 && r <= 1) return { feeRate: r, feeExponent: ex != null && ex > 0 && ex <= 4 ? ex : 1, feeSource: 'market:feeSchedule', feeCategory: cat };
  return { feeRate: PM_FEE_RATES[cat], feeExponent: 1, feeSource: 'category-table', feeCategory: cat };
}
/* a Gamma market -> Saturn's shape. Only binary Yes/No markets with two outcome tokens are kept. */
export function normMarket(m, ev = null) {
  if (!m || typeof m !== 'object') return null;
  /* r143: docs.polymarket.com/market-data/market-details — `version` selects the trading id: "v2" -> positionIds (Protocol V2 Position IDs),
   * "v1" -> clobTokenIds (CTF token ids). Both can be present, so presence does not decide. Other versions are unsupported. Missing = v1. */
  const ver = m.version == null || m.version === '' ? 'v1' : String(m.version);
  if (ver !== 'v1' && ver !== 'v2') return null;
  const outcomes = arr(m.outcomes), tokens = ver === 'v2' ? arr(m.positionIds) : arr(m.clobTokenIds), prices = arr(m.outcomePrices);
  if (!outcomes || outcomes.length !== 2 || !tokens || tokens.length !== 2) return null;
  const o0 = String(outcomes[0]).toLowerCase(), o1 = String(outcomes[1]).toLowerCase();
  /* r142: any two-outcome market is shown. For Yes/No markets `yes` is always Yes; otherwise `yes` = Polymarket's first outcome (e.g. Up, a team). */
  const yn = (o0 === 'yes' && o1 === 'no') || (o0 === 'no' && o1 === 'yes');
  const yi = yn && o0 === 'no' ? 1 : 0, ni = 1 - yi, t0 = tokId(tokens[yi]), t1 = tokId(tokens[ni]);
  const lab = i => str(String(outcomes[i] ?? ''), 40) || (i === yi ? 'Yes' : 'No');
  if (!t0 || !t1 || t0 === t1) return null;
  const p = i => { const v = prices ? num(prices[i]) : null; return v != null && v >= 0 && v <= 1 ? v : null; };
  const tags = (ev && Array.isArray(ev.tags) ? ev.tags : Array.isArray(m.tags) ? m.tags : []);
  const slug = typeof m.slug === 'string' && SLUG.test(m.slug) ? m.slug : null; if (!slug) return null;
  const question = str(m.question, 300); if (!question) return null;
  const cat = feeCategory(tags);
  return {
    id: String(m.id ?? ''), slug, question, eventTitle: ev ? str(ev.title, 300) : null, eventSlug: ev && typeof ev.slug === 'string' && SLUG.test(ev.slug) ? ev.slug : null,
    category: cat, tags: tags.map(t => str((t && (t.label || t.slug)) || '', 40)).filter(Boolean).slice(0, 6),
    endDate: iso(m.endDate) || (ev ? iso(ev.endDate) : null), active: m.active !== false, closed: m.closed === true,
    acceptingOrders: m.acceptingOrders !== false && m.enableOrderBook !== false && m.closed !== true,
    volume: num(m.volumeNum) ?? num(m.volume), volume24h: num(m.volume24hr), liquidity: num(m.liquidityNum) ?? num(m.liquidity),
    image: url(m.icon) || url(m.image) || (ev ? url(ev.icon) || url(ev.image) : null), description: str(m.description, 4000) || (ev ? str(ev.description, 4000) : null),
    resolutionSource: url(m.resolutionSource) || (ev ? url(ev.resolutionSource) : null),
    yes: { token: t0, price: p(yi), label: yn ? 'Yes' : lab(yi) }, no: { token: t1, price: p(ni), label: yn ? 'No' : lab(ni) }, yesNo: yn,
    groupTitle: str(m.groupItemTitle, 120) || null,
    bestBid: num(m.bestBid), bestAsk: num(m.bestAsk), lastTradePrice: num(m.lastTradePrice), dayChange: num(m.oneDayPriceChange),
    tick: num(m.orderPriceMinTickSize), minSize: num(m.orderMinSize), negRisk: m.negRisk === true, conditionId: typeof m.conditionId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.conditionId) ? m.conditionId : null,
    version: ver, enableOrderBook: m.enableOrderBook !== false,
    /* fees: the market's own feeSchedule (Polymarket: "use the feeSchedule object within the market data"); category table only as fallback */
    ...feeOf(m, cat), source: 'polymarket'
  };
}
/* r142: an event as Saturn shows it (Polymarket's card): one question, or several outcomes ranked by probability.
 * Card = top 2 outcomes; full (event page) = all open outcomes. Only real Polymarket prices; an outcome without a price is left out. */
const OUTCOME_KEYS = ['slug', 'question', 'groupTitle', 'yes', 'no', 'yesNo', 'dayChange', 'volume', 'volume24h', 'endDate', 'acceptingOrders', 'image'];
export function eventView(ev, full = false) {
  if (!ev || !Array.isArray(ev.markets) || typeof ev.slug !== 'string' || !SLUG.test(ev.slug)) return null;
  const ms = ev.markets.map(m => normMarket(m, ev)).filter(m => m && m.acceptingOrders && !m.closed && m.yes.price != null);
  if (!ms.length) return null;
  const multi = ms.length > 1;
  if (multi) ms.sort((a, b) => (b.yes.price - a.yes.price) || ((b.volume || 0) - (a.volume || 0)));
  const vol = num(ev.volume) ?? ms.reduce((a, m) => a + (m.volume || 0), 0), v24 = num(ev.volume24hr) ?? ms.reduce((a, m) => a + (m.volume24h || 0), 0);
  const ser = Array.isArray(ev.series) && ev.series[0] ? ev.series[0] : null;
  const moves = ms.map(m => m.dayChange).filter(x => x != null);
  const pick = m => Object.fromEntries(OUTCOME_KEYS.map(k => [k, m[k]]));
  const mover = ms.filter(m => m.dayChange != null).sort((a, b) => Math.abs(b.dayChange) - Math.abs(a.dayChange))[0] || null;
  return {
    slug: ev.slug, title: str(ev.title, 300) || ms[0].question, kind: multi ? 'multi' : 'single',
    image: url(ev.icon) || url(ev.image) || ms[0].image, category: ms[0].category, tags: ms[0].tags,
    volume: vol, volume24h: v24, liquidity: num(ev.liquidity), endDate: iso(ev.endDate) || ms[0].endDate, startDate: iso(ev.startDate),
    recurrence: ser && typeof ser.recurrence === 'string' && /^[a-z0-9-]{1,20}$/i.test(ser.recurrence) ? ser.recurrence.toLowerCase() : null,
    live: ev.live === true, negRisk: ev.negRisk === true, ended: ev.ended === true,
    score: str(ev.score, 40), gameStatus: str(ev.gameStatus, 40), period: str(ev.period, 20), startTime: iso(ev.startTime),
    league: (Array.isArray(ev.tags) ? ev.tags : []).map(t => t && t.label).filter(x => typeof x === 'string' && /^[A-Z0-9]{2,6}$/.test(x))[0] || null, maxMove: moves.length ? moves.reduce((a, x) => Math.abs(x) > Math.abs(a) ? x : a, 0) : null,
    mover: mover ? pick(mover) : null,   /* the outcome with the largest 24h move (Breaking shows this one) */
    count: ms.length, outcomes: (full ? ms.slice(0, 80) : ms.slice(0, 2)).map(pick),
    description: full ? (str(ev.description, 4000) || ms[0].description) : undefined, resolutionSource: full ? (url(ev.resolutionSource) || ms[0].resolutionSource) : undefined,
    source: 'polymarket'
  };
}
const eventCard = ev => eventView(ev, false);

/* walk the REAL ask side of the order book: spend `usd`, get shares at each level, never beyond the book */
export function quoteFromBook(book, usd, feeRate, feeExponent = 1) {
  const asks = (Array.isArray(book && book.asks) ? book.asks : []).map(l => ({ p: num(l.price), s: num(l.size) })).filter(l => l.p > 0 && l.p < 1 && l.s > 0).sort((a, b) => a.p - b.p);
  let left = usd, shares = 0, cost = 0, fee = 0, levels = 0, worst = null;
  for (const l of asks) {
    if (left <= 1e-9) break;
    const take = Math.min(l.s, left / l.p), c = take * l.p;
    shares += take; cost += c; left -= c; levels++; worst = l.p; fee += take * (feeRate || 0) * Math.pow(l.p * (1 - l.p), feeExponent || 1);
  }
  const best = asks.length ? asks[0].p : null, avg = shares > 0 ? cost / shares : null;
  return { bestAsk: best, avgPrice: avg != null ? +avg.toFixed(6) : null, worstPrice: worst, shares: +shares.toFixed(4), cost: +cost.toFixed(4), payout: +shares.toFixed(4),
    unfilledUsd: +Math.max(0, left).toFixed(4), fillable: left <= 1e-6, levels, feeEstimate: +fee.toFixed(5), slippagePct: best && avg ? +((avg - best) / best * 100).toFixed(3) : null,
    bookDepthUsd: +asks.reduce((a, l) => a + l.p * l.s, 0).toFixed(2), minOrderSize: num(book && book.min_order_size), tick: num(book && book.tick_size) };
}

export function createPmData({ fetchImpl = globalThis.fetch, limiter, now = Date.now, timeoutMs = 9000, metrics = null, log = () => {}, maxBodyBytes = 16 * 1024 * 1024, tradingState = null } = {}) {
  const cache = new Map();
  /* r139/r142 diagnostics: failures log host, path, the (public, key-free) query, HTTP status and a short sanitized body snippet, so the exact
   * Polymarket rejection reason is visible in Render logs. Credential-looking text is redacted; nothing of this reaches the public response. */
  const clean = t => String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|api[_-]?key|key|secret|passphrase|signature|password|auth\w*)\s*[=:]\s*\S+/gi, '$1=[redacted]').replace(/\S*secret\S*/gi, '[redacted]').slice(0, 300);
  async function get(base, path, ttl) {
    const u = base + path, k = u, c = cache.get(k), t = now();
    if (c && t - c.at < ttl) return c.v;
    const U = new URL(u), where = { host: U.host, path: U.pathname, query: U.search };
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(u, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' }, signal: ac.signal });
      if (!r.ok) {
        metrics?.inc('pm_http_' + r.status); let body = ''; try { body = clean(await r.text()); } catch {}
        const e = new Error('upstream_' + r.status); e.status = r.status; e.logged = true;
        log('prediction_upstream_failure', { ...where, status: r.status, reason: 'http_' + r.status, body }); throw e;
      }
      const txt = await r.text();
      if (txt.length > maxBodyBytes) { const e = new Error('body_too_large'); e.logged = true; log('prediction_upstream_failure', { ...where, status: null, reason: 'body_too_large', bytes: txt.length }); throw e; }
      let v; try { v = JSON.parse(txt); } catch { const e = new Error('bad_json'); e.logged = true; log('prediction_upstream_failure', { ...where, status: r.status, reason: 'bad_json', body: clean(txt.slice(0, 300)) }); throw e; }
      cache.set(k, { at: t, v }); if (cache.size > 800) cache.delete(cache.keys().next().value); return v;
    } catch (e) {
      if (!(e && e.logged)) log('prediction_upstream_failure', { ...where, status: null, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', code: e && e.code || null, name: e && e.name || 'Error' });
      throw e;
    } finally { clearTimeout(timer); }
  }
  /* r142: sort field per view, using Gamma's real JSON field names (volume24hr, startDate). A 4xx on a sort field falls back to the next one
   * (then unsorted) and the working field is remembered; every fallback is logged so a Polymarket API change shows up in Render logs. */
  const orderIx = { trending: 0, breaking: 0, new: 0 };
  const evQuery = (tag, offset, limit, o) => '/events?active=true&closed=false&archived=false' + (o ? '&order=' + o + '&ascending=false' : '') + '&limit=' + limit + '&offset=' + offset + (tag ? '&tag_slug=' + encodeURIComponent(tag) : '');
  async function events(tag, offset, limit, sort = 'trending', ttl = 30000) {
    const F = ORDER_FIELDS[sort] || ORDER_FIELDS.trending;
    for (let i = orderIx[sort] || 0; i < F.length; i++) {
      try { const v = await get(GAMMA, evQuery(tag, offset, limit, F[i]), ttl); orderIx[sort] = i; return v; }
      catch (e) { if (!(e && e.status >= 400 && e.status < 500) || i === F.length - 1) throw e; log('prediction_sort_fallback', { sort, from: F[i], to: F[i + 1], status: e.status }); }
    }
  }
  const BREAK_POOL = 100, BREAK_MIN_VOL24 = 5000, POOL_PAGE = 20;
  /* r143.1: live Gamma responses embed every market of every event; 100 events in one response exceeded the 16 MB cap in production
   * (prediction_upstream_failure reason=body_too_large, 2026-11-22). Read the pool in pages of 20; a page that fails is skipped, not fatal. */
  async function pool(sort, ttl) {
    const out = []; let ok = 0, lastErr = null;
    for (let off = 0; off < BREAK_POOL; off += POOL_PAGE) {
      try { const evs = await events(null, off, POOL_PAGE, sort, ttl); if (!Array.isArray(evs)) throw new Error('malformed'); ok++; out.push(...evs); if (evs.length < POOL_PAGE) break; }
      catch (e) { lastErr = e; }
    }
    if (!ok) throw lastErr || new Error('pool_failed');
    return out;
  }
  async function feed(cat, offset, limit, tagOverride = null) {
    const tags = tagOverride ? [tagOverride] : PM_CATEGORIES[cat]; if (!tags) throw Object.assign(new Error('bad_category'), { code: 400 });
    const sort = tagOverride ? 'trending' : SORT_OF(cat);
    if (sort === 'live') {
      /* Live = events Polymarket currently flags live (in-play games etc.), from the most traded open events */
      const evs = await pool('live', 30000);
      const all = evs.filter(e => e && e.live === true).map(eventCard).filter(Boolean);
      return { cat, sort, tag: null, offset, nextOffset: offset + limit < all.length ? offset + limit : null, markets: all.slice(offset, offset + limit) };
    }
    if (sort === 'breaking') {
      /* Breaking = biggest 24h probability moves among actively traded open events (Polymarket's oneDayPriceChange). */
      const evs = await pool('breaking', 60000);
      const all = evs.map(eventCard).filter(c => c && c.maxMove != null && Math.abs(c.maxMove) > 0 && (c.volume24h || 0) >= BREAK_MIN_VOL24)
        .sort((a, b) => Math.abs(b.maxMove) - Math.abs(a.maxMove));
      const page = all.slice(offset, offset + limit);
      return { cat, sort, tag: null, offset, nextOffset: offset + limit < all.length ? offset + limit : null, markets: page };
    }
    for (const tag of tags) {
      const evs = await events(tag, offset, limit, sort);
      if (!Array.isArray(evs)) throw new Error('malformed');
      const cards = evs.map(eventCard).filter(Boolean);
      if (cards.length || tag === tags[tags.length - 1]) return { cat, sort, tag, offset, nextOffset: evs.length === limit ? offset + limit : null, markets: cards };
    }
    return { cat, sort, offset, nextOffset: null, markets: [] };
  }
  /* sub-category chips: Polymarket's related tags for the category tag (GET /tags/slug/{slug}/related-tags/tags) */
  async function tags(cat) {
    const list = PM_CATEGORIES[cat]; if (!list) throw Object.assign(new Error('bad_category'), { code: 400 });
    if (!list[0]) return { cat, tags: [] };
    for (const t of list) {
      let r; try { r = await get(GAMMA, '/tags/slug/' + encodeURIComponent(t) + '/related-tags/tags', 3600000); } catch (e) { if (e && e.status === 404) continue; throw e; }
      const out = (Array.isArray(r) ? r : []).map(x => ({ slug: typeof x?.slug === 'string' && SLUG.test(x.slug) ? x.slug : null, label: str(x?.label, 40) }))
        .filter(x => x.slug && x.label && x.slug !== t).slice(0, 14);
      return { cat, tag: t, tags: out };
    }
    return { cat, tags: [] };
  }
  async function event(slug) {
    const r = await get(GAMMA, '/events?slug=' + encodeURIComponent(slug), 15000);
    const ev = Array.isArray(r) ? r[0] : null; if (!ev) throw Object.assign(new Error('not_found'), { code: 404 });
    const v = eventView(ev, true); if (!v) throw Object.assign(new Error('no_open_markets'), { code: 404 });
    v.pricesAt = Math.floor(now() / 1000); return v;
  }
  /* r143 crypto Up/Down: the current window's event by slug, plus the next window if the current one is not open yet. */
  async function updown(asset, interval) {
    const sec = UPDOWN.intervals[interval]; if (!sec || !UPDOWN.assets.includes(asset)) throw Object.assign(new Error('bad_updown'), { code: 400 });
    const t = Math.floor(now() / 1000), start = Math.floor(t / sec) * sec;
    for (const st of [start, start + sec]) {
      const slug = asset + '-updown-' + interval + '-' + st;
      const r = await get(GAMMA, '/events?slug=' + slug, 10000); const ev = Array.isArray(r) ? r[0] : null; if (!ev) continue;
      const v = eventView(ev, true); if (!v) continue;
      /* Polymarket publishes the window's opening price as the "price to beat". Field placement is not in the public docs; read it only from
       * known spots and send null otherwise — the app then shows no target rather than a guessed one. */
      const meta = [ev.eventMetadata, ev.markets && ev.markets[0] && ev.markets[0].eventMetadata, ev].find(o => o && typeof o === 'object' && num(o.priceToBeat) != null);
      return { ...v, asset, interval, windowStart: st, windowEnd: st + sec, priceToBeat: meta ? num(meta.priceToBeat) : null, priceToBeatSource: meta ? 'gamma:priceToBeat' : null };
    }
    throw Object.assign(new Error('no_open_window'), { code: 404 });
  }
  /* user positions from the public Data API (wallet address only; no auth) */
  async function positions(user) {
    const r = await get(DATA, '/v2/positions?user=' + user.toLowerCase() + '&limit=100', 5000);
    const rows = r && Array.isArray(r.data) ? r.data : Array.isArray(r) ? r : null; if (!rows) throw new Error('malformed');
    const pick = (o, ...ks) => { for (const k of ks) if (o[k] != null) return o[k]; return null; };
    return { user, source: 'polymarket data-api v2 positions', positions: rows.slice(0, 100).map(o => ({
      title: str(pick(o, 'title'), 300), outcome: str(pick(o, 'outcome'), 60), slug: str(pick(o, 'slug'), 200), eventSlug: str(pick(o, 'eventSlug', 'event_slug'), 200),
      icon: url(pick(o, 'icon')), asset: tokId(pick(o, 'asset', 'token_id', 'tokenId')), conditionId: str(pick(o, 'conditionId', 'condition_id'), 66),
      size: num(pick(o, 'size')), avgPrice: num(pick(o, 'avgPrice', 'avg_price')), curPrice: num(pick(o, 'curPrice', 'cur_price')),
      initialValue: num(pick(o, 'initialValue', 'initial_value')), currentValue: num(pick(o, 'currentValue', 'current_value')),
      cashPnl: num(pick(o, 'cashPnl', 'cash_pnl')), percentPnl: num(pick(o, 'percentPnl', 'percent_pnl')), redeemable: pick(o, 'redeemable') === true,
      endDate: iso(pick(o, 'endDate', 'end_date')) })).filter(p => p.title && p.size != null) };
  }
  async function search(qs) {
    const r = await get(GAMMA, '/public-search?q=' + encodeURIComponent(qs) + '&limit_per_type=12&events_status=active', 30000);
    const evs = r && Array.isArray(r.events) ? r.events : [];
    return { q: qs, markets: evs.map(eventCard).filter(Boolean).slice(0, 20) };
  }
  /* r142 live self-check: one real request to Polymarket, result kept for /v1/pm/status and written to the server log (no secrets, no bodies). */
  let lastCheck = null;
  async function selfCheck() {
    const t0 = now();
    try {
      const f = await feed('trending', 0, 5);
      const o = f.markets.reduce((a, c) => a + c.outcomes.length, 0), priced = f.markets.every(c => c.outcomes.every(x => x.yes.price != null && x.yes.token));
      lastCheck = { ok: f.markets.length > 0 && priced, at: Math.floor(now() / 1000), ms: now() - t0, events: f.markets.length, outcomes: o, sample: f.markets[0] ? f.markets[0].title.slice(0, 80) : null, sortField: ORDER_FIELDS.trending[orderIx.trending] };
    } catch (e) { lastCheck = { ok: false, at: Math.floor(now() / 1000), ms: now() - t0, status: Number.isInteger(e && e.status) ? e.status : null, name: e && e.name || 'Error' }; }
    log('prediction_selfcheck', lastCheck); return lastCheck;
  }
  async function market(slug) {
    const ms = await get(GAMMA, '/markets?slug=' + encodeURIComponent(slug), 15000);
    const raw = Array.isArray(ms) ? ms[0] : null; if (!raw) throw Object.assign(new Error('not_found'), { code: 404 });
    let ev = null;
    const evs = Array.isArray(raw.events) ? raw.events : [];
    if (evs[0] && typeof evs[0].slug === 'string' && SLUG.test(evs[0].slug)) { try { const e = await get(GAMMA, '/events?slug=' + encodeURIComponent(evs[0].slug), 60000); ev = Array.isArray(e) ? e[0] : null; } catch { ev = evs[0]; } }
    const m = normMarket(raw, ev || evs[0] || null); if (!m) throw Object.assign(new Error('unsupported_market'), { code: 422 });
    /* live best prices from the order book (BUY = lowest ask) */
    const live = {};
    for (const [k, tok] of [['yes', m.yes.token], ['no', m.no.token]]) {
      try { const r = await get(CLOB, '/price?token_id=' + tok + '&side=BUY', 5000); const v = num(r && r.price); live[k] = v != null && v > 0 && v < 1 ? v : null; } catch { live[k] = null; }
    }
    m.yes.buy = live.yes; m.no.buy = live.no; m.pricesAt = Math.floor(now() / 1000);
    return m;
  }
  async function history(token, range) {
    const R = RANGES[range]; if (!R) throw Object.assign(new Error('bad_range'), { code: 400 });
    const pts = []; let cursor = null;
    for (let page = 0; page < 4; page++) {
      const r = await get(DATA, '/v2/prices-history?token_id=' + token + '&interval=' + R[0] + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), range === '1d' ? 60000 : 300000);
      const d = r && Array.isArray(r.data) ? r.data : null; if (!d) throw new Error('malformed');
      for (const x of d) { const t = num(x.timestamp), p = num(x.price); if (t > 0 && p != null && p >= 0 && p <= 1) pts.push({ t, p }); }
      cursor = r.pagination && r.pagination.has_more ? r.pagination.next_cursor : null; if (!cursor) break;
    }
    pts.sort((a, b) => a.t - b.t);
    return { token, range, source: 'polymarket:data-api/v2/prices-history', points: pts };
  }
  async function quote(slug, outcome, usd) {
    const m = await market(slug), side = outcome === 'no' ? m.no : m.yes;
    if (!m.acceptingOrders) throw Object.assign(new Error('market_closed'), { code: 409 });
    const book = await get(CLOB, '/book?token_id=' + side.token, 4000);
    const q = quoteFromBook(book, usd, m.feeRate, m.feeExponent);
    return { slug, outcome, usd, token: side.token, question: m.question, ...q, feeRate: m.feeRate, feeCategory: m.feeCategory,
      feeNote: 'Estimate: Polymarket taker fee = shares × ' + m.feeRate + ' × price × (1 − price)' + (m.feeExponent !== 1 ? '^' + m.feeExponent : '') + ' (' + (m.feeSource === 'market:feeSchedule' ? 'this market’s fee schedule' : m.feeSource === 'category-table' ? m.feeCategory + ' category rate' : 'fees off') + '), charged at match time.',
      version: m.version, negRisk: m.negRisk, tick: q.tick ?? m.tick, minOrderSize: q.minOrderSize ?? m.minSize, conditionId: m.conditionId, bestAskAt: Math.floor(now() / 1000),
      quotedAt: Math.floor(now() / 1000), source: 'polymarket:clob/book' };
  }

  async function handle(path, q, ip) {
    try {
      if (limiter && limiter(ip + '|pm', 120)) return [429, { ok: false, error: 'rate_limited' }];
      if (path === '/v1/pm/status') return [200, { ok: true, trading: tradingState ? tradingState.enabled : false, reason: tradingState ? tradingState.reason : 'Trading module not loaded.', network: 'polygon', collateral: 'pUSD', feeRates: PM_FEE_RATES, categories: Object.keys(PM_CATEGORIES), lastCheck }];
      if (path === '/v1/pm/feed') {
        const cat = String(q.get('cat') || 'trending'), off = Math.max(0, Math.min(500, Number.parseInt(q.get('offset') || '0', 10) || 0)), lim = Math.max(1, Math.min(20, Number.parseInt(q.get('limit') || '8', 10) || 8));
        const tg = q.get('tag'); if (tg != null && !SLUG.test(tg)) return [400, { ok: false, error: 'bad_tag' }];
        if (!PM_CATEGORIES[cat]) return [400, { ok: false, error: 'bad_category' }];
        return [200, { ok: true, ...(await feed(cat, off, lim, tg || null)) }];
      }
      if (path === '/v1/pm/updown') { const a = String(q.get('asset') || 'btc'), iv = String(q.get('interval') || '15m'); return [200, { ok: true, event: await updown(a, iv) }]; }
      if (path === '/v1/pm/positions') { const u = String(q.get('user') || ''); if (!ADDR.test(u)) return [400, { ok: false, error: 'bad_user' }]; return [200, { ok: true, ...(await positions(u)) }]; }
      if (path === '/v1/pm/tags') { const cat = String(q.get('cat') || ''); if (!PM_CATEGORIES[cat]) return [400, { ok: false, error: 'bad_category' }]; return [200, { ok: true, ...(await tags(cat)) }]; }
      if (path === '/v1/pm/event') { const s = String(q.get('slug') || ''); if (!SLUG.test(s)) return [400, { ok: false, error: 'bad_slug' }]; return [200, { ok: true, event: await event(s) }]; }
      if (path === '/v1/pm/search') { const s = String(q.get('q') || '').trim(); if (s.length < 2 || s.length > 80) return [400, { ok: false, error: 'bad_query' }]; return [200, { ok: true, ...(await search(s)) }]; }
      if (path === '/v1/pm/market') { const s = String(q.get('slug') || ''); if (!SLUG.test(s)) return [400, { ok: false, error: 'bad_slug' }]; return [200, { ok: true, market: await market(s) }]; }
      if (path === '/v1/pm/history') { const t = String(q.get('token') || ''); if (!TOKEN.test(t)) return [400, { ok: false, error: 'bad_token' }]; return [200, { ok: true, ...(await history(t, String(q.get('range') || '1w'))) }]; }
      if (path === '/v1/pm/quote') {
        const s = String(q.get('slug') || ''), o = String(q.get('outcome') || ''), usd = Number(q.get('usd'));
        if (!SLUG.test(s) || !['yes', 'no'].includes(o) || !(usd >= 1 && usd <= 100000)) return [400, { ok: false, error: 'bad_request' }];
        if (limiter && limiter(ip + '|pm-quote', 60)) return [429, { ok: false, error: 'rate_limited' }];
        return [200, { ok: true, quote: await quote(s, o, Math.round(usd * 100) / 100) }];
      }
      return [404, { ok: false, error: 'not_found' }];
    } catch (e) {
      if (e && e.code >= 400 && e.code < 500) return [e.code, { ok: false, error: e.message }];
      /* Polymarket is rate-limiting or temporarily unavailable: say so (503) instead of a generic failure; the app shows an honest message. */
      if (e && (e.status === 429 || e.status === 503)) { metrics?.inc('pm_busy'); log('prediction_request_failed', { route: path, status: e.status, reason: 'polymarket_busy' }); return [503, { ok: false, error: 'polymarket_busy' }]; }
      metrics?.inc('pm_error');
      log('prediction_request_failed', {
        route: path,
        status: Number.isInteger(e && e.status) ? e.status : null,
        code: e && e.code || null,
        name: e && e.name || 'Error'
      });
      return [502, { ok: false, error: 'polymarket_unavailable' }];
    }
  }
  return Object.freeze({ handle, feed, tags, event, search, market, history, quote, updown, positions, selfCheck, get lastCheck() { return lastCheck; } });
}

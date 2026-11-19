/* r137 Saturn Prediction — READ-ONLY Polymarket data service (no keys, no signing, no orders).
 * Sources (all public, official Polymarket APIs):
 *   Gamma   https://gamma-api.polymarket.com   discovery, market metadata (events, markets, public-search)
 *   CLOB    https://clob.polymarket.com        live order books and best prices (/book, /price)
 *   Data    https://data-api.polymarket.com    probability history (/v2/prices-history)
 * Everything returned to the app is Polymarket's own data, normalised. Quotes are computed by walking the REAL order book; the only
 * estimate is Polymarket's taker fee (its published category rate x shares x p x (1-p)), and it is labelled as an estimate.
 * Routes (GET only):  /v1/pm/status · /v1/pm/feed?cat=&offset= · /v1/pm/search?q= · /v1/pm/market?slug= · /v1/pm/history?token=&range= · /v1/pm/quote?slug=&outcome=&usd=
 * Trading is NOT implemented here: execution needs a Polymarket Builder account and a per-user Deposit Wallet (Polygon, pUSD). */
export const PM_HOSTS = Object.freeze(['gamma-api.polymarket.com', 'clob.polymarket.com', 'data-api.polymarket.com']);
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com', DATA = 'https://data-api.polymarket.com';

/* Polymarket's published taker fee rates by market category (docs.polymarket.com/trading/fees). Used ONLY for the labelled fee estimate. */
export const PM_FEE_RATES = Object.freeze({ crypto: 0.07, sports: 0.05, politics: 0.04, finance: 0.04, tech: 0.04, mentions: 0.04, economics: 0.05, culture: 0.05, weather: 0.05, geopolitics: 0, other: 0.05 });
/* Saturn categories -> Polymarket tag slugs, tried in order until one returns markets */
export const PM_CATEGORIES = Object.freeze({
  trending: [null], crypto: ['crypto'], politics: ['politics'], sports: ['sports'], technology: ['tech', 'technology', 'ai'],
  business: ['business', 'economy', 'finance'], world: ['world', 'geopolitics']
});
const RANGES = Object.freeze({ '1d': ['1d', 300], '1w': ['1w', 3600], '1m': ['1m', 14400], all: ['max', 86400] });
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/, TOKEN = /^[0-9]{6,90}$/;
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

/* a Gamma market -> Saturn's shape. Only binary Yes/No markets with two outcome tokens are kept. */
export function normMarket(m, ev = null) {
  if (!m || typeof m !== 'object') return null;
  const outcomes = arr(m.outcomes), tokens = arr(m.clobTokenIds) || (Array.isArray(m.positionIds) ? m.positionIds : null), prices = arr(m.outcomePrices);
  if (!outcomes || outcomes.length !== 2 || !tokens || tokens.length !== 2) return null;
  const o0 = String(outcomes[0]).toLowerCase(), o1 = String(outcomes[1]).toLowerCase();
  if (!((o0 === 'yes' && o1 === 'no') || (o0 === 'no' && o1 === 'yes'))) return null;
  const yi = o0 === 'yes' ? 0 : 1, ni = 1 - yi, t0 = String(tokens[yi]), t1 = String(tokens[ni]);
  if (!TOKEN.test(t0) || !TOKEN.test(t1)) return null;
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
    yes: { token: t0, price: p(yi) }, no: { token: t1, price: p(ni) },
    bestBid: num(m.bestBid), bestAsk: num(m.bestAsk), lastTradePrice: num(m.lastTradePrice), dayChange: num(m.oneDayPriceChange),
    tick: num(m.orderPriceMinTickSize), minSize: num(m.orderMinSize), negRisk: m.negRisk === true, conditionId: typeof m.conditionId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.conditionId) ? m.conditionId : null,
    feeRate: PM_FEE_RATES[cat], feeCategory: cat, source: 'polymarket'
  };
}
/* one card per event: its most traded open binary market */
function eventCard(ev) {
  if (!ev || !Array.isArray(ev.markets)) return null;
  const ms = ev.markets.map(m => normMarket(m, ev)).filter(m => m && m.acceptingOrders && !m.closed);
  if (!ms.length) return null;
  ms.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0) || (b.volume || 0) - (a.volume || 0));
  const c = ms[0]; c.eventMarkets = ms.length; return c;
}

/* walk the REAL ask side of the order book: spend `usd`, get shares at each level, never beyond the book */
export function quoteFromBook(book, usd, feeRate) {
  const asks = (Array.isArray(book && book.asks) ? book.asks : []).map(l => ({ p: num(l.price), s: num(l.size) })).filter(l => l.p > 0 && l.p < 1 && l.s > 0).sort((a, b) => a.p - b.p);
  let left = usd, shares = 0, cost = 0, fee = 0, levels = 0, worst = null;
  for (const l of asks) {
    if (left <= 1e-9) break;
    const take = Math.min(l.s, left / l.p), c = take * l.p;
    shares += take; cost += c; left -= c; levels++; worst = l.p; fee += take * (feeRate || 0) * l.p * (1 - l.p);
  }
  const best = asks.length ? asks[0].p : null, avg = shares > 0 ? cost / shares : null;
  return { bestAsk: best, avgPrice: avg != null ? +avg.toFixed(6) : null, worstPrice: worst, shares: +shares.toFixed(4), cost: +cost.toFixed(4), payout: +shares.toFixed(4),
    unfilledUsd: +Math.max(0, left).toFixed(4), fillable: left <= 1e-6, levels, feeEstimate: +fee.toFixed(5), slippagePct: best && avg ? +((avg - best) / best * 100).toFixed(3) : null,
    bookDepthUsd: +asks.reduce((a, l) => a + l.p * l.s, 0).toFixed(2), minOrderSize: num(book && book.min_order_size), tick: num(book && book.tick_size) };
}

export function createPmData({ fetchImpl = globalThis.fetch, limiter, now = Date.now, timeoutMs = 9000, metrics = null } = {}) {
  const cache = new Map();
  async function get(base, path, ttl) {
    const u = base + path, k = u, c = cache.get(k), t = now();
    if (c && t - c.at < ttl) return c.v;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(u, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' }, signal: ac.signal });
      if (!r.ok) { metrics?.inc('pm_http_' + r.status); const e = new Error('upstream_' + r.status); e.status = r.status; throw e; }
      const txt = await r.text(); if (txt.length > 4 * 1024 * 1024) throw new Error('body_too_large');
      const v = JSON.parse(txt); cache.set(k, { at: t, v }); if (cache.size > 800) cache.delete(cache.keys().next().value); return v;
    } finally { clearTimeout(timer); }
  }
  /* the docs name the sort field volume_24hr; older deployments used volume24hr. Try both, then unsorted, and remember what worked. */
  const ORDERS = ['volume_24hr', 'volume24hr', null]; let orderIx = 0;
  const evQuery = (tag, offset, limit, o) => '/events?active=true&closed=false&archived=false' + (o ? '&order=' + o + '&ascending=false' : '') + '&limit=' + limit + '&offset=' + offset + (tag ? '&tag_slug=' + encodeURIComponent(tag) : '');
  async function events(tag, offset, limit) {
    for (let i = orderIx; i < ORDERS.length; i++) {
      try { const v = await get(GAMMA, evQuery(tag, offset, limit, ORDERS[i]), 30000); orderIx = i; return v; }
      catch (e) { if (!(e && e.status >= 400 && e.status < 500) || i === ORDERS.length - 1) throw e; }
    }
  }

  async function feed(cat, offset, limit) {
    const tags = PM_CATEGORIES[cat]; if (!tags) throw Object.assign(new Error('bad_category'), { code: 400 });
    for (const tag of tags) {
      const evs = await events(tag, offset, limit);
      if (!Array.isArray(evs)) throw new Error('malformed');
      const cards = evs.map(eventCard).filter(Boolean);
      if (cards.length || tag === tags[tags.length - 1]) return { cat, tag, offset, nextOffset: evs.length === limit ? offset + limit : null, markets: cards };
    }
    return { cat, offset, nextOffset: null, markets: [] };
  }
  async function search(qs) {
    const r = await get(GAMMA, '/public-search?q=' + encodeURIComponent(qs) + '&limit_per_type=12&events_status=active', 30000);
    const evs = r && Array.isArray(r.events) ? r.events : [];
    return { q: qs, markets: evs.map(eventCard).filter(Boolean).slice(0, 20) };
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
      const r = await get(DATA, '/v2/prices-history?token_id=' + token + '&interval=' + R[0] + '&bucket_seconds=' + R[1] + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), range === '1d' ? 60000 : 300000);
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
    const q = quoteFromBook(book, usd, m.feeRate);
    return { slug, outcome, usd, token: side.token, question: m.question, ...q, feeRate: m.feeRate, feeCategory: m.feeCategory,
      feeNote: 'Estimate: Polymarket charges takers ' + (m.feeRate * 100).toFixed(0) + '% x shares x price x (1 - price) on ' + m.feeCategory + ' markets, set at match time.',
      quotedAt: Math.floor(now() / 1000), source: 'polymarket:clob/book' };
  }

  async function handle(path, q, ip) {
    try {
      if (limiter && limiter(ip + '|pm', 120)) return [429, { ok: false, error: 'rate_limited' }];
      if (path === '/v1/pm/status') return [200, { ok: true, trading: false, reason: 'Prediction trading is not enabled in Saturn yet. Prices and charts are live Polymarket data.', network: 'polygon', collateral: 'pUSD', feeRates: PM_FEE_RATES }];
      if (path === '/v1/pm/feed') {
        const cat = String(q.get('cat') || 'trending'), off = Math.max(0, Math.min(500, Number.parseInt(q.get('offset') || '0', 10) || 0)), lim = Math.max(1, Math.min(20, Number.parseInt(q.get('limit') || '8', 10) || 8));
        return [200, { ok: true, ...(await feed(cat, off, lim)) }];
      }
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
      metrics?.inc('pm_error'); return [502, { ok: false, error: 'polymarket_unavailable' }];
    }
  }
  return Object.freeze({ handle, feed, search, market, history, quote });
}

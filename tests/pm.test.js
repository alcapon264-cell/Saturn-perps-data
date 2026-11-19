/* r137 Saturn Prediction — read-only Polymarket data module. OFFLINE: scripted Polymarket responses shaped like the official APIs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPmData, normMarket, quoteFromBook, PM_FEE_RATES } from '../src/pm-data.js';

const YES = '1'.repeat(70), NO = '2'.repeat(70);
const mkt = (o = {}) => ({ id: '501', slug: 'will-bitcoin-reach-150k-before-2027', question: 'Will Bitcoin reach $150,000 before 2027?', outcomes: '["Yes", "No"]', outcomePrices: '["0.07", "0.93"]',
  clobTokenIds: JSON.stringify([YES, NO]), endDate: '2026-12-31T23:59:00Z', active: true, closed: false, acceptingOrders: true, volumeNum: 4200000, volume24hr: 120000, liquidityNum: 620000,
  description: 'Resolves Yes if Bitcoin trades at or above $150,000 ...', orderPriceMinTickSize: 0.01, orderMinSize: 5, negRisk: false, conditionId: '0x' + 'ab'.repeat(32), icon: 'https://polymarket-upload.s3.amazonaws.com/btc.png', ...o });
const ev = (o = {}) => ({ id: '9', slug: 'bitcoin-150k', title: 'Bitcoin $150k?', tags: [{ slug: 'crypto', label: 'Crypto' }], markets: [mkt()], ...o });

function fakeFetch(routes, log = []) {
  return async (u) => { log.push(u); for (const [re, fn] of routes) { const m = u.match(re); if (m) { const r = await fn(u, m); return new Response(typeof r === 'string' ? r : JSON.stringify(r.body ?? r), { status: r.status || 200 }); } } return new Response('{}', { status: 404 }); };
}

test('normMarket: JSON-encoded outcomes/prices/token ids; Yes/No order respected; non-binary or malformed markets rejected', () => {
  const m = normMarket(mkt(), ev());
  assert.equal(m.yes.token, YES); assert.equal(m.no.token, NO); assert.equal(m.yes.price, 0.07); assert.equal(m.no.price, 0.93);
  assert.equal(m.category, 'crypto'); assert.equal(m.feeRate, 0.07); assert.equal(m.endDate, '2026-12-31T23:59:00.000Z'); assert.equal(m.volume, 4200000);
  const flipped = normMarket(mkt({ outcomes: '["No","Yes"]', outcomePrices: '["0.93","0.07"]', clobTokenIds: JSON.stringify([NO, YES]) }), ev());
  assert.equal(flipped.yes.token, YES); assert.equal(flipped.yes.price, 0.07, 'Yes is always Yes even when Polymarket lists No first');
  assert.equal(normMarket(mkt({ outcomes: '["Trump","Harris"]' }), ev()), null);
  assert.equal(normMarket(mkt({ clobTokenIds: '[]' }), ev()), null);
  assert.equal(normMarket(mkt({ slug: 'Bad Slug!' }), ev()), null);
  assert.equal(normMarket(mkt({ icon: 'javascript:alert(1)', image: null }), ev()).image, null, 'only https images');
  const v2 = normMarket(mkt({ clobTokenIds: null, positionIds: [YES, NO] }), ev()); assert.equal(v2.yes.token, YES, 'v2 markets carry positionIds');
});

test('quoteFromBook walks the real asks; fee = Polymarket formula shares x rate x p x (1-p) (docs example $50 crypto at 0.50 -> $1.75)', () => {
  const q = quoteFromBook({ asks: [{ price: '0.50', size: '1000' }], min_order_size: '5', tick_size: '0.01' }, 50, PM_FEE_RATES.crypto);
  assert.equal(q.shares, 100); assert.equal(q.avgPrice, 0.5); assert.equal(q.payout, 100); assert.equal(q.feeEstimate, 1.75); assert.equal(q.fillable, true);
  const w = quoteFromBook({ asks: [{ price: '0.08', size: '100' }, { price: '0.07', size: '200' }, { price: '0.09', size: '1000' }] }, 25, 0.07);
  assert.equal(w.bestAsk, 0.07); assert.equal(w.levels, 3, 'cheapest first: 0.07, 0.08, then 0.09'); assert.ok(Math.abs(w.shares - (200 + 100 + 3 / 0.09)) < 1e-3); assert.equal(w.worstPrice, 0.09);
  assert.ok(w.avgPrice > 0.07 && w.avgPrice < 0.08); assert.ok(w.slippagePct > 0);
  const thin = quoteFromBook({ asks: [{ price: '0.5', size: '10' }] }, 100, 0.04); assert.equal(thin.fillable, false); assert.equal(thin.unfilledUsd, 95);
  const none = quoteFromBook({ asks: [] }, 10, 0.04); assert.equal(none.shares, 0); assert.equal(none.avgPrice, null); assert.equal(none.fillable, false);
});

test('feed: one card per event (its most traded open binary market), category tag fallback, sort-field fallback, pagination', async () => {
  const log = [];
  const pm = createPmData({ fetchImpl: fakeFetch([
    [/order=volume_24hr/, () => ({ status: 422, body: { error: 'bad order' } })],
    [/tag_slug=tech$/, () => []],
    [/tag_slug=technology$/, () => [ev({ slug: 'ai-x', tags: [{ slug: 'tech' }], markets: [mkt({ slug: 'will-ai-x', question: 'Will AI X?' })] })]],
    [/\/events\?active=true/, () => [ev({ markets: [mkt({ slug: 'small', volume24hr: 10 }), mkt({ slug: 'big', volume24hr: 999 }), mkt({ slug: 'shut', closed: true, volume24hr: 5000 })] }), ev({ slug: 'multi', markets: [mkt({ outcomes: '["A","B"]' })] })]]
  ], log) });
  const f = await pm.feed('trending', 0, 2);
  assert.equal(f.markets.length, 1); assert.equal(f.markets[0].slug, 'big'); assert.equal(f.markets[0].eventMarkets, 2); assert.equal(f.nextOffset, 2);
  assert.ok(log.some(u => u.includes('order=volume_24hr')) && log.some(u => u.includes('order=volume24hr')), 'falls back to the older sort field');
  const t = await pm.feed('technology', 0, 8); assert.equal(t.tag, 'technology'); assert.equal(t.markets[0].slug, 'will-ai-x');
  await assert.rejects(pm.feed('casino', 0, 8));
});

test('market + live prices from the CLOB order book; history pages merged oldest-first; quote uses the book of the chosen outcome', async () => {
  const log = [];
  const pm = createPmData({ fetchImpl: fakeFetch([
    [/\/markets\?slug=/, () => [mkt({ events: [{ slug: 'bitcoin-150k' }] })]],
    [/\/events\?slug=bitcoin-150k/, () => [ev()]],
    [new RegExp('/price\\?token_id=' + YES), () => ({ price: '0.071' })],
    [new RegExp('/price\\?token_id=' + NO), () => ({ price: '0.94' })],
    [/prices-history.*cursor=c2/, () => ({ data: [{ timestamp: 300, price: 0.07, resolution_seconds: 3600 }], pagination: { has_more: false } })],
    [/prices-history/, () => ({ data: [{ timestamp: 100, price: 0.05 }, { timestamp: 200, price: 0.06 }, { timestamp: 250, price: 7 }], pagination: { has_more: true, next_cursor: 'c2' } })],
    [new RegExp('/book\\?token_id=' + NO), () => ({ asks: [{ price: '0.94', size: '1000' }], min_order_size: '5', tick_size: '0.01' })],
  ], log) });
  const m = await pm.market('will-bitcoin-reach-150k-before-2027');
  assert.equal(m.yes.buy, 0.071); assert.equal(m.no.buy, 0.94); assert.equal(m.category, 'crypto');
  const h = await pm.history(YES, '1w'); assert.deepEqual(h.points.map(p => p.t), [100, 200, 300], 'out-of-range price dropped, pages merged');
  assert.ok(log.some(u => u.includes('interval=1w') && u.includes('bucket_seconds=3600')));
  const q = await pm.quote('will-bitcoin-reach-150k-before-2027', 'no', 94);
  assert.equal(q.token, NO); assert.equal(q.shares, 100); assert.equal(q.payout, 100); assert.ok(Math.abs(q.feeEstimate - 100 * 0.07 * 0.94 * 0.06) < 1e-4); assert.match(q.feeNote, /^Estimate/);
});

test('handle(): strict validation, rate limits, upstream failure -> 502 without leaking details, status says trading is off', async () => {
  let n = 0; const limiter = () => ++n > 1000;
  const pm = createPmData({ limiter, fetchImpl: async () => { throw new Error('boom secret detail'); } });
  assert.equal((await pm.handle('/v1/pm/market', new URLSearchParams('slug=Bad%20Slug'), '1.1.1.1'))[0], 400);
  assert.equal((await pm.handle('/v1/pm/history', new URLSearchParams('token=abc'), '1.1.1.1'))[0], 400);
  assert.equal((await pm.handle('/v1/pm/quote', new URLSearchParams('slug=a-b&outcome=maybe&usd=5'), '1.1.1.1'))[0], 400);
  assert.equal((await pm.handle('/v1/pm/quote', new URLSearchParams('slug=a-b&outcome=yes&usd=0.5'), '1.1.1.1'))[0], 400);
  assert.equal((await pm.handle('/v1/pm/search', new URLSearchParams('q=a'), '1.1.1.1'))[0], 400);
  const [c, b] = await pm.handle('/v1/pm/feed', new URLSearchParams('cat=crypto'), '1.1.1.1'); assert.equal(c, 502); assert.equal(b.error, 'polymarket_unavailable'); assert.ok(!JSON.stringify(b).includes('secret'));
  const [s, st] = await pm.handle('/v1/pm/status', new URLSearchParams(), '1.1.1.1'); assert.equal(s, 200); assert.equal(st.trading, false);
  const lim = createPmData({ limiter: () => true, fetchImpl: async () => new Response('[]') }); assert.equal((await lim.handle('/v1/pm/feed', new URLSearchParams(), '1.1.1.1'))[0], 429);
});

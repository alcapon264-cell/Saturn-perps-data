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
  const ud = normMarket(mkt({ outcomes: '["Up","Down"]', outcomePrices: '["0.82","0.18"]' }), ev());   /* r142: any two-outcome market, labelled */
  assert.equal(ud.yes.label, 'Up'); assert.equal(ud.no.label, 'Down'); assert.equal(ud.yes.price, 0.82); assert.equal(ud.yesNo, false);
  assert.equal(m.yes.label, 'Yes'); assert.equal(m.yesNo, true);
  assert.equal(normMarket(mkt({ outcomes: '["A","B","C"]' }), ev()), null, 'three outcomes in one market are not shown');
  assert.equal(normMarket(mkt({ clobTokenIds: '[]' }), ev()), null);
  assert.equal(normMarket(mkt({ slug: 'Bad Slug!' }), ev()), null);
  assert.equal(normMarket(mkt({ icon: 'javascript:alert(1)', image: null }), ev()).image, null, 'only https images');
  const v2 = normMarket(mkt({ version: 'v2', clobTokenIds: JSON.stringify(['3'.repeat(70), '4'.repeat(70)]), positionIds: [YES, NO] }), ev());
  assert.equal(v2.yes.token, YES, 'r143: version "v2" trades by positionIds even when clobTokenIds is also present'); assert.equal(v2.version, 'v2');
  assert.equal(normMarket(mkt({ version: 'v2', positionIds: null }), ev()), null, 'v2 without position ids is not tradable');
  assert.equal(normMarket(mkt({ version: 'v3' }), ev()), null, 'unknown versions are unsupported');
  assert.equal(normMarket(mkt(), ev()).version, 'v1');
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

test('r142 feed: Gamma field volume24hr is used first (volume_24hr gave HTTP 422 in production); 4xx falls back to unsorted and is logged', async () => {
  const log = [], logs = [];
  const pm = createPmData({ log: (n, d) => logs.push([n, d]), fetchImpl: fakeFetch([
    [/order=volume24hr/, () => ({ status: 422, body: { error: 'bad order' } })],
    [/tag_slug=tech$/, () => []],
    [/tag_slug=technology$/, () => [ev({ slug: 'ai-x', tags: [{ slug: 'tech' }], markets: [mkt({ slug: 'will-ai-x', question: 'Will AI X?' })] })]],
    [/\/events\?active=true/, () => [ev({ markets: [mkt({ slug: 'shut', closed: true, volume24hr: 5000 })] }), ev({ slug: 'three-way', markets: [mkt({ outcomes: '["A","B","C"]' })] }), ev({ slug: 'ok-one' })]]
  ], log) });
  const f = await pm.feed('trending', 0, 3);
  assert.ok(log[0].includes('order=volume24hr&ascending=false'), 'first request uses Gamma field name volume24hr');
  assert.ok(!log.some(u => u.includes('volume_24hr')), 'the invalid field is never sent');
  assert.equal(f.markets.length, 1, 'closed-only and 3-outcome events are skipped'); assert.equal(f.markets[0].slug, 'ok-one'); assert.equal(f.nextOffset, 3);
  assert.ok(logs.some(([n, d]) => n === 'prediction_sort_fallback' && d.from === 'volume24hr' && d.status === 422));
  const t = await pm.feed('tech', 0, 8); assert.equal(t.tag, 'technology'); assert.equal(t.markets[0].slug, 'ai-x');
  await assert.rejects(pm.feed('casino', 0, 8));
});

test('r142 events: multi-outcome events ranked by probability (card = top 2, event page = all); single markets keep their own outcome names', async () => {
  const A = '3'.repeat(70), B = '4'.repeat(70), C = '5'.repeat(70), D = '6'.repeat(70), E = '7'.repeat(70), G = '8'.repeat(70);
  const nominee = ev({ slug: 'democratic-nominee-2028', title: 'Democratic Presidential Nominee 2028', volume: 1.0e9, volume24hr: 2.2e6, negRisk: true, series: [{ recurrence: 'weekly' }], markets: [
    mkt({ slug: 'aoc', question: 'Will AOC win?', groupItemTitle: 'Alexandria Ocasio-Cortez', outcomePrices: '["0.14","0.86"]', clobTokenIds: JSON.stringify([A, B]), oneDayPriceChange: -0.02 }),
    mkt({ slug: 'ossoff', question: 'Will Ossoff win?', groupItemTitle: 'Jon Ossoff', outcomePrices: '["0.26","0.74"]', clobTokenIds: JSON.stringify([C, D]), oneDayPriceChange: 0.05 }),
    mkt({ slug: 'x-other', question: 'Will X win?', groupItemTitle: 'X', outcomePrices: '["0.02","0.98"]', clobTokenIds: JSON.stringify([E, G]) }),
    mkt({ slug: 'no-price', question: 'Will Y win?', outcomePrices: null })] });
  const updown = ev({ slug: 'btc-updown-5m', title: 'BTC Up or Down 5m', markets: [mkt({ slug: 'btc-updown-5m-1', question: 'BTC Up or Down 5m', outcomes: '["Up","Down"]', outcomePrices: '["0.82","0.18"]' })] });
  const pm = createPmData({ fetchImpl: fakeFetch([
    [/\/events\?slug=democratic-nominee-2028/, () => [nominee]],
    [/\/events\?active=true/, () => [nominee, updown]]
  ]) });
  const f = await pm.feed('politics', 0, 8);
  const c = f.markets[0];
  assert.equal(c.kind, 'multi'); assert.equal(c.count, 3, 'outcome without a real price is left out'); assert.equal(c.outcomes.length, 2);
  assert.deepEqual(c.outcomes.map(o => o.groupTitle), ['Jon Ossoff', 'Alexandria Ocasio-Cortez'], 'highest probability first');
  assert.equal(c.outcomes[0].yes.price, 0.26); assert.equal(c.volume, 1.0e9); assert.equal(c.recurrence, 'weekly'); assert.equal(c.maxMove, 0.05); assert.equal(c.mover.groupTitle, 'Jon Ossoff');
  const s = f.markets[1]; assert.equal(s.kind, 'single'); assert.equal(s.outcomes[0].yes.label, 'Up'); assert.equal(s.outcomes[0].no.label, 'Down');
  const full = await pm.event('democratic-nominee-2028'); assert.equal(full.outcomes.length, 3); assert.equal(full.outcomes[2].groupTitle, 'X'); assert.ok(full.description);
  const [code] = await pm.handle('/v1/pm/event', new URLSearchParams('slug=Bad Slug'), '9.9.9.9'); assert.equal(code, 400);
});

test('r142 breaking / new / sub-tags / self-check', async () => {
  const log = [], logs = [];
  const mv = (slug, ch, v24) => ev({ slug, title: slug, volume24hr: v24, markets: [mkt({ slug: slug + '-m', oneDayPriceChange: ch, volume24hr: v24 })] });
  const pm = createPmData({ log: (n, d) => logs.push([n, d]), fetchImpl: fakeFetch([
    [/related-tags\/tags/, () => [{ slug: 'trump', label: 'Trump' }, { slug: 'midterms', label: 'Midterms' }, { slug: 'politics', label: 'Politics' }, { slug: 'Bad Slug', label: 'x' }]],
    [/order=startDate/, () => [mv('fresh-one', 0, 10)]],
    [/limit=20&offset=0/, () => [mv('calm', 0.01, 90000), mv('spike', -0.40, 60000), mv('tiny-volume', 0.9, 100), mv('jump', 0.25, 20000)]],
    [/\/events\?active=true/, () => [mv('top', 0.02, 1e6)]]
  ], log) });
  const b = await pm.feed('breaking', 0, 2);
  assert.deepEqual(b.markets.map(m => m.slug), ['spike', 'jump'], 'largest 24h move first; thin markets excluded'); assert.equal(b.nextOffset, 2);
  const n = await pm.feed('new', 0, 8); assert.equal(n.markets[0].slug, 'fresh-one'); assert.ok(log.some(u => u.includes('order=startDate&ascending=false')));
  const t = await pm.tags('politics'); assert.deepEqual(t.tags.map(x => x.slug), ['trump', 'midterms'], 'own tag and invalid slugs dropped');
  assert.deepEqual((await pm.tags('trending')).tags, []);
  const sub = await pm.handle('/v1/pm/feed', new URLSearchParams('cat=politics&tag=trump'), '5.5.5.5'); assert.equal(sub[0], 200);
  assert.ok(log.some(u => u.includes('tag_slug=trump')));
  assert.equal((await pm.handle('/v1/pm/feed', new URLSearchParams('cat=politics&tag=Bad%20Tag'), '5.5.5.5'))[0], 400);
  const sc = await pm.selfCheck(); assert.equal(sc.ok, true); assert.equal(sc.events, 1); assert.equal(sc.sample, 'top'); assert.equal(sc.sortField, 'volume24hr');
  assert.ok(logs.some(([k]) => k === 'prediction_selfcheck'));
  const st = await pm.handle('/v1/pm/status', new URLSearchParams(), '5.5.5.5'); assert.equal(st[1].trading, false); assert.equal(st[1].lastCheck.ok, true);
  const bad = createPmData({ log: () => {}, fetchImpl: async () => { throw new Error('down'); } });
  const sb = await bad.selfCheck(); assert.equal(sb.ok, false);
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
  assert.ok(log.some(u => u.includes('interval=1w')) && !log.some(u => u.includes('bucket_seconds')), 'no explicit bucket width (Polymarket returns empty pages for expired widths)');
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

/* R139 — upstream-failure diagnostics and response-size handling. OFFLINE (scripted responses), not live Polymarket. */
test('R139: a Gamma response larger than the old 4 MB cap is accepted; one above the cap fails with a clear logged reason', async () => {
  const pad = 'x'.repeat(5 * 1024 * 1024);                                  /* 5 MB: above the old cap, below the new one */
  const big = [ev({ description: pad })];
  const logs = [];
  const pm = createPmData({ fetchImpl: fakeFetch([[/\/events\?active=true/, () => big]]), log: (n, d) => logs.push([n, d]) });
  const f = await pm.feed('trending', 0, 8); assert.equal(f.markets.length, 1, 'a ~5 MB events page now loads');
  const tiny = createPmData({ fetchImpl: fakeFetch([[/\/events\?active=true/, () => big]]), maxBodyBytes: 1024, log: (n, d) => logs.push([n, d]) });
  await assert.rejects(tiny.feed('trending', 0, 8), /body_too_large/);
  const l = logs.find(([n]) => n === 'prediction_upstream_failure')[1];
  assert.equal(l.reason, 'body_too_large'); assert.ok(l.bytes > 1024); assert.equal(l.status, null); assert.equal(l.host, 'gamma-api.polymarket.com'); assert.equal(l.path, '/events');
});

test('R139: HTTP failures log status, safe query and a sanitized body snippet; secrets are redacted; the public error stays generic', async () => {
  const logs = [];
  const bodyText = 'invalid field\n"order" Bearer abc123SECRET token=zzz ' + 'y'.repeat(900);
  const pm = createPmData({ fetchImpl: fakeFetch([[/\/events\?/, () => ({ status: 422, body: bodyText })]]), log: (n, d) => logs.push([n, d]) });
  const [code, body] = await pm.handle('/v1/pm/feed', new URLSearchParams('cat=trending'), '1.2.3.4');
  assert.equal(code, 502); assert.deepEqual(body, { ok: false, error: 'polymarket_unavailable' });
  const l = logs.find(([n]) => n === 'prediction_upstream_failure')[1], fail = logs.find(([n]) => n === 'prediction_request_failed')[1];
  assert.equal(l.status, 422); assert.match(l.query, /^\?active=true&closed=false/); assert.ok(l.body.length <= 300);
  assert.ok(!/SECRET|abc123|zzz/.test(JSON.stringify(logs)), 'credential-looking text is redacted'); assert.ok(!/[\n\r]/.test(l.body));
  assert.equal(fail.route, '/v1/pm/feed'); assert.equal(fail.status, 422);
});

/* r142 audit regressions. OFFLINE (scripted Polymarket responses). */
test('r142 audit: every upstream request is a GET to the three public Polymarket hosts; no order/sign/cancel route exists', async () => {
  const calls = [];
  const spy = async (u, o) => { calls.push([o && o.method, new URL(u).host, new URL(u).pathname]); const U = new URL(u);
    if (U.pathname === '/markets') return new Response(JSON.stringify([mkt({ events: [{ slug: 'bitcoin-150k' }] })]));
    if (U.pathname === '/events') return new Response(JSON.stringify([ev()]));
    if (U.pathname === '/price') return new Response(JSON.stringify({ price: '0.07' }));
    if (U.pathname === '/book') return new Response(JSON.stringify({ asks: [{ price: '0.07', size: '1000' }] }));
    if (U.pathname === '/v2/prices-history') return new Response(JSON.stringify({ data: [{ timestamp: 1, price: 0.07 }], pagination: { has_more: false } }));
    if (U.pathname === '/public-search') return new Response(JSON.stringify({ events: [ev()] }));
    return new Response(JSON.stringify([]));
  };
  const pm = createPmData({ fetchImpl: spy, log: () => {} });
  const q = s => new URLSearchParams(s);
  for (const [p, s] of [['/v1/pm/status', ''], ['/v1/pm/feed', 'cat=trending'], ['/v1/pm/feed', 'cat=breaking'], ['/v1/pm/feed', 'cat=new'], ['/v1/pm/tags', 'cat=politics'],
    ['/v1/pm/event', 'slug=bitcoin-150k'], ['/v1/pm/market', 'slug=will-bitcoin-reach-150k-before-2027'], ['/v1/pm/history', 'token=' + YES + '&range=all'],
    ['/v1/pm/quote', 'slug=will-bitcoin-reach-150k-before-2027&outcome=yes&usd=10'], ['/v1/pm/search', 'q=bitcoin']]) {
    const [code] = await pm.handle(p, q(s), '7.7.7.7'); assert.equal(code, 200, p + '?' + s);
  }
  await pm.selfCheck();
  assert.ok(calls.length > 5);
  for (const [m, h] of calls) { assert.equal(m, 'GET'); assert.ok(['gamma-api.polymarket.com', 'clob.polymarket.com', 'data-api.polymarket.com'].includes(h), h); }
  assert.ok(!calls.some(([, , p]) => /order|cancel|auth|sign|api-key|relay/i.test(p)), 'no trading endpoints are ever called');
  for (const p of ['/v1/pm/order', '/v1/pm/orders', '/v1/pm/sign', '/v1/pm/cancel', '/v1/pm/trade', '/v1/pm/deposit', '/v1/pm/withdraw'])
    assert.equal((await pm.handle(p, q(''), '7.7.7.7'))[0], 404, p);
  const st = (await pm.handle('/v1/pm/status', q(''), '7.7.7.7'))[1];
  assert.equal(st.trading, false); assert.ok(!/key|secret|token|passphrase|password|rpc|database|postgres/i.test(JSON.stringify(Object.keys(st)) + JSON.stringify(st.lastCheck || {})), 'status exposes no secrets');
});

test('r142 audit: Polymarket rate limit (429) -> 503 polymarket_busy (honest), not a generic failure; prices-history ALL needs no bucket width', async () => {
  const pm = createPmData({ log: () => {}, fetchImpl: async () => new Response('{"error":"rate_limited"}', { status: 429 }) });
  const [code, body] = await pm.handle('/v1/pm/feed', new URLSearchParams('cat=trending'), '8.8.8.8');
  assert.equal(code, 503); assert.deepEqual(body, { ok: false, error: 'polymarket_busy' });
  const log = [];
  const pm2 = createPmData({ fetchImpl: fakeFetch([[/prices-history/, () => ({ data: [], pagination: { has_more: false } })]], log) });
  const h = await pm2.history(YES, 'all'); assert.deepEqual(h.points, []);
  assert.ok(log[0].includes('interval=max') && !log[0].includes('bucket_seconds'));
});

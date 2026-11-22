/* r143 Prediction trading support (src/pm-trade.js) + trading-related data paths in src/pm-data.js. OFFLINE: scripted responses, no network, no funds. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPmTrade, validateRelayer, callAllowed, builderHeaders, PMX } from '../src/pm-trade.js';
import { createPmData, normMarket, quoteFromBook } from '../src/pm-data.js';

const W = '0x' + 'ab'.repeat(20), EOA = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const pad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const approve = (spender, amt = 'f'.repeat(64)) => '0x095ea7b3' + pad(spender) + amt;
const setAll = (op, on = true) => '0xa22cb465' + pad(op) + (on ? '0'.repeat(63) + '1' : '0'.repeat(64));
const transfer = (to) => '0xa9059cbb' + pad(to) + '0'.repeat(56) + '00989680';
const APPROVALS = [[PMX.pUSD, approve(PMX.v2Exchange)], [PMX.pUSD, approve(PMX.standardExchange)], [PMX.pUSD, approve(PMX.negRiskExchange)], [PMX.pUSD, approve(PMX.negRiskAdapter)],
  [PMX.ctf, setAll(PMX.standardExchange)], [PMX.ctf, setAll(PMX.negRiskExchange)], [PMX.ctf, setAll(PMX.negRiskAdapter)], [PMX.positionManager, setAll(PMX.v2Exchange)]].map(([target, data]) => ({ target, value: '0', data }));
const batch = (calls, o = {}) => JSON.stringify({ type: 'WALLET', from: EOA, to: PMX.factory, nonce: '0', signature: '0x' + '11'.repeat(65), metadata: 'Saturn approvals', depositWalletParams: { depositWallet: W, deadline: '1795000000', calls }, ...o });
const ENV = { PM_TRADING_ENABLED: '1', POLY_BUILDER_API_KEY: 'k-123', POLY_BUILDER_SECRET: Buffer.from('builder-secret-bytes').toString('base64'), POLY_BUILDER_PASSPHRASE: 'pp', PM_BUILDER_CODE: '0x' + '0c'.repeat(32) };
function req(method, bodyObj) { const b = Buffer.from(bodyObj == null ? '' : JSON.stringify(bodyObj)); const h = { 'content-length': String(b.length) }; const r = { method, headers: h, on(ev, fn) { if (ev === 'data') setImmediate(() => { fn(b); this._end && this._end(); }); if (ev === 'end') this._end = fn; return this; }, destroy() {} }; return r; }

test('approval allow-list: exactly the 8 documented approvals pass; transfers, other spenders, revoke and odd encodings are refused', () => {
  for (const c of APPROVALS) assert.ok(callAllowed(c), c.data.slice(0, 10) + ' ' + c.target);
  assert.ok(!callAllowed({ target: PMX.pUSD, value: '0', data: transfer(EOA) }), 'pUSD transfer refused');
  assert.ok(!callAllowed({ target: PMX.pUSD, value: '0', data: approve(EOA) }), 'approve to an arbitrary spender refused');
  assert.ok(!callAllowed({ target: PMX.ctf, value: '0', data: setAll(PMX.v2Exchange) }), 'operator not in the set for that token');
  assert.ok(!callAllowed({ target: PMX.ctf, value: '0', data: setAll(PMX.standardExchange, false) }), 'setApprovalForAll(false) refused');
  assert.ok(!callAllowed({ target: PMX.pUSD, value: '1', data: approve(PMX.v2Exchange) }), 'non-zero POL value refused');
  assert.ok(!callAllowed({ target: PMX.pUSD, value: '0', data: approve(PMX.v2Exchange) + '00' }), 'trailing bytes refused');
  assert.ok(!callAllowed({ target: PMX.pUSD, value: '0', data: approve(PMX.v2Exchange), extra: 1 }), 'extra fields refused');
});

test('relayer validation: WALLET-CREATE and approval batches only; status/nonce GETs only; everything else refused', () => {
  assert.equal(validateRelayer('POST', '/submit', JSON.stringify({ type: 'WALLET-CREATE', from: EOA, to: PMX.factory, metadata: 'Deploy Deposit Wallet' })), null);
  assert.equal(validateRelayer('POST', '/submit', JSON.stringify({ type: 'WALLET-CREATE', from: EOA, to: '0x' + '99'.repeat(20) })), 'wrong_factory');
  assert.equal(validateRelayer('POST', '/submit', batch(APPROVALS)), null);
  assert.equal(validateRelayer('POST', '/submit', batch([...APPROVALS, { target: PMX.pUSD, value: '0', data: transfer(EOA) }])), 'bad_calls');
  assert.equal(validateRelayer('POST', '/submit', batch([{ target: PMX.pUSD, value: '0', data: transfer(EOA) }])), 'call_not_allowed');
  assert.equal(validateRelayer('POST', '/submit', batch(APPROVALS.slice(0, 2), { type: 'SAFE' })), 'type_not_allowed');
  assert.equal(validateRelayer('POST', '/submit', batch(APPROVALS.slice(0, 2), { extra: 1 })), 'unexpected_field');
  assert.equal(validateRelayer('POST', '/execute', batch(APPROVALS)), 'path_not_allowed');
  assert.equal(validateRelayer('GET', '/v1/account/transactions/params?address=' + EOA + '&type=WALLET', ''), null);
  assert.equal(validateRelayer('GET', '/transaction?id=0193-abc', ''), null);
  assert.equal(validateRelayer('GET', '/v1/account/transactions/0193-abc', ''), null);
  assert.equal(validateRelayer('GET', 'https://evil.example/transaction?id=1', ''), 'bad_path');
  assert.equal(validateRelayer('GET', '/v1/account/transactions/params?address=' + EOA + '&type=SAFE', ''), 'bad_query');
  assert.equal(validateRelayer('DELETE', '/submit', ''), 'path_not_allowed');
});

test('builder HMAC = urlsafe base64(HMAC-SHA256(base64decode(secret), ts + method + path + body)) — Polymarket documented format', () => {
  const creds = { key: 'k', secret: Buffer.from('s3cr3t').toString('base64'), pass: 'p' };
  const h = builderHeaders(creds, 1795000000, 'POST', '/submit', '{"a":1}');
  const want = createHmac('sha256', Buffer.from('s3cr3t')).update('1795000000POST/submit{"a":1}').digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.deepEqual(h, { POLY_BUILDER_API_KEY: 'k', POLY_BUILDER_TIMESTAMP: '1795000000', POLY_BUILDER_PASSPHRASE: 'p', POLY_BUILDER_SIGNATURE: want });
});

test('pm-trade routes: off by default; config never exposes the secret; signing refused for disallowed calls; bridge proxy keeps only addresses', async () => {
  const off = createPmTrade({ env: {}, log: () => {} });
  const [c0, b0] = await off.handle(req('GET'), '/v1/pm/x/config', new URLSearchParams(), '1.1.1.1');
  assert.equal(c0, 200); assert.equal(b0.trading.enabled, false); assert.match(b0.trading.reason, /switched off/);
  assert.equal((await off.handle(req('POST', { method: 'POST', path: '/submit', body: batch(APPROVALS) }), '/v1/pm/x/relayer-sign', new URLSearchParams(), '1.1.1.1'))[0], 503);
  const noCreds = createPmTrade({ env: { PM_TRADING_ENABLED: '1' }, log: () => {} }); assert.equal(noCreds.enabled, false); assert.match(noCreds.reason, /Builder API key/);
  const calls = [];
  const on = createPmTrade({ env: ENV, log: () => {}, now: () => 1795000000000, fetchImpl: async (u, o) => { calls.push([u, o.method, o.headers, o.body]); return new Response(JSON.stringify({ address: { evm: '0x' + '12'.repeat(20), svm: 'So1anaDepositAddr1111111111111111111111111', btc: 'bc1qexample0000000000000000000000' }, note: 'Only send supported assets.' })); } });
  const [c1, b1] = await on.handle(req('GET'), '/v1/pm/x/config', new URLSearchParams(), '1.1.1.1');
  assert.equal(b1.trading.enabled, true); assert.equal(b1.trading.builderCode, ENV.PM_BUILDER_CODE); assert.ok(!JSON.stringify(b1).includes(ENV.POLY_BUILDER_SECRET) && !JSON.stringify(b1).includes('k-123'), 'no credentials in config');
  const [c2, b2] = await on.handle(req('POST', { method: 'POST', path: '/submit', body: batch(APPROVALS) }), '/v1/pm/x/relayer-sign', new URLSearchParams(), '1.1.1.1');
  assert.equal(c2, 200); assert.equal(b2.headers.POLY_BUILDER_API_KEY, 'k-123'); assert.equal(b2.headers.POLY_BUILDER_TIMESTAMP, '1795000000'); assert.ok(!JSON.stringify(b2).includes(ENV.POLY_BUILDER_SECRET));
  const [c3, b3] = await on.handle(req('POST', { method: 'POST', path: '/submit', body: batch([{ target: PMX.pUSD, value: '0', data: transfer(EOA) }]) }), '/v1/pm/x/relayer-sign', new URLSearchParams(), '1.1.1.1');
  assert.equal(c3, 403); assert.equal(b3.reason, 'call_not_allowed'); assert.ok(!b3.headers);
  const [c4, b4] = await on.handle(req('POST', { address: W }), '/v1/pm/x/bridge-deposit', new URLSearchParams(), '1.1.1.1');
  assert.equal(c4, 200); assert.deepEqual(Object.keys(b4.addresses).sort(), ['btc', 'evm', 'svm']);
  assert.equal(calls[0][0], 'https://bridge.polymarket.com/deposit'); assert.equal(calls[0][1], 'POST'); assert.equal(calls[0][2]['X-Builder-Code'], ENV.PM_BUILDER_CODE); assert.deepEqual(JSON.parse(calls[0][3]), { address: W });
  assert.equal((await on.handle(req('POST', { address: 'nope' }), '/v1/pm/x/bridge-deposit', new URLSearchParams(), '1.1.1.1'))[0], 400);
  assert.equal((await on.handle(req('POST', { address: W, to: EOA }), '/v1/pm/x/bridge-deposit', new URLSearchParams(), '1.1.1.1'))[0], 400);
  for (const p of ['/v1/pm/x/order', '/v1/pm/x/cancel', '/v1/pm/x/transfer', '/v1/pm/x/withdraw']) assert.equal((await on.handle(req('POST', {}), p, new URLSearchParams(), '1.1.1.1'))[0], 404, p);
});

test('market fees come from the market feeSchedule (BTC 5m/15m coefficient 0.05 since 2026-11-20); feesEnabled=false -> 0; exponent applied', () => {
  const base = { id: '1', slug: 'btc-updown-15m-1795000000-up', question: 'BTC Up or Down', outcomes: '["Up","Down"]', outcomePrices: '["0.6","0.4"]', clobTokenIds: JSON.stringify(['5'.repeat(70), '6'.repeat(70)]), active: true, closed: false };
  const ev = { tags: [{ slug: 'crypto' }] };
  const m = normMarket({ ...base, feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true } }, ev); assert.equal(m.feeRate, 0.05); assert.equal(m.feeSource, 'market:feeSchedule');
  assert.equal(normMarket({ ...base, feesEnabled: false, feeSchedule: { rate: 0.07 } }, ev).feeRate, 0);
  assert.equal(normMarket(base, ev).feeSource, 'category-table');
  const q = quoteFromBook({ asks: [{ price: '0.5', size: '1000' }] }, 50, 0.05, 2); assert.ok(Math.abs(q.feeEstimate - 100 * 0.05 * 0.0625) < 1e-9);
});

test('Up/Down discovery: slug {asset}-updown-{interval}-{window start}; next window if the current one is not listed; priceToBeat only from Polymarket fields', async () => {
  const t0 = 1795000123, start = Math.floor(t0 / 900) * 900, log = [];
  const evFor = (slug, extra = {}) => ({ id: '9', slug, title: 'Bitcoin Up or Down', tags: [{ slug: 'crypto' }], markets: [{ id: '1', slug: slug + '-m', question: 'Bitcoin Up or Down', outcomes: '["Up","Down"]', outcomePrices: '["0.73","0.27"]', clobTokenIds: JSON.stringify(['7'.repeat(70), '8'.repeat(70)]), active: true, closed: false, acceptingOrders: true }], ...extra });
  const pm = createPmData({ now: () => t0 * 1000, fetchImpl: async u => { log.push(u); const s = new URL(u).searchParams.get('slug');
    if (s === 'btc-updown-15m-' + start) return new Response(JSON.stringify([evFor(s, { eventMetadata: { priceToBeat: 59953.96 } })]));
    if (s === 'eth-updown-5m-' + (Math.floor(t0 / 300) * 300 + 300)) return new Response(JSON.stringify([evFor(s)]));
    return new Response('[]'); } });
  const b = await pm.updown('btc', '15m');
  assert.equal(b.slug, 'btc-updown-15m-' + start); assert.equal(b.windowEnd - b.windowStart, 900); assert.equal(b.priceToBeat, 59953.96); assert.equal(b.outcomes[0].yes.label, 'Up'); assert.equal(b.outcomes[0].yes.price, 0.73);
  const e = await pm.updown('eth', '5m'); assert.equal(e.priceToBeat, null, 'no published target -> null, never guessed'); assert.equal(e.windowStart, Math.floor(t0 / 300) * 300 + 300);
  await assert.rejects(pm.updown('doge2', '15m')); await assert.rejects(pm.updown('btc', '1h'));
  assert.equal((await pm.handle('/v1/pm/updown', new URLSearchParams('asset=sol&interval=15m'), '2.2.2.2'))[0], 404);
});

test('positions: Data API v2 by wallet address; camel or snake fields; bad address refused', async () => {
  const pm = createPmData({ fetchImpl: async u => { assert.match(u, /^https:\/\/data-api\.polymarket\.com\/v2\/positions\?user=0x[0-9a-f]{40}&limit=100$/);
    return new Response(JSON.stringify({ data: [{ title: 'Bitcoin Up or Down', outcome: 'Up', size: 34.5, avg_price: 0.72, cur_price: 0.8, current_value: 27.6, cash_pnl: 2.76, asset: '7'.repeat(70) }, { title: null, size: 1 }], pagination: { has_more: false } })); } });
  const r = await pm.positions(W); assert.equal(r.positions.length, 1); assert.equal(r.positions[0].avgPrice, 0.72); assert.equal(r.positions[0].currentValue, 27.6);
  assert.equal((await pm.handle('/v1/pm/positions', new URLSearchParams('user=0x12'), '3.3.3.3'))[0], 400);
});

test('r143.1: Live/Breaking read the event pool in pages of 20 (one 100-event response exceeded 16 MB in production); a failed page is skipped', async () => {
  const seen = [];
  const ev = (i, live) => ({ id: 'e' + i, slug: 'ev-' + i, title: 'Event ' + i, live, volume24hr: 9000, tags: [{ slug: 'sports' }], markets: [{ id: 'm' + i, slug: 'm-' + i, question: 'Q' + i, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: JSON.stringify([String(10n ** 69n + BigInt(i * 2)), String(10n ** 69n + BigInt(i * 2 + 1))]), active: true, closed: false, acceptingOrders: true, oneDayPriceChange: i / 1000 }] });
  const pm = createPmData({ log: () => {}, fetchImpl: async u => { const q = new URL(u).searchParams; seen.push([q.get('limit'), q.get('offset')]);
    if (q.get('offset') === '40') return new Response('too big', { status: 200, headers: { 'content-length': '1' } }).text().then(() => { throw Object.assign(new Error('body_too_large'), { logged: true }); });
    const off = +q.get('offset'); return new Response(JSON.stringify(Array.from({ length: off >= 80 ? 5 : 20 }, (_, k) => ev(off + k, (off + k) % 3 === 0)))); } });
  const live = await pm.feed('live', 0, 8);
  assert.ok(seen.every(([l]) => l === '20'), 'never asks for more than 20 events at once');
  assert.ok(live.markets.length === 8 && live.markets.every(m => m.live), 'live events from the pages that loaded');
  const br = await pm.feed('breaking', 0, 5); assert.equal(br.markets.length, 5);
});

test('r143.2 bridge-status: read-only GET of Polymarket /status/{address}; statuses whitelisted; bad addresses refused', async () => {
  const calls = [];
  const on = createPmTrade({ env: ENV, log: () => {}, fetchImpl: async (u, o) => { calls.push([u, o.method]); return new Response(JSON.stringify({ transactions: [
    { fromChainId: '1151111081099710', fromTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', fromAmountBaseUnit: '5000000', toChainId: '137', toTokenAddress: PMX.pUSD, status: 'PROCESSING', createdTimeMs: 1795000000000 },
    { status: 'EVIL<script>', txHash: '0x<bad>' }], nextCursor: null })); } });
  const svm = 'So1anaDepositAddr1111111111111111111111111';
  const [c, b] = await on.handle(req('GET'), '/v1/pm/x/bridge-status', new URLSearchParams('address=' + svm), '1.1.1.1');
  assert.equal(c, 200); assert.equal(calls[0][0], 'https://bridge.polymarket.com/status/' + svm + '?limit=20'); assert.equal(calls[0][1], 'GET');
  assert.equal(b.transactions[0].status, 'PROCESSING'); assert.equal(b.transactions[0].fromAmountBaseUnit, '5000000'); assert.equal(b.transactions[1].status, 'UNKNOWN'); assert.equal(b.transactions[1].txHash, null);
  assert.equal((await on.handle(req('GET'), '/v1/pm/x/bridge-status', new URLSearchParams('address=../deposit'), '1.1.1.1'))[0], 400);
  assert.equal((await on.handle(req('POST', {}), '/v1/pm/x/bridge-status', new URLSearchParams('address=' + svm), '1.1.1.1'))[0], 405);
});

test('r144.2 price to beat: from polymarket.com/api/crypto/crypto-price (openPrice) when Gamma has none; tries the window-name spellings, remembers the working one, never guesses', async () => {
  const t0 = 1795000123, start = Math.floor(t0 / 900) * 900, calls = [];
  const evFor = slug => ({ id: '9', slug, title: 'Bitcoin Up or Down', tags: [{ slug: 'crypto' }], markets: [{ id: '1', slug: slug + '-m', question: 'Bitcoin Up or Down', outcomes: '["Up","Down"]', outcomePrices: '["0.73","0.27"]', clobTokenIds: JSON.stringify(['7'.repeat(70), '8'.repeat(70)]), active: true, closed: false, acceptingOrders: true, enableOrderBook: true }] });
  let mode = 'ok';
  const pm = createPmData({ now: () => t0 * 1000, fetchImpl: async u => { const U = new URL(u); calls.push(U.host + U.pathname + U.search);
    if (U.host === 'gamma-api.polymarket.com') { const s = U.searchParams.get('slug'); return new Response(s === 'btc-updown-15m-' + start || s === 'eth-updown-15m-' + start ? JSON.stringify([evFor(s)]) : '[]'); }
    if (U.host === 'polymarket.com' && U.pathname === '/api/crypto/crypto-price') {
      assert.equal(U.searchParams.get('eventStartTime'), new Date(start * 1000).toISOString().replace('.000Z', 'Z')); assert.equal(U.searchParams.get('endDate'), new Date((start + 900) * 1000).toISOString().replace('.000Z', 'Z'));
      if (mode === 'none') return new Response(JSON.stringify({ openPrice: null, closePrice: null, completed: false }));
      if (U.searchParams.get('variant') !== 'fifteenminute') return new Response('{"error":"bad variant"}', { status: 400 });
      return new Response(JSON.stringify({ openPrice: U.searchParams.get('symbol') === 'BTC' ? 84123.45 : 3010.5, closePrice: 84200, completed: false, incomplete: true }));
    }
    throw new Error('unexpected ' + u); } });
  const b = await pm.updown('btc', '15m');
  assert.equal(b.priceToBeat, 84123.45); assert.equal(b.priceToBeatSource, 'polymarket:crypto-price');
  assert.deepEqual(calls.filter(c => c.startsWith('polymarket.com')).map(c => new URLSearchParams(c.split('?')[1]).get('variant')), ['fifteen', 'fifteenminute'], 'tries spellings in order');
  calls.length = 0; const e = await pm.updown('eth', '15m'); assert.equal(e.priceToBeat, 3010.5);
  assert.deepEqual(calls.filter(c => c.startsWith('polymarket.com')).map(c => new URLSearchParams(c.split('?')[1]).get('variant')), ['fifteenminute'], 'the working spelling is remembered');
  calls.length = 0; await pm.updown('btc', '15m'); assert.equal(calls.filter(c => c.startsWith('polymarket.com')).length, 0, 'an opening price is kept for the window');
  mode = 'none'; const pm2 = createPmData({ now: () => t0 * 1000, fetchImpl: async u => { const U = new URL(u); if (U.host === 'gamma-api.polymarket.com') return new Response(JSON.stringify([evFor(U.searchParams.get('slug'))])); return new Response(JSON.stringify({ openPrice: null })); } });
  assert.equal((await pm2.updown('btc', '15m')).priceToBeat, null, 'no opening price published -> null, never guessed');
});

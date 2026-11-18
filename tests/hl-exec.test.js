/* r128 Hyperliquid MAINNET relay (/v1/perps/hl/*): switches, schemas, signature recovery, agent check, limits, slippage, idempotency, audit.
 * [MOCK Hyperliquid (scripted /info + /exchange), REAL PostgreSQL, REAL secp256k1/EIP-712 signatures made with throw-away TEST keys]
 * Nothing here contacts Hyperliquid. "enabled" is forced ON only inside these tests (cfg override) to exercise the checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { clusterUp } from './helpers/pg-local.js';
import { makeEnv } from './helpers/harness.js';
import { loadConfig } from '../src/config.js';
import { createHlGateway, hlConfig, HL_EXECUTE_VERIFIED, USDC_TOKEN } from '../src/hl-exec.js';
import { createLimiter } from '../src/limits.js';
import * as H from '../src/vendor/hlsign.mjs';

const HAVE = clusterUp(); const opts = { skip: HAVE ? false : 'no local PostgreSQL available' };
const USERK = H.newPrivateKey(), USER = H.addressOf(USERK), AGENTK = H.newPrivateKey(), AGENT = H.addressOf(AGENTK), OTHERK = H.newPrivateKey();
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

function fakeHl({ builders = {}, acct = {}, wallet = { usdc: 20, eth: 0.001 }, receipts = {}, ledger = [], agents = [{ address: AGENT, name: 'saturn', validUntil: T0 + 86400000 }], mids = { HYPE: '38.10', ZEC: '410', JUP: '0.52', NEAR: '2.5', BNB: '905', 'xyz:SNDK': '655.5', 'xyz:SPCX': '120', 'xyz:SKHYNIX': '600' }, exchangeReply = null } = {}) {
  const sent = [], infos = [];
  const MAIN = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'HYPE', szDecimals: 2, maxLeverage: 10 }, { name: 'ZEC', szDecimals: 2, maxLeverage: 10 }, { name: 'JUP', szDecimals: 0, maxLeverage: 10 }, { name: 'NEAR', szDecimals: 1, maxLeverage: 10 }, { name: 'BNB', szDecimals: 3, maxLeverage: 10 }];
  const XYZ = [{ name: 'xyz:TSLA', szDecimals: 3, maxLeverage: 10, onlyIsolated: true }, { name: 'xyz:SNDK', szDecimals: 2, maxLeverage: 10, onlyIsolated: true }, { name: 'xyz:SPCX', szDecimals: 2, maxLeverage: 5, onlyIsolated: true }, { name: 'xyz:SKHYNIX', szDecimals: 2, maxLeverage: 5, onlyIsolated: true }];
  const fetch = async (url, init) => {
    const u = new URL(url), b = JSON.parse(init.body);
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'arb1.arbitrum.io') return J({ jsonrpc: '2.0', id: 1, result: arbRpc(b) });   /* MOCK Arbitrum One RPC */
    assert.equal(u.hostname, 'api.hyperliquid.xyz', 'relay must only talk to Hyperliquid MAINNET');
    if (u.pathname === '/info') { infos.push(b.type);
      if (b.type === 'perpDexs') return J([null, { name: 'flx' }, { name: 'xyz' }]);
      if (b.type === 'metaAndAssetCtxs') { const uni = b.dex === 'xyz' ? XYZ : MAIN; return J([{ universe: uni, ...(b.dex === 'xyz' ? { collateralToken: 0 } : {}) }, uni.map(x => ({ markPx: mids[x.name] || '1', funding: '0.00001' }))]); }
      if (b.type === 'allMids') return J(Object.fromEntries(Object.entries(mids).filter(([k]) => b.dex === 'xyz' ? k.startsWith('xyz:') : !k.includes(':'))));
      if (b.type === 'extraAgents') return J(String(b.user).toLowerCase() === USER ? agents : []);
      const A = { mode: 'disabled', main: 0, xyz: 0, spot: 0, used: 0, ...acct };
      const cs = (v, used) => ({ marginSummary: { accountValue: String(v), totalMarginUsed: String(used) }, withdrawable: String(Math.max(0, v - used)), assetPositions: [] });
      if (b.type === 'userAbstraction') return J(A.mode);
      if (b.type === 'clearinghouseState' && builders[String(b.user).toLowerCase()] != null) return J(cs(builders[String(b.user).toLowerCase()], 0));   /* r131 Saturn fee wallet */
      if (b.type === 'clearinghouseState') return J(b.dex === 'xyz' ? cs(A.xyz, 0) : cs(A.main, A.used));
      if (b.type === 'spotClearinghouseState') return J({ balances: [{ coin: 'USDC', token: 0, total: String(A.spot), hold: '0' }] });
      if (b.type === 'frontendOpenOrders') return J([]);
      if (b.type === 'userNonFundingLedgerUpdates') return J(ledger.filter(x => x.time >= b.startTime));
      return J(null);
    }
    if (u.pathname === '/exchange') { sent.push(b); if (exchangeReply) return exchangeReply(b); return J({ status: 'ok', response: b.action.type === 'order' ? { type: 'order', data: { statuses: [{ filled: { totalSz: b.action.orders[0].s, avgPx: '38.1', oid: 9 } }] } } : { type: 'default' } }); }
    return J({}, 404);
  };
  const pad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  function arbRpc(b) {
    if (b.method === 'eth_call') return '0x' + BigInt(Math.round(wallet.usdc * 1e6)).toString(16);
    if (b.method === 'eth_getBalance') return '0x' + BigInt(Math.round(wallet.eth * 1e18)).toString(16);
    if (b.method === 'eth_getTransactionReceipt') return receipts[b.params[0]] || null;
    return null;
  }
  const receipt = (from, to, amount, ok = true) => ({ status: ok ? '0x1' : '0x0', to: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', logs: [{ address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + pad(from), '0x' + pad(to)], data: '0x' + BigInt(Math.round(amount * 1e6)).toString(16) }] });
  return { fetch, sent, infos, receipts, ledger, wallet, acct, receipt };
}
function req(body, headers = {}) { const r = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]); r.headers = { 'content-type': 'application/json', ...headers }; r.method = 'POST'; return r; }
const pad = x => '0x' + BigInt(x).toString(16).padStart(64, '0');
function l1(action, nonce, key = AGENTK, mainnet = true) { const s = H.signL1Action(key, action, null, nonce, null, mainnet); return { action, nonce, signature: { r: pad(s.r), s: pad(s.s), v: s.v }, vaultAddress: null, user: USER }; }
function userSigned(action, types, primary, key = USERK) { return { action, nonce: action.nonce ?? action.time, signature: H.splitSig(H.signDigestRaw(key, H.typedDataHash(H.userSignedPayload(primary, types, action)))), user: USER }; }
const order = ({ a = 1, b = true, p = '38.5', s = '0.5', r = false, tif = 'Ioc', c = '0x' + 'ab'.repeat(16) } = {}) => H.orderAction([H.orderWire({ asset: a, isBuy: b, limitPx: Number(p), sz: Number(s), reduceOnly: r, orderType: { limit: { tif } }, cloid: c })]);

async function setup(t, { env = {}, enabled = true, hl = {} } = {}) {
  const e = await makeEnv({ env: { HL_EXECUTION_ENABLED: '1', HL_VERIFIED_MARKETS: 'HYPE,SNDK', ...env }, init: true, start: T0 });
  const F = fakeHl(hl);
  const cfg = { ...e.cfg, hl: { ...e.cfg.hl, enabled } };
  const gw = createHlGateway({ cfg, store: e.parts.store, limiter: createLimiter({ now: e.clock.now }), now: e.clock.now, fetchImpl: F.fetch });
  t.after(() => e.drop());
  const call = async b => { const [code, body] = await gw.handle(req(b), '/v1/perps/hl/exchange', new URLSearchParams(), '203.0.113.9'); return { code, body }; };
  const rows = () => e.db.rows("SELECT id,user_addr,signer,action_type,market,asset,is_buy,size,price,reduce_only,tif,cloid,notional_usd,state,reason,upstream_status FROM perps_hl_requests ORDER BY created_at, id");
  return { e, F, gw, call, rows, now: () => e.clock.now() };
}

test('production switches (r130: code switch approved ON): real money needs HL_EXECUTION_ENABLED=1 too; unset env = off', () => {
  assert.equal(HL_EXECUTE_VERIFIED, true);
  const off = loadConfig({ DATABASE_URL: 'postgres://x@y/z', ALLOWED_ORIGINS: 'https://a.b' });
  assert.equal(off.hl.enabled, false, 'without the Render setting nothing can trade');
  const c = loadConfig({ DATABASE_URL: 'postgres://x@y/z', ALLOWED_ORIGINS: 'https://a.b', HL_EXECUTION_ENABLED: '1', HL_VERIFIED_MARKETS: 'HYPE,ZEC,SOL,NOPE' });
  assert.equal(c.hl.requested, true); assert.equal(c.hl.enabled, true);
  assert.deepEqual(c.hl.verifiedMarkets, ['HYPE', 'ZEC'], 'only the 8 Hyperliquid markets can be listed (SOL / unknown dropped)');
  assert.equal(hlConfig({}).maxOrderUsd, 50); assert.equal(hlConfig({ HL_MAX_ORDER_USD: '999999999' }).maxOrderUsd, 50, 'out-of-range limit ignored');
});

test('disabled: every exchange request is refused before parsing, Hyperliquid is never contacted', opts, async t => {
  const S = await setup(t, { enabled: false });
  const r = await S.call(l1(order(), S.now()));
  assert.equal(r.code, 403); assert.equal(r.body.error, 'execution_disabled');
  assert.equal(S.F.sent.length, 0); assert.equal((await S.rows()).length, 0);
});

test('config + mainnet market discovery (asset ids incl. HIP-3 xyz = 100000 + 2*10000 + index)', opts, async t => {
  const S = await setup(t);
  const [c1, cfgBody] = await S.gw.handle({ method: 'GET', headers: {} }, '/v1/perps/hl/config', null, '1.1.1.1');
  assert.equal(c1, 200); assert.equal(cfgBody.network, 'hyperliquid-mainnet'); assert.equal(cfgBody.bridge.bridge2, '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7'); assert.equal(cfgBody.bridge.minDepositUsd, 5);
  const [c2, mk] = await S.gw.handle({ method: 'GET', headers: {} }, '/v1/perps/hl/markets', null, '1.1.1.1');
  assert.equal(c2, 200);
  const by = Object.fromEntries(mk.markets.map(m => [m.market, m]));
  assert.equal(by.HYPE.asset, 1); assert.equal(by.HYPE.venue, 'hyperliquid'); assert.equal(by.JUP.asset, 3);
  assert.equal(by.SNDK.asset, 120001); assert.equal(by.SNDK.venue, 'hyperliquid:xyz'); assert.equal(by.SNDK.onlyIsolated, true);
  assert.equal(by.SPCX.asset, 120002); assert.equal(by.SKHYNIX.asset, 120003);
  assert.equal(by.HYPE.verified, true); assert.equal(by.ZEC.verified, false);
  assert.ok(mk.markets.every(m => m.listed && m.collateral === 'USDC'));
});

test('agent-signed IOC order on a verified market: recovered, checked, recorded, forwarded once; replay returns the stored result', opts, async t => {
  const S = await setup(t);
  const b = l1(order(), S.now());
  const r1 = await S.call(b);
  assert.equal(r1.code, 200, JSON.stringify(r1.body)); assert.equal(r1.body.ok, true); assert.ok(r1.body.exchange.response.data.statuses[0].filled);
  assert.equal(S.F.sent.length, 1);
  assert.deepEqual(S.F.sent[0], { action: b.action, nonce: b.nonce, signature: b.signature, vaultAddress: null }, 'forwards exactly the canonical signed action');
  const r2 = await S.call(b);
  assert.equal(r2.body.duplicate, true); assert.equal(r2.body.state, 'submitted'); assert.equal(S.F.sent.length, 1, 'never forwarded twice');
  const rows = await S.rows();
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'submitted'); assert.equal(rows[0].market, 'HYPE'); assert.equal(rows[0].signer, AGENT); assert.equal(rows[0].user_addr, USER);
  assert.ok(!JSON.stringify(rows).includes(b.signature.r.slice(2, 20)), 'no signature stored');
});

test('same cloid with a new nonce (double tap after re-sign) is refused as duplicate_order', opts, async t => {
  const S = await setup(t);
  assert.equal((await S.call(l1(order(), S.now()))).code, 200);
  const r = await S.call(l1(order(), S.now() + 5));
  assert.equal(r.code, 409); assert.equal(r.body.error, 'duplicate_order'); assert.equal(S.F.sent.length, 1);
});

test('refusals: unapproved signer, testnet-signed, unverified market, too large, slippage, price band, size decimals, no cloid, stale nonce', opts, async t => {
  const S = await setup(t); const n = () => S.now() + Math.floor(Math.random() * 1000);
  const cases = [
    [l1(order(), n(), OTHERK), 401, 'agent_not_approved'],
    [l1(order(), n(), AGENTK, false), 401, 'agent_not_approved'],          /* testnet phantom agent recovers to a different address */
    [l1(order({ a: 2, p: '411', s: '0.05', c: '0x' + '01'.repeat(16) }), n()), 403, 'market_not_verified'],   /* ZEC not in HL_VERIFIED_MARKETS */
    [l1(order({ s: '2', c: '0x' + '02'.repeat(16) }), n()), 400, 'order_too_large'],
    [l1(order({ s: '0.2', c: '0x' + '03'.repeat(16) }), n()), 400, 'order_too_small'],
    [l1(order({ p: '40.1', c: '0x' + '04'.repeat(16) }), n()), 400, 'slippage_limit'],
    [l1(order({ p: '20', tif: 'Gtc', c: '0x' + '05'.repeat(16) }), n()), 400, 'price_band'],
    [l1(order({ s: '0.505', c: '0x' + '06'.repeat(16) }), n()), 400, 'bad_size'],
    [l1(order({ c: null }), n()), 400, 'cloid_required'],
    [l1(order({ c: '0x' + '07'.repeat(16) }), S.now() - 3600000), 400, 'stale_nonce'],
  ];
  for (const [b, code, err] of cases) { const r = await S.call(b); assert.equal(r.code, code, err + ' -> ' + JSON.stringify(r.body)); assert.equal(r.body.error, err); }
  assert.equal(S.F.sent.length, 0, 'nothing reached Hyperliquid');
  assert.ok((await S.rows()).filter(r => r.state === 'refused').length >= 7, 'refusals audited');
});

test('reduce-only close is allowed on an unverified market and above the size cap (users can always exit)', opts, async t => {
  const S = await setup(t);
  const r = await S.call(l1(order({ a: 2, b: false, p: '400', s: '1', r: true, c: '0x' + '0c'.repeat(16) }), S.now()));
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(S.F.sent.length, 1);
});

test('action allowlist: usdSend / spotSend / builder fee / abstraction change / vault are refused; extra fields refused', opts, async t => {
  const S = await setup(t);
  for (const type of ['usdSend', 'spotSend', 'userSetAbstraction', 'vaultTransfer', 'createSubAccount']) {
    const r = await S.call(l1({ type, amount: '1' }, S.now())); assert.equal(r.body.error, 'action_not_allowed', type);
  }
  const bad = l1({ ...order(), builder: { b: USER, f: 10 } }, S.now());
  assert.equal((await S.call(bad)).body.error, 'builder_not_allowed', 'r131: no builder fee to anyone but Saturn\'s own fee wallet');
  const extra = l1(order(), S.now()); extra.expiresAfter = 1;
  assert.equal((await S.call(extra)).code, 400);
  assert.equal(S.F.sent.length, 0);
});

test('user-signed: approveAgent needs a <=30 day expiry and the user\'s own signature; Mainnet only', opts, async t => {
  const S = await setup(t);
  const mk = (name, extra = {}) => ({ type: 'approveAgent', signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet', agentAddress: AGENT, agentName: name, nonce: S.now(), ...extra });
  const ok = await S.call(userSigned(mk('saturn valid_until ' + (S.now() + 7 * 86400000)), H.APPROVE_AGENT_TYPES, 'HyperliquidTransaction:ApproveAgent'));
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal((await S.call(userSigned(mk('saturn'), H.APPROVE_AGENT_TYPES, 'HyperliquidTransaction:ApproveAgent'))).body.error, 'agent_expiry');
  assert.equal((await S.call(userSigned(mk('saturn valid_until ' + (S.now() + 200 * 86400000)), H.APPROVE_AGENT_TYPES, 'HyperliquidTransaction:ApproveAgent'))).body.error, 'agent_expiry');
  assert.equal((await S.call(userSigned(mk('saturn valid_until ' + (S.now() + 86400000), { hyperliquidChain: 'Testnet' }), H.APPROVE_AGENT_TYPES, 'HyperliquidTransaction:ApproveAgent'))).body.error, 'wrong_network');
  assert.equal((await S.call(userSigned(mk('saturn valid_until ' + (S.now() + 86400000)), H.APPROVE_AGENT_TYPES, 'HyperliquidTransaction:ApproveAgent', OTHERK))).body.error, 'bad_signature');
  assert.equal(S.F.sent.length, 1);
});

test('withdraw3 only to the user\'s own address; sendAsset only USDC between main and xyz', opts, async t => {
  const S = await setup(t);
  const W = (dest, amount) => userSigned({ type: 'withdraw3', signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet', destination: dest, amount, time: S.now() }, H.WITHDRAW_TYPES, 'HyperliquidTransaction:Withdraw');
  assert.equal((await S.call(W(USER, '10'))).code, 200);
  assert.equal((await S.call(W(H.addressOf(OTHERK), '10'))).body.error, 'own_address_only');
  assert.equal((await S.call(W(USER, '1'))).body.error, 'bad_amount');
  const SA = { types: [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'sourceDex', type: 'string' }, { name: 'destinationDex', type: 'string' }, { name: 'token', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'fromSubAccount', type: 'string' }, { name: 'nonce', type: 'uint64' }] };
  const X = o => userSigned({ type: 'sendAsset', signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet', destination: USER, sourceDex: '', destinationDex: 'xyz', token: USDC_TOKEN, amount: '25', fromSubAccount: '', nonce: S.now() + Math.floor(Math.random() * 999), ...o }, SA.types, 'HyperliquidTransaction:SendAsset');
  assert.equal((await S.call(X({}))).code, 200);
  assert.equal((await S.call(X({ destination: H.addressOf(OTHERK) }))).body.error, 'own_address_only');
  assert.equal((await S.call(X({ destinationDex: 'spot' }))).body.error, 'bad_transfer');
  assert.equal((await S.call(X({ token: 'PURR:0xc4bf3f870c0e9465323c0b6ed28096c2' }))).body.error, 'own_address_only');
  assert.equal(S.F.sent.length, 2);
});

test('ambiguous upstream (timeout / 5xx) is recorded unknown and never retried; exchange rejection recorded', opts, async t => {
  let mode = '5xx';
  const S = await setup(t, { hl: { exchangeReply: b => mode === '5xx' ? new Response('bad gateway', { status: 502 }) : new Response(JSON.stringify({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Insufficient margin to place order. asset=1' }] } } }), { status: 200 }) } });
  const b = l1(order(), S.now());
  const r = await S.call(b); assert.equal(r.code, 502); assert.equal(r.body.error, 'unknown_outcome');
  const again = await S.call(b); assert.equal(again.body.duplicate, true); assert.equal(again.body.state, 'unknown'); assert.equal(S.F.sent.length, 1);
  mode = 'reject';
  const r2 = await S.call(l1(order({ c: '0x' + 'cd'.repeat(16) }), S.now() + 1));
  assert.equal(r2.code, 200); assert.equal((await S.rows()).find(x => x.cloid === '0x' + 'cd'.repeat(16)).state, 'rejected');
});

test('rate limits per user', opts, async t => {
  const S = await setup(t); let last;
  for (let i = 0; i < 25; i++) last = await S.call(l1({ type: 'cancel', cancels: [{ a: 1, o: 100 + i }] }, S.now() + i));
  assert.equal(last.code, 429);
});

/* ---------------- r129 ---------------- */
const G = async (S, path) => { const u = new URL('http://x' + path); const [code, body] = await S.gw.handle({ method: 'GET', headers: {} }, u.pathname, u.searchParams, '198.51.100.7'); return { code, body }; };
const P = async (S, path, b) => { const [code, body] = await S.gw.handle(req(b), path, new URLSearchParams(), '198.51.100.7'); return { code, body }; };
const BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';

test('r129 TP/SL group (normalTpsl): accepted when reduce-only, opposite side, same size; refused when wrong side or size', opts, async t => {
  const S = await setup(t);
  const grp = (sl, tp, s2 = '0.5') => ({ type: 'order', orders: [
    { a: 1, b: true, p: '38.5', s: '0.5', r: false, t: { limit: { tif: 'Ioc' } }, c: '0x' + '11'.repeat(16) },
    ...(tp ? [{ a: 1, b: false, p: tp, s: s2, r: true, t: { trigger: { isMarket: true, triggerPx: tp, tpsl: 'tp' } } }] : []),
    ...(sl ? [{ a: 1, b: false, p: sl, s: s2, r: true, t: { trigger: { isMarket: true, triggerPx: sl, tpsl: 'sl' } } }] : [])], grouping: 'normalTpsl' });   /* SDK field order: type, orders, grouping */
  const ok = await S.call(l1(grp('35', '45'), S.now())); assert.equal(ok.code, 200, JSON.stringify(ok.body));
  const swapped = l1(grp('35', '45'), S.now() + 9); swapped.action = { type: 'order', grouping: 'normalTpsl', orders: swapped.action.orders };
  assert.equal((await S.call(swapped)).code, 409, 'reordered JSON keys canonicalize to the SAME action, so it is caught as a duplicate, never sent twice');
  assert.equal(S.F.sent[0].action.grouping, 'normalTpsl'); assert.equal(S.F.sent[0].action.orders.length, 3);
  assert.equal((await S.call(l1(grp('40', null), S.now() + 1))).body.error, 'bad_tpsl', 'long stop loss above the market');
  assert.equal((await S.call(l1(grp(null, '30'), S.now() + 2))).body.error, 'bad_tpsl', 'long take profit below the market');
  assert.equal((await S.call(l1(grp('35', null, '0.4'), S.now() + 3))).body.error, 'bad_tpsl', 'TP/SL size must equal the order');
  assert.equal(S.F.sent.length, 1);
});

test('r129 L1 action signed directly by the user\'s own Saturn Wallet (no agent) is accepted; a stranger is not', opts, async t => {
  const S = await setup(t, { hl: { agents: [] } });
  assert.equal((await S.call(l1(order(), S.now(), USERK))).code, 200);
  assert.equal((await S.call(l1(order({ c: '0x' + '22'.repeat(16) }), S.now() + 1, OTHERK))).body.error, 'agent_not_approved');
});

test('r129 unified balance: one number = venue collateral + Saturn Wallet Arbitrum USDC; Trade.xyz counts the main balance via move; nothing double counted', opts, async t => {
  const S = await setup(t, { hl: { acct: { mode: 'disabled', main: 50, xyz: 0, used: 10 }, wallet: { usdc: 20, eth: 0.001 } } });
  const h = (await G(S, '/v1/perps/hl/balance?user=' + USER + '&market=HYPE')).body;
  assert.equal(h.venue.direct, 40, 'withdrawable excludes the 10 committed to positions'); assert.equal(h.wallet.usable, 20); assert.equal(h.available, 60);
  const x = (await G(S, '/v1/perps/hl/balance?user=' + USER + '&market=SNDK')).body;
  assert.equal(x.venue.direct, 0); assert.equal(x.venue.viaMove, 40); assert.equal(x.available, 60, 'same funds, same total, whichever market');
  assert.equal((await G(S, '/v1/perps/hl/balance?user=nope')).code, 400);
  assert.equal((await G(S, '/v1/perps/hl/balance?user=' + USER + '&market=SOL')).code, 400, 'Jupiter markets are not accounted here');
});

test('r129 unified-account mode uses the single spot USDC balance (no move needed)', opts, async t => {
  const S = await setup(t, { hl: { acct: { mode: 'unifiedAccount', spot: 80, main: 80, xyz: 80 }, wallet: { usdc: 0, eth: 0 } } });
  const x = (await G(S, '/v1/perps/hl/balance?user=' + USER + '&market=SNDK')).body;
  assert.equal(x.unified, true); assert.equal(x.venue.direct, 80); assert.equal(x.venue.viaMove, 0); assert.equal(x.available, 80); assert.equal(x.wallet.reason, 'none');
});

test('r129 wallet USDC below the 5 USDC bridge minimum, or without ETH for gas, is NOT counted as available', opts, async t => {
  const S1 = await setup(t, { hl: { acct: { main: 0 }, wallet: { usdc: 3, eth: 0.01 } } });
  const a = (await G(S1, '/v1/perps/hl/balance?user=' + USER + '&market=HYPE')).body; assert.equal(a.available, 0); assert.equal(a.wallet.reason, 'below_min_deposit');
});
test('r129 wallet USDC without ETH gas is not available', opts, async t => {
  const S2 = await setup(t, { hl: { acct: { main: 0 }, wallet: { usdc: 30, eth: 0 } } });
  const b = (await G(S2, '/v1/perps/hl/balance?user=' + USER + '&market=HYPE')).body; assert.equal(b.available, 0); assert.equal(b.wallet.reason, 'no_gas');
});

test('r129 funding: verified on Arbitrum, recorded pending (counted nowhere), credited only from Hyperliquid\'s ledger, never twice', opts, async t => {
  const S = await setup(t, { hl: { acct: { main: 0 }, wallet: { usdc: 0, eth: 0.001 } } });
  const tx = '0x' + 'a1'.repeat(32), bad = '0x' + 'b2'.repeat(32);
  S.F.receipts[tx] = S.F.receipt(USER, BRIDGE, 25); S.F.receipts[bad] = S.F.receipt(USER, '0x' + '99'.repeat(20), 25);
  assert.equal((await P(S, '/v1/perps/hl/funding', { user: USER, txHash: bad, amount: 25 })).body.error, 'not_a_deposit');
  assert.equal((await P(S, '/v1/perps/hl/funding', { user: USER, txHash: '0x' + 'c3'.repeat(32), amount: 25 })).code, 202, 'not mined yet');
  const r = await P(S, '/v1/perps/hl/funding', { user: USER, txHash: tx, amount: 25 }); assert.equal(r.body.recorded, true);
  assert.equal((await P(S, '/v1/perps/hl/funding', { user: USER, txHash: tx, amount: 25 })).body.duplicate, true);
  let b = (await G(S, '/v1/perps/hl/balance?user=' + USER + '&market=HYPE')).body;
  assert.equal(b.pending.usd, 25); assert.equal(b.available, 0, 'pending is not available');
  S.F.ledger.push({ time: Date.now(), hash: '0xledger1', delta: { type: 'deposit', usdc: '25.0' } }); S.F.acct.main = 25; S.e.clock.t += 5000;
  b = (await G(S, '/v1/perps/hl/balance?user=' + USER + '&market=HYPE')).body;
  assert.equal(b.pending.usd, 0); assert.equal(b.available, 25, 'credited funds counted once, on the venue');
  assert.deepEqual((await S.e.db.rows("SELECT state, ledger_hash FROM perps_hl_funding")).map(x => [x.state, x.ledger_hash]), [['credited', '0xledger1']]);
});

test('r129 funding registration is behind the execution switch', opts, async t => {
  const S = await setup(t, { enabled: false });
  assert.equal((await P(S, '/v1/perps/hl/funding', { user: USER, txHash: '0x' + 'a1'.repeat(32), amount: 25 })).code, 403);
});

/* ---------- r131 global Saturn platform fee (0.06%) via Hyperliquid builder codes ---------- */
const FEEK = H.newPrivateKey(), FEEW = H.addressOf(FEEK);
const withB = (act, b = { b: FEEW, f: 60 }) => ({ ...act, builder: b });
const abf = (over = {}, n) => ({ type: 'approveBuilderFee', signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet', maxFeeRate: '0.06%', builder: FEEW, nonce: n, ...over });
const ABF_TYPES = [{ name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' }, { name: 'builder', type: 'address' }, { name: 'nonce', type: 'uint64' }];

test('r131 fee wallet set + funded: every order must carry exactly {b: Saturn fee wallet, f: 60}; it is forwarded with the builder field', opts, async t => {
  const S = await setup(t, { env: { SATURN_PERPS_FEE_WALLET_EVM: FEEW.toUpperCase().replace('0X', '0x') }, hl: { builders: { [FEEW]: 150 } } });
  const [, cfg] = await S.gw.handle({ method: 'GET', headers: {} }, '/v1/perps/hl/config', null, '1.1.1.1');
  assert.deepEqual({ ...cfg.saturnFee }, { bps: 6, rate: 0.0006, percent: '0.06%', mechanism: 'hyperliquid-builder-code', builder: FEEW, builderTenthsBp: 60, collecting: true, reason: null });
  const n = () => S.now() + Math.floor(Math.random() * 1000);
  const cases = [
    [l1(order({ c: '0x' + '11'.repeat(16) }), n()), 400, 'saturn_fee_required'],
    [l1(withB(order({ c: '0x' + '12'.repeat(16) }), { b: USER, f: 60 }), n()), 400, 'saturn_fee_mismatch'],
    [l1(withB(order({ c: '0x' + '13'.repeat(16) }), { b: FEEW, f: 100 }), n()), 400, 'saturn_fee_mismatch'],
    [l1(withB(order({ c: '0x' + '14'.repeat(16) }), { b: FEEW, f: 59 }), n()), 400, 'saturn_fee_mismatch'],
    [l1(order({ r: true, c: '0x' + '15'.repeat(16) }), n()), 400, 'saturn_fee_required'],   /* closing side pays too (per executed side) */
  ];
  for (const [b, code, err] of cases) { const r = await S.call(b); assert.equal(r.code, code, err + ' -> ' + JSON.stringify(r.body)); assert.equal(r.body.error, err); }
  assert.equal(S.F.sent.length, 0);
  const ok = l1(withB(order({ c: '0x' + '16'.repeat(16) })), n());
  const r = await S.call(ok); assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(S.F.sent[0].action), ['type', 'orders', 'grouping', 'builder'], 'official SDK key order');
  assert.deepEqual(S.F.sent[0].action.builder, { b: FEEW, f: 60 });
  const rows = await S.e.db.rows("SELECT saturn_fee_tenths_bp FROM perps_hl_requests WHERE state = 'submitted'"); assert.equal(rows[0].saturn_fee_tenths_bp, 60, 'audited');
});

test('r131 approveBuilderFee: only Saturn\'s fee wallet at exactly "0.06%", signed by the user\'s own wallet', opts, async t => {
  const S = await setup(t, { env: { SATURN_PERPS_FEE_WALLET_EVM: FEEW }, hl: { builders: { [FEEW]: 150 } } });
  const sign = (a, k) => userSigned(a, ABF_TYPES, 'HyperliquidTransaction:ApproveBuilderFee', k);
  const n = () => S.now() + Math.floor(Math.random() * 1000);
  let x = n(); assert.equal((await S.call(sign(abf({ builder: USER }, x)))).body.error, 'builder_not_allowed');
  x = n(); assert.equal((await S.call(sign(abf({ maxFeeRate: '0.1%' }, x)))).body.error, 'fee_rate_mismatch');
  x = n(); assert.equal((await S.call(sign(abf({ maxFeeRate: '0.05%' }, x)))).body.error, 'fee_rate_mismatch');
  x = n(); assert.equal((await S.call(sign(abf({}, x), OTHERK))).body.error, 'bad_signature');
  assert.equal(S.F.sent.length, 0);
  x = n(); const r = await S.call(sign(abf({}, x))); assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(S.F.sent[0].action.type, 'approveBuilderFee'); assert.equal(S.F.sent[0].action.builder, FEEW); assert.equal(S.F.sent[0].action.maxFeeRate, '0.06%');
});

test('r131 fee not collectable: no wallet -> no builder allowed, honest config; wallet below 100 USDC -> opening paused, closing still works without a fee', opts, async t => {
  const S = await setup(t);
  const [, cfg] = await S.gw.handle({ method: 'GET', headers: {} }, '/v1/perps/hl/config', null, '1.1.1.1');
  assert.equal(cfg.saturnFee.bps, 6); assert.equal(cfg.saturnFee.collecting, false); assert.equal(cfg.saturnFee.reason, 'fee_wallet_not_set');
  assert.equal((await S.call(l1(withB(order({ c: '0x' + '21'.repeat(16) })), S.now()))).body.error, 'builder_not_allowed', 'no builder fee to anyone when Saturn has no fee wallet');
  const n = S.now() + 7; const ab = userSigned(abf({}, n), ABF_TYPES, 'HyperliquidTransaction:ApproveBuilderFee');
  assert.equal((await S.call(ab)).body.error, 'fee_wallet_not_set');
  const U = await setup(t, { env: { SATURN_PERPS_FEE_WALLET_EVM: FEEW }, hl: { builders: { [FEEW]: 40 } } });
  const [, c2] = await U.gw.handle({ method: 'GET', headers: {} }, '/v1/perps/hl/config', null, '1.1.1.1');
  assert.equal(c2.saturnFee.collecting, false); assert.equal(c2.saturnFee.reason, 'fee_wallet_below_100_usdc');
  assert.equal((await U.call(l1(order({ c: '0x' + '22'.repeat(16) }), U.now()))).body.error, 'fee_wallet_unfunded');
  const close = await U.call(l1(order({ r: true, c: '0x' + '23'.repeat(16) }), U.now() + 3)); assert.equal(close.code, 200, 'users can always exit');
});

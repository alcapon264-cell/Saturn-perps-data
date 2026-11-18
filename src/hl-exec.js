/* r128 Saturn Perps: Hyperliquid MAINNET execution relay  /v1/perps/hl/*
 * Saturn never holds a user key and never signs. The user's Ethereum wallet signs user-signed actions; a browser-held, trade-only
 * Hyperliquid agent ("API wallet", cannot withdraw) signs L1 trading actions. This relay checks every request, records it, and only then
 * forwards it to https://api.hyperliquid.xyz/exchange.
 *
 *   GET  /v1/perps/hl/config    execution switch, limits, verified markets (public, no secrets)
 *   GET  /v1/perps/hl/markets   mainnet discovery for the 8 Hyperliquid / Trade.xyz markets (read-only)
 *   POST /v1/perps/hl/exchange  relay ONE signed action (403 execution_disabled unless BOTH switches below are on)
 *   GET  /v1/perps/hl/balance   r129 unified balance for ONE Saturn Wallet EVM address: venue collateral + Saturn Wallet USDC on Arbitrum
 *                               + pending transfers, reconciled against Hyperliquid's own ledger (read-only)
 *   POST /v1/perps/hl/funding   r129 record a Saturn Wallet -> Hyperliquid deposit AFTER verifying the Arbitrum receipt (execution switch applies)
 *
 * Real-money switches (both required):
 *   1. HL_EXECUTE_VERIFIED in this file (code; false until the owner approves activation after review)
 *   2. HL_EXECUTION_ENABLED=1 in the environment
 * plus a market must be listed in HL_VERIFIED_MARKETS to accept any position-opening order.
 *
 * Checks on every POST: strict schema; action allowlist (no usdSend/spotSend/vault/builder-fee/abstraction changes);
 * Mainnet only; signature recovered here (user-signed: must equal the claimed user; L1: must be an agent Hyperliquid lists for that
 * user and not expired); nonce freshness; durable replay/idempotency (sha256(signer:nonce)); unique cloid per user for orders;
 * order-size cap; leverage cap; IOC price within the slippage cap of Hyperliquid's current mid; resting-limit price band;
 * transfers only to the user's own address; per-IP / per-user / upstream rate limits; audit row without secrets.
 * An ambiguous upstream result (timeout / network / 5xx) is recorded as 'unknown' and never retried. */
import { createHash } from 'node:crypto';
import { VIEW_MARKET_TABLE } from './config.js';
import * as H from './vendor/hlsign.mjs';

export const HL_EXECUTE_VERIFIED = true;   /* r130: owner approved real-money activation on 2026-11-18 (all 8 markets). Still needs HL_EXECUTION_ENABLED=1 + HL_VERIFIED_MARKETS on Render */
export const HL_API = 'https://api.hyperliquid.xyz';
export const USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';   /* Hyperliquid mainnet USDC (token 0) */
export const ARB = Object.freeze({ usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', bridge2: '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7', minDeposit: 5 });   /* Arbitrum One native USDC, Hyperliquid Bridge2 */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const DEFAULT_ARB_RPC = 'https://arb1.arbitrum.io/rpc';   /* public Arbitrum One RPC; override with ARB_RPC_URL (never returned to clients) */
const ADDR = /^0x[0-9a-fA-F]{40}$/, HEX32 = /^0x[0-9a-fA-F]{1,64}$/, CLOID = /^0x[0-9a-f]{32}$/, DEC = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
const USER_SIGNED = { approveAgent: { types: H.APPROVE_AGENT_TYPES, primary: 'HyperliquidTransaction:ApproveAgent' },
  withdraw3: { types: H.WITHDRAW_TYPES, primary: 'HyperliquidTransaction:Withdraw' },
  sendAsset: { types: [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'sourceDex', type: 'string' }, { name: 'destinationDex', type: 'string' },
    { name: 'token', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'fromSubAccount', type: 'string' }, { name: 'nonce', type: 'uint64' }], primary: 'HyperliquidTransaction:SendAsset' } };
const L1 = new Set(['order', 'cancel', 'cancelByCloid', 'updateLeverage']);
const onlyKeys = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k));
const sha = s => createHash('sha256').update(s).digest('hex');
const refuse = (code, error, message, extra) => Object.assign(new Error(error), { http: code, error, message, extra });

export function hlConfig(env) {
  const num = (v, d, lo, hi) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  const list = String(env.HL_VERIFIED_MARKETS || '').split(',').map(s => s.trim().toUpperCase()).filter(k => k && VIEW_MARKET_TABLE[k]);
  const requested = /^1$/.test(String(env.HL_EXECUTION_ENABLED || ''));
  return { requested, enabled: HL_EXECUTE_VERIFIED && requested, verifiedMarkets: list,
    maxOrderUsd: num(env.HL_MAX_ORDER_USD, 50, 10, 100000), maxLeverage: num(env.HL_MAX_LEVERAGE, 10, 1, 50),
    maxSlippageBps: num(env.HL_MAX_SLIPPAGE_BPS, 300, 10, 1000), limitBandPct: 20, maxWithdrawUsd: num(env.HL_MAX_WITHDRAW_USD, 1000, 2, 1000000),
    agentMaxDays: 30, nonceSkewPastMs: 10 * 60000, nonceSkewFutureMs: 60000, maxBody: 8192, arbRpc: /^https:\/\/[^\s]+$/.test(String(env.ARB_RPC_URL || '')) ? String(env.ARB_RPC_URL) : DEFAULT_ARB_RPC,
    perMinIp: 30, perMinUser: 20, ordersPerMinUser: 8, upstreamPerMin: 120 };
}

export function createHlGateway({ cfg, store, limiter, now = Date.now, fetchImpl = globalThis.fetch, metrics, log = () => {}, api = HL_API }) {
  const C = cfg.hl;
  /* ---------- Hyperliquid info (read-only) ---------- */
  async function info(body, ms = 8000) {
    if (limiter('hl|upstream', C.upstreamPerMin)) throw refuse(503, 'upstream_busy', 'Saturn is at its Hyperliquid request budget. Try again in a minute.');
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try { const r = await fetchImpl(api + '/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      if (!r.ok) throw new Error('http_' + r.status); return await r.json(); }
    finally { clearTimeout(t) }
  }
  const cache = new Map();
  async function cached(key, ttl, fn) { const c = cache.get(key); if (c && now() - c.at < ttl) return c.v; const v = await fn(); cache.set(key, { at: now(), v }); if (cache.size > 2000) cache.delete(cache.keys().next().value); return v; }

  /* market discovery: the 8 markets, resolved against Hyperliquid mainnet metadata (asset id = index, or 100000 + dexIndex*10000 + index for HIP-3) */
  async function markets() {
    return cached('markets', 60000, async () => {
      const dexes = await info({ type: 'perpDexs' });
      if (!Array.isArray(dexes)) throw new Error('perpDexs unreadable');
      const metas = {};
      for (const dex of ['', 'xyz']) { const r = await info(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }); metas[dex] = Array.isArray(r) && r[0] && Array.isArray(r[0].universe) ? r : null; }
      const out = [];
      for (const [k, d] of Object.entries(VIEW_MARKET_TABLE)) {
        const dex = d.dex || '', venue = dex ? 'hyperliquid:' + dex : 'hyperliquid';
        const row = { market: k, venue, dex, network: 'hyperliquid-mainnet', collateral: 'USDC', coin: null, asset: null, dexIndex: null, szDecimals: null, maxLeverage: null, onlyIsolated: null,
          markPx: null, funding: null, listed: false, blocker: null, verified: C.verifiedMarkets.includes(k) };
        const di = dex ? dexes.findIndex(x => x && x.name === dex) : 0;
        const m = metas[dex];
        if (di < 0 || !m) { row.blocker = dex + ' dex not found on Hyperliquid mainnet'; out.push(row); continue; }
        if (dex && m[0].collateralToken !== undefined && m[0].collateralToken !== 0) { row.blocker = dex + ' collateral is not USDC'; out.push(row); continue; }
        const uni = m[0].universe; let idx = -1;
        for (const c of d.venueCoins) { idx = uni.findIndex(u => u && u.name === c); if (idx >= 0) { row.coin = c; break; } }
        if (idx < 0) { row.blocker = 'not listed on Hyperliquid mainnet'; out.push(row); continue; }
        const u = uni[idx], cx = (m[1] || [])[idx] || {};
        if (u.isDelisted) { row.blocker = 'delisted on Hyperliquid mainnet'; out.push(row); continue; }
        Object.assign(row, { listed: true, dexIndex: di, asset: dex ? 100000 + di * 10000 + idx : idx, szDecimals: u.szDecimals | 0, maxLeverage: u.maxLeverage | 0,
          onlyIsolated: !!u.onlyIsolated || u.marginMode === 'strictIsolated' || u.marginMode === 'noCross', markPx: Number(cx.markPx) || null, funding: cx.funding != null ? Number(cx.funding) : null });
        out.push(row);
      }
      return out;
    });
  }
  const byAsset = async a => (await markets()).find(m => m.listed && m.asset === a) || null;
  async function mid(m) { const r = await cached('mids|' + m.dex, 3000, () => info(m.dex ? { type: 'allMids', dex: m.dex } : { type: 'allMids' })); const p = r && Number(r[m.coin]); return p > 0 ? p : null; }
  async function agentsOf(user, fresh) {
    const k = 'agents|' + user; if (fresh) cache.delete(k);
    const l = await cached(k, 30000, () => info({ type: 'extraAgents', user }));
    return Array.isArray(l) ? l : [];
  }

  /* ---------- canonical actions (exact field order the official SDK hashes) ---------- */
  function canonOrder(a) {
    /* one order (grouping "na"), or r129 one entry order + its TP and/or SL (grouping "normalTpsl"); never a builder fee */
    if (!onlyKeys(a, ['type', 'orders', 'grouping']) || !Array.isArray(a.orders) || !((a.grouping === 'na' && a.orders.length === 1) || (a.grouping === 'normalTpsl' && a.orders.length >= 2 && a.orders.length <= 3)))
      throw refuse(400, 'bad_action', 'One order (or one order with its TP/SL) per request, no builder fee.');
    const wires = a.orders.map((o, i) => {
      const lim = o && o.t && onlyKeys(o.t, ['limit']) && onlyKeys(o.t.limit, ['tif']) && ['Gtc', 'Ioc', 'Alo'].includes(o.t.limit.tif);
      const trg = o && o.t && onlyKeys(o.t, ['trigger']) && onlyKeys(o.t.trigger, ['isMarket', 'triggerPx', 'tpsl']) && o.t.trigger.isMarket === true && DEC.test(o.t.trigger.triggerPx) && ['tp', 'sl'].includes(o.t.trigger.tpsl);
      if (!onlyKeys(o, ['a', 'b', 'p', 's', 'r', 't', 'c']) || !Number.isInteger(o.a) || typeof o.b !== 'boolean' || typeof o.r !== 'boolean' || !DEC.test(o.p) || !DEC.test(o.s) || !(i === 0 ? lim : trg))
        throw refuse(400, 'bad_order', 'Malformed order.');
      if (o.p !== H.floatToWire(Number(o.p)) || o.s !== H.floatToWire(Number(o.s)) || (trg && o.t.trigger.triggerPx !== H.floatToWire(Number(o.t.trigger.triggerPx)))) throw refuse(400, 'bad_order', 'Price and size must be in canonical form.');
      if (o.c !== undefined && !CLOID.test(o.c)) throw refuse(400, 'bad_order', 'Bad client order id.');
      const w = { a: o.a, b: o.b, p: o.p, s: o.s, r: o.r, t: lim ? { limit: { tif: o.t.limit.tif } } : { trigger: { isMarket: true, triggerPx: o.t.trigger.triggerPx, tpsl: o.t.trigger.tpsl } } }; if (o.c) w.c = o.c;
      return w;
    });
    if (a.grouping === 'normalTpsl') {
      const [m0, ...ch] = wires, kinds = ch.map(x => x.t.trigger.tpsl);
      if (m0.r || new Set(kinds).size !== kinds.length || ch.some(x => x.a !== m0.a || x.b === m0.b || !x.r || x.s !== m0.s || x.p !== x.t.trigger.triggerPx)) throw refuse(400, 'bad_tpsl', 'TP/SL must be reduce-only, opposite side, same market and size as the order.');
    }
    return { type: 'order', orders: wires, grouping: a.grouping };
  }
  function canonL1(a) {
    if (a.type === 'order') return canonOrder(a);
    if (a.type === 'cancel') { if (!onlyKeys(a, ['type', 'cancels']) || !Array.isArray(a.cancels) || a.cancels.length !== 1 || !onlyKeys(a.cancels[0], ['a', 'o']) || !Number.isInteger(a.cancels[0].a) || !Number.isInteger(a.cancels[0].o)) throw refuse(400, 'bad_action', 'Malformed cancel.'); return { type: 'cancel', cancels: [{ a: a.cancels[0].a, o: a.cancels[0].o }] }; }
    if (a.type === 'cancelByCloid') { if (!onlyKeys(a, ['type', 'cancels']) || !Array.isArray(a.cancels) || a.cancels.length !== 1 || !onlyKeys(a.cancels[0], ['asset', 'cloid']) || !Number.isInteger(a.cancels[0].asset) || !CLOID.test(a.cancels[0].cloid)) throw refuse(400, 'bad_action', 'Malformed cancel.'); return { type: 'cancelByCloid', cancels: [{ asset: a.cancels[0].asset, cloid: a.cancels[0].cloid }] }; }
    if (a.type === 'updateLeverage') { if (!onlyKeys(a, ['type', 'asset', 'isCross', 'leverage']) || !Number.isInteger(a.asset) || typeof a.isCross !== 'boolean' || !Number.isInteger(a.leverage)) throw refuse(400, 'bad_action', 'Malformed leverage update.'); return { type: 'updateLeverage', asset: a.asset, isCross: a.isCross, leverage: a.leverage }; }
    throw refuse(400, 'action_not_allowed', 'This action is not allowed through Saturn.');
  }
  function canonUser(a) {
    const base = ['type', 'signatureChainId', 'hyperliquidChain'];
    if (typeof a.signatureChainId !== 'string' || !/^0x[0-9a-f]{1,8}$/.test(a.signatureChainId)) throw refuse(400, 'bad_action', 'Bad signatureChainId.');
    if (a.hyperliquidChain !== 'Mainnet') throw refuse(400, 'wrong_network', 'Saturn only relays Hyperliquid mainnet actions.');
    if (a.type === 'approveAgent') { if (!onlyKeys(a, [...base, 'agentAddress', 'agentName', 'nonce']) || !ADDR.test(a.agentAddress) || typeof a.agentName !== 'string' || !Number.isInteger(a.nonce)) throw refuse(400, 'bad_action', 'Malformed agent approval.'); return { type: a.type, signatureChainId: a.signatureChainId, hyperliquidChain: 'Mainnet', agentAddress: a.agentAddress.toLowerCase(), agentName: a.agentName, nonce: a.nonce }; }
    if (a.type === 'withdraw3') { if (!onlyKeys(a, [...base, 'destination', 'amount', 'time']) || !ADDR.test(a.destination) || !DEC.test(a.amount) || !Number.isInteger(a.time)) throw refuse(400, 'bad_action', 'Malformed withdrawal.'); return { type: a.type, signatureChainId: a.signatureChainId, hyperliquidChain: 'Mainnet', destination: a.destination, amount: a.amount, time: a.time }; }
    if (a.type === 'sendAsset') { if (!onlyKeys(a, [...base, 'destination', 'sourceDex', 'destinationDex', 'token', 'amount', 'fromSubAccount', 'nonce']) || !ADDR.test(a.destination) || !DEC.test(a.amount) || !Number.isInteger(a.nonce)) throw refuse(400, 'bad_action', 'Malformed transfer.'); return { type: a.type, signatureChainId: a.signatureChainId, hyperliquidChain: 'Mainnet', destination: a.destination, sourceDex: a.sourceDex, destinationDex: a.destinationDex, token: a.token, amount: a.amount, fromSubAccount: a.fromSubAccount, nonce: a.nonce }; }
    throw refuse(400, 'action_not_allowed', 'This action is not allowed through Saturn.');
  }

  /* ---------- policy ---------- */
  async function checkUserSigned(a, user) {
    const t = now();
    if (a.type === 'approveAgent') {
      const m = /^saturn valid_until (\d{13})$/.exec(a.agentName);
      if (!m || Number(m[1]) <= t || Number(m[1]) > t + C.agentMaxDays * 86400000) throw refuse(400, 'agent_expiry', 'Saturn trading keys must expire within ' + C.agentMaxDays + ' days.');
      return { reason: null };
    }
    if (a.type === 'withdraw3') {
      if (a.destination.toLowerCase() !== user) throw refuse(400, 'own_address_only', 'Withdrawals can only go to your own wallet address.');
      const amt = Number(a.amount); if (!(amt >= 2) || amt > C.maxWithdrawUsd) throw refuse(400, 'bad_amount', 'Withdrawals must be between $2 and $' + C.maxWithdrawUsd + '.');
      return { amount: amt };
    }
    if (a.type === 'sendAsset') {
      if (a.destination.toLowerCase() !== user || a.fromSubAccount !== '' || a.token !== USDC_TOKEN) throw refuse(400, 'own_address_only', 'Only USDC moves between your own Hyperliquid balances.');
      const ok = new Set(['', 'xyz']); if (!ok.has(a.sourceDex) || !ok.has(a.destinationDex) || a.sourceDex === a.destinationDex) throw refuse(400, 'bad_transfer', 'Only transfers between the main USDC balance and Trade.xyz are allowed.');
      const amt = Number(a.amount); if (!(amt > 0) || amt > 1000000) throw refuse(400, 'bad_amount', 'Bad amount.');
      return { amount: amt };
    }
  }
  async function checkL1(a, user) {
    if (a.type === 'cancel' || a.type === 'cancelByCloid') { const m = await byAsset(a.type === 'cancel' ? a.cancels[0].a : a.cancels[0].asset); if (!m) throw refuse(400, 'unknown_asset', 'Not a Saturn Hyperliquid market.'); return { m }; }
    if (a.type === 'updateLeverage') {
      const m = await byAsset(a.asset); if (!m) throw refuse(400, 'unknown_asset', 'Not a Saturn Hyperliquid market.');
      if (!C.verifiedMarkets.includes(m.market)) throw refuse(403, 'market_not_verified', m.market + ' is not activated for trading.');
      if (a.leverage < 1 || a.leverage > Math.min(m.maxLeverage, C.maxLeverage)) throw refuse(400, 'leverage_limit', 'Leverage must be 1-' + Math.min(m.maxLeverage, C.maxLeverage) + 'x.');
      if (m.onlyIsolated && a.isCross) throw refuse(400, 'isolated_only', m.market + ' is isolated margin only.');
      return { m };
    }
    const o = a.orders[0], m = await byAsset(o.a); if (!m) throw refuse(400, 'unknown_asset', 'Not a Saturn Hyperliquid market.');
    const px = Number(o.p), sz = Number(o.s), notional = px * sz;
    if (Math.round(sz * 10 ** m.szDecimals) !== +(sz * 10 ** m.szDecimals).toFixed(6)) throw refuse(400, 'bad_size', 'Size has too many decimals for ' + m.market + '.');
    const ref = await mid(m); if (!ref) throw refuse(503, 'no_price', 'No live Hyperliquid price for ' + m.market + ' right now.');
    const tif = o.t.limit.tif, dev = Math.abs(px - ref) / ref;
    if (!o.r) {
      if (!C.verifiedMarkets.includes(m.market)) throw refuse(403, 'market_not_verified', m.market + ' is not activated for trading.');
      if (!o.c) throw refuse(400, 'cloid_required', 'Orders need a client order id.');
      if (notional > C.maxOrderUsd) throw refuse(400, 'order_too_large', 'Saturn limits orders to $' + C.maxOrderUsd + ' for now.');
      if (notional < 10) throw refuse(400, 'order_too_small', 'Hyperliquid needs at least $10 per order.');
    }
    if (tif === 'Ioc') { const worse = o.b ? px > ref : px < ref; if (worse && dev > C.maxSlippageBps / 10000) throw refuse(400, 'slippage_limit', 'Price is more than ' + C.maxSlippageBps / 100 + '% from the market.'); }
    else if (dev > C.limitBandPct / 100) throw refuse(400, 'price_band', 'Limit price must be within ' + C.limitBandPct + '% of the market.');
    for (const x of a.orders.slice(1)) {   /* r129 TP above / SL below the price for a long, the reverse for a short; within 90% */
      const tp = x.t.trigger.tpsl === 'tp', trig = Number(x.t.trigger.triggerPx), long = o.b;
      const okSide = tp ? (long ? trig > ref : trig < ref) : (long ? trig < ref : trig > ref);
      if (!okSide || Math.abs(trig - ref) / ref > 0.9 || !(trig > 0)) throw refuse(400, 'bad_tpsl', (tp ? 'Take profit' : 'Stop loss') + ' price is on the wrong side of the market.');
    }
    if (!o.r && limiter('hlu:' + user + '|orders', C.ordersPerMinUser)) throw refuse(429, 'rate_limited', 'Too many orders. Wait a moment.');
    return { m, notional, ref };
  }

  async function readBody(req) {
    if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] || ''))) throw refuse(415, 'content_type');
    const len = Number(req.headers['content-length']); if (Number.isFinite(len) && len > C.maxBody) throw refuse(413, 'body_too_large');
    return await new Promise((resolve, reject) => {
      let size = 0; const chunks = []; const t = setTimeout(() => { reject(refuse(408, 'body_timeout')); req.destroy(); }, 5000);
      req.on('data', c => { size += c.length; if (size > C.maxBody) { clearTimeout(t); reject(refuse(413, 'body_too_large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { clearTimeout(t); try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; resolve(o); } catch { reject(refuse(400, 'bad_json')); } });
      req.on('error', () => { clearTimeout(t); reject(refuse(400, 'body_error')); });
    });
  }

  async function exchange(req, ip) {
    const t0 = now(), ipHash = sha('ip|' + ip).slice(0, 16);
    if (!C.enabled) { metrics?.inc('hl_exec_disabled'); return [403, { ok: false, error: 'execution_disabled', message: 'Real-money Hyperliquid trading is not activated in Saturn yet.' }]; }
    if (limiter(ip + '|hl-exec', C.perMinIp)) return [429, { ok: false, error: 'rate_limited', message: 'Too many requests.' }, { 'retry-after': '20' }];
    const b = await readBody(req);
    if (!onlyKeys(b, ['action', 'nonce', 'signature', 'vaultAddress', 'user']) || !b.action || typeof b.action.type !== 'string' || !Number.isInteger(b.nonce) || !ADDR.test(b.user || '') || (b.vaultAddress != null)
      || !onlyKeys(b.signature, ['r', 's', 'v']) || !HEX32.test(b.signature.r) || !HEX32.test(b.signature.s) || ![27, 28].includes(b.signature.v)) return [400, { ok: false, error: 'bad_request' }];
    const user = b.user.toLowerCase(), type = b.action.type, n = b.nonce, t = now();
    if (n < t - C.nonceSkewPastMs || n > t + C.nonceSkewFutureMs) return [400, { ok: false, error: 'stale_nonce', message: 'This request is too old. Review the order again.' }];
    if (limiter('hlu:' + user + '|exec', C.perMinUser)) return [429, { ok: false, error: 'rate_limited', message: 'Too many requests.' }, { 'retry-after': '20' }];
    let action, signer, pol = {}, row = { user_addr: user, action_type: type, ip_hash: ipHash };
    try {
      if (USER_SIGNED[type]) {
        action = canonUser(b.action);
        const inner = type === 'withdraw3' ? action.time : action.nonce; if (inner !== n) throw refuse(400, 'nonce_mismatch', 'Nonce mismatch.');
        const U = USER_SIGNED[type];
        signer = H.recoverAddress(H.typedDataHash(H.userSignedPayload(U.primary, U.types, action)), b.signature).toLowerCase();
        if (signer !== user) throw refuse(401, 'bad_signature', 'The signature is not from this wallet.');
        pol = await checkUserSigned(action, user) || {};
        row.amount_usd = pol.amount ?? null;
      } else if (L1.has(type)) {
        action = canonL1(b.action);
        signer = H.recoverAddress(H.typedDataHash(H.l1Payload(H.actionHash(action, null, n, null), true /* mainnet */)), b.signature).toLowerCase();
        if (signer !== user) {   /* the user's own Saturn Wallet may sign directly; otherwise it must be a trade-only agent Hyperliquid lists for this user */
          let ag = (await agentsOf(user)).find(x => x && String(x.address).toLowerCase() === signer);
          if (!ag) ag = (await agentsOf(user, true)).find(x => x && String(x.address).toLowerCase() === signer);
          if (!ag) throw refuse(401, 'agent_not_approved', 'This trading key is not approved for your account. Enable trading again.');
          if (ag.validUntil && Number(ag.validUntil) <= t) throw refuse(401, 'agent_expired', 'Your Saturn trading key expired. Enable trading again.');
        }
        pol = await checkL1(action, user);
        if (type === 'order') { const o = action.orders[0]; Object.assign(row, { market: pol.m.market, asset: o.a, is_buy: o.b, size: Number(o.s), price: Number(o.p), reduce_only: o.r, tif: o.t.limit.tif, cloid: o.c || null, notional_usd: pol.notional }); }
        else row.market = pol.m.market;
      } else throw refuse(400, 'action_not_allowed', 'This action is not allowed through Saturn.');
    } catch (e) {
      if (!e.http) throw e;
      metrics?.inc('hl_exec_refused');
      if (signer) await store.hlRecord({ id: sha(signer + ':' + n), signer, ...row, state: 'refused', reason: e.error }).catch(() => {});
      return [e.http, { ok: false, error: e.error, message: e.message }];
    }
    /* durable idempotency: one row per (signer, nonce); the cloid index also stops the same order twice */
    const id = sha(signer + ':' + n);
    let claim; try { claim = await store.hlClaim({ id, signer, ...row }); } catch (e) { return [503, { ok: false, error: 'db_unavailable' }]; }
    if (!claim.fresh) { const p = claim.prior; metrics?.inc('hl_exec_duplicate'); return [200, { ok: true, duplicate: true, state: p.state, exchange: p.response || null, message: p.state === 'unknown' ? 'Hyperliquid did not confirm this request. Check your open orders and positions.' : undefined }]; }
    if (claim.cloidTaken) return [409, { ok: false, error: 'duplicate_order', message: 'This order was already sent.' }];
    if (limiter('hl|upstream', C.upstreamPerMin)) { await store.hlSettle(id, 'refused', { reason: 'upstream_budget' }); return [503, { ok: false, error: 'upstream_busy' }]; }
    let up, status = null, j = null;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 10000);
    try { up = await fetchImpl(api + '/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, nonce: n, signature: b.signature, vaultAddress: null }), signal: ac.signal }); status = up.status; j = await up.json().catch(() => null); }
    catch (e) { status = null; } finally { clearTimeout(timer); }
    const lat = now() - t0;
    if (status === null || status >= 500 || !j) {
      await store.hlSettle(id, 'unknown', { upstream: status, latency: lat, reason: status === null ? 'network_or_timeout' : 'upstream_' + status }).catch(() => {});
      metrics?.inc('hl_exec_unknown');
      return [502, { ok: false, error: 'unknown_outcome', message: 'Hyperliquid did not confirm this request. Check your open orders and positions before trying again.' }];
    }
    const okish = status === 200 && j.status === 'ok';
    const errs = okish && j.response && j.response.data && Array.isArray(j.response.data.statuses) ? j.response.data.statuses.filter(s => s && s.error).map(s => String(s.error).slice(0, 150)) : [];
    const reason = !okish ? String(typeof j.response === 'string' ? j.response : j.error || 'rejected').slice(0, 200) : errs[0] || null;
    await store.hlSettle(id, okish && !errs.length ? 'submitted' : 'rejected', { upstream: status, latency: lat, reason, response: j }).catch(() => {});
    if (type === 'approveAgent' && okish) cache.delete('agents|' + user);
    for (const k of [...cache.keys()]) if (k.startsWith('bal|' + user + '|')) cache.delete(k);   /* r129: any accepted write changes the unified balance */
    metrics?.inc(okish ? 'hl_exec_forwarded' : 'hl_exec_rejected');
    log('hl_exec', { type, market: row.market || null, state: okish && !errs.length ? 'submitted' : 'rejected', ms: lat });
    return [200, { ok: okish, exchange: j }];
  }

  /* ---------- r129 Saturn Wallet <-> venue accounting ---------- */
  async function arb(method, params, ms = 8000) {
    if (limiter('hl|arb', 120)) throw refuse(503, 'upstream_busy', 'Saturn is at its Arbitrum request budget.');
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms);
    try { const r = await fetchImpl(C.arbRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
      const j = await r.json(); if (j.error) throw new Error('rpc'); return j.result; } finally { clearTimeout(tm); }
  }
  const pad32 = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  async function walletArb(user) {
    const [u, e] = await Promise.all([arb('eth_call', [{ to: ARB.usdc, data: '0x70a08231' + pad32(user) }, 'latest']), arb('eth_getBalance', [user, 'latest'])]);
    return { usdc: Number(BigInt(u || '0x0')) / 1e6, eth: Number(BigInt(e || '0x0')) / 1e18 };
  }
  async function reconcile(user) {   /* pending -> credited only when Hyperliquid's own ledger shows a matching deposit; each ledger entry settles one transfer */
    const list = await store.hlFundingList(user), pend = list.filter(x => x.state === 'pending');
    if (pend.length) {
      const used = new Set(list.map(x => x.ledger_hash).filter(Boolean));
      const led = await info({ type: 'userNonFundingLedgerUpdates', user, startTime: Math.min(...pend.map(x => x.t)) - 120000 });
      for (const p of pend) {
        const hit = (Array.isArray(led) ? led : []).find(x => x && x.delta && x.delta.type === 'deposit' && !used.has(x.hash) && Math.abs(Number(x.delta.usdc) - p.amount) < 0.01 && x.time >= p.t - 120000);
        if (hit && await store.hlFundingCredit(p.tx_hash, String(hit.hash))) { used.add(hit.hash); p.state = 'credited'; }
      }
    }
    return list;
  }
  async function balance(user, market) {
    return cached('bal|' + user + '|' + market, 4000, async () => {
      const mk = market ? (await markets()).find(m => m.market === market) : null;
      const [mode, main, xyz, spot, oo, oox, w, fund] = await Promise.all([info({ type: 'userAbstraction', user }).catch(() => null), info({ type: 'clearinghouseState', user }), info({ type: 'clearinghouseState', user, dex: 'xyz' }),
        info({ type: 'spotClearinghouseState', user }).catch(() => null), info({ type: 'frontendOpenOrders', user }).catch(() => []), info({ type: 'frontendOpenOrders', user, dex: 'xyz' }).catch(() => []),
        walletArb(user).catch(() => null), reconcile(user)]);
      const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
      const side = cs => ({ accountValue: n(cs && cs.marginSummary && cs.marginSummary.accountValue), withdrawable: n(cs && cs.withdrawable), marginUsed: n(cs && cs.marginSummary && cs.marginSummary.totalMarginUsed) });
      const unified = mode === 'unifiedAccount' || mode === 'portfolioMargin';
      const sb = spot && Array.isArray(spot.balances) ? spot.balances.find(b => b && b.coin === 'USDC') : null, spotFree = sb ? Math.max(0, n(sb.total) - n(sb.hold)) : 0;
      const M = side(main), X = side(xyz), dex = mk ? mk.dex : '';
      const orderNotional = [...(Array.isArray(oo) ? oo : []), ...(Array.isArray(oox) ? oox : [])].filter(o => o && !o.reduceOnly).reduce((s, o) => s + n(o.sz) * n(o.limitPx), 0);
      const venueDirect = unified ? spotFree : dex === 'xyz' ? X.withdrawable : M.withdrawable;   /* usable on this venue right now */
      const venueMove = !unified && dex === 'xyz' ? M.withdrawable : 0;                            /* main Hyperliquid balance that needs an internal move to Trade.xyz */
      const pending = fund.filter(x => x.state === 'pending').reduce((s, x) => s + x.amount, 0);
      const walletUsable = w && w.usdc >= ARB.minDeposit && w.eth > 0 ? w.usdc : 0;                 /* Saturn Wallet USDC on Arbitrum that can be funded (min 5, needs ETH gas) */
      return { ok: true, user, market: market || null, dex, mode: mode || 'unknown', unified,
        wallet: w ? { arbitrumUsdc: w.usdc, arbitrumEth: w.eth, usable: walletUsable, reason: !w ? 'unreadable' : w.usdc < ARB.minDeposit ? (w.usdc > 0 ? 'below_min_deposit' : 'none') : w.eth > 0 ? null : 'no_gas' } : { arbitrumUsdc: null, arbitrumEth: null, usable: 0, reason: 'unreadable' },
        venue: { main: M, xyz: X, spotFree, direct: venueDirect, viaMove: venueMove, committed: unified ? M.marginUsed + X.marginUsed : (dex === 'xyz' ? X.marginUsed : M.marginUsed), openOrderNotional: orderNotional },
        pending: { usd: pending, transfers: fund.filter(x => x.state === 'pending').map(x => ({ txHash: x.tx_hash, amount: x.amount })) },
        available: +(venueDirect + venueMove + walletUsable).toFixed(6),
        note: 'available = venue collateral usable now + Hyperliquid balance movable to this venue + Saturn Wallet USDC on Arbitrum (>=5, with gas). Pending transfers, open-order holds and position margin are excluded.' };
    });
  }
  async function registerFunding(req, ip) {
    if (!C.enabled) return [403, { ok: false, error: 'execution_disabled', message: 'Real-money Hyperliquid trading is not activated in Saturn yet.' }];
    if (limiter(ip + '|hl-fund', 10)) return [429, { ok: false, error: 'rate_limited' }];
    const b = await readBody(req);
    if (!onlyKeys(b, ['user', 'txHash', 'amount']) || !ADDR.test(b.user || '') || !/^0x[0-9a-f]{64}$/.test(b.txHash || '') || !(Number(b.amount) >= ARB.minDeposit)) return [400, { ok: false, error: 'bad_request' }];
    const user = b.user.toLowerCase(), amt = Number(b.amount);
    let rc; try { rc = await arb('eth_getTransactionReceipt', [b.txHash]); } catch (e) { return [503, { ok: false, error: 'rpc_unavailable', message: 'Could not read the Arbitrum transaction yet. Try again shortly.' }]; }
    if (!rc) return [202, { ok: false, error: 'not_mined', message: 'The Arbitrum transaction is not confirmed yet.' }];
    const log = rc.status === '0x1' && String(rc.to || '').toLowerCase() === ARB.usdc && (rc.logs || []).find(l => l && String(l.address).toLowerCase() === ARB.usdc && l.topics && l.topics[0] === TRANSFER_TOPIC
      && l.topics[1] === '0x' + pad32(user) && l.topics[2] === '0x' + pad32(ARB.bridge2));
    if (!log || Math.abs(Number(BigInt(log.data)) / 1e6 - amt) > 0.000001) return [400, { ok: false, error: 'not_a_deposit', message: 'That transaction is not a USDC transfer from this wallet to Hyperliquid.' }];
    const fresh = await store.hlFundingAdd({ tx_hash: b.txHash, user_addr: user, amount_usd: amt });
    for (const k of [...cache.keys()]) if (k.startsWith('bal|' + user + '|')) cache.delete(k);
    return [200, { ok: true, recorded: fresh, duplicate: !fresh, state: 'pending' }];
  }

  async function handle(req, path, q, ip) {
    try {
      if (path === '/v1/perps/hl/config' && req.method === 'GET') {
        if (limiter(ip + '|hl-cfg', 60)) return [429, { ok: false, error: 'rate_limited' }];
        return [200, { ok: true, network: 'hyperliquid-mainnet', api: HL_API, executionEnabled: C.enabled, executionRequested: C.requested, codeVerified: HL_EXECUTE_VERIFIED,
          verifiedMarkets: C.verifiedMarkets, limits: { maxOrderUsd: C.maxOrderUsd, maxLeverage: C.maxLeverage, maxSlippageBps: C.maxSlippageBps, limitBandPct: C.limitBandPct, maxWithdrawUsd: C.maxWithdrawUsd, agentMaxDays: C.agentMaxDays },
          bridge: { chainId: 42161, usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', bridge2: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7', minDepositUsd: 5, withdrawFeeUsd: 1 } }];
      }
      if (path === '/v1/perps/hl/markets' && req.method === 'GET') {
        if (limiter(ip + '|hl-mk', 30)) return [429, { ok: false, error: 'rate_limited' }];
        try { return [200, { ok: true, network: 'hyperliquid-mainnet', markets: await markets() }]; } catch (e) { return [503, { ok: false, error: 'upstream_unavailable' }]; }
      }
      if (path === '/v1/perps/hl/exchange' && req.method === 'POST') return await exchange(req, ip);
      if (path === '/v1/perps/hl/balance' && req.method === 'GET') {
        const user = String(q.get('user') || ''), market = String(q.get('market') || '').toUpperCase();
        if (!ADDR.test(user) || (market && !VIEW_MARKET_TABLE[market]) || [...q.keys()].some(k => k !== 'user' && k !== 'market')) return [400, { ok: false, error: 'bad_request' }];
        if (limiter(ip + '|hl-bal', 60) || limiter('hlu:' + user.toLowerCase() + '|bal', 40)) return [429, { ok: false, error: 'rate_limited' }];
        try { return [200, await balance(user.toLowerCase(), market)]; }
        catch (e) { return [503, { ok: false, error: 'balance_unavailable', message: 'Your balance could not be read right now. Nothing is shown until it can be verified.' }]; }
      }
      if (path === '/v1/perps/hl/funding' && req.method === 'POST') return await registerFunding(req, ip);
      return [404, { ok: false, error: 'not_found' }];
    } catch (e) {
      if (e && e.http) return [e.http, { ok: false, error: e.error, message: e.message }];
      metrics?.inc('hl_exec_errors'); return [500, { ok: false, error: 'server_error' }];
    }
  }
  return { handle, markets, _t: { canonL1, canonUser } };
}

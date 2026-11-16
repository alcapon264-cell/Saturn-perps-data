/* Saturn Perps gateway: /v1/perps/jup/*. Separate from Saturn's production backend. Holds no keys and never signs.
 *
 * Reads (always on):   GET  /v1/perps/jup/positions?walletAddress=<base58>&includeClosedPositions=false
 *                      GET  /v1/perps/jup/market-stats?mint=<SOL|ETH|BTC mint>    (served from this service's own recorder, no upstream call)
 * Transactions (OFF unless PERPS_EXECUTION_ENABLED=1 and GATEWAY_TICKET_SECRET is set; answer 403 execution_disabled otherwise):
 *                      POST /v1/perps/jup/positions/increase   build an UNSIGNED transaction via Jupiter, check it, return it with a ticket
 *                      POST /v1/perps/jup/positions/decrease   same, for close / partial close / collateral withdrawal
 *                      POST /v1/perps/jup/execute              relay ONE transaction the user's own wallet signed
 *
 * Abuse controls (an Origin header is NOT authentication and is not used as one):
 *   - strict schemas, unknown fields rejected, 8 KB bodies, JSON only, 5 s body deadline
 *   - per-IP and per-wallet limits, plus one shared upstream budget so the gateway can never starve the recorder of Jupiter quota
 *   - /execute needs a ticket the gateway issued for that exact message (HMAC over wallet, action, sha256(message), expiry),
 *     a valid ed25519 signature by the fee payer over that message, and a structurally valid Jupiter Perps transaction
 *   - durable idempotency by signature (PostgreSQL): a signature is relayed at most once; duplicates get the stored state
 *   - an ambiguous upstream result (timeout / network / 5xx) is recorded as 'unknown' and NEVER retried; the client checks the chain */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MARKETS } from './config.js';
import { parseTx, msgHash, verifyEd25519, b64ToBytes, b58encode, isPubkey } from './solana.js';
import { inspectPerpsTx, ACTIONS } from './perps-program.js';

const MINT_TO_MARKET = Object.fromEntries(Object.entries(MARKETS).map(([k, v]) => [v, k]));
const ASSETS = new Set(['SOL', 'ETH', 'BTC']), TOKENS = new Set(['USDC', 'SOL', 'ETH', 'BTC']);
const POS_KEYS = ['asset', 'side', 'leverage', 'sizeUsd', 'entryPriceUsd', 'markPriceUsd', 'collateralUsd', 'liquidationPriceUsd', 'pnlBeforeFeesUsd', 'pnlAfterFeesUsd', 'createdTime', 'assetMint', 'positionPubkey'];
const scalar = v => v === null || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 64 && /^[\x20-\x7e]*$/.test(v));
const clean = s => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '').slice(0, 200);
const digits = (s, max = 20) => typeof s === 'string' && new RegExp('^[1-9]\\d{0,' + (max - 1) + '}$').test(s);
const onlyKeys = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k));

export function createGateway({ cfg, store, upstream, limiter, now, metrics, getLivePrice }) {
  const G = cfg.gateway;
  const posCache = new Map();   /* wallet -> {at, v}; 4 s, bounded */
  const inflight = new Map();

  /* ---- tickets ---- */
  const mac = s => createHmac('sha256', G.ticketSecret).update(s).digest('hex');
  function issueTicket(wallet, action, hash) {
    const p = Buffer.from(JSON.stringify({ v: 1, w: wallet, a: action, h: hash, e: now() + G.ticketTtlMs })).toString('base64url');
    return p + '.' + mac(p);
  }
  function readTicket(t) {
    if (typeof t !== 'string' || t.length > 600 || !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(t)) return null;
    const [p, m] = t.split('.');
    if (!timingSafeEqual(Buffer.from(m, 'hex'), Buffer.from(mac(p), 'hex'))) return null;
    try { const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return o && o.v === 1 ? o : null; } catch { return null; }
  }

  async function readBody(req) {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json(;|$)/i.test(ct)) throw Object.assign(new Error('content_type'), { code: 415 });
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > G.maxBody) throw Object.assign(new Error('body_too_large'), { code: 413 });
    return await new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      const t = setTimeout(() => { reject(Object.assign(new Error('body_timeout'), { code: 408 })); req.destroy(); }, 5000);
      req.on('data', c => { size += c.length; if (size > G.maxBody) { clearTimeout(t); reject(Object.assign(new Error('body_too_large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { clearTimeout(t); try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; resolve(o); } catch { reject(Object.assign(new Error('bad_json'), { code: 400 })); } });
      req.on('error', () => { clearTimeout(t); reject(Object.assign(new Error('body_error'), { code: 400 })); });
    });
  }
  const budget = () => !limiter('gw|upstream', G.upstreamPerMin);

  /* ---- reads ---- */
  function sanitizePositions(j) {
    if (!j || typeof j !== 'object' || !Array.isArray(j.dataList) || j.dataList.length > 20) return null;
    const list = [];
    for (const p of j.dataList) { if (!p || typeof p !== 'object') return null; const o = {}; for (const k of POS_KEYS) { if (k in p) { if (!scalar(p[k])) return null; o[k] = p[k]; } } list.push(o); }
    const count = j.count === undefined || j.count === null ? undefined : (scalar(j.count) ? j.count : null);
    if (count === null) return null;
    return count === undefined ? { dataList: list } : { dataList: list, count };
  }
  async function positions(q, ip) {
    const w = q.get('walletAddress') || '';
    if (!isPubkey(w) || q.get('includeClosedPositions') !== 'false' || [...q.keys()].some(k => k !== 'walletAddress' && k !== 'includeClosedPositions')) return [400, { ok: false, error: 'bad_request' }];
    if (limiter(ip + '|gw-pos', G.positionsPerMinIp) || limiter('w:' + w + '|gw-pos', G.positionsPerMinWallet)) return [429, { ok: false, error: 'rate_limited', message: 'Too many requests. Wait a moment and try again.' }, { 'retry-after': '20' }];
    const c = posCache.get(w); if (c && now() - c.at < 4000) return [200, c.v];
    if (inflight.has(w)) return inflight.get(w);
    const p = (async () => {
      if (!budget()) { metrics?.inc('gw_budget_exhausted'); return [503, { ok: false, error: 'upstream_busy', message: 'The Perps service is busy. Try again shortly.' }, { 'retry-after': '10' }]; }
      const r = await upstream.positions(w); metrics?.inc('gw_upstream_positions');
      if (!r.ok) return [r.outcome === 'http' && r.status < 500 ? 502 : 504, { ok: false, error: 'upstream_' + r.outcome, message: 'Jupiter did not return positions.' }];
      const v = sanitizePositions(r.json); if (!v) return [502, { ok: false, error: 'upstream_malformed', message: 'Jupiter returned positions in an unexpected shape.' }];
      posCache.set(w, { at: now(), v }); if (posCache.size > 2000) posCache.delete(posCache.keys().next().value);
      return [200, v];
    })().finally(() => inflight.delete(w));
    inflight.set(w, p); return p;
  }
  async function marketStats(q) {
    const m = MINT_TO_MARKET[q.get('mint') || ''];
    if (!m || [...q.keys()].length !== 1) return [400, { ok: false, error: 'bad_mint' }];
    const v = await getLivePrice(m);
    if (!v || v.state !== 'live' || !(v.price > 0)) return [503, { ok: false, error: 'no_live_price', message: 'No live price is recorded for this market right now.' }];
    return [200, { price: String(v.price), source: 'saturn-recorder:jupiter-perps:market-stats', observedAt: v.observedAt, ageMs: v.ageMs }];
  }

  /* ---- transactions ---- */
  function checkBuilt(r, { kind, wallet, position }) {
    if (!r.ok) return { err: [r.outcome === 'http' && r.status < 500 ? 502 : 504, { ok: false, error: 'upstream_' + r.outcome, message: clean(r.json && (r.json.message || r.json.error)) || 'Jupiter could not build this transaction.' }] };
    const j = r.json; let t;
    try { if (typeof j.serializedTxBase64 !== 'string' || j.serializedTxBase64.length > 4096) throw 0; t = parseTx(b64ToBytes(j.serializedTxBase64)); } catch { return { err: [502, { ok: false, error: 'upstream_tx_unreadable' }] }; }
    const w = wallet || t.keys[0];
    const ins = inspectPerpsTx(t, { wallet: w, kind });
    if (!ins.ok) { metrics?.inc('gw_tx_refused'); return { err: [502, { ok: false, error: 'tx_refused', reason: ins.why, message: 'Saturn refused the transaction Jupiter built (' + ins.why + '). Nothing was signed.' }] }; }
    if (position && ins.position !== position) return { err: [502, { ok: false, error: 'tx_refused', reason: 'position_mismatch' }] };
    if (kind === 'increase' && (typeof j.positionPubkey !== 'string' || j.positionPubkey !== ins.position)) return { err: [502, { ok: false, error: 'tx_refused', reason: 'position_mismatch' }] };
    if (t.sigs[0].some(x => x !== 0)) return { err: [502, { ok: false, error: 'tx_refused', reason: 'already_signed' }] };
    const quote = {}; if (j.quote && typeof j.quote === 'object') { let n = 0; for (const [k, v] of Object.entries(j.quote)) { if (++n > 40) break; if (/^[A-Za-z0-9]{1,40}$/.test(k) && scalar(v)) quote[k] = v; } }
    const meta = {}; if (j.txMetadata && typeof j.txMetadata === 'object') for (const k of ['blockhash', 'transactionFeeLamports', 'accountRentLamports']) if (scalar(j.txMetadata[k])) meta[k] = j.txMetadata[k];
    const action = kind === 'increase' ? 'increase-position' : 'decrease-position';
    return { ok: { serializedTxBase64: j.serializedTxBase64, positionPubkey: ins.position, quote, txMetadata: meta, saturnTicket: issueTicket(w, action, msgHash(t.msg)), ticketExpiresInSec: Math.floor(G.ticketTtlMs / 1000) } };
  }
  async function increase(b, ip) {
    if (!onlyKeys(b, ['asset', 'side', 'inputToken', 'inputTokenAmount', 'leverage', 'maxSlippageBps', 'walletAddress'])) return [400, { ok: false, error: 'bad_request' }];
    const lev = Number(b.leverage), slip = Number(b.maxSlippageBps);
    if (!ASSETS.has(b.asset) || (b.side !== 'long' && b.side !== 'short') || !TOKENS.has(b.inputToken) || !digits(b.inputTokenAmount) || typeof b.leverage !== 'string' || !/^\d{1,3}(\.\d)?$/.test(b.leverage) || !(lev >= 1.1 && lev <= 100)
      || typeof b.maxSlippageBps !== 'string' || !/^\d{2,3}$/.test(b.maxSlippageBps) || !(slip >= 10 && slip <= 500) || !isPubkey(b.walletAddress)) return [400, { ok: false, error: 'bad_request' }];
    if (limiter(ip + '|gw-prep', G.preparePerMinIp) || limiter('w:' + b.walletAddress + '|gw-prep', G.preparePerMinWallet)) return [429, { ok: false, error: 'rate_limited', message: 'Too many requests. Wait a moment and try again.' }, { 'retry-after': '30' }];
    if (!budget()) return [503, { ok: false, error: 'upstream_busy' }];
    const r = await upstream.increase({ asset: b.asset, side: b.side, inputToken: b.inputToken, inputTokenAmount: b.inputTokenAmount, leverage: b.leverage, maxSlippageBps: b.maxSlippageBps, walletAddress: b.walletAddress });
    const c = checkBuilt(r, { kind: 'increase', wallet: b.walletAddress }); return c.err || [200, c.ok];
  }
  async function decrease(b, ip) {
    if (!onlyKeys(b, ['positionPubkey', 'receiveToken', 'entirePosition', 'sizeUsdDelta', 'collateralUsdDelta', 'maxSlippageBps'])) return [400, { ok: false, error: 'bad_request' }];
    const modes = [b.entirePosition === true, b.sizeUsdDelta !== undefined, b.collateralUsdDelta !== undefined].filter(Boolean).length;
    if (!isPubkey(b.positionPubkey) || !TOKENS.has(b.receiveToken) || modes !== 1 || (b.entirePosition !== undefined && b.entirePosition !== true)
      || (b.sizeUsdDelta !== undefined && !digits(b.sizeUsdDelta, 16)) || (b.collateralUsdDelta !== undefined && !digits(b.collateralUsdDelta, 16))
      || (b.maxSlippageBps !== undefined && (typeof b.maxSlippageBps !== 'string' || !/^\d{2,3}$/.test(b.maxSlippageBps) || Number(b.maxSlippageBps) > 500))) return [400, { ok: false, error: 'bad_request' }];
    if (limiter(ip + '|gw-prep', G.preparePerMinIp) || limiter('p:' + b.positionPubkey + '|gw-prep', G.preparePerMinWallet)) return [429, { ok: false, error: 'rate_limited' }, { 'retry-after': '30' }];
    if (!budget()) return [503, { ok: false, error: 'upstream_busy' }];
    const body = { positionPubkey: b.positionPubkey, receiveToken: b.receiveToken };
    for (const k of ['entirePosition', 'sizeUsdDelta', 'collateralUsdDelta', 'maxSlippageBps']) if (b[k] !== undefined) body[k] = b[k];
    const r = await upstream.decrease(body);
    const c = checkBuilt(r, { kind: 'decrease', wallet: null, position: b.positionPubkey }); return c.err || [200, c.ok];
  }
  async function execute(b, ip) {
    if (!onlyKeys(b, ['action', 'serializedTxBase64', 'ticket']) || !(b.action in ACTIONS) || typeof b.serializedTxBase64 !== 'string' || b.serializedTxBase64.length > 4096) return [400, { ok: false, error: 'bad_request' }];
    const tk = readTicket(b.ticket); if (!tk) return [403, { ok: false, error: 'bad_ticket', message: 'This transaction was not prepared by Saturn. Nothing was submitted.' }];
    if (tk.e < now()) return [403, { ok: false, error: 'ticket_expired', message: 'This review expired. Nothing was submitted.' }];
    if (tk.a !== b.action) return [403, { ok: false, error: 'ticket_mismatch' }];
    let t; try { t = parseTx(b64ToBytes(b.serializedTxBase64)); } catch { return [400, { ok: false, error: 'tx_unreadable' }]; }
    const hash = msgHash(t.msg);
    if (hash !== tk.h || t.keys[0] !== tk.w) return [403, { ok: false, error: 'ticket_mismatch', message: 'The signed transaction differs from the one Saturn prepared. Nothing was submitted.' }];
    const ins = inspectPerpsTx(t, { wallet: tk.w, kind: ACTIONS[b.action] }); if (!ins.ok) return [400, { ok: false, error: 'tx_refused', reason: ins.why }];
    if (!verifyEd25519(tk.w, t.msg, t.sigs[0])) return [400, { ok: false, error: 'bad_signature', message: 'The wallet signature is not valid. Nothing was submitted.' }];
    if (limiter(ip + '|gw-exec', G.executePerMinIp) || limiter('w:' + tk.w + '|gw-exec', G.executePerMinWallet)) return [429, { ok: false, error: 'rate_limited' }, { 'retry-after': '30' }];
    const sig = b58encode(t.sigs[0]);
    let first;
    try { first = await store.claimExec({ signature: sig, wallet: tk.w, action: b.action, msgHash: hash }); }
    catch { return [503, { ok: false, error: 'db_unavailable', message: 'Saturn could not record this request, so it was NOT submitted. Nothing was sent.' }]; }   /* no durable record -> no relay */
    if (!first) {
      metrics?.inc('gw_exec_duplicate');
      const row = await store.getExec(sig).catch(() => null);
      const state = row ? (row.state === 'pending' ? 'unknown' : row.state) : 'unknown';
      return [200, { ok: state === 'submitted', duplicate: true, state, txid: sig, message: 'This transaction was already received. It was not sent again.' }];
    }
    if (!budget()) { await store.settleExec(sig, 'rejected', null).catch(() => {}); return [503, { ok: false, error: 'upstream_busy', state: 'rejected', txid: sig, message: 'The Perps service is busy. Nothing was submitted. Review a new transaction.' }]; }
    const r = await upstream.execute({ action: b.action, serializedTxBase64: b.serializedTxBase64 });
    metrics?.inc('gw_upstream_execute');
    if (r.ok) {
      const same = r.json && r.json.txid === sig;
      await store.settleExec(sig, same ? 'submitted' : 'unknown', r.status).catch(() => {});
      return same ? [200, { ok: true, state: 'submitted', txid: sig }] : [202, { ok: false, state: 'unknown', txid: sig, message: 'Jupiter answered without this transaction id. Check the chain before doing anything else.' }];
    }
    if (r.outcome === 'http' && r.status >= 400 && r.status < 500) {
      await store.settleExec(sig, 'rejected', r.status).catch(() => {});
      return [422, { ok: false, state: 'rejected', txid: sig, error: 'upstream_rejected', message: clean(r.json && (r.json.message || r.json.error)) || 'Jupiter rejected the transaction.' }];
    }
    await store.settleExec(sig, 'unknown', r.status || null).catch(() => {});   /* timeout / network / 5xx / malformed 2xx: AMBIGUOUS, never retried */
    metrics?.inc('gw_exec_unknown');
    return [202, { ok: false, state: 'unknown', txid: sig, message: 'Jupiter did not confirm receipt. The transaction may or may not have been sent. Saturn will not resend it; check the chain.' }];
  }

  const ROUTES = { '/v1/perps/jup/positions': 'GET', '/v1/perps/jup/market-stats': 'GET', '/v1/perps/jup/positions/increase': 'POST', '/v1/perps/jup/positions/decrease': 'POST', '/v1/perps/jup/execute': 'POST' };
  return {
    routes: ROUTES,
    /* -> [status, body, extraHeaders?] */
    async handle(req, path, q, ip) {
      const m = ROUTES[path]; if (!m) return [404, { ok: false, error: 'not_found' }];
      if (req.method !== m) return [405, { ok: false, error: 'method_not_allowed' }];
      if (m === 'GET') return path.endsWith('/positions') ? positions(q, ip) : marketStats(q);
      if (!G.executionEnabled) { metrics?.inc('gw_exec_disabled'); return [403, { ok: false, error: 'execution_disabled', message: 'Perps execution is disabled on this service.' }]; }
      if ([...q.keys()].length) return [400, { ok: false, error: 'bad_request' }];
      let b; try { b = await readBody(req); } catch (e) { return [e.code || 400, { ok: false, error: e.message }]; }
      if (path.endsWith('/increase')) return increase(b, ip);
      if (path.endsWith('/decrease')) return decrease(b, ip);
      return execute(b, ip);
    }
  };
}

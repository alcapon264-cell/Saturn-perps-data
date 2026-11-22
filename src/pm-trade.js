/* r143 Saturn Prediction — Polymarket trading support (server side).
 *
 * What runs where (docs.polymarket.com, read 2026-11-22):
 *   - Orders are signed by the user's own Saturn EVM wallet IN THE BROWSER and posted from the browser to clob.polymarket.com with the user's
 *     own CLOB API credentials. Polymarket geoblocks by the requesting IP, and this server runs in Singapore (close-only), so the server
 *     must never place orders. There is no order, cancel, transfer or withdrawal code in this file.
 *   - Deposit-wallet creation and the one-time trading approvals go through Polymarket's gasless Relayer, which requires Saturn's
 *     Builder API key. The key/secret/passphrase stay HERE (env). This module computes the POLY_BUILDER_* HMAC headers ("remote builder
 *     signing", the pattern Polymarket documents) and ONLY for: WALLET-CREATE to the Deposit Wallet factory, WALLET batches whose calls are
 *     exactly the documented approval set, and read-only relayer status/nonce lookups. Anything else is refused, so Saturn's builder key
 *     cannot be used to move funds. WALLET batches are additionally signed by the user's own wallet and verified on-chain by the deposit wallet.
 *   - Bridge: asks bridge.polymarket.com for the user's personal deposit addresses (funds arrive as pUSD in the user's Polymarket wallet).
 * Routes (prefix /v1/pm/x/): GET config · POST relayer-sign · POST bridge-deposit · GET bridge-assets
 * Trading is OFF unless PM_TRADING_ENABLED=1 AND all three builder credentials are set. */
import { createHmac } from 'node:crypto';

export const PMX = Object.freeze({
  relayer: 'https://relayer-v2.polymarket.com', clob: 'https://clob.polymarket.com', bridge: 'https://bridge.polymarket.com', chainId: 137,
  factory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
  pUSD: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  positionManager: '0x006F54F7f9A22e0000CC2AB60031000000ae9fEF',
  v2Exchange: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',
  standardExchange: '0xE111180000d2663C0091e4f400237545B87B996B',
  negRiskExchange: '0xe2222d279d744050d28e00520010520000310F59',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'
});
/* the documented approval set (docs.polymarket.com/trading/deposit-wallets "Approval Set"); selectors: approve 0x095ea7b3, setApprovalForAll 0xa22cb465 */
const lc = s => String(s || '').toLowerCase();
const APPROVE = '0x095ea7b3', SET_ALL = '0xa22cb465';
const ALLOWED_CALLS = Object.freeze([
  [PMX.pUSD, APPROVE, PMX.v2Exchange], [PMX.pUSD, APPROVE, PMX.standardExchange], [PMX.pUSD, APPROVE, PMX.negRiskExchange], [PMX.pUSD, APPROVE, PMX.negRiskAdapter],
  [PMX.ctf, SET_ALL, PMX.standardExchange], [PMX.ctf, SET_ALL, PMX.negRiskExchange], [PMX.ctf, SET_ALL, PMX.negRiskAdapter],
  [PMX.positionManager, SET_ALL, PMX.v2Exchange]
].map(([t, s, sp]) => [lc(t), s, lc(sp)]));
const ADDR = /^0x[0-9a-fA-F]{40}$/, HEXSIG = /^0x[0-9a-fA-F]{130,4000}$/, DIGITS = /^[0-9]{1,30}$/, TXID = /^[A-Za-z0-9_-]{1,100}$/, B32 = /^0x[0-9a-fA-F]{64}$/;

export function pmxConfig(env = process.env) {
  const key = env.POLY_BUILDER_API_KEY || '', secret = env.POLY_BUILDER_SECRET || '', pass = env.POLY_BUILDER_PASSPHRASE || '';
  const code = env.PM_BUILDER_CODE || '';
  return {
    requested: env.PM_TRADING_ENABLED === '1', hasCreds: !!(key && secret && pass),
    creds: key && secret && pass ? { key, secret, pass } : null,
    builderCode: B32.test(code) ? code.toLowerCase() : null, builderCodeInvalid: !!code && !B32.test(code)
  };
}

/* one call {target,value,data} -> allowed iff it is one entry of the approval set with value 0 */
export function callAllowed(c) {
  if (!c || typeof c !== 'object' || Object.keys(c).some(k => !['target', 'value', 'data'].includes(k))) return false;
  if (String(c.value) !== '0' || !ADDR.test(c.target || '') || typeof c.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(c.data)) return false;
  const d = c.data.toLowerCase(), sel = d.slice(0, 10), arg1 = '0x' + d.slice(34, 74), tail = d.slice(74);
  if (d.length !== 2 + 8 + 64 + 64) return false;
  if (d.slice(10, 34) !== '0'.repeat(24)) return false;
  if (!ALLOWED_CALLS.some(([t, s, sp]) => t === lc(c.target) && s === sel && sp === arg1)) return false;
  if (sel === SET_ALL) return tail === '0'.repeat(63) + '1';          /* setApprovalForAll(op, true) only */
  return /^[0-9a-f]{64}$/.test(tail);                                  /* approve(spender, amount) */
}

/* validate a relayer request the browser wants Saturn's builder headers for */
export function validateRelayer(method, path, body) {
  if (method === 'GET') {
    if (body) return 'get_has_body';
    let u; try { u = new URL(path, PMX.relayer); } catch { return 'bad_path'; }
    if (u.origin !== PMX.relayer || u.hash) return 'bad_path';
    const q = u.searchParams;
    if (u.pathname === '/v1/account/transactions/params') return [...q.keys()].sort().join() === 'address,type' && ADDR.test(q.get('address')) && q.get('type') === 'WALLET' ? null : 'bad_query';
    if (u.pathname === '/transaction') return [...q.keys()].join() === 'id' && TXID.test(q.get('id')) ? null : 'bad_query';
    const m = /^\/v1\/account\/transactions\/([A-Za-z0-9_-]{1,100})$/.exec(u.pathname); if (m && !u.search) return null;
    return 'path_not_allowed';
  }
  if (method !== 'POST' || path !== '/submit') return 'path_not_allowed';
  let b; try { b = JSON.parse(body); } catch { return 'bad_json'; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'bad_json';
  if (lc(b.to) !== lc(PMX.factory)) return 'wrong_factory';
  if (!ADDR.test(b.from || '')) return 'bad_from';
  if (b.metadata != null && (typeof b.metadata !== 'string' || b.metadata.length > 120)) return 'bad_metadata';
  if (b.type === 'WALLET-CREATE') return Object.keys(b).every(k => ['type', 'from', 'to', 'metadata'].includes(k)) ? null : 'unexpected_field';
  if (b.type !== 'WALLET') return 'type_not_allowed';
  if (!Object.keys(b).every(k => ['type', 'from', 'to', 'nonce', 'signature', 'metadata', 'depositWalletParams'].includes(k))) return 'unexpected_field';
  if (!DIGITS.test(String(b.nonce)) || !HEXSIG.test(b.signature || '')) return 'bad_signature';
  const p = b.depositWalletParams;
  if (!p || typeof p !== 'object' || !ADDR.test(p.depositWallet || '') || !DIGITS.test(String(p.deadline)) || !Array.isArray(p.calls)) return 'bad_params';
  if (Object.keys(p).some(k => !['depositWallet', 'deadline', 'calls'].includes(k))) return 'unexpected_field';
  if (p.calls.length < 1 || p.calls.length > ALLOWED_CALLS.length) return 'bad_calls';
  if (!p.calls.every(callAllowed)) return 'call_not_allowed';
  return null;
}

export function builderHeaders(creds, ts, method, path, body) {
  const msg = String(ts) + method + path + (body || '');
  const sig = createHmac('sha256', Buffer.from(creds.secret, 'base64')).update(msg).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return { POLY_BUILDER_API_KEY: creds.key, POLY_BUILDER_TIMESTAMP: String(ts), POLY_BUILDER_PASSPHRASE: creds.pass, POLY_BUILDER_SIGNATURE: sig };
}

export function createPmTrade({ env = process.env, fetchImpl = globalThis.fetch, limiter, now = Date.now, log = () => {}, metrics = null, timeoutMs = 10000, maxBody = 16 * 1024 } = {}) {
  const C = pmxConfig(env);
  const enabled = C.requested && C.hasCreds;
  const reason = enabled ? null : !C.requested ? 'Prediction trading is switched off on the server (PM_TRADING_ENABLED is not 1).' : 'Saturn’s Polymarket Builder API key is not configured on the server.';
  if (C.builderCodeInvalid) log('pm_trade_config', { warning: 'PM_BUILDER_CODE is not a 0x-prefixed bytes32; ignored' });
  log('pm_trade_config', { enabled, requested: C.requested, builderCreds: C.hasCreds, builderCode: !!C.builderCode });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length']); if (Number.isFinite(len) && len > maxBody) return reject(Object.assign(new Error('body_too_large'), { code: 413 }));
      let size = 0; const chunks = []; const t = setTimeout(() => reject(Object.assign(new Error('body_timeout'), { code: 408 })), 5000);
      req.on('data', c => { size += c.length; if (size > maxBody) { clearTimeout(t); reject(Object.assign(new Error('body_too_large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { clearTimeout(t); resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', e => { clearTimeout(t); reject(e); });
    });
  }
  async function upstream(url, init) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit', signal: ac.signal });
      const txt = await r.text(); let v = null; try { v = JSON.parse(txt); } catch {}
      if (!r.ok || v == null) { log('pm_trade_upstream_failure', { host: new URL(url).host, path: new URL(url).pathname, status: r.status }); const e = new Error('upstream_' + r.status); e.status = r.status; throw e; }
      return v;
    } finally { clearTimeout(timer); }
  }
  const assetsCache = { at: 0, v: null };

  async function handle(req, path, q, ip) {
    try {
      if (path === '/v1/pm/x/config') {
        if (req.method !== 'GET') return [405, { ok: false, error: 'method_not_allowed' }];
        return [200, { ok: true, trading: { enabled, reason, builderCode: C.builderCode, chainId: PMX.chainId, clob: PMX.clob, relayer: PMX.relayer, contracts: { factory: PMX.factory, pUSD: PMX.pUSD, ctf: PMX.ctf, positionManager: PMX.positionManager, v2Exchange: PMX.v2Exchange, standardExchange: PMX.standardExchange, negRiskExchange: PMX.negRiskExchange, negRiskAdapter: PMX.negRiskAdapter } } }];
      }
      if (req.method !== 'POST' && path !== '/v1/pm/x/bridge-assets') return [405, { ok: false, error: 'method_not_allowed' }];
      if (path === '/v1/pm/x/relayer-sign') {
        if (!enabled) return [503, { ok: false, error: 'trading_disabled', reason }];
        if (limiter && limiter(ip + '|pmx-sign', 40)) return [429, { ok: false, error: 'rate_limited' }];
        let r; try { r = JSON.parse(await readBody(req)); } catch (e) { return [e.code || 400, { ok: false, error: e.code ? e.message : 'bad_json' }]; }
        const method = r && r.method, p = r && r.path, body = r && r.body != null ? r.body : '';
        if (!['GET', 'POST'].includes(method) || typeof p !== 'string' || p.length > 300 || typeof body !== 'string') return [400, { ok: false, error: 'bad_request' }];
        const bad = validateRelayer(method, p, body);
        if (bad) { metrics?.inc('pmx_sign_refused'); log('pm_trade_sign_refused', { reason: bad, method, path: p.split('?')[0] }); return [403, { ok: false, error: 'not_allowed', reason: bad }]; }
        metrics?.inc('pmx_sign');
        return [200, { ok: true, headers: builderHeaders(C.creds, Math.floor(now() / 1000), method, p, body) }];
      }
      if (path === '/v1/pm/x/bridge-deposit') {
        if (limiter && limiter(ip + '|pmx-bridge', 10)) return [429, { ok: false, error: 'rate_limited' }];
        let r; try { r = JSON.parse(await readBody(req)); } catch (e) { return [e.code || 400, { ok: false, error: e.code ? e.message : 'bad_json' }]; }
        if (!r || !ADDR.test(r.address || '') || Object.keys(r).length !== 1) return [400, { ok: false, error: 'bad_address' }];
        const headers = { 'content-type': 'application/json', accept: 'application/json' }; if (C.builderCode) headers['X-Builder-Code'] = C.builderCode;
        const v = await upstream(PMX.bridge + '/deposit', { method: 'POST', headers, body: JSON.stringify({ address: r.address }) });
        /* keep only address-shaped values the app shows; nothing is sent anywhere by Saturn */
        const src = v && typeof v.address === 'object' && v.address ? v.address : v;
        const out = {}; for (const k of ['evm', 'svm', 'btc', 'tron']) { const a = src && src[k]; if (typeof a === 'string' && /^[A-Za-z0-9]{20,120}$/.test(a)) out[k] = a; }
        if (!Object.keys(out).length) return [502, { ok: false, error: 'bridge_unexpected_response' }];
        return [200, { ok: true, wallet: r.address, addresses: out, note: v && typeof v.note === 'string' ? v.note.slice(0, 300) : null, source: 'polymarket bridge deposit addresses' }];
      }
      if (path === '/v1/pm/x/bridge-assets') {
        if (req.method !== 'GET') return [405, { ok: false, error: 'method_not_allowed' }];
        if (limiter && limiter(ip + '|pmx-assets', 30)) return [429, { ok: false, error: 'rate_limited' }];
        if (!assetsCache.v || now() - assetsCache.at > 600000) { assetsCache.v = await upstream(PMX.bridge + '/supported-assets', { method: 'GET', headers: { accept: 'application/json' } }); assetsCache.at = now(); }
        return [200, { ok: true, assets: assetsCache.v, source: 'polymarket:bridge/supported-assets' }];
      }
      return [404, { ok: false, error: 'not_found' }];
    } catch (e) {
      metrics?.inc('pmx_error');
      if (e && (e.status === 429 || e.status === 503)) return [503, { ok: false, error: 'polymarket_busy' }];
      log('pm_trade_request_failed', { route: path, status: Number.isInteger(e && e.status) ? e.status : null, name: e && e.name || 'Error' });
      return [502, { ok: false, error: 'polymarket_unavailable' }];
    }
  }
  return Object.freeze({ handle, enabled, reason, builderCode: C.builderCode });
}

/* Jupiter Perps /market-stats client. READ-ONLY: a single GET to one fixed host and path. No cookies, no redirects, bounded body. */
import { JUPITER_BASE, JUPITER_HOST } from './config.js';

const RATE_HDR = /^(retry-after|x-?ratelimit[\w-]*|ratelimit[\w-]*|x-rate-limit[\w-]*)$/i;
const MAX_BODY = 64 * 1024;

export function parseRetryAfter(v, nowMs = Date.now()) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d{1,6}$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

export function createJupiterClient({ fetchImpl = globalThis.fetch, base = JUPITER_BASE, timeoutMs = 8000, now = Date.now, keyHeader = '', key = '', metrics = null } = {}) {
  const u = new URL(base);
  if (u.protocol !== 'https:' || u.hostname !== JUPITER_HOST) throw new Error('jupiter_base_not_allowed');
  const headers = { accept: 'application/json' };
  if (keyHeader && key) headers[keyHeader] = key;

  /* -> {ok:true, json, ms, status, rateHeaders} | {ok:false, outcome, status?, retryAfterMs?, ms, rateHeaders} */
  return async function fetchMarketStats(mint) {
    const url = base + '/market-stats?mint=' + encodeURIComponent(mint);
    const t0 = now(); const ac = new AbortController();
    /* Hard deadline covering BOTH the request and the body read, even if a fetch implementation ignores the abort signal. */
    let timer; const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error('deadline'), { deadline: true })); }, timeoutMs); }); deadline.catch(() => {});
    const within = p => Promise.race([p, deadline]);
    const rateHeaders = {};
    try {
      const res = await within(fetchImpl(url, { method: 'GET', headers, signal: ac.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }));
      try { res.headers && res.headers.forEach && res.headers.forEach((v, k) => { if (RATE_HDR.test(k)) rateHeaders[k.toLowerCase()] = String(v).slice(0, 200); }); } catch { /* ignore */ }
      const status = res.status, hget = k => (res.headers && res.headers.get ? res.headers.get(k) : null);
      const base = () => ({ status, ms: now() - t0, rateHeaders });
      if (status === 429) return { ok: false, outcome: 'http_429', retryAfterMs: parseRetryAfter(hget('retry-after'), now()), ...base() };
      if (status >= 500) return { ok: false, outcome: 'http_5xx', retryAfterMs: parseRetryAfter(hget('retry-after'), now()), ...base() };
      if (!res.ok) return { ok: false, outcome: 'http_other', ...base() };
      const len = Number(hget('content-length'));
      if (Number.isFinite(len) && len > MAX_BODY) return { ok: false, outcome: 'malformed', detail: 'body_too_large', ...base() };
      const text = await within(res.text());
      if (text.length > MAX_BODY) return { ok: false, outcome: 'malformed', detail: 'body_too_large', ...base() };
      let json; try { json = JSON.parse(text); } catch { return { ok: false, outcome: 'malformed', detail: 'invalid_json', ...base() }; }
      return { ok: true, json, ...base() };
    } catch (e) {
      return { ok: false, outcome: (e && e.deadline) || ac.signal.aborted ? 'timeout' : 'network', ms: now() - t0, rateHeaders };
    } finally { clearTimeout(timer); }
  };
}

/* ---- Perps gateway upstream (separate from the recorder). Fixed host, fixed paths, no redirects, no cookies, bounded bodies, hard deadline.
 * GET  /positions            read a wallet's positions (public data)
 * POST /positions/increase   ask Jupiter to BUILD an unsigned transaction   } only reachable when PERPS_EXECUTION_ENABLED=1
 * POST /positions/decrease   ask Jupiter to BUILD an unsigned transaction   } (off by default). These paths are NOT in Jupiter's
 * POST /transaction/execute  relay a transaction the USER's wallet signed  } official developer docs; see docs/SECURITY-REPORT.md.
 * This module never signs anything and holds no keys. */
export const GATEWAY_PATHS = Object.freeze({ positions: '/positions', increase: '/positions/increase', decrease: '/positions/decrease', execute: '/transaction/execute' });
export function createJupiterGateway({ fetchImpl = globalThis.fetch, base = JUPITER_BASE, timeoutMs = 10000, now = Date.now, keyHeader = '', key = '' } = {}) {
  const u = new URL(base);
  if (u.protocol !== 'https:' || u.hostname !== JUPITER_HOST) throw new Error('jupiter_base_not_allowed');
  const hdr = { accept: 'application/json' };
  if (keyHeader && key) hdr[keyHeader] = key;
  /* -> {ok:true,status,json} | {ok:false,outcome:'http'|'timeout'|'network'|'malformed',status?,json?}  outcome timeout/network/5xx = UNKNOWN result */
  async function call(method, path, { query = null, body = null, maxBody = 64 * 1024, deadlineMs = timeoutMs } = {}) {
    if (!Object.values(GATEWAY_PATHS).includes(path)) throw new Error('path_not_allowed');
    if (method !== 'GET' && method !== 'POST') throw new Error('method_not_allowed');
    const url = new URL(base + path); if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const ac = new AbortController(); let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(Object.assign(new Error('deadline'), { deadline: true })); }, deadlineMs); }); deadline.catch(() => {});
    const within = p => Promise.race([p, deadline]);
    try {
      const res = await within(fetchImpl(url.toString(), { method, headers: body ? { ...hdr, 'content-type': 'application/json' } : hdr, body: body ? JSON.stringify(body) : undefined, signal: ac.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }));
      const status = res.status; const text = await within(res.text());
      if (text.length > maxBody) return { ok: false, outcome: 'malformed', status };
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (status >= 200 && status < 300) return json && typeof json === 'object' ? { ok: true, status, json } : { ok: false, outcome: 'malformed', status };
      return { ok: false, outcome: 'http', status, json };
    } catch (e) {
      return { ok: false, outcome: (e && e.deadline) || ac.signal.aborted ? 'timeout' : 'network' };
    } finally { clearTimeout(timer); }
  }
  return {
    positions: wallet => call('GET', GATEWAY_PATHS.positions, { query: { walletAddress: wallet, includeClosedPositions: 'false' }, maxBody: 256 * 1024 }),
    increase: body => call('POST', GATEWAY_PATHS.increase, { body }),
    decrease: body => call('POST', GATEWAY_PATHS.decrease, { body }),
    execute: body => call('POST', GATEWAY_PATHS.execute, { body, deadlineMs: Math.max(timeoutMs, 20000) })
  };
}

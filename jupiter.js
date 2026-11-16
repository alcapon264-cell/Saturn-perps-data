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

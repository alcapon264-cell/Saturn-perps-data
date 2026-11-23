/* r166 token pictures + names for Pump.fun coins the market lists don't know.
 * Sources (read-only, public, fixed rules):
 *   1. the live stream (src/tok-live.js) already gives each coin's name, symbol and metadata uri;
 *      the uri's JSON (IPFS / metadata host) holds the picture. Only https uris on public host names are fetched, 4 s timeout, 64 KB max.
 *   2. a coin the stream hasn't seen: Pump.fun's public coin endpoint (fixed host) for name, symbol and picture.
 * Results are cached (failures too, shorter) so each coin is looked up once. Nothing is stored on disk. */
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMP_COIN = 'https://frontend-api-v3.pump.fun/coins/';
const okHost = h => !!h && !/^(localhost|.*\.local|.*\.internal)$/i.test(h) && !/^[\d.]+$/.test(h) && !h.includes(':') && h.includes('.');
const cleanTxt = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').slice(0, 40) : null;
const okImg = v => { if (typeof v !== 'string' || v.length > 400) return null; try { const u = new URL(v); return u.protocol === 'https:' && okHost(u.hostname) ? u.href : null; } catch { return null; } };
const ipfsFix = v => typeof v === 'string' ? v.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/') : v;

export function createTokMeta({ fetchImpl = globalThis.fetch, now = Date.now, tok = () => null, okTtl = 6 * 3600e3, badTtl = 20 * 60e3, cap = 20000, perCall = 16 } = {}) {
  const C = new Map();   /* mint -> { at, v:{name,symbol,image}|null } */
  const inflight = new Map();
  async function getJson(url) {
    let u; try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || !okHost(u.hostname)) return null;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
    try {
      const r = await fetchImpl(u.href, { signal: ac.signal, headers: { accept: 'application/json' }, redirect: 'follow' });
      if (!r || !r.ok) return null;
      const txt = await r.text(); if (!txt || txt.length > 65536) return null;
      return JSON.parse(txt);
    } catch { return null; } finally { clearTimeout(t); }
  }
  async function one(mint) {
    const live = (() => { try { const t = tok(); return t && t.meta ? t.meta([mint])[mint] : null; } catch { return null; } })();
    let name = live && live.name || null, symbol = live && live.symbol || null, image = null;
    if (live && live.uri) { const j = await getJson(ipfsFix(live.uri)); if (j && typeof j === 'object') { image = okImg(ipfsFix(j.image)); name = name || cleanTxt(j.name); symbol = symbol || cleanTxt(j.symbol); } }
    if (!image || !name) { const j = await getJson(PUMP_COIN + mint); if (j && typeof j === 'object' && j.mint === mint) { image = image || okImg(ipfsFix(j.image_uri)); name = name || cleanTxt(j.name); symbol = symbol || cleanTxt(j.symbol); } }
    return name || symbol || image ? { name, symbol, image } : null;
  }
  function get(mint) {
    const c = C.get(mint), t = now();
    if (c && t - c.at < (c.v ? okTtl : badTtl)) return Promise.resolve(c.v);
    if (inflight.has(mint)) return inflight.get(mint);
    const p = one(mint).catch(() => null).then(v => { C.delete(mint); C.set(mint, { at: now(), v }); if (C.size > cap) C.delete(C.keys().next().value); return v; }).finally(() => inflight.delete(mint));
    inflight.set(mint, p); return p;
  }
  /* returns what is known now; looks up at most perCall new coins per request (the browser asks again for the rest) */
  async function resolve(mints) {
    const list = [...new Set(mints.filter(m => typeof m === 'string' && MINT.test(m)))].slice(0, 50), out = {}, t = now(); let fresh = 0; const jobs = [];
    for (const m of list) { const c = C.get(m);
      if (c && t - c.at < (c.v ? okTtl : badTtl)) { if (c.v) out[m] = c.v; continue; }
      if (fresh >= perCall && !inflight.has(m)) continue; fresh++; jobs.push(get(m).then(v => { if (v) out[m] = v; })); }
    await Promise.all(jobs); return { meta: out, pending: list.filter(m => !(m in out) && !(C.get(m) && !C.get(m).v)).length };
  }
  return Object.freeze({ resolve, _C: C });
}

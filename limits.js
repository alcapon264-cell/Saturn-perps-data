/* Per-key sliding-window limiter + client-IP extraction. The service runs as a single instance, so in-memory state is accurate. */
export function createLimiter({ now = Date.now, windowMs = 60000, maxKeys = 10000 } = {}) {
  const hits = new Map();
  /* returns true when the caller is OVER the limit */
  return function over(key, max) {
    const t = now(); let a = hits.get(key);
    if (!a) { if (hits.size >= maxKeys) { for (const [k, v] of hits) { if (!v.length || t - v[v.length - 1] > windowMs) hits.delete(k); if (hits.size < maxKeys * 0.9) break; } if (hits.size >= maxKeys) return true; } a = []; hits.set(key, a); }
    while (a.length && t - a[0] > windowMs) a.shift();
    if (a.length >= max) return true;
    a.push(t); return false;
  };
}

/* Client IP behind N trusted proxies. The FIRST x-forwarded-for entry is client-controlled and is never used.
 * With hops=1 the last entry (appended by the nearest trusted proxy) is used. hops=0 ignores the header. */
export function clientIp(req, hops = 1) {
  const sock = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!hops) return sock;
  const raw = req.headers['x-forwarded-for'];
  if (!raw) return sock;
  const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 1) return sock;
  const v = parts[Math.max(0, parts.length - hops)];
  return /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : sock;
}

/* r144 Hyperliquid WebSocket price feed for the VIEW-ONLY markets (read-only; nothing here can sign or trade).
 * Why: Saturn's server shares an outbound IP on Render, and Hyperliquid's REST /info answers 429 to it every minute, so the view
 * markets (HYPE, ZEC, JUP, NEAR, BNB, SNDK, SPCX, SKHYNIX) stopped getting prices. Hyperliquid's WebSocket pushes the same data
 * (allMids + activeAssetCtx) without polling and is not subject to the REST request-weight limit.
 *   One connection per market set ('' = main perps, 'xyz' = Trade.xyz HIP-3), so every allMids message is known to belong to its set.
 *   Subscriptions: {type:'allMids'[, dex]} and {type:'activeAssetCtx', coin} for each configured coin.
 *   Heartbeat: {"method":"ping"} every 30 s; no message for 70 s -> the socket is dropped and reopened. Reconnect with backoff 1 s .. 60 s.
 * Fixed host only. The REST path in view.js stays as the fallback when this feed is not fresh. */
export const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const COIN = /^([a-z]{1,8}:)?[A-Za-z0-9]{1,20}$/;
const DEC = /^-?\d{1,15}(\.\d{1,18})?$/;
const qualify = (dex, name) => (dex && !name.includes(':') ? dex + ':' + name : name);
const num = v => (typeof v === 'string' && DEC.test(v) ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : null);

export function createHlWsFeed({ WebSocketImpl, url = HL_WS_URL, sets = [], now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, log = () => {}, metrics = null, pingMs = 30000, silentMs = 70000 } = {}) {
  if (url !== HL_WS_URL && !/^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(url)) throw new Error('hl_ws_url_not_allowed');
  const inc = n => { try { metrics?.inc(n); } catch {} };
  /* sets: [{dex:'', coins:['HYPE',...]}, {dex:'xyz', coins:['xyz:SNDK',...]}] */
  const C = sets.map(s => ({ dex: s.dex || '', coins: [...new Set(s.coins || [])].filter(c => COIN.test(c)), ws: null, open: false, retry: 1000, rt: null, lastMsg: 0,
    mids: null, midsAt: 0, ctx: new Map(), opens: 0, msgs: 0, lastErr: null }));
  let running = false, hb = null; const listeners = new Set();

  function connect(c) {
    if (!running || c.ws) return;
    let ws; try { ws = new WebSocketImpl(url); } catch (e) { c.lastErr = String(e && e.message || e).slice(0, 80); schedule(c); return; }
    c.ws = ws; c.open = false;
    const on = (ev, f) => { if (typeof ws.on === 'function') ws.on(ev, f); else ws.addEventListener(ev, f); };
    on('open', () => {
      if (c.ws !== ws) return; c.open = true; c.opens++; c.lastMsg = now(); c.retry = 1000; inc('hl_ws_open');
      const send = sub => { try { ws.send(JSON.stringify({ method: 'subscribe', subscription: sub })); } catch {} };
      send(c.dex ? { type: 'allMids', dex: c.dex } : { type: 'allMids' });
      for (const coin of c.coins) send({ type: 'activeAssetCtx', coin });
    });
    on('message', ev => { if (c.ws !== ws) return; c.lastMsg = now(); c.msgs++; handle(c, typeof ev === 'object' && ev && 'data' in ev && !(ev instanceof Uint8Array) ? ev.data : ev); });
    on('close', () => { if (c.ws !== ws) return; c.ws = null; c.open = false; inc('hl_ws_closed'); schedule(c); });
    on('error', e => { c.lastErr = String(e && (e.message || e.type) || 'error').slice(0, 80); inc('hl_ws_error'); try { ws.close(); } catch {} });
  }
  function schedule(c) {
    if (!running || c.rt) return;
    const wait = c.retry; c.retry = Math.min(60000, c.retry * 2);
    c.rt = setTimeoutImpl(() => { c.rt = null; connect(c); }, wait);
  }
  function drop(c) { const ws = c.ws; c.ws = null; c.open = false; try { ws && (ws.terminate ? ws.terminate() : ws.close()); } catch {} schedule(c); }
  function handle(c, raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.channel === 'allMids' && m.data && m.data.mids && typeof m.data.mids === 'object') {
      const out = {}; for (const [k, v] of Object.entries(m.data.mids)) if ((COIN.test(k) || /^@\d{1,6}$/.test(k)) && typeof v === 'string' && DEC.test(v)) out[qualify(c.dex, k)] = v;
      c.mids = out; c.midsAt = now(); inc('hl_ws_mids'); for (const f of listeners) { try { f(c.dex, out, c.midsAt); } catch {} } return;
    }
    if (m.channel === 'activeAssetCtx' && m.data && typeof m.data.coin === 'string' && m.data.ctx) {
      const k = qualify(c.dex, m.data.coin); if (!c.coins.includes(k)) return; const x = m.data.ctx;
      c.ctx.set(k, { oraclePx: num(x.oraclePx), prevDayPx: num(x.prevDayPx), midPx: num(x.midPx), markPx: num(x.markPx), dayNtlVlm: num(x.dayNtlVlm), openInterest: num(x.openInterest), at: now() });
      inc('hl_ws_ctx'); return;
    }
    if (m.channel === 'error') { c.lastErr = String(m.data || 'error').slice(0, 120); inc('hl_ws_server_error'); log('hl-ws: server error', c.dex || 'main', c.lastErr); }
  }
  function beat() {
    const t = now();
    for (const c of C) {
      if (!c.ws) continue;
      if (c.open && t - c.lastMsg > silentMs) { inc('hl_ws_silent_drop'); log('hl-ws: no message for', Math.round((t - c.lastMsg) / 1000) + 's; reconnecting', c.dex || 'main'); drop(c); continue; }
      if (c.open) { try { c.ws.send(JSON.stringify({ method: 'ping' })); } catch {} }
    }
  }
  return Object.freeze({
    start() { if (running || !C.length || !WebSocketImpl) return; running = true; for (const c of C) connect(c); hb = setIntervalImpl(beat, pingMs); if (hb && hb.unref) hb.unref(); log('hl-ws: started', C.map(c => (c.dex || 'main') + '(' + c.coins.length + ')').join(' ')); },
    stop() { running = false; if (hb) clearIntervalImpl(hb); hb = null; for (const c of C) { if (c.rt) clearTimeoutImpl(c.rt); c.rt = null; const ws = c.ws; c.ws = null; c.open = false; try { ws && ws.close(); } catch {} } },
    /* mids of one market set, or null; `at` = when the last allMids message arrived */
    mids(dex = '') { const c = C.find(x => x.dex === dex); return c && c.mids ? { mids: c.mids, at: c.midsAt } : null; },
    /* r144.3: called on every allMids push (dex, mids, at) — used for the 1 s live price ticks */
    onMids(f) { listeners.add(f); return () => listeners.delete(f); },
    ctx(coin) { for (const c of C) { const v = c.ctx.get(coin); if (v) return v; } return null; },
    stats() { return C.map(c => ({ dex: c.dex || 'main', open: c.open, opens: c.opens, msgs: c.msgs, midsAgeMs: c.midsAt ? now() - c.midsAt : null, ctx: c.ctx.size, lastErr: c.lastErr })); },
    _C: C
  });
}

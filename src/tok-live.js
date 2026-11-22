/* r158 TOKENS LIVE — Discover list prices over ONE Saturn WebSocket (path /tokens/live). Read-only market data; nothing here can sign or trade.
 * Why: on the Discover Tokens list every Solana row only changed when the DexScreener refresh came back (seconds), while the token page
 * moves on every trade. This relay keeps a small number of upstream trade streams open on the SERVER and forwards, to each browser, only the
 * trades of the tokens that browser has on screen.
 *   Upstreams (fixed hosts only; the browser can never name one):
 *     - PumpAPI data stream   wss://stream.pumpapi.io/        (all Pump.fun / PumpSwap events; filtered here by mint)
 *     - PumpPortal data API   wss://pumpportal.fun/api/data   (subscribeTokenTrade with the union of watched mints, one connection)
 *   Each upstream trade is normalised to { mint, p (price in SOL per token), mc (market cap in SOL, when the upstream gives it), side }.
 *   Per mint, updates are coalesced to at most one message every COALESCE_MS; each client gets only its own mints.
 *   Browser protocol:  -> {"type":"sub","mints":[...<=40 base58]} (replaces the set)   -> {"type":"ping"}
 *                      <- {"type":"hello","max":40}  <- {"type":"tok","mint","p","mc","side","n","src","at"}  <- {"type":"pong"}
 * Stats are logged once a minute while anyone is connected, so Render logs show whether trades really flow. */
export const PUMPAPI_URL = 'wss://stream.pumpapi.io/';
export const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINT_IN = /"mint"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/;
const SOL = 'So11111111111111111111111111111111111111112';
const pos = v => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e15 ? n : null; };

export function createTokLive({ WebSocketImpl, upstreams = ['pumpapi', 'pumpportal'], urls = {}, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, log = () => {}, metrics = null, maxPerClient = 40, maxMints = 3000, coalesceMs = 250,
  graceMs = 30000, silentMs = 90000, statsMs = 60000 } = {}) {
  const inc = n => { try { metrics?.inc(n); } catch {} };
  const U = upstreams.filter(k => k === 'pumpapi' || k === 'pumpportal').map(kind => ({ kind, url: kind === 'pumpapi' ? (urls.pumpapi || PUMPAPI_URL) : (urls.pumpportal || PUMPPORTAL_URL),
    ws: null, open: false, retry: 1000, rt: null, lastMsg: 0, opens: 0, msgs: 0, matched: 0, subscribed: new Set(), lastErr: null }));
  for (const u of U) if (![PUMPAPI_URL, PUMPPORTAL_URL].includes(u.url) && !/^ws:\/\/127\.0\.0\.1:\d+\//.test(u.url)) throw new Error('tok_live_url_not_allowed');
  const clients = new Map();          /* ws -> { mints:Set, ip, sent } */
  const ref = new Map();              /* mint -> number of clients watching */
  const leftAt = new Map();           /* mint -> when its last watcher left (unsubscribed upstream after graceMs) */
  const pend = new Map();             /* mint -> pending update */
  let flushT = null, running = false, hb = null, st = null, sent = 0;

  /* ---------- upstreams ---------- */
  const on = (ws, ev, f) => { if (typeof ws.on === 'function') ws.on(ev, f); else ws.addEventListener(ev, f); };
  function connect(u) {
    if (!running || u.ws || !watching()) return;
    let ws; try { ws = new WebSocketImpl(u.url); } catch (e) { u.lastErr = String(e && e.message || e).slice(0, 80); schedule(u); return; }
    u.ws = ws; u.open = false; u.subscribed = new Set();
    on(ws, 'open', () => { if (u.ws !== ws) return; u.open = true; u.opens++; u.lastMsg = now(); u.retry = 1000; inc('tok_up_open'); if (u.kind === 'pumpportal') syncPortal(u); });
    on(ws, 'message', ev => { if (u.ws !== ws) return; u.lastMsg = now(); u.msgs++; handle(u, typeof ev === 'object' && ev && 'data' in ev && !(ev instanceof Uint8Array) ? ev.data : ev); });
    on(ws, 'close', () => { if (u.ws !== ws) return; u.ws = null; u.open = false; inc('tok_up_closed'); schedule(u); });
    on(ws, 'error', e => { u.lastErr = String(e && (e.message || e.type) || 'error').slice(0, 80); try { ws.close(); } catch {} });
  }
  function schedule(u) { if (!running || u.rt || !watching()) return; const w = u.retry; u.retry = Math.min(60000, u.retry * 2); u.rt = setTimeoutImpl(() => { u.rt = null; connect(u); }, w); }
  function closeUp(u) { if (u.rt) clearTimeoutImpl(u.rt); u.rt = null; const ws = u.ws; u.ws = null; u.open = false; u.subscribed = new Set(); try { ws && (ws.terminate ? ws.terminate() : ws.close()); } catch {} }
  function syncPortal(u) {
    if (!u.open || !u.ws) return;
    const add = [...ref.keys()].filter(m => !u.subscribed.has(m));
    const t = now(), del = [...u.subscribed].filter(m => !ref.has(m) && t - (leftAt.get(m) || 0) >= graceMs);
    const send = o => { try { u.ws.send(JSON.stringify(o)); } catch {} };
    for (let i = 0; i < add.length; i += 100) { const k = add.slice(i, i + 100); send({ method: 'subscribeTokenTrade', keys: k }); k.forEach(m => u.subscribed.add(m)); }
    for (let i = 0; i < del.length; i += 100) { const k = del.slice(i, i + 100); send({ method: 'unsubscribeTokenTrade', keys: k }); k.forEach(m => { u.subscribed.delete(m); leftAt.delete(m); }); }
  }
  function handle(u, raw) {
    let s; try { s = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'); } catch { return; }
    if (s.length > 65536) return;
    const mm = MINT_IN.exec(s); if (!mm || !ref.has(mm[1])) return;      /* not a watched token: dropped before JSON parsing */
    let j; try { j = JSON.parse(s); } catch { return; }
    if (!j || typeof j !== 'object' || j.mint !== mm[1]) return;
    let p = null, mc = null, side = null;
    if (u.kind === 'pumpapi') {
      if (j.quoteMint && j.quoteMint !== SOL) return;
      p = pos(j.price); mc = pos(j.marketCapQuote); side = j.action === 'buy' || j.action === 'sell' ? j.action : null;
    } else {
      const sa = pos(j.solAmount), ta = pos(j.tokenAmount); p = sa && ta ? sa / ta : null; mc = pos(j.marketCapSol);
      side = j.txType === 'buy' || j.txType === 'sell' ? j.txType : null;
    }
    if (!p) return;
    u.matched++; inc('tok_trade');
    const prev = pend.get(j.mint);
    pend.set(j.mint, { mint: j.mint, p, mc: mc || (prev && prev.mc) || null, side: side || (prev && prev.side) || null, n: (prev ? prev.n : 0) + 1, src: u.kind, at: now() });
    if (!flushT) flushT = setTimeoutImpl(flush, coalesceMs);
  }
  function flush() {
    flushT = null; if (!pend.size) return;
    const out = [...pend.values()]; pend.clear();
    for (const [ws, c] of clients) {
      for (const x of out) { if (!c.mints.has(x.mint)) continue;
        if (ws.readyState !== 1) break;
        if ((ws.bufferedAmount || 0) > 256 * 1024) { inc('tok_client_slow_skip'); break; }
        try { ws.send(JSON.stringify({ type: 'tok', ...x })); c.sent++; sent++; } catch {} }
    }
  }
  const watching = () => ref.size > 0;
  function reconcile() {
    for (const u of U) { if (watching()) { if (!u.ws && !u.rt) connect(u); else if (u.kind === 'pumpportal') syncPortal(u); } }
    /* nobody watching for a while -> upstreams close (they reopen on the next subscription) */
    if (!watching() && U.some(u => u.ws || u.rt)) { const t = now(); if ([...leftAt.values()].every(x => t - x >= graceMs)) U.forEach(closeUp); }
  }

  /* ---------- browsers ---------- */
  function setMints(c, list) {
    const next = new Set(list.filter(m => typeof m === 'string' && MINT.test(m)).slice(0, maxPerClient));
    for (const m of c.mints) if (!next.has(m)) { const n = (ref.get(m) || 1) - 1; if (n > 0) ref.set(m, n); else { ref.delete(m); leftAt.set(m, now()); } }
    for (const m of next) if (!c.mints.has(m)) { if (!ref.has(m) && ref.size >= maxMints) { inc('tok_capacity'); next.delete(m); continue; } ref.set(m, (ref.get(m) || 0) + 1); leftAt.delete(m); }
    c.mints = next; reconcile();
  }
  function attach(ws, { ip } = {}) {
    const c = { mints: new Set(), ip, sent: 0, msgs: 0, winAt: now() }; clients.set(ws, c); inc('tok_client_open');
    try { ws.send(JSON.stringify({ type: 'hello', max: maxPerClient })); } catch {}
    on(ws, 'message', raw => {
      const t = now(); if (t - c.winAt > 10000) { c.winAt = t; c.msgs = 0; } if (++c.msgs > 30) { inc('tok_client_rate'); return; }
      let m; try { m = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw && raw.data !== undefined ? raw.data : raw).toString('utf8')); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ping') { try { ws.send('{"type":"pong"}'); } catch {} return; }
      if (m.type === 'sub' && Array.isArray(m.mints)) setMints(c, m.mints);
    });
    on(ws, 'close', () => { if (!clients.has(ws)) return; setMints(c, []); clients.delete(ws); inc('tok_client_closed'); });
    on(ws, 'error', () => { try { ws.close(); } catch {} });
  }
  function beat() {
    const t = now();
    for (const u of U) { if (u.open && u.ws && t - u.lastMsg > silentMs) { inc('tok_up_silent'); log('tok-live: ' + u.kind + ' silent ' + Math.round((t - u.lastMsg) / 1000) + 's; reconnecting'); closeUp(u); schedule(u); } }
    reconcile();
  }
  const stats = () => ({ clients: clients.size, mints: ref.size, sent, upstreams: U.map(u => ({ kind: u.kind, open: u.open, opens: u.opens, msgs: u.msgs, matched: u.matched, subscribed: u.subscribed.size, lastErr: u.lastErr })) });
  return Object.freeze({
    start() { if (running || !WebSocketImpl || !U.length) return; running = true; hb = setIntervalImpl(beat, 5000); if (hb && hb.unref) hb.unref();
      st = setIntervalImpl(() => { if (clients.size || ref.size) log('tok-live: ' + JSON.stringify(stats())); }, statsMs); if (st && st.unref) st.unref();
      log('tok-live: started ' + U.map(u => u.kind).join('+')); },
    stop() { running = false; if (hb) clearIntervalImpl(hb); if (st) clearIntervalImpl(st); if (flushT) clearTimeoutImpl(flushT); flushT = null; U.forEach(closeUp); for (const ws of clients.keys()) { try { ws.close(); } catch {} } clients.clear(); ref.clear(); },
    attach, stats, _U: U, _flush: flush, _beat: beat
  });
}

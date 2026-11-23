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
const TRADER_IN = /"(?:traderPublicKey|txSigner|trader|user)"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const BUY_IN = /"action"\s*:\s*"buy"/, QA_IN = /"quoteAmount"\s*:\s*([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/;
const BIG_STORE_MIN = 0.5;   /* r163: buys of >= 0.5 SOL on ANY token are kept (last 300) for Pulse "big buys" */
const clean = v => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').slice(0, 32) : null;
const pos = v => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e15 ? n : null; };

export function createTokLive({ WebSocketImpl, upstreams = ['pumpapi', 'pumpportal'], urls = {}, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, log = () => {}, metrics = null, maxPerClient = 40, maxMints = 3000, coalesceMs = 250,
  graceMs = 30000, silentMs = 90000, statsMs = 60000, record = false, recWallets = 20000, recPerWallet = 100, recMints = 40000, recTotal = 80000, pxPerMint = 3600, pxTotal = 250000 } = {}) {
  const inc = n => { try { metrics?.inc(n); } catch {} };
  const U = upstreams.filter(k => k === 'pumpapi' || k === 'pumpportal').map(kind => ({ kind, url: kind === 'pumpapi' ? (urls.pumpapi || PUMPAPI_URL) : (urls.pumpportal || PUMPPORTAL_URL),
    ws: null, open: false, retry: 1000, rt: null, lastMsg: 0, opens: 0, msgs: 0, matched: 0, subscribed: new Set(), lastErr: null }));
  for (const u of U) if (![PUMPAPI_URL, PUMPPORTAL_URL].includes(u.url) && !/^ws:\/\/127\.0\.0\.1:\d+\//.test(u.url)) throw new Error('tok_live_url_not_allowed');
  const clients = new Map();          /* ws -> { mints:Set, ip, sent } */
  const ref = new Map();              /* mint -> number of clients watching */
  const leftAt = new Map();           /* mint -> when its last watcher left (unsubscribed upstream after graceMs) */
  const pend = new Map();             /* mint -> pending update */
  const BIG = [], BIG5 = [], lastPx = new Map();  /* r163: recent big buys (any token) and the last trade price per token */
  const wref = new Map();             /* r162: wallet -> number of clients following it (Pulse "Following") */
  let flushT = null, running = false, hb = null, st = null, sent = 0;
  /* r166 recorder (memory only, nothing written to any database): every Pump.fun / PumpSwap trade seen on the stream is kept per wallet
   * (last recPerWallet trades of the last recWallets active wallets) and every token's name/symbol/metadata uri (last recMints tokens).
   * Profiles use it to show a trader's buys and sells made anywhere (not only in Saturn) since this server started. */
  const REC = new Map(), META = new Map(); let recN = 0; const recSince = now();
  const RX = { act: /"(?:action|txType)":"(buy|sell)"/, qm: /"quoteMint":"([^"]{1,60})"/, sig: /"signature":"([1-9A-HJ-NP-Za-km-z]{60,100})"/, tr: /"(?:txSigner|traderPublicKey)":"([1-9A-HJ-NP-Za-km-z]{32,44})"/,
    sol: /"(?:quoteAmount|solAmount)":([0-9.eE+-]{1,30})/, tok: /"(?:tokenAmount|baseAmount)":([0-9.eE+-]{1,30})/, px: /"(?:priceSol|price)":([0-9.eE+-]{1,30})/,
    nm: /"name":"((?:[^"\\]|\\.){0,80})"/, sy: /"symbol":"((?:[^"\\]|\\.){0,30})"/, uri: /"uri":"(https:\/\/[^"\s<>]{8,300})"/ };
  /* r171c: copy matched text into its own small string; a regex match is a slice that keeps the whole ~3 KB message alive in memory */
  const own = x => typeof x === 'string' ? Buffer.from(x, 'utf8').toString('utf8') : x;
  const g = (r, h) => { const m = r.exec(h); return m ? own(m[1]) : undefined; };
  const unq = v => { if (v == null) return v; try { return JSON.parse('"' + v + '"'); } catch { return null; } };
  function lite(s, mint0) { let mint = mint0;
    const h = s.length > 2600 ? s.slice(0, 2600) : s, sol = Number((RX.sol.exec(h) || [])[1]), needMeta = !META.has(mint);
    if (!needMeta && !(sol >= 0.1)) return null;
    mint = own(mint);
    const o = { mint, action: g(RX.act, h), quoteMint: g(RX.qm, h), signature: g(RX.sig, h), txSigner: g(RX.tr, h), quoteAmount: sol, tokenAmount: Number(g(RX.tok, h)), price: Number(g(RX.px, h)) };
    if (needMeta) { o.name = unq(g(RX.nm, h)); o.symbol = unq(g(RX.sy, h)); o.uri = g(RX.uri, h); }
    const ti = s.lastIndexOf('"timestamp":'); if (ti > 0) { const t = Number((/^[0-9]{9,14}/.exec(s.slice(ti + 12, ti + 30)) || [])[0]); if (t > 0) o.timestamp = t; }
    if (!(sol >= 0.1)) o.action = null;
    return o;
  }
  function remember(j, kind) { if (!j) return;
    const mint = j.mint; if (typeof mint !== 'string' || !MINT.test(mint)) return;
    if (!META.has(mint) || (j.uri && !META.get(mint).u)) { const u = typeof j.uri === 'string' && /^https:\/\/[^\s"<>]{8,300}$/.test(j.uri) ? j.uri : null; const n = clean(j.name), sy = clean(j.symbol);
      if (n || sy || u) { META.delete(mint); META.set(mint, { n, s: sy, u }); if (META.size > recMints) META.delete(META.keys().next().value); } }
    const side = kind === 'pumpapi' ? (j.action === 'buy' || j.action === 'sell' ? j.action : null) : (j.txType === 'buy' || j.txType === 'sell' ? j.txType : null);
    if (!side || (j.quoteMint && j.quoteMint !== SOL)) return;
    const w = [j.traderPublicKey, j.txSigner, j.trader, j.user].find(x => typeof x === 'string' && MINT.test(x)); if (!w) return;
    const sig = [j.signature, j.txSignature, j.sig, j.tx].find(x => typeof x === 'string' && SIG.test(x)); if (!sig) return;
    const sol = pos(j.solAmount != null ? j.solAmount : j.quoteAmount), tok = pos(j.tokenAmount != null ? j.tokenAmount : j.baseAmount);
    let ts = Number(j.timestamp != null ? j.timestamp : j.blockTime); if (ts > 1e12) ts = Math.floor(ts / 1000); if (!(ts > 0)) ts = Math.floor(now() / 1000);
    let a = REC.get(w); if (a) REC.delete(w); else a = []; REC.set(w, a);
    if (a.some(x => x[0] === sig && x[1] === mint)) return;
    a.push([sig, mint, side, sol, tok, pos(j.price), ts]); recN++; if (a.length > recPerWallet) { a.shift(); recN--; }
    while (REC.size > recWallets || (recN > recTotal && REC.size > 1)) { const k = REC.keys().next().value; recN -= REC.get(k).length; REC.delete(k); }
  }
  /* r177 PRICE HISTORY (memory only): 1-second candles in SOL for every Pump.fun / PumpSwap token seen on the stream, so a token page's chart
   * has history (also for brand-new tokens no chart service lists yet) and a phone that left for a minute can fill the gap when it comes back.
   * Read with the same cheap regexes as the recorder (no JSON parsing). Per token the last pxPerMint seconds that had a trade; pxTotal overall,
   * least recently traded tokens dropped first. */
  const PXH = new Map(); let pxN = 0;
  const PX_RX = /"price":([0-9.eE+-]{1,30})/, QM_RX = /"quoteMint":"([^"]{1,60})"/, SOLV_RX = /"(?:quoteAmount|solAmount)":([0-9.eE+-]{1,30})/;
  function pxRecord(s, mint) {
    const q = QM_RX.exec(s); if (q && q[1] !== SOL) return;
    const p = Number((PX_RX.exec(s) || [])[1]); if (!(p > 0 && p < 1e9)) return;
    let ts = 0; const ti = s.lastIndexOf('"timestamp":'); if (ti > 0) ts = Number((/^[0-9]{9,14}/.exec(s.slice(ti + 12, ti + 30)) || [])[0]) || 0;
    if (ts > 1e12) ts = Math.floor(ts / 1000); const nowS = Math.floor(now() / 1000); if (!(ts > 0) || ts > nowS + 5 || ts < nowS - 600) ts = nowS;
    const v = Number((SOLV_RX.exec(s) || [])[1]) || 0;
    let a = PXH.get(mint);
    if (!a) { mint = own(mint); a = []; PXH.set(mint, a); }
    const n = a.length;
    if (n && a[n - 6] === ts) { if (p > a[n - 4]) a[n - 4] = p; if (p < a[n - 3]) a[n - 3] = p; a[n - 2] = p; a[n - 1] += v; return; }
    if (n && ts < a[n - 6]) { for (let i = n - 6; i >= 0; i -= 6) if (a[i] === ts) { if (p > a[i + 2]) a[i + 2] = p; if (p < a[i + 3]) a[i + 3] = p; a[i + 5] += v; return; } return; }
    PXH.delete(mint); PXH.set(mint, a);              /* most recently traded last */
    a.push(ts, p, p, p, p, v); pxN++;
    if (a.length > pxPerMint * 6) { a.splice(0, 6); pxN--; }
    while (pxN > pxTotal && PXH.size > 1) { const k = PXH.keys().next().value; pxN -= PXH.get(k).length / 6; PXH.delete(k); }
  }
  /* r199 DISCOVER FEED (memory only, from the same stream): per token, when Saturn first saw it trade, its live market cap / price, and
   * one-minute activity buckets (buys, sells, SOL in and out, distinct traders). New = tokens first seen in the last minute on a fresh
   * bonding curve; Hot = tokens whose last 5 minutes show many distinct buyers, real buy volume and a rising market cap. */
  const ACT = new Map(); const ACT_CAP = 6000; let upSince = 0;   /* r201: when the Pump.fun stream last connected (0 = not connected) */
  const warmNow = t => upSince > 0 && t - upSince > 90000;
  const A_RX = { act: /"action":"(buy|sell|create)"/, mcu: /"marketCapUsd":([0-9.eE+-]{1,30})/, mcs: /"marketCapSol":([0-9.eE+-]{1,30})/, pu: /"priceUsd":([0-9.eE+-]{1,30})/, tr: /"(?:txSigner|traderPublicKey)":"([1-9A-HJ-NP-Za-km-z]{32,44})"/ };
  function actRecord(s, mint) {
    const a = (A_RX.act.exec(s) || [])[1]; if (!a) return;
    const t = now(), mi = Math.floor(t / 60000), sol = Number((SOLV_RX.exec(s) || [])[1]) || 0, mcu = Number((A_RX.mcu.exec(s) || [])[1]) || 0, mcs = Number((A_RX.mcs.exec(s) || [])[1]) || 0, pu = Number((A_RX.pu.exec(s) || [])[1]) || 0;
    let r = ACT.get(mint);
    if (!r) { if (ACT.size >= ACT_CAP) { let oldK = null, oldT = Infinity; let n = 0; for (const [k, v] of ACT) { if (v.last < oldT) { oldT = v.last; oldK = k; } if (++n > 400) break; } if (oldK) ACT.delete(oldK); }
      r = { first: t, firstMcSol: mcs || null, created: a === 'create', last: t, mcu: 0, mcs: 0, pu: 0, b: [] }; ACT.set(own(mint), r);
      if (a === 'create' || (warmNow(t) && mcs > 0 && mcs < 32)) { r.mcu = mcu || 0; r.mcs = mcs || 0; r.pu = pu || 0; queueNew(mint, r); } }
    if (a === 'create') r.created = true;
    r.last = t; if (mcu > 0) r.mcu = mcu; if (mcs > 0) r.mcs = mcs; if (pu > 0) r.pu = pu;
    if (a === 'create') return;
    let b = r.b[r.b.length - 1]; if (!b || b.m !== mi) { b = { m: mi, nb: 0, ns: 0, sb: 0, ss: 0, w: new Set(), mc0: r.mcu || mcu || 0 }; r.b.push(b); if (r.b.length > 10) r.b.shift(); }
    if (a === 'buy') { b.nb++; b.sb += sol; } else { b.ns++; b.ss += sol; }
    if (b.w.size < 300) { const w = (A_RX.tr.exec(s) || [])[1]; if (w) b.w.add(w); }
  }
  /* r200: launches are pushed to New-tab clients as they happen (coalesced every 250 ms so a burst is one message) */
  const NEWQ = new Map(), newHooks = new Set(); let newT = null;
  function queueNew(mint, r) { NEWQ.set(mint, r); if (!newT) newT = setTimeoutImpl(flushNew, 250); }
  function flushNew() { newT = null; if (!NEWQ.size) return; const toks = [...NEWQ].map(([k, r]) => actView(k, r, 2)); NEWQ.clear();
    const msg = JSON.stringify({ type: 'newtok', tokens: toks });
    for (const [ws, c] of clients) { if (!c.newFeed || ws.readyState !== 1 || (ws.bufferedAmount || 0) > 256 * 1024) continue; try { ws.send(msg); sent++; } catch {} }
    for (const f of newHooks) { try { f(toks); } catch {} } }
  function pushMeta(list) { const msg = JSON.stringify({ type: 'newmeta', tokens: list }); for (const [ws, c] of clients) { if (!c.newFeed || ws.readyState !== 1) continue; try { ws.send(msg); } catch {} } }
  function actView(mint, r, mins) {
    const t = now(), from = Math.floor(t / 60000) - mins + 1, B = r.b.filter(x => x.m >= from), w = new Set(); let nb = 0, ns = 0, sb = 0, ss = 0;
    for (const x of B) { nb += x.nb; ns += x.ns; sb += x.sb; ss += x.ss; for (const k of x.w) w.add(k); }
    const mc0 = B.length ? B[0].mc0 : 0, m = META.get(mint);
    return { mint, name: m && m.n || null, symbol: m && m.s || null, mcUsd: r.mcu || null, priceUsd: r.pu || null, born: r.first, created: r.created,
      buys: nb, sells: ns, buySol: +sb.toFixed(3), sellSol: +ss.toFixed(3), traders: w.size, chg: mc0 > 0 && r.mcu > 0 ? +((r.mcu / mc0 - 1) * 100).toFixed(1) : null, solUsd: r.mcs > 0 && r.mcu > 0 ? r.mcu / r.mcs : null };
  }
  function feed(kind) {
    const t = now(), out = [];
    if (kind === 'new') {
      const warm = warmNow(t);   /* right after a restart every token looks "new": only tokens seen being created count then */
      for (const [k, r] of ACT) { if (t - r.first > 60000) continue; if (!r.created && (!warm || !(r.firstMcSol > 0 && r.firstMcSol < 32))) continue; out.push(actView(k, r, 2)); }
      return out.sort((a, b) => b.born - a.born).slice(0, 40);
    }
    for (const [k, r] of ACT) {
      if (t - r.last > 120000) continue; const v = actView(k, r, 5);
      if (v.traders < 8 || v.buys < 10 || v.buySol < 2 || !(v.chg > 5) || v.buySol < v.sellSol * 0.8) continue;
      v.score = v.traders * Math.log1p(v.buySol) * (1 + Math.min(v.chg, 300) / 100) * (t - r.first < 3 * 3600e3 ? 1.3 : 1); out.push(v);
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
  }
  /* candles for one token, aggregated to tf seconds (1..3600), oldest first, at most 1500 */
  function candles(mint, tf = 1) {
    const a = PXH.get(mint); if (!a) return [];
    const out = []; let c = null;
    for (let i = 0; i < a.length; i += 6) { const b = Math.floor(a[i] / tf) * tf;
      if (!c || c[0] !== b) { c = [b, a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]]; out.push(c); }
      else { if (a[i + 2] > c[2]) c[2] = a[i + 2]; if (a[i + 3] < c[3]) c[3] = a[i + 3]; c[4] = a[i + 4]; c[5] += a[i + 5]; } }
    return out.length > 1500 ? out.slice(-1500) : out;
  }
  function walletTrades(w) { const a = REC.get(w) || [];
    return a.map(x => { const m = META.get(x[1]); return { sig: x[0], mint: x[1], side: x[2], sol: x[3], tok: x[4], p: x[5], at: x[6], name: m && m.n || null, symbol: m && m.s || null }; }).reverse(); }
  function meta(mints) { const o = {}; for (const m of mints) { const x = META.get(m); if (x) o[m] = { name: x.n, symbol: x.s, uri: x.u }; } return o; }

  /* ---------- upstreams ---------- */
  const on = (ws, ev, f) => { if (typeof ws.on === 'function') ws.on(ev, f); else ws.addEventListener(ev, f); };
  function connect(u) {
    if (!running || u.ws || !watching()) return;
    let ws; try { ws = new WebSocketImpl(u.url); } catch (e) { u.lastErr = String(e && e.message || e).slice(0, 80); schedule(u); return; }
    u.ws = ws; u.open = false; u.subscribed = new Set();
    on(ws, 'open', () => { if (u.ws !== ws) return; u.open = true; if (u.kind === 'pumpapi') upSince = now(); u.opens++; u.lastMsg = now(); u.retry = 1000; inc('tok_up_open'); if (u.kind === 'pumpportal') syncPortal(u); });
    on(ws, 'message', ev => { if (u.ws !== ws) return; u.lastMsg = now(); u.msgs++; handle(u, typeof ev === 'object' && ev && 'data' in ev && !(ev instanceof Uint8Array) ? ev.data : ev); });
    on(ws, 'close', () => { if (u.ws !== ws) return; u.ws = null; u.open = false; if (u.kind === 'pumpapi') upSince = 0; inc('tok_up_closed'); schedule(u); });
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
    const mm = MINT_IN.exec(s); if (!mm) return;
    let big = false; if (BUY_IN.test(s)) { const q = QA_IN.exec(s); big = !!q && Number(q[1]) >= BIG_STORE_MIN; }
    /* r171: the recorder no longer JSON-parses every firehose message (that pinned the 0.15-CPU instance and slowed every request).
     * It reads the few fields it needs with anchored regexes on the head of the message, and skips dust trades (< 0.1 SOL). */
    if (record) { try { remember(lite(s, mm[1]), u.kind); } catch {} if (u.kind === 'pumpapi') { try { pxRecord(s, mm[1]); } catch {} try { actRecord(s, mm[1]); } catch {} } }
    let wm = null; if (!ref.has(mm[1]) && !big) { if (!wref.size) return; wm = TRADER_IN.exec(s); if (!wm || !wref.has(wm[1])) return; }   /* neither a watched token nor a followed wallet: dropped before JSON parsing */
    let j; try { j = JSON.parse(s); } catch { return; }
    if (!j || typeof j !== 'object' || j.mint !== mm[1]) return;
    let p = null, mc = null, side = null;
    if (u.kind === 'pumpapi') {
      if (!u.keysLogged) { u.keysLogged = true; try { log('tok-live: pumpapi event fields ' + JSON.stringify(Object.keys(j).map(k => k + ':' + (Array.isArray(j[k]) ? 'array' : typeof j[k])))); } catch {} }
      if (j.quoteMint && j.quoteMint !== SOL) return;
      p = pos(j.price); mc = pos(j.marketCapQuote); side = j.action === 'buy' || j.action === 'sell' ? j.action : null;
    } else {
      const sa = pos(j.solAmount), ta = pos(j.tokenAmount); p = sa && ta ? sa / ta : null; mc = pos(j.marketCapSol);
      side = j.txType === 'buy' || j.txType === 'sell' ? j.txType : null;
    }
    if (!p) return;
    u.matched++; inc('tok_trade');
    /* r162: every single trade (not coalesced) for clients that asked for trades (Pulse) */
    if (side) {
      const sig = [j.signature, j.txSignature, j.sig, j.tx].find(x => typeof x === 'string' && SIG.test(x));
      const w = [j.traderPublicKey, j.txSigner, j.trader, j.user].find(x => typeof x === 'string' && MINT.test(x)) || null;
      const sol = pos(j.solAmount != null ? j.solAmount : j.quoteAmount), tok = pos(j.tokenAmount != null ? j.tokenAmount : j.baseAmount);
      let ts = Number(j.timestamp != null ? j.timestamp : j.blockTime); if (ts > 1e12) ts = Math.floor(ts / 1000); if (!(ts > 0)) ts = Math.floor(now() / 1000);
      lastPx.set(j.mint, { p, at: now() }); if (lastPx.size > 5000) lastPx.delete(lastPx.keys().next().value);
      const isBig = big && side === 'buy' && sol >= BIG_STORE_MIN;
      if (sig) { const rec = { type: 'trade', mint: j.mint, sig, w, side, sol, tok, p, at: ts, src: u.kind, name: clean(j.name), symbol: clean(j.symbol), mcUsd: pos(j.marketCapUsd) };
        if (isBig) { rec.big = true; BIG.push(rec); if (BIG.length > 300) BIG.shift(); if (sol >= 3) { BIG5.push(rec); if (BIG5.length > 400) BIG5.shift(); } }
        const msg = JSON.stringify(rec); const t = now();
        for (const [ws, c] of clients) { if (!c.trades || !(c.mints.has(j.mint) || (w && c.wallets.has(w)) || (isBig && c.bigMin > 0 && sol >= c.bigMin))) continue; if (ws.readyState !== 1) continue;
          if (t - c.tw > 1000) { c.tw = t; c.tn = 0; } if (++c.tn > 30) { inc('tok_trade_rate_drop'); continue; }
          if ((ws.bufferedAmount || 0) > 256 * 1024) continue; try { ws.send(msg); sent++; } catch {} } }
    }
    if (!ref.has(j.mint)) return;
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
  const watching = () => ref.size > 0 || wref.size > 0 || [...clients.values()].some(c => c.bigMin > 0 || c.newFeed);
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
  function setWallets(c, list) {
    const next = new Set(list.filter(w => typeof w === 'string' && MINT.test(w)).slice(0, maxPerClient));
    for (const w of c.wallets) if (!next.has(w)) { const n = (wref.get(w) || 1) - 1; if (n > 0) wref.set(w, n); else wref.delete(w); }
    for (const w of next) if (!c.wallets.has(w)) wref.set(w, (wref.get(w) || 0) + 1);
    c.wallets = next;
  }
  function attach(ws, { ip } = {}) {
    const c = { mints: new Set(), wallets: new Set(), trades: false, bigMin: 0, ip, sent: 0, msgs: 0, winAt: now(), tw: now(), tn: 0 }; clients.set(ws, c); inc('tok_client_open');
    try { ws.send(JSON.stringify({ type: 'hello', max: maxPerClient })); } catch {}
    on(ws, 'message', raw => {
      const t = now(); if (t - c.winAt > 10000) { c.winAt = t; c.msgs = 0; } if (++c.msgs > 30) { inc('tok_client_rate'); return; }
      let m; try { m = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw && raw.data !== undefined ? raw.data : raw).toString('utf8')); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ping') { try { ws.send('{"type":"pong"}'); } catch {} return; }
      if (m.type === 'sub' && Array.isArray(m.mints)) { c.trades = m.trades === true; const was = c.bigMin; const wasNew = c.newFeed;
        /* r200: newFeed = every Pump.fun launch pushed the moment it happens (Discover > New) */
        c.newFeed = m.newFeed === true; if (c.newFeed && !wasNew) { try { ws.send(JSON.stringify({ type: 'newtoks', tokens: feed('new') })); } catch {} reconcile(); }
        c.bigMin = c.trades && Number(m.bigMin) >= BIG_STORE_MIN ? Math.min(1000, Number(m.bigMin)) : 0;
        setWallets(c, Array.isArray(m.wallets) ? m.wallets : []); const before = new Set(c.mints); setMints(c, m.mints);
        /* r163: on (re)subscribe -> recent big buys at once, and the last known price of every newly watched token */
        if (c.bigMin && was !== c.bigMin) { for (const r of (c.bigMin >= 3 ? BIG5 : BIG).filter(x => x.sol >= c.bigMin).slice(c.bigMin >= 3 ? -150 : -60)) { try { ws.send(JSON.stringify({ ...r, recent: true })); } catch {} } }
        for (const mt of c.mints) { if (before.has(mt)) continue; const lp = lastPx.get(mt); if (lp) { try { ws.send(JSON.stringify({ type: 'tok', mint: mt, p: lp.p, n: 0, src: 'last', at: lp.at })); } catch {} } } }
    });
    on(ws, 'close', () => { if (!clients.has(ws)) return; setWallets(c, []); setMints(c, []); clients.delete(ws); inc('tok_client_closed'); });
    on(ws, 'error', () => { try { ws.close(); } catch {} });
  }
  function beat() {
    const t = now();
    for (const u of U) { if (u.open && u.ws && t - u.lastMsg > silentMs) { inc('tok_up_silent'); log('tok-live: ' + u.kind + ' silent ' + Math.round((t - u.lastMsg) / 1000) + 's; reconnecting'); closeUp(u); schedule(u); } }
    reconcile();
  }
  const stats = () => ({ clients: clients.size, mints: ref.size, wallets: wref.size, bigClients: [...clients.values()].filter(c => c.bigMin > 0).length, bigKept: BIG.length, sent, recWallets: REC.size, recTrades: recN, recMints: META.size, pxMints: PXH.size, pxCandles: pxN, actTokens: ACT.size, upstreams: U.map(u => ({ kind: u.kind, open: u.open, opens: u.opens, msgs: u.msgs, matched: u.matched, subscribed: u.subscribed.size, lastErr: u.lastErr })) });
  return Object.freeze({
    start() { if (running || !WebSocketImpl || !U.length) return; running = true; hb = setIntervalImpl(beat, 5000); if (hb && hb.unref) hb.unref();
      st = setIntervalImpl(() => { if (clients.size || ref.size) log('tok-live: ' + JSON.stringify(stats())); }, statsMs); if (st && st.unref) st.unref();
      log('tok-live: started ' + U.map(u => u.kind).join('+')); },
    stop() { running = false; if (hb) clearIntervalImpl(hb); if (st) clearIntervalImpl(st); if (flushT) clearTimeoutImpl(flushT); flushT = null; U.forEach(closeUp); for (const ws of clients.keys()) { try { ws.close(); } catch {} } clients.clear(); ref.clear(); },
    attach, stats, walletTrades, meta, candles, feed, onNew: f => { newHooks.add(f); return () => newHooks.delete(f); }, pushMeta, recSince: () => recSince, recording: () => record, _U: U, _flush: flush, _beat: beat
  });
}

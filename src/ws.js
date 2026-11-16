/* Separate Perps WebSocket hub (path /perps/live on this service only). It never touches the spot WebSocket.
 * Messages are broadcast only when a NEW valid observation (or a state change) occurs. */
import { MARKET_KEYS, SOURCE } from './config.js';
import { isTf, TFS } from './time.js';

export function createHub({ cfg, now = Date.now, metrics, snapshot, epoch, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  const L = cfg.ws; const clients = new Set(); let nextId = 1;
  const seqSeen = new Map();

  function raw(c, obj, { droppable = false } = {}) {
    const ws = c.ws; if (ws.readyState !== 1) return false;
    const buf = ws.bufferedAmount || 0;
    if (buf > L.hardBuffer) { metrics?.inc('ws_slow_closed'); try { ws.terminate ? ws.terminate() : ws.close(1013, 'slow_consumer'); } catch {} return false; }
    if (droppable && buf > L.softBuffer) { metrics?.inc('ws_dropped_backpressure'); return false; }
    try { ws.send(JSON.stringify(obj)); metrics?.inc('ws_messages_out'); return true; } catch { return false; }
  }
  const err = (c, code, extra = {}) => { metrics?.inc('ws_client_errors'); raw(c, { type: 'perps_error', code, ...extra }); };
  const overRate = c => { const t = now(); c.times = c.times.filter(x => t - x < L.windowMs); c.times.push(t); return c.times.length > L.maxMsgPerWindow; };

  function attach(ws, { ip = '' } = {}) {
    const c = { id: 'c' + nextId++, ws, ip, markets: new Set(), tfs: new Set(), times: [], alive: true, closed: false };
    clients.add(c); metrics?.inc('ws_connected');
    raw(c, { type: 'perps_hello', v: 1, epoch, serverTime: Math.floor(now() / 1000), markets: MARKET_KEYS, intervalSec: cfg.intervalSec, source: SOURCE, timeframes: TFS });
    ws.on('message', d => { onMessage(c, d).catch(() => { metrics?.inc('ws_handler_errors'); }); });
    ws.on('pong', () => { c.alive = true; });
    const done = () => { if (c.closed) return; c.closed = true; clients.delete(c); };
    ws.on('close', done); ws.on('error', done);
    return c;
  }

  async function onMessage(c, data) {
    if (c.closed) return;
    if (overRate(c)) { metrics?.inc('ws_rate_limited'); return err(c, 'rate_limited'); }
    let m; try { m = JSON.parse(data.toString()); } catch { return err(c, 'bad_json'); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return err(c, 'bad_message');
    if (m.type === 'ping') return void raw(c, { type: 'pong', t: now() });
    if (m.type === 'subscribe') {
      if (!Array.isArray(m.markets) || m.markets.length === 0 || m.markets.length > L.maxMarkets) return err(c, m.markets && m.markets.length > L.maxMarkets ? 'too_many_markets' : 'bad_markets');
      const mk = []; for (const x of m.markets) { const u = typeof x === 'string' ? x.toUpperCase() : ''; if (!MARKET_KEYS.includes(u)) return err(c, 'bad_market'); if (!mk.includes(u)) mk.push(u); }
      let tfs = ['1h']; if (m.tfs !== undefined) { if (!Array.isArray(m.tfs) || m.tfs.length > TFS.length || !m.tfs.every(isTf)) return err(c, 'bad_tf'); tfs = [...new Set(m.tfs)]; }
      if (new Set([...c.markets, ...mk]).size > L.maxMarkets) return err(c, 'too_many_markets');
      mk.forEach(x => c.markets.add(x)); tfs.forEach(x => c.tfs.add(x));
      /* A failed snapshot lookup (database down) must not crash the process or leave the client without an answer: the subscription stands,
       * the snapshot for that market is null (nothing is invented) and snapshotOk=false tells the client not to treat the ack as fresh data. */
      const snap = {}; let snapshotOk = true;
      for (const x of mk) { try { snap[x] = await snapshot(x); } catch { snap[x] = null; snapshotOk = false; metrics?.inc('ws_snapshot_failed'); } }
      return void raw(c, { type: 'perps_subscribed', markets: [...c.markets], tfs: [...c.tfs], snapshot: snap, snapshotOk });
    }
    if (m.type === 'unsubscribe') {
      if (!Array.isArray(m.markets)) return err(c, 'bad_markets');
      for (const x of m.markets) if (typeof x === 'string') c.markets.delete(x.toUpperCase());
      return void raw(c, { type: 'perps_unsubscribed', markets: [...c.markets] });
    }
    return err(c, 'unknown_type');
  }

  const eachSub = (market, fn) => { for (const c of clients) if (!c.closed && c.markets.has(market)) fn(c); };
  return Object.freeze({
    attach,
    publishTick(t) { eachSub(t.market, c => raw(c, { type: 'perps_tick', market: t.market, price: t.price, observedAt: t.observedAt, seq: t.seq, source: SOURCE, ...(t.persisted === false ? { persisted: false } : {}) }, { droppable: true })); },
    publishCandle(market, k) {
      const final = k.status === 'complete';
      eachSub(market, c => { if (!c.tfs.has(k.tf)) return; raw(c, { type: 'perps_candle', market, tf: k.tf, final, candle: { t: Math.floor(k.startMs / 1000), o: k.o, h: k.h, l: k.l, c: k.c, n: k.n, status: k.status, ...(final ? { valid: k.valid } : {}) } }, { droppable: !final }); });
    },
    publishStatus(market, state, ageMs) { eachSub(market, c => raw(c, { type: 'perps_status', market, state, ageMs })); },
    heartbeat() { for (const c of [...clients]) { if (!c.alive) { metrics?.inc('ws_heartbeat_closed'); try { c.ws.terminate(); } catch {} clients.delete(c); c.closed = true; continue; } c.alive = false; try { c.ws.ping(); } catch {} } },
    closeAll(code = 1001, reason = 'service_shutdown') { for (const c of clients) try { c.ws.close(code, reason); } catch {} },
    get size() { return clients.size; },
    stats: () => ({ clients: clients.size })
  });
}

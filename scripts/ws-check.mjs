#!/usr/bin/env node
/* READ-ONLY real-service check of the Perps WebSocket. Run it YOURSELF (the build sandbox cannot reach Render):
 *   node scripts/ws-check.mjs                                      against wss://saturn-perps-staging.onrender.com/perps/live
 *   WS_URL=ws://127.0.0.1:8080/perps/live node scripts/ws-check.mjs   against a local copy
 * It only connects, subscribes (SOL, ETH, BTC), listens, sends one deliberately invalid subscribe (to confirm rejection), closes, reconnects and resubscribes.
 * No API key, no cookies, no orders. Exit code 1 if any check fails. Ticks only exist while the recorder is enabled on the service: with the recorder
 * disabled the "ticks" check is reported as SKIPPED (not passed) and the snapshot states are printed instead. */
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const URL_ = process.env.WS_URL || 'wss://saturn-perps-staging.onrender.com/perps/live';
const ORIGIN = process.env.WS_ORIGIN || 'https://alcapon264-cell.github.io';      /* must be one of the service's ALLOWED_ORIGINS */
const LISTEN = Math.min(300, Math.max(5, Number(process.env.LISTEN_SEC || 45)));
const OUT = process.env.OUT || '';
const checks = []; const ck = (name, pass, detail) => { checks.push({ name, pass: pass === null ? 'SKIPPED' : !!pass, detail }); console.log((pass === null ? 'SKIP ' : pass ? 'PASS ' : 'FAIL ') + name + (pass || pass === null || detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function open() {
  return new Promise((res, rej) => { const t0 = Date.now(); const ws = new WebSocket(URL_, { headers: { origin: ORIGIN }, handshakeTimeout: 15000 }); const c = { ws, msgs: [], t0, openMs: null };
    ws.on('message', d => { try { c.msgs.push({ at: Date.now(), m: JSON.parse(d.toString()) }); } catch {} });
    ws.on('open', () => { c.openMs = Date.now() - t0; res(c); }); ws.on('unexpected-response', (_, r) => rej(new Error('upgrade refused: HTTP ' + r.statusCode))); ws.on('error', e => rej(e)); });
}
const wait = async (c, pred, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const h = c.msgs.find(x => pred(x.m)); if (h) return h.m; await sleep(50); } return null; };

let c1;
try { c1 = await open(); ck('connect (upgrade accepted for the configured Origin)', true); console.log('  open in ' + c1.openMs + ' ms'); } catch (e) { ck('connect (upgrade accepted for the configured Origin)', false, String(e.message)); finish(); }
const hello = await wait(c1, m => m.type === 'perps_hello', 15000);
ck('perps_hello received (v1, markets SOL/ETH/BTC, epoch, intervalSec)', hello && hello.v === 1 && hello.markets.join() === 'SOL,ETH,BTC' && typeof hello.epoch === 'string' && hello.intervalSec > 0, hello);
c1.ws.send(JSON.stringify({ type: 'subscribe', markets: ['SOL', 'ETH', 'BTC'], tfs: ['1m', '5m', '15m', '1h', '4h'] }));
const ack = await wait(c1, m => m.type === 'perps_subscribed', 15000);
ck('subscription acknowledged for SOL, ETH, BTC and five timeframes', ack && ack.markets.join() === 'SOL,ETH,BTC' && ack.tfs.length === 5, ack);
if (ack) console.log('  snapshot states: ' + JSON.stringify(Object.fromEntries(Object.entries(ack.snapshot || {}).map(([k, v]) => [k, v ? { state: v.state, ageMs: v.ageMs, price: v.price } : null]))) + '  snapshotOk=' + ack.snapshotOk);
c1.ws.send(JSON.stringify({ type: 'subscribe', markets: ['DOGE'] }));
const bad = await wait(c1, m => m.type === 'perps_error' && m.code === 'bad_market', 10000);
ck('an unsupported market is rejected (perps_error bad_market)', !!bad, bad);
console.log('  listening ' + LISTEN + ' s for ticks …'); await sleep(LISTEN * 1000);
const ticks = c1.msgs.map(x => x.m).filter(m => m.type === 'perps_tick'), pongs = 0;
const per = Object.fromEntries(['SOL', 'ETH', 'BTC'].map(k => [k, ticks.filter(t => t.market === k)]));
const mono = Object.values(per).every(a => a.every((t, i) => !i || t.seq > a[i - 1].seq && t.observedAt >= a[i - 1].observedAt));
const valid = ticks.every(t => typeof t.price === 'number' && t.price > 0 && Number.isInteger(t.seq));
const anyLive = ack && Object.values(ack.snapshot || {}).some(v => v && v.state === 'live');
if (ticks.length === 0 && !anyLive) ck('ticks for SOL, ETH and BTC', null, 'no ticks and no live snapshot: the recorder is probably disabled on the service (expected until you enable it)');
else ck('ticks for SOL, ETH and BTC within ' + LISTEN + ' s (needs ≥1 sampling interval; 15 s default)', ['SOL', 'ETH', 'BTC'].every(k => per[k].length > 0), Object.fromEntries(Object.entries(per).map(([k, a]) => [k, a.length])));
ck('ticks are valid, strictly increasing in seq and not out of order', valid && mono, per);
ck('server heartbeat: connection stayed open for the whole listening period', c1.ws.readyState === 1, c1.ws.readyState);
c1.ws.close(); await sleep(500);
let c2; try { c2 = await open(); const h2 = await wait(c2, m => m.type === 'perps_hello', 15000); c2.ws.send(JSON.stringify({ type: 'subscribe', markets: ['SOL', 'ETH', 'BTC'], tfs: ['1m', '5m', '15m', '1h', '4h'] })); const a2 = await wait(c2, m => m.type === 'perps_subscribed', 15000);
  ck('reconnect + resubscribe works (new hello, new ack)', h2 && a2 && a2.markets.join() === 'SOL,ETH,BTC', { hello: !!h2, ack: !!a2 }); c2.ws.close(); } catch (e) { ck('reconnect + resubscribe works', false, String(e.message)); }
try { await new Promise((res, rej) => { const x = new WebSocket(URL_, { headers: { origin: 'https://not-allowed.example' } }); x.on('unexpected-response', (_, r) => { ck('a foreign Origin is refused', r.statusCode === 403, r.statusCode); res(); }); x.on('open', () => { ck('a foreign Origin is refused', false, 'upgrade was ACCEPTED'); x.close(); res(); }); x.on('error', () => res()); }); } catch {}
finish();
function finish() { const failed = checks.filter(x => x.pass === false).length; console.log(`\n${checks.filter(x => x.pass === true).length} passed, ${failed} failed, ${checks.filter(x => x.pass === 'SKIPPED').length} skipped`); if (OUT) writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), url: URL_, origin: ORIGIN, checks }, null, 2)); process.exit(failed ? 1 : 0); }

/* Hub-level reliability tests (fake sockets, no database needed). [MOCK sockets, MOCK snapshot] */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/ws.js';
import { loadConfig } from '../src/config.js';

const mk = () => ({ readyState: 1, bufferedAmount: 0, sent: [], handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, send(x) { this.sent.push(JSON.parse(x)); }, ping() {}, terminate() { this.readyState = 3; } });
const tick = ms => new Promise(r => setTimeout(r, ms));

test('subscribe while the database is down: no unhandled rejection, client gets an answer, subscription still works afterwards', async () => {
  const cfg = loadConfig({}); let fail = true; const unhandled = []; const h = e => unhandled.push(e); process.on('unhandledRejection', h);
  const hub = createHub({ cfg, epoch: 'e', snapshot: async m => { if (fail) { const x = new Error('db_unavailable'); x.dbUnavailable = true; throw x; } return { market: m, price: 1, state: 'live' }; } });
  const ws = mk(); hub.attach(ws, {});
  ws.handlers.message(JSON.stringify({ type: 'subscribe', markets: ['SOL'], tfs: ['1h'] })); await tick(30);
  process.off('unhandledRejection', h);
  assert.equal(unhandled.length, 0, 'no unhandled rejection');
  const ack = ws.sent.find(m => m.type === 'perps_subscribed'); assert.ok(ack, 'the client still receives perps_subscribed');
  assert.equal(ack.snapshot.SOL, null, 'no snapshot is invented when the lookup failed');
  assert.equal(ack.snapshotOk, false);
  hub.publishTick({ market: 'SOL', price: 5, observedAt: 5, seq: 1 }); assert.equal(ws.sent.filter(m => m.type === 'perps_tick').length, 1, 'live ticks still reach the client');
  fail = false; ws.handlers.message(JSON.stringify({ type: 'subscribe', markets: ['SOL'] })); await tick(30);
  assert.equal(ws.sent.filter(m => m.type === 'perps_subscribed').pop().snapshotOk, true);
});

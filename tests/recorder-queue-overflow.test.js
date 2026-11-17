import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/recorder.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({});

test('queue overflow preserves all older observations and rejects the newest', async () => {
  const clock = 1_000_000;
  let fetches = 0;
  const metrics = new Map();
  const store = {
    async lastObservation() { return null; },
    async insertFetchLog() {},
    async insertReject() {},
    async insertObservation() {
      throw new Error('controlled database outage');
    }
  };
  const jupiter = async () => {
    fetches++;
    return { ok: true, json: { price: 100 }, ms: 1 };
  };
  const rec = createRecorder({
    jupiter, store, cfg, now: () => clock,
    metrics: {
      inc(name, n = 1) { metrics.set(name, (metrics.get(name) || 0) + n); },
      observe() {}
    }
  });
  await rec.start();
  try {
    const original = Array.from({ length: 240 }, (_, i) => ({
      market: i % 2 ? 'ETH' : 'SOL',
      slotMs: clock,
      observedMs: clock,
      price: 100 + i,
      fetchMs: 1
    }));
    rec._queue.push(...original);

    await rec.runOnce('SOL');

    assert.equal(fetches, 1, 'one new sample was fetched');
    assert.equal(rec._queue.length, 240, 'queue remains bounded at 240');
    assert.deepEqual(rec._queue, original, 'none of the older queued observations was removed or reordered');
    assert.equal(metrics.get('queue_overflow_dropped'), 1, 'overflow is counted');
    assert.equal(rec.summary().queued, 240);
  } finally {
    await rec.stop();
  }
});

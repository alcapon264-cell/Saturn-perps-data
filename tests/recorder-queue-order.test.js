import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/recorder.js';
import { loadConfig, MARKETS } from '../src/config.js';

const cfg = loadConfig({});

test('a newer observation never bypasses an older queued observation after a failed flush', async () => {
  let clock = 1_000_000;
  let attempts = 0;
  const successful = [];
  const store = {
    async lastObservation() { return null; },
    async insertFetchLog() {},
    async insertReject() {},
    async insertObservation(observation) {
      attempts++;
      /* Fail the first direct write, then fail the first queue-flush attempt. */
      if (attempts <= 2) throw new Error('controlled transient database failure');
      successful.push(observation.market);
      return true;
    }
  };
  const jupiter = async mint => ({ ok: true, json: { price: mint === MARKETS.SOL ? 100 : 200 }, ms: 1 });
  const rec = createRecorder({ jupiter, store, cfg, now: () => clock });
  await rec.start();
  try {
    await rec.runOnce('SOL');
    assert.deepEqual(rec._queue.map(x => x.market), ['SOL']);

    clock += 1;
    await rec.runOnce('ETH');
    assert.deepEqual(rec._queue.map(x => x.market), ['SOL', 'ETH']);
    assert.deepEqual(successful, [], 'ETH must not be written directly when the older SOL flush fails');

    await rec.flushQueue();
    assert.deepEqual(successful, ['SOL', 'ETH'], 'recovery must persist observations in FIFO order');
    assert.equal(rec.summary().queued, 0);
  } finally {
    await rec.stop();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/recorder.js';
import { createMetrics } from '../src/metrics.js';
import { loadConfig, MARKETS } from '../src/config.js';

const cfg = loadConfig({});
function harness({ jupiter, insertObservation, log = () => {}, now = () => 1_000_000 } = {}) {
  const metrics = createMetrics();
  const store = {
    async lastObservation() { return null; },
    async insertFetchLog() {},
    async insertReject() {},
    insertObservation: insertObservation || (async () => true)
  };
  const rec = createRecorder({
    jupiter: jupiter || (async () => ({ ok: true, json: { price: 100 }, ms: 7 })),
    store, cfg, metrics, log, now
  });
  return { rec, metrics };
}

test('recorder summary exposes request and DB diagnostics without changing the sampling contract', async () => {
  let clock = 1_000_000;
  const { rec, metrics } = harness({ now: () => clock });
  await rec.start();
  await rec.runOnce('SOL');
  const m = rec.summary().markets.SOL;
  assert.equal(m.lastOutcome, 'ok');
  assert.equal(m.lastRequestDurationMs, 0);
  assert.equal(m.lastDbOutcome, 'inserted');
  assert.equal(m.lastDbWriteMs, 0);
  assert.equal(rec.summary().intervalSec, cfg.intervalSec);
  assert.equal(rec.summary().queueCapacity, 240);
  assert.equal(metrics.get('db_insert_ok'), 1);
  await rec.stop();
});

test('thrown upstream request is classified as network failure and does not crash recorder', async () => {
  const { rec, metrics } = harness({ jupiter: async () => { throw new Error('socket reset'); } });
  await rec.start();
  await rec.runOnce('SOL');
  const m = rec.summary().markets.SOL;
  assert.equal(m.lastOutcome, 'network');
  assert.equal(m.consecutiveFailures, 1);
  assert.equal(metrics.get('fetch_network'), 1);
  await rec.stop();
});

test('database errors are measured and surfaced while observation remains queued', async () => {
  const { rec, metrics } = harness({ insertObservation: async () => { throw new Error('database unavailable'); } });
  await rec.start();
  await rec.runOnce('SOL');
  const summary = rec.summary();
  assert.equal(summary.dbDegraded, true);
  assert.equal(summary.queued, 1);
  assert.equal(summary.markets.SOL.lastDbOutcome, 'error');
  assert.equal(metrics.get('db_write_errors'), 1);
  assert.equal(metrics.get('queue_flush_failures'), 0);
  await rec.stop();
});

test('throwing diagnostic logger cannot prevent a valid observation from being accepted', async () => {
  const { rec } = harness({
    jupiter: async () => ({ ok: false, outcome: 'http_5xx', status: 503, ms: 4 }),
    log: () => { throw new Error('logger unavailable'); }
  });
  await rec.start();
  await rec.runOnce('SOL');
  assert.equal(rec.summary().markets.SOL.lastOutcome, 'http_5xx');
  assert.equal(rec.summary().markets.SOL.consecutiveFailures, 1);
  await rec.stop();
});

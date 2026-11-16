/* scripts/live-check.mjs against a STUBBED fetch (MOCK). It proves the script is read-only, rate-capped and reports what it sees; it does NOT contact Jupiter. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const run = (env, args = []) => spawnSync(process.execPath, ['--import', path.join(root, 'tests/helpers/stub-fetch.mjs'), 'scripts/live-check.mjs', ...args], { cwd: root, env: { PATH: process.env.PATH, STUB_DUMP: '1', ...env }, encoding: 'utf8', timeout: 30000 });

test('live-check: GET-only to the Jupiter host, 3 requests per sample, reports headers / price type / timestamp-like keys', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lc-')), out = path.join(dir, 'r.json');
  const r = run({}, ['--samples', '2', '--out', out]); assert.equal(r.status, 0, r.stderr);
  const calls = JSON.parse(r.stderr.split('CALLS ')[1]); assert.equal(calls.length, 6);
  assert.ok(calls.every(c => c.method === 'GET' && c.host === 'perps-api.jup.ag' && c.url.startsWith('https://perps-api.jup.ag/v1/market-stats?mint=')));
  const rep = JSON.parse(readFileSync(out, 'utf8')); assert.equal(rep.results.length, 6);
  assert.deepEqual(rep.verdict.rateLimitHeadersSeen.sort(), ['retry-after', 'x-ratelimit-remaining']); assert.deepEqual(rep.verdict.priceTypes, ['string']); assert.equal(rep.verdict.priceParsedByService, true);
  assert.deepEqual(rep.verdict.timestampLikeKeysSeen, ['updatedAt']); assert.equal(rep.verdict.allHttp200, true);
});

test('live-check: caps requests (max 20 samples), exits non-zero on 429 or network failure, never sends credentials', () => {
  const big = run({}, ['--samples', '999']); assert.equal(JSON.parse(big.stderr.split('CALLS ')[1]).length, 60, '20 samples x 3 markets is the ceiling');
  const r429 = run({ STUB_MODE: '429' }, ['--samples', '1']); assert.equal(r429.status, 2); assert.match(r429.stdout, /"rateLimited429": 3/);
  const down = run({ STUB_MODE: 'down' }, ['--samples', '1']); assert.equal(down.status, 2); assert.match(down.stdout, /ERROR fetch failed/);
  assert.ok(!/authorization|x-api-key|cookie/i.test(readFileSync(path.join(root, 'scripts/live-check.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
});

/* r120: official token icons from Jupiter's Tokens API V2. Pure unit tests with a scripted fetch (no network). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenIcons, iconOk } from '../src/jupiter.js';

const SOL = 'So11111111111111111111111111111111111111112', ETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', BTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
function fake(body, { status = 200 } = {}) {
  const f = { calls: [], body, status };
  f.fetch = async (url, init) => { f.calls.push({ url, init }); return new Response(typeof f.body === 'string' ? f.body : JSON.stringify(f.body), { status: f.status, headers: { 'content-type': 'application/json' } }); };
  return f;
}
const tick = () => new Promise(r => setTimeout(r, 5));

test('r120 icons: one GET to the fixed host/path with the asked mints; only https icons for the asked mints are kept', async () => {
  const f = fake([{ id: SOL, icon: 'https://example.org/sol.png' }, { id: ETH, icon: 'http://insecure/eth.png' }, { id: BTC, icon: 'javascript:alert(1)' }, { id: 'Other1111111111111111111111111111111', icon: 'https://x/o.png' }]);
  let t = 1e12; const ic = createTokenIcons({ fetchImpl: f.fetch, now: () => t });
  assert.equal(ic.get([SOL, ETH, BTC]).size, 0, 'first call returns the (empty) cache immediately, never blocks');
  await ic.pending; await tick();
  const m = ic.get([SOL, ETH, BTC]);
  assert.equal(f.calls.length, 1); const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.jup.ag/tokens/v2/search'); assert.equal(u.searchParams.get('query'), [SOL, ETH, BTC].join(','));
  assert.equal(f.calls[0].init.redirect, 'error'); assert.equal(f.calls[0].init.credentials, 'omit');
  assert.deepEqual([...m.entries()], [[SOL, 'https://example.org/sol.png']], 'http, javascript: and unasked mints are dropped');
});

test('r120 icons: cached for the TTL; a failure keeps the last good icons and waits before retrying', async () => {
  const f = fake([{ id: SOL, icon: 'https://e/sol.png' }, { id: ETH, icon: 'https://e/eth.png' }, { id: BTC, icon: 'https://e/btc.png' }]);
  let t = 1e12; const ic = createTokenIcons({ fetchImpl: f.fetch, now: () => t, ttlMs: 1000, retryMs: 500 });
  ic.get([SOL, ETH, BTC]); await ic.pending; await tick();
  ic.get([SOL, ETH, BTC]); assert.equal(f.calls.length, 1, 'no refetch inside the TTL');
  f.status = 500; t += 1001; ic.get([SOL, ETH, BTC]); await ic.pending; await tick();
  assert.equal(f.calls.length, 2); assert.equal(ic.get([SOL, ETH, BTC]).get(ETH), 'https://e/eth.png', 'failure keeps the last good set');
  t += 100; ic.get([SOL, ETH, BTC]); assert.equal(f.calls.length, 2, 'no retry before retryMs');
});

test('r120 icons: malformed responses give no icons (nothing invented); only the fixed host is allowed; key stays in the request header', async () => {
  for (const body of ['not json', { a: 1 }, 'x'.repeat(300 * 1024)]) {
    const f = fake(body); const ic = createTokenIcons({ fetchImpl: f.fetch }); ic.get([SOL]); await ic.pending; await tick(); assert.equal(ic.get([SOL]).size, 0);
  }
  assert.throws(() => createTokenIcons({ base: 'https://evil.example/tokens/v2' }), /tokens_base_not_allowed/);
  assert.throws(() => createTokenIcons({ base: 'http://api.jup.ag/tokens/v2' }), /tokens_base_not_allowed/);
  const f = fake([]); const ic = createTokenIcons({ fetchImpl: f.fetch, keyHeader: 'x-api-key', key: 'secret-key' }); ic.get([SOL]); await ic.pending;
  assert.equal(f.calls[0].init.headers['x-api-key'], 'secret-key'); assert.ok(!f.calls[0].url.includes('secret'), 'key never in the URL');
  assert.equal(iconOk('https://static.jup.ag/jup/icon.png'), true); assert.equal(iconOk('https://a/"onerror=x'), false); assert.equal(iconOk('data:image/png;base64,AAA'), false);
});

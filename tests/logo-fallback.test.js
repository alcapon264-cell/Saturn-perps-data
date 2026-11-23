import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLogo } from '../src/viewsources.js';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const f = async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => PNG.buffer, body: null });
test('r180 logo fallback: pinned hosts by default; anyHost only for https without credentials; bytes must be an image', async () => {
  assert.equal((await fetchLogo(f, 'https://xstocks.example/a.png')).outcome, 'host_not_allowed');
  assert.equal((await fetchLogo(f, 'http://xstocks.example/a.png', { anyHost: true })).outcome, 'host_not_allowed');
  assert.equal((await fetchLogo(f, 'https://u:p@xstocks.example/a.png', { anyHost: true })).outcome, 'host_not_allowed');
  const r = await fetchLogo(f, 'https://xstocks.example/a.png', { anyHost: true }); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.type, 'image/png');
  const r2 = await fetchLogo(f, 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/doge/info/logo.png'); assert.equal(r2.ok, true);
});

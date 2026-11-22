import test from 'node:test';
import assert from 'node:assert/strict';
import { createPmData } from '../src/pm-data.js';
const YES = '1'.repeat(70), NO = '2'.repeat(70);
const ev = i => ({ id: String(i), slug: 'ev-' + i, title: 'E' + i, markets: [{ id: '5' + i, slug: 'm-' + i, question: 'Q' + i, outcomes: '["Yes", "No"]', outcomePrices: '["0.5", "0.5"]',
  clobTokenIds: JSON.stringify([YES, NO]), endDate: '2027-12-31T23:59:00Z', active: true, closed: false, acceptingOrders: true, volumeNum: 1000, volume24hr: 10, liquidityNum: 100 }] });
test('a too-big Gamma page is split down to single events; a single huge event is skipped', async () => {
  const all = Array.from({ length: 12 }, (_, i) => ev(i)); const calls = [];
  const fetchImpl = async url => { const q = new URL(url).searchParams, off = +q.get('offset'), lim = +q.get('limit'); calls.push([off, lim]);
    const page = all.slice(off, off + lim); const body = JSON.stringify(page) + (page.some(e => e.slug === 'ev-5') ? ' '.repeat(5000) : '');
    return { ok: true, status: 200, text: async () => body }; };
  const pm = createPmData({ fetchImpl, maxBodyBytes: 4000, log: () => {} });
  const r = await pm.feed('trending', 0, 12);
  assert.equal(r.markets.length, 11);
  const slugs = r.markets.map(m => m.slug); assert.ok(!slugs.includes('ev-5')); assert.equal(r.nextOffset, 12);
  const n = calls.length; await pm.feed('trending', 0, 12); assert.ok(calls.length - n === 0, 'cached / no refetch of the big page');
});

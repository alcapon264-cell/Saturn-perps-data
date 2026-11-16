/* Preload for the live-check test: stubs fetch (scripted Jupiter) and fast-forwards sleeps. TEST ONLY. */
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 1000 ? 1 : ms, ...a);
globalThis.__calls = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(url); globalThis.__calls.push({ url: String(url), method: init.method, host: u.hostname });
  const mode = process.env.STUB_MODE || 'ok';
  if (mode === 'down') throw new TypeError('fetch failed');
  const h = new Headers({ 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'retry-after': '1' });
  if (mode === '429') return new Response('{"error":"rate"}', { status: 429, headers: h });
  return new Response(JSON.stringify({ price: '148.31', priceChange24H: '1.2', updatedAt: 1763250000, volume: 5 }), { status: 200, headers: h });
};
process.on('exit', () => { if (process.env.STUB_DUMP) console.error('CALLS ' + JSON.stringify(globalThis.__calls)); });

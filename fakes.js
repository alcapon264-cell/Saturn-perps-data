/* Test doubles: fake clock with timer queue, scripted fake Jupiter fetch. NOT production code. */

export class FakeClock {
  constructor(start = Date.UTC(2026, 10, 16, 0, 0, 0)) { this.t = start; this.timers = []; this.seq = 0; }
  now = () => this.t;
  setTimeout = (fn, ms) => { const h = { id: ++this.seq, at: this.t + Math.max(0, ms), fn, unref() {} }; this.timers.push(h); return h; };
  clearTimeout = h => { this.timers = this.timers.filter(x => x !== h); };
  setInterval = (fn, ms) => { const h = { id: ++this.seq, at: this.t + ms, every: ms, fn, unref() {} }; this.timers.push(h); return h; };
  clearInterval = h => this.clearTimeout(h);
  /* advance virtual time, running due timers in order, letting async work settle after each */
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every) due.at += due.every; else this.timers = this.timers.filter(x => x !== due);
      due.fn();
      await settle(); if (this.idleFn) await this.idleFn();
    }
    this.t = end; await settle(); if (this.idleFn) await this.idleFn();
  }
  jump(ms) { this.t += ms; }
}
export const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
export async function settleUntil(cond, { tries = 400 } = {}) { for (let i = 0; i < tries; i++) { if (await cond()) return true; await new Promise(r => setTimeout(r, 5)); } return false; }

/* Scripted Jupiter: per-mint behaviour. price may be a number, string, or function(callIndex)->value. */
export function fakeJupiter({ prices = {}, headers = {} } = {}) {
  const f = {
    calls: [], mode: {}, prices: { ...prices }, delayMs: {}, clock: null, headers,
    fetch: async (url, init = {}) => {
      const u = new URL(url); const mint = u.searchParams.get('mint');
      f.calls.push({ url, mint, method: init.method, headers: init.headers, redirect: init.redirect, credentials: init.credentials, at: f.clock ? f.clock.now() : Date.now() });
      const mode = f.mode[mint] || 'ok';
      const hdr = new Headers({ 'content-type': 'application/json', ...f.headers });
      const mk = (status, body, extra = {}) => { for (const [k, v] of Object.entries(extra)) hdr.set(k, v); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: hdr }); };
      if (typeof mode === 'function') return mode(mint, f.calls.length, mk, init);
      switch (mode) {
        case 'ok': { const p = typeof f.prices[mint] === 'function' ? f.prices[mint](f.calls.length) : f.prices[mint]; return mk(200, { price: p, priceChange24H: '0.5', volume: '1000' }); }
        case 'http429': return mk(429, { error: 'rate' });
        case 'http429retry': return mk(429, { error: 'rate' }, { 'retry-after': '90' });
        case 'http500': return mk(500, { error: 'boom' });
        case 'http404': return mk(404, { error: 'nf' });
        case 'badjson': return mk(200, 'not json{');
        case 'noprice': return mk(200, { volume: 1 });
        case 'array': return mk(200, [1, 2]);
        case 'huge': return mk(200, 'x'.repeat(70 * 1024));
        case 'network': throw new TypeError('fetch failed');
        case 'hang': return new Promise((_, rej) => { init.signal && init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
        default: throw new Error('unknown mode ' + mode);
      }
    }
  };
  return f;
}

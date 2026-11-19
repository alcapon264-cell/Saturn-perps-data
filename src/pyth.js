/* r135 Pyth Benchmarks (public, keyless, read-only) — history for SOL/ETH/BTC chart gaps.
 * Why Pyth: Jupiter Perps prices come from its oracle set (Edge by Chaos Labs primary; Chainlink and Pyth verify it and are the fallback).
 * Saturn's own recorder is the source for SOL/ETH/BTC candles; Pyth's historical oracle candles are used ONLY for buckets Saturn did not
 * record (e.g. while the free server was asleep), and every such candle is labelled src:'pyth'. Nothing is estimated or smoothed.
 *   GET https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.SOL/USD&resolution=60&from=..&to=..
 * Fixed host and path, GET only, no cookies, no redirects, bounded body, hard deadline. */
export const PYTH_HOST = 'benchmarks.pyth.network';
export const PYTH_BASE = 'https://benchmarks.pyth.network/v1/shims/tradingview/history';
const SYMBOL = Object.freeze({ SOL: 'Crypto.SOL/USD', ETH: 'Crypto.ETH/USD', BTC: 'Crypto.BTC/USD' });
const RES = Object.freeze({ '1m': ['1', 60], '5m': ['5', 300], '15m': ['15', 900], '1h': ['60', 3600], '4h': ['240', 14400] });

export function createPythClient({ fetchImpl = globalThis.fetch, timeoutMs = 8000, maxBody = 1024 * 1024 } = {}) {
  /* -> {ok:true, candles:[{t,o,h,l,c}]} (t = bucket start, seconds) | {ok:false, outcome} */
  async function history(market, tf, from, to) {
    const sym = SYMBOL[market], r = RES[tf];
    if (!sym || !r || !Number.isInteger(from) || !Number.isInteger(to) || to <= from || (to - from) / r[1] > 2000) return { ok: false, outcome: 'bad_request' };
    const url = PYTH_BASE + '?symbol=' + encodeURIComponent(sym) + '&resolution=' + r[0] + '&from=' + from + '&to=' + to;
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' }, signal: ac.signal });
      if (!res.ok) return { ok: false, outcome: 'http_' + res.status };
      const text = await res.text(); if (text.length > maxBody) return { ok: false, outcome: 'body_too_large' };
      let j; try { j = JSON.parse(text); } catch { return { ok: false, outcome: 'invalid_json' }; }
      if (!j || j.s !== 'ok') return { ok: j && j.s === 'no_data', outcome: j && j.s === 'no_data' ? 'no_data' : 'malformed', candles: [] };
      const T = j.t, O = j.o, H = j.h, L = j.l, C = j.c;
      if (![T, O, H, L, C].every(Array.isArray) || T.length !== O.length || T.length !== H.length || T.length !== L.length || T.length !== C.length || T.length > 5000) return { ok: false, outcome: 'malformed' };
      const out = [];
      for (let i = 0; i < T.length; i++) {
        const t = T[i], o = O[i], h = H[i], l = L[i], c = C[i];
        if (!Number.isInteger(t) || t % r[1] !== 0 || ![o, h, l, c].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) || h < Math.max(o, c) || l > Math.min(o, c)) continue;
        out.push({ t, o, h, l, c });
      }
      return { ok: true, candles: out };
    } catch (e) { return { ok: false, outcome: ac.signal.aborted ? 'timeout' : 'network' }; }
    finally { clearTimeout(timer); }
  }
  return Object.freeze({ history, SYMBOL, RES });
}

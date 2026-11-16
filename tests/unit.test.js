import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandle, ohlcOk, maxGapAllowedSec, groupByBucket } from '../src/candles.js';
import { bucketStartMs, bucketEndMs, slotMs, TF_SEC, isTf } from '../src/time.js';
import { parseMarketStats, createJumpFilter } from '../src/validate.js';
import { createJupiterClient, parseRetryAfter } from '../src/jupiter.js';
import { loadConfig, validateConfig, MARKETS } from '../src/config.js';
import { clientIp, createLimiter } from '../src/limits.js';
import { fakeJupiter } from './helpers/fakes.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const mkObs = (startMs, intervalSec, count, f = i => 100 + i, offsetMs = 0) => Array.from({ length: count }, (_, i) => ({ t: startMs + offsetMs + i * intervalSec * 1000, price: f(i) }));
const O = (startMs, tf, obs, nowMs, extra = {}) => buildCandle(obs, { startMs, tf, intervalSec: 15, nowMs, graceMs: 15000, coverageMin: 0.8, ...extra });

test('time: UTC alignment for every timeframe, incl. day/month/year boundaries', () => {
  for (const tf of Object.keys(TF_SEC)) {
    const w = TF_SEC[tf] * 1000;
    for (const t of [0, 1, w - 1, w, T0, T0 + 12345678, Date.UTC(2026, 11, 31, 23, 59, 59, 999), Date.UTC(2027, 0, 1), Date.UTC(2028, 1, 29, 12, 3, 4)]) {
      const s = bucketStartMs(t, tf); assert.equal(s % w, 0); assert.ok(s <= t && t < s + w); assert.equal(bucketEndMs(s, tf), s + w);
    }
  }
  const d = new Date(bucketStartMs(Date.UTC(2026, 10, 16, 13, 59, 59), '4h')); assert.equal(d.getUTCHours(), 12);
  assert.equal(new Date(bucketStartMs(Date.UTC(2026, 10, 16, 23, 59, 59), '4h')).getUTCHours(), 20);
  assert.equal(slotMs(T0 + 14999, 15), T0); assert.equal(slotMs(T0 + 15000, 15), T0 + 15000);
  assert.ok(isTf('1h') && !isTf('2h') && !isTf('__proto__') && !isTf('constructor') && !isTf(null));
});

test('candle: OHLC correct, first/last by time, high/low from extremes', () => {
  const s = T0, obs = [{ t: s + 1000, price: 10 }, { t: s + 16000, price: 15 }, { t: s + 31000, price: 7 }, { t: s + 46000, price: 12 }];
  const k = O(s, '1m', obs, s + 100000);
  assert.deepEqual([k.o, k.h, k.l, k.c, k.n], [10, 15, 7, 12, 4]);
  assert.ok(ohlcOk(k)); assert.equal(k.status, 'complete');
});

test('candle: zero observations -> no candle (never fabricated)', () => { assert.equal(O(T0, '1h', [], T0 + 7200000), null); assert.equal(O(T0, '1h', null, T0), null); });

test('candle: forming until bucket end + grace, complete after', () => {
  const obs = mkObs(T0, 15, 4);
  assert.equal(O(T0, '1m', obs, T0 + 59000).status, 'forming');
  assert.equal(O(T0, '1m', obs, T0 + 60000 + 14999).status, 'forming');
  assert.equal(O(T0, '1m', obs, T0 + 60000 + 15000).status, 'complete');
  assert.equal(O(T0, '1m', obs, T0 + 59000).valid, false, 'a forming candle is never valid');
});

test('candle: validity thresholds at exact boundaries (coverage 0.80 and max gap)', () => {
  /* 1h: expected 240 samples. 192 = 0.80 exactly -> ok if gaps fine. */
  const full = mkObs(T0, 15, 240);
  const take = cnt => { const a = []; const stride = 240 / cnt; for (let i = 0; i < cnt; i++) a.push(full[Math.floor(i * stride)]); return a; };
  const now = T0 + 3600000 + 20000;
  const at192 = O(T0, '1h', take(192), now), at191 = O(T0, '1h', take(191), now);
  assert.equal(at192.coverage, 0.8); assert.equal(at192.valid, true);
  assert.ok(at191.coverage < 0.8); assert.equal(at191.valid, false);
  /* gap rule 1h: 600 s allowed. Build 192+ samples with one 600 s gap vs 601 s gap, nothing else large. */
  const dense = mkObs(T0, 15, 240);
  const withGap = gapSec => dense.filter(x => !(x.t > T0 + 1800000 && x.t < T0 + 1800000 + gapSec * 1000));
  const gOk = O(T0, '1h', withGap(600 - 15 + 1), now);   /* removes samples leaving ~600 s spacing */
  assert.ok(gOk.maxGapSec <= 600, 'gap ' + gOk.maxGapSec); assert.equal(gOk.valid, true);
  const gBad = O(T0, '1h', withGap(700), now); assert.ok(gBad.maxGapSec > 600); assert.equal(gBad.valid, false);
  assert.deepEqual(['1m', '5m', '15m', '1h', '4h'].map(tf => maxGapAllowedSec(tf, 15)), [60, 60, 150, 600, 2400]);
  assert.equal(maxGapAllowedSec('1h', 30), 600); assert.equal(maxGapAllowedSec('1m', 30), 120);
});

test('candle: bucket-edge gaps count (recording started mid-bucket -> invalid)', () => {
  const obs = mkObs(T0, 15, 120, i => 100, 1800000); /* starts 30 min into the hour */
  const k = O(T0, '1h', obs, T0 + 3600000 + 20000); assert.ok(k.maxGapSec >= 1800); assert.equal(k.valid, false); assert.ok(k.coverage < 0.8);
});

test('candle: property test vs brute-force oracle (random sets, shuffled-insertion invariance)', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let iter = 0; iter < 300; iter++) {
    const tf = ['1m', '5m', '15m', '1h', '4h'][Math.floor(rnd() * 5)], w = TF_SEC[tf] * 1000, s = T0 + Math.floor(rnd() * 50) * w;
    const n = 1 + Math.floor(rnd() * Math.min(300, w / 15000));
    const ts = new Set(); while (ts.size < n) ts.add(Math.floor(rnd() * (w / 15000)) * 15000);
    const obs = [...ts].sort((a, b) => a - b).map(o => ({ t: s + o, price: 1 + Math.floor(rnd() * 1e6) / 100 }));
    const k = O(s, tf, obs, s + w + 60000);
    const prices = obs.map(x => x.price);
    assert.equal(k.h, Math.max(...prices)); assert.equal(k.l, Math.min(...prices)); assert.equal(k.o, prices[0]); assert.equal(k.c, prices[prices.length - 1]); assert.equal(k.n, n);
    assert.ok(ohlcOk(k)); assert.ok(k.coverage > 0 && k.coverage <= 1);
    const g = groupByBucket([...obs].reverse().sort((a, b) => a.t - b.t), tf); assert.equal(g.size, 1);
    const k2 = O(s, tf, g.get(s), s + w + 60000); assert.deepEqual(k2, k, 'deterministic');
  }
});

test('candle: ohlcOk rejects invalid candles', () => {
  const ok = { o: 5, h: 6, l: 4, c: 5 };
  assert.ok(ohlcOk(ok));
  for (const bad of [{ ...ok, h: 4.5 }, { ...ok, l: 5.5 }, { ...ok, o: 0 }, { ...ok, c: -1 }, { ...ok, h: NaN }, { ...ok, l: Infinity }, { ...ok, o: 7 }]) assert.equal(ohlcOk(bad), false, JSON.stringify(bad));
});

test('validate: price parsing accepts plain positive decimals only', () => {
  for (const [v, p] of [[148.31, 148.31], ['148.31', 148.31], [' 5 ', 5], ['0.000001', 1e-6], [1, 1]]) assert.deepEqual(parseMarketStats({ price: v }), { ok: true, price: p }, String(v));
  const bad = [[0, 'non_positive'], [-1, 'non_positive'], ['-5', 'non_positive'], [NaN, 'non_finite'], [Infinity, 'non_finite'], ['NaN', 'non_finite'], ['Infinity', 'non_finite'], ['1e5', 'non_finite'], ['0x10', 'non_finite'], ['1,5', 'non_finite'], ['', 'malformed'], [null, 'malformed'], [undefined, 'malformed'], [{}, 'malformed'], [[5], 'malformed'], [true, 'malformed'], [2e9, 'non_finite']];
  for (const [v, reason] of bad) { const r = parseMarketStats({ price: v }); assert.equal(r.ok, false, String(v)); assert.equal(r.reason, reason, String(v)); }
  for (const body of [null, undefined, 5, 'x', [], [{ price: 1 }]]) assert.equal(parseMarketStats(body).ok, false);
  assert.equal(parseMarketStats({}).reason, 'malformed');
});

test('jump filter: 20% rule, 3 consecutive confirming samples required', () => {
  const f = createJumpFilter({ jumpPct: 20, confirm: 3, confirmTolPct: 5 });
  assert.equal(f.check(100, 1).accept, true);
  assert.equal(f.check(119.9, 2).accept, true, 'just under 20% passes');
  const base = f.last.price;
  assert.equal(f.check(base * 1.21, 3).accept, false);           /* 1 of 3 */
  assert.equal(f.check(base * 1.21, 4).accept, false);           /* 2 of 3 */
  const r = f.check(base * 1.215, 5); assert.equal(r.accept, true); assert.equal(r.confirmedJump, true); /* 3 of 3 */
  assert.equal(f.last.price, base * 1.215);
});

test('jump filter: a lone spike never gets in; pending resets when price returns', () => {
  const f = createJumpFilter(); f.check(100, 1);
  assert.equal(f.check(300, 2).accept, false); assert.equal(f.pendingCount, 1);
  assert.equal(f.check(101, 3).accept, true); assert.equal(f.pendingCount, 0);
  assert.equal(f.check(10, 4).accept, false); assert.equal(f.check(10.2, 5).accept, false); assert.equal(f.pendingCount, 2);
  assert.equal(f.check(101, 6).accept, true, 'return to normal clears pending'); assert.equal(f.pendingCount, 0);
});

test('jump filter: non-agreeing jumps do not confirm each other; down moves handled symmetrically', () => {
  const f = createJumpFilter(); f.check(100, 1);
  for (const [p, t] of [[200, 2], [300, 3], [200, 4], [500, 5]]) assert.equal(f.check(p, t).accept, false, String(p));
  const g = createJumpFilter(); g.check(100, 1);
  assert.equal(g.check(50, 2).accept, false); assert.equal(g.check(50.5, 3).accept, false); assert.equal(g.check(49.8, 4).accept, true);
  const h = createJumpFilter(); assert.equal(h.check(7, 1).baseline, true);
});

test('jump filter: seed() sets a baseline; reset() clears it', () => {
  const f = createJumpFilter(); f.seed(100, 1); assert.equal(f.check(150, 2).accept, false); f.reset(); assert.equal(f.check(150, 3).accept, true);
});

test('jupiter client: fixed host only, GET only, no redirects, no credentials', async () => {
  assert.throws(() => createJupiterClient({ base: 'https://evil.example/v1' }), /jupiter_base_not_allowed/);
  assert.throws(() => createJupiterClient({ base: 'http://perps-api.jup.ag/v1' }), /jupiter_base_not_allowed/);
  assert.throws(() => createJupiterClient({ base: 'https://perps-api.jup.ag.evil.example/v1' }), /jupiter_base_not_allowed/);
  const fj = fakeJupiter({ prices: { [MARKETS.SOL]: 150 } }); const c = createJupiterClient({ fetchImpl: fj.fetch });
  const r = await c(MARKETS.SOL); assert.equal(r.ok, true); assert.equal(r.json.price, 150);
  const call = fj.calls[0]; assert.equal(call.method, 'GET'); assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit');
  assert.ok(call.url.startsWith('https://perps-api.jup.ag/v1/market-stats?mint=')); assert.equal(new URL(call.url).searchParams.get('mint'), MARKETS.SOL);
  /* a hostile "mint" cannot break out of the query string */
  await c('a&b=c#x'); assert.equal(new URL(fj.calls[1].url).hostname, 'perps-api.jup.ag'); assert.equal(new URL(fj.calls[1].url).searchParams.get('mint'), 'a&b=c#x');
});

test('jupiter client: classifies every failure mode', async () => {
  const fj = fakeJupiter({ prices: { m: 1 } }); const c = createJupiterClient({ fetchImpl: fj.fetch, timeoutMs: 40 });
  const want = { http429: 'http_429', http429retry: 'http_429', http500: 'http_5xx', http404: 'http_other', badjson: 'malformed', huge: 'malformed', network: 'network', hang: 'timeout' };
  for (const [mode, outcome] of Object.entries(want)) { fj.mode.m = mode; const r = await c('m'); assert.equal(r.ok, false, mode); assert.equal(r.outcome, outcome, mode); }
  fj.mode.m = 'http429retry'; assert.equal((await c('m')).retryAfterMs, 90000);
  fj.mode.m = 'ok'; assert.equal((await c('m')).ok, true);
});

test('jupiter client: captures rate-limit headers generically; sends API key only when configured, with the configured header name', async () => {
  const fj = fakeJupiter({ prices: { m: 1 }, headers: { 'x-ratelimit-remaining': '7', 'retry-after': '3', 'x-other': 'no' } });
  const c = createJupiterClient({ fetchImpl: fj.fetch }); const r = await c('m');
  assert.deepEqual(r.rateHeaders, { 'x-ratelimit-remaining': '7', 'retry-after': '3' });
  assert.equal(fj.calls[0].headers['x-api-key'], undefined);
  const c2 = createJupiterClient({ fetchImpl: fj.fetch, keyHeader: 'x-api-key', key: 'SECRET' }); await c2('m'); assert.equal(fj.calls[1].headers['x-api-key'], 'SECRET');
});

test('jupiter client: retry-after parsing', () => {
  assert.equal(parseRetryAfter('5'), 5000); assert.equal(parseRetryAfter(null), null); assert.equal(parseRetryAfter('garbage'), null);
  const base = Date.UTC(2026, 0, 1); assert.equal(parseRetryAfter(new Date(base + 7000).toUTCString(), base), 7000);
  assert.equal(parseRetryAfter(new Date(base - 5000).toUTCString(), base), 0, 'past date -> 0');
});

test('config: defaults, bounds, secrets handling', () => {
  const c = loadConfig({}); assert.equal(c.intervalSec, 15); assert.equal(c.coverageMin, 0.8); assert.equal(c.jumpPct, 20); assert.equal(c.jumpConfirm, 3); assert.equal(c.maxRps, 0.25);
  assert.equal(loadConfig({ SAMPLE_INTERVAL_SEC: '2' }).intervalSec, 15, 'below minimum falls back');
  assert.equal(loadConfig({ SAMPLE_INTERVAL_SEC: '30' }).intervalSec, 30);
  assert.equal(loadConfig({ MAX_REQUESTS_PER_SEC: '5' }).maxRps, 0.25, 'cannot exceed the stated 0.5 rps ceiling');
  assert.ok(loadConfig({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' }).allowedOrigins.has('https://b.example'));
  assert.deepEqual(validateConfig(loadConfig({})), ['DATABASE_URL is required']);
  assert.ok(validateConfig(loadConfig({ DATABASE_URL: 'x', JUPITER_API_KEY: 'k' })).some(e => /together/.test(e)));
  assert.deepEqual(validateConfig(loadConfig({ DATABASE_URL: 'x', JUPITER_API_KEY: 'k', JUPITER_API_KEY_HEADER: 'x-api-key' })), []);
  assert.ok(validateConfig(loadConfig({ DATABASE_URL: 'x', JUPITER_API_KEY: 'k', JUPITER_API_KEY_HEADER: 'bad header\r\n' })).length);
});

test('config: STATUS_TOKEN must be long and printable; empty means the status endpoint is disabled', () => {
  const v = t => validateConfig(loadConfig({ DATABASE_URL: 'x', STATUS_TOKEN: t }));
  assert.deepEqual(v(''), []); assert.deepEqual(v('a'.repeat(24)), []); assert.ok(v('short').some(e => /STATUS_TOKEN/.test(e))); assert.ok(v('has space inside the token!!').some(e => /STATUS_TOKEN/.test(e)));
  assert.equal(loadConfig({}).statusToken, '');
});

test('limits: client IP ignores a spoofed first x-forwarded-for entry', () => {
  const req = (xff, ra = '10.0.0.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: ra } });
  assert.equal(clientIp(req('1.2.3.4, 5.6.7.8'), 1), '5.6.7.8');
  assert.equal(clientIp(req('6.6.6.6, 1.2.3.4, 5.6.7.8'), 1), '5.6.7.8');
  assert.equal(clientIp(req('1.2.3.4, 5.6.7.8'), 2), '1.2.3.4');
  assert.equal(clientIp(req('1.2.3.4'), 0), '10.0.0.9'); assert.equal(clientIp(req(undefined), 1), '10.0.0.9');
  assert.equal(clientIp(req('<script>'), 1), '10.0.0.9');
});

test('limits: sliding window limiter', () => {
  let t = 0; const over = createLimiter({ now: () => t, windowMs: 1000 });
  for (let i = 0; i < 3; i++) assert.equal(over('k', 3), false);
  assert.equal(over('k', 3), true); assert.equal(over('other', 3), false);
  t = 1500; assert.equal(over('k', 3), false);
});

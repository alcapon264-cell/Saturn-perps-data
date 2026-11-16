#!/usr/bin/env node
/* READ-ONLY live check of Jupiter Perps GET /v1/market-stats. Run it YOURSELF (S2): the build sandbox cannot reach Jupiter.
 *   node scripts/live-check.mjs                       one GET per market (3 requests)
 *   node scripts/live-check.mjs --samples 4 --interval 15 --out live-check.json
 * It sends no API key, no cookies and only GET requests, never more than markets x samples requests (max 3 x 20), and never faster than 1 request/5 s.
 * It prints every response header (so you can see rate-limit headers), the response's top-level keys and types, the price type,
 * and whether any timestamp-like field exists. Nothing is assumed: it only reports what Jupiter actually returned. */
import { writeFileSync } from 'node:fs';

const BASE = 'https://perps-api.jup.ag/v1';
const MARKETS = { SOL: 'So11111111111111111111111111111111111111112', ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' };
const args = process.argv.slice(2); const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const samples = Math.min(20, Math.max(1, Number(arg('samples', 1)) | 0)), interval = Math.max(5, Number(arg('interval', 15)) || 15), out = arg('out', '');
const TS = /(time|ts|stamp|updated|at)$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { when: new Date().toISOString(), node: process.version, base: BASE, samples, intervalSec: interval, results: [] };
let non200 = 0, tooMany = 0;

for (let s = 0; s < samples; s++) {
  for (const [m, mint] of Object.entries(MARKETS)) {
    const t0 = Date.now(); const r = { sample: s + 1, market: m, at: new Date(t0).toISOString() };   /* request start time (UTC), evidence of the real cadence */
    try {
      const res = await fetch(`${BASE}/market-stats?mint=${encodeURIComponent(mint)}`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      r.status = res.status; r.ms = Date.now() - t0; r.headers = Object.fromEntries(res.headers.entries());
      if (res.status !== 200) non200++; if (res.status === 429) tooMany++;
      const text = await res.text(); r.bytes = text.length;
      try { const j = JSON.parse(text); r.topLevelKeys = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, Array.isArray(v) ? 'array' : typeof v])); r.price = j.price; r.priceType = typeof j.price; r.timestampLikeKeys = Object.keys(j).filter(k => TS.test(k)); r.sample_values = Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v !== 'object').slice(0, 12)); }
      catch { r.parseError = true; r.bodyHead = text.slice(0, 200); }
    } catch (e) { r.error = String(e && e.message || e); r.ms = Date.now() - t0; non200++; }
    report.results.push(r);
    console.log(`#${r.sample} ${m}: ${r.error ? 'ERROR ' + r.error : 'HTTP ' + r.status} in ${r.ms} ms${r.price !== undefined ? ', price=' + r.price + ' (' + r.priceType + ')' : ''}`);
    await sleep(5000);                                              /* never faster than 1 request per 5 s */
  }
  if (s < samples - 1) await sleep(Math.max(0, interval * 1000 - 3 * 5000));
}

const hdrNames = [...new Set(report.results.flatMap(r => Object.keys(r.headers || {})))].sort();
const rl = hdrNames.filter(h => /rate|limit|retry|quota|remaining|reset/i.test(h));
const tsKeys = [...new Set(report.results.flatMap(r => r.timestampLikeKeys || []))];
const types = [...new Set(report.results.map(r => r.priceType))];
report.verdict = {
  allHttp200: non200 === 0, rateLimited429: tooMany,
  priceTypes: types, priceParsedByService: report.results.every(r => (r.priceType === 'number' && r.price > 0) || (r.priceType === 'string' && /^\d{1,15}(\.\d{1,18})?$/.test(String(r.price).trim()) && Number(r.price) > 0)),
  rateLimitHeadersSeen: rl, allHeaderNames: hdrNames, timestampLikeKeysSeen: tsKeys,
  note: 'These are observations from one run, not guarantees. Paste this JSON back for S2 sign-off.'
};
console.log('\n--- verdict ---\n' + JSON.stringify(report.verdict, null, 2));
if (out) { writeFileSync(out, JSON.stringify(report, null, 2)); console.log('\nfull report written to ' + out); }
process.exit(non200 ? 2 : 0);

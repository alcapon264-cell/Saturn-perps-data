/* r131 ACCEPTANCE SUITE — GLOBAL SATURN PERPS FEE RULE.
 * One suite proves that every supported Perps chain, venue and market (backend AND the app) resolves to exactly 0.06% (6 bps),
 * that future venues inherit it automatically, that the fee is computed on executed notional only, and that no adapter defines its
 * own Saturn rate. A venue that cannot collect the fee must say so (never "pretend collected").
 * The app half reads the built index.html from SATURN_FRONTEND_HTML (or the R131 dist path); if no file is found that half is SKIPPED, loudly. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { SATURN_PERPS_FEE, SATURN_PERPS_FEE_BPS, VENUE_MECHANISMS, MARKET_VENUES, feeFor, feeForMarket, feeOnExecuted, hlBuilder } from '../src/fee-policy.js';
import { MARKETS, VIEW_MARKET_TABLE } from '../src/config.js';
import { hlConfig } from '../src/hl-exec.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_MARKETS = [...Object.keys(MARKETS), ...Object.keys(VIEW_MARKET_TABLE)];
const EXPECT = { bps: 6, rate: 0.0006, percent: '0.06%' };
const close = (a, b) => Math.abs(a - b) < 1e-12;

test('the policy constant is exactly 0.06% (6 bps); Hyperliquid builder f = 60 tenths of a bp, within the 0.1% protocol cap', () => {
  assert.equal(SATURN_PERPS_FEE_BPS, 6);
  assert.deepEqual({ bps: SATURN_PERPS_FEE.bps, rate: SATURN_PERPS_FEE.rate, percent: SATURN_PERPS_FEE.percent }, EXPECT);
  assert.equal(SATURN_PERPS_FEE.hlBuilderTenthsBp, 60);
  assert.ok(Object.isFrozen(SATURN_PERPS_FEE));
});

test('every supported market (Solana + Hyperliquid + Trade.xyz) is mapped to a venue and resolves to exactly 0.06%', () => {
  assert.deepEqual(ALL_MARKETS.slice().sort(), Object.keys(MARKET_VENUES).sort(), 'every listed market must be in MARKET_VENUES (a new market fails here until mapped)');
  assert.ok(ALL_MARKETS.length >= 11);   /* r179: more Hyperliquid markets */
  for (const k of ALL_MARKETS) { const p = feeForMarket(k); assert.equal(p.bps, 6, k); assert.ok(close(p.rate, 0.0006), k); assert.equal(p.percent, '0.06%', k); }
});

test('every venue / chain resolves to the same 0.06%; mechanisms differ, the rate never does', () => {
  for (const v of Object.keys(VENUE_MECHANISMS)) { const p = feeFor(v); assert.equal(p.bps, 6, v); assert.ok(close(p.rate, 0.0006), v); }
  assert.equal(feeFor('hyperliquid').supported, true); assert.equal(feeFor('hyperliquid:xyz').supported, true);
  const sol = feeFor('solana'); assert.equal(sol.bps, 6); assert.equal(sol.supported, false, 'Solana Perps cannot collect: reported, not pretended'); assert.match(sol.limitation, /no integrator-fee mechanism/);
});

test('future integrations inherit 0.06% automatically and report that they cannot collect yet', () => {
  for (const v of ['arbitrum:gmx', 'base:newvenue', 'solana:other', '', 'unknown:XYZ']) { const p = feeFor(v); assert.equal(p.bps, 6); assert.ok(close(p.rate, 0.0006)); assert.equal(p.supported, false); assert.ok(p.limitation); }
  assert.equal(feeForMarket('DOGE').bps, 6);
});

test('fee is charged on EXECUTED notional only: unfilled/cancelled = 0, partial fills proportional', () => {
  assert.equal(feeOnExecuted(0), 0); assert.equal(feeOnExecuted(null), 0); assert.equal(feeOnExecuted(-5), 0); assert.equal(feeOnExecuted('x'), 0);
  assert.ok(close(feeOnExecuted(1000), 0.6)); assert.ok(close(feeOnExecuted(1000 * 0.4), 0.24), '40% partial fill pays 40%');
  assert.ok(close(feeOnExecuted(500) + feeOnExecuted(500), feeOnExecuted(1000)), 'two partial fills = one full fill');
});

test('Hyperliquid builder object and relay config come from the policy (address only, never a key)', () => {
  assert.equal(hlBuilder(''), null); assert.equal(hlBuilder('0xNOPE'), null);
  assert.deepEqual({ ...hlBuilder('0x' + 'ab'.repeat(20)) }, { b: '0x' + 'ab'.repeat(20), f: 60 });
  assert.equal(hlConfig({ SATURN_PERPS_FEE_WALLET_EVM: '0x' + 'AB'.repeat(20) }).feeWallet, '0x' + 'ab'.repeat(20));
  assert.equal(hlConfig({ SATURN_PERPS_FEE_WALLET_EVM: 'not-an-address' }).feeWallet, null);
});

test('no backend source file defines its own Saturn fee rate (only src/fee-policy.js)', () => {
  const files = readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js') && f !== 'fee-policy.js');
  for (const f of files) {
    const t = readFileSync(path.join(root, 'src', f), 'utf8');
    assert.ok(!/\b0\.0006\b|\b6\s*\/\s*10000\b|\bf:\s*60\b|['"]0\.06%['"]/.test(t), f + ' must not hard-code a Saturn fee rate');
  }
  assert.match(readFileSync(path.join(root, 'src/hl-exec.js'), 'utf8'), /from '\.\/fee-policy\.js'/);
});

/* ---------- the app (index.html) ---------- */
const HTML = [process.env.SATURN_FRONTEND_HTML, '/home/claude/w/dist/R131/index.html', '/home/claude/hl/index131.html'].find(p => p && existsSync(p));
const app = { skip: HTML ? false : 'SKIPPED: no built index.html found (set SATURN_FRONTEND_HTML)' };
const block = (html, id) => { const i = html.indexOf('<script id="' + id + '">'); assert.ok(i >= 0, id + ' missing'); return html.slice(html.indexOf('>', i) + 1, html.indexOf('</script>', i)); };

test('APP: the single SaturnPerpsFee policy resolves every market and venue to exactly 0.06%, identical to the backend', app, () => {
  const html = readFileSync(HTML, 'utf8'), ctx = { window: {} };
  vm.runInNewContext(block(html, 'saturn-fee-policy'), ctx);
  const P = ctx.window.SaturnPerpsFee;
  assert.equal(P.bps, 6); assert.ok(close(P.rate, 0.0006)); assert.equal(P.percent, '0.06%'); assert.equal(P.hlBuilderTenthsBp, 60);
  for (const [k, v] of Object.entries(P.MARKET_VENUES)) assert.equal(MARKET_VENUES[k], v, 'app and backend map ' + k + ' to the same venue');   /* r179: the backend lists more view-only markets */
  assert.deepEqual(Object.keys(P.VENUES).sort(), Object.keys(VENUE_MECHANISMS).sort());
  for (const k of ALL_MARKETS.filter(k => k in P.MARKET_VENUES)) { const a = P.feeForMarket(k), b = feeForMarket(k); assert.equal(a.bps, 6, k); assert.equal(a.rate, b.rate, k); assert.equal(a.supported, b.supported, k); }
  for (const v of [...Object.keys(VENUE_MECHANISMS), 'future:venue']) { const a = P.feeFor(v); assert.equal(a.bps, 6, v); assert.equal(a.supported, feeFor(v).supported, v); }
  assert.ok(close(P.feeOnExecuted(1000), 0.6)); assert.equal(P.feeOnExecuted(0), 0);
});

test('APP: adapters and the Perps core never define a Saturn rate; they read SaturnPerpsFee', app, () => {
  const html = readFileSync(HTML, 'utf8'), hl = block(html, 'saturn-r129-hl'), core = block(html, 'saturn-r113-perps');
  const adapter = hl.slice(hl.indexOf('/* r129 Saturn Perps: Hyperliquid + Trade.xyz execution ADAPTERS'));
  assert.ok(!/\b0\.0006\b|\bf:\s*60\b|['"]0\.06%['"]/.test(adapter), 'Hyperliquid adapter has no own Saturn rate');
  assert.match(adapter, /window\.SaturnPerpsFee/); assert.match(adapter, /hlBuilderTenthsBp/);
  assert.match(core, /function satFee\(V,m,size\)\{const P=window\.SaturnPerpsFee/);
  assert.ok(html.indexOf('<script id="saturn-fee-policy">') < html.indexOf('<script id="saturn-r113-perps">'), 'policy loads before the core');
});

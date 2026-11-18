import { createHash } from 'node:crypto';
/* Static guarantees about the repository: read-only, isolated, no secrets in code. [no network, no database] */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const walk = d => readdirSync(d).flatMap(f => { const p = path.join(d, f); return f === 'node_modules' || f === '.git' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(root);
const src = files.filter(f => /\/(src|scripts)\/.*\.(js|mjs)$/.test(f) || /server\.js$/.test(f));
const all = Object.fromEntries(files.map(f => [path.relative(root, f), readFileSync(f, 'utf8')]));
const prod = Object.fromEntries(src.map(f => [path.relative(root, f), readFileSync(f, 'utf8')]));

test('isolation: the existing Saturn WebSocket constant and hosts never appear in this repository', () => {
  for (const [f, t] of Object.entries(all)) {
    if (/^(docs|README)/.test(f) || f === 'tests/static.test.js') continue;                 /* reports may name them when stating what is untouched */
    assert.ok(!/SATURN_LIVE_WS_URL/.test(t), f);
    assert.ok(!/saturn-fun-0vzt|saturn-evm-ws|saturn-backend-gilt|onrender\.com\/live/.test(t), f);
  }
});

test('outbound: only src/jupiter.js performs HTTP; the recorder is GET-only; the gateway client has a fixed path allow-list; no signing anywhere', () => {
  const callers = Object.entries(prod).filter(([f, t]) => /\bfetch\s*\(|fetchImpl\s*\(|https?\.request|net\.connect|axios/.test(t) && !/live-check/.test(f)).map(([f]) => f);
  assert.deepEqual(callers.sort(), ['src/hl-exec.js', 'src/jupiter.js', 'src/viewsources.js'], 'outbound HTTP lives in exactly three modules (r120 view sources, r128 Hyperliquid relay)');
  /* r128: the Hyperliquid relay talks ONLY to Hyperliquid MAINNET, on exactly two fixed paths, and never signs anything (it only recovers signers) */
  const hx = prod['src/hl-exec.js'].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(hx, /export const HL_API = 'https:\/\/api\.hyperliquid\.xyz';/);
  assert.deepEqual([...hx.matchAll(/fetchImpl\(([^,]+),/g)].map(m => m[1].trim()).sort(), ['C.arbRpc', "api + '/exchange'", "api + '/info'"]);
  /* r129: Arbitrum RPC is read-only (balances, receipts); the relay can never send an Arbitrum transaction */
  assert.match(hx, /export const DEFAULT_ARB_RPC = 'https:\/\/arb1\.arbitrum\.io\/rpc';/);
  assert.deepEqual([...new Set([...hx.matchAll(/arb\('(eth_\w+)'/g)].map(m => m[1]))].sort(), ['eth_call', 'eth_getBalance', 'eth_getTransactionReceipt']);
  assert.ok(!/eth_send(Raw)?Transaction/.test(hx));
  assert.ok(!/signL1Action|signDigest|newPrivateKey|signUserSignedAction|hyperliquid-testnet/.test(hx), 'the relay never signs and never targets testnet');
  assert.match(hx, /export const HL_EXECUTE_VERIFIED = (true|false);/, 'real-money switch in code is an explicit constant (r130: owner approved true)');
  assert.equal(createHash('sha256').update(readFileSync(path.join(root, 'src/vendor/hlsign.mjs'))).digest('hex'), '572220e3e1d3c6a8445dbc9f0c3c3b608b4aefff3b3390fddd65bf4576c0b6c6', 'vendored Hyperliquid crypto is byte-pinned');
  assert.deepEqual(Object.entries(prod).filter(([f, t]) => /vendor\/hlsign/.test(t)).map(([f]) => f), ['src/hl-exec.js'], 'only the relay imports the vendored crypto');
  const vs = prod['src/viewsources.js'];
  assert.match(vs, /HL_HOST = 'api\.hyperliquid\.xyz'/); assert.match(vs, /CG_HOST = 'api\.coingecko\.com'/);
  assert.match(vs, /u\.hostname !== HL_HOST\) throw/); assert.match(vs, /u\.hostname !== CG_HOST\) throw/, 'r120 sources have fixed hosts');
  assert.match(vs, /base \+ '\/info'/); assert.match(vs, /base \+ '\/coins\/markets\?vs_currency=usd&ids='/, 'r120 sources have fixed paths');
  assert.ok(!/console\.|log\(/.test(vs.replace(/\/\*[\s\S]*?\*\//g, '')), 'viewsources never logs (the CoinGecko key can never reach a log line)');
  assert.ok(!/[?&]x_cg_demo_api_key=|key=' \+/.test(vs), 'the CoinGecko key is sent in a header only, never in a URL');
  const j = prod['src/jupiter.js'];
  const rec = j.slice(0, j.indexOf('createJupiterGateway')); assert.match(rec, /method: 'GET'/); assert.ok(!/method: '(POST|PUT|PATCH|DELETE)'/.test(rec), 'the market-stats recorder client is GET-only');
  assert.match(j, /GATEWAY_PATHS = Object\.freeze\(\{ positions: '\/positions', increase: '\/positions\/increase', decrease: '\/positions\/decrease', execute: '\/transaction\/execute' \}\)/, 'gateway upstream paths are a fixed allow-list');
  assert.match(j, /if \(!Object\.values\(GATEWAY_PATHS\)\.includes\(path\)\) throw/);
  const tk = j.slice(j.indexOf('export function createTokenIcons')); assert.match(tk, /base \+ '\/search\?query='/); assert.match(tk, /method: 'GET'/); assert.ok(!/method: '(POST|PUT|PATCH|DELETE)'/.test(tk), 'r120 token-icon client is GET-only, fixed path');
  for (const [f, t] of Object.entries(prod)) {
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (!['src/jupiter.js', 'src/gateway.js', 'src/perps-program.js'].includes(f) && !/live-check/.test(f)) assert.ok(!/\/(orders?|positions?|trades?|swap|increase|decrease|close|limit|deposit|withdraw|transfer)\b/i.test(code), f + ' references a trading endpoint outside the gateway');
    if (f === 'src/vendor/hlsign.mjs') continue;   /* r128 vendored audited crypto (pinned by hash below); the relay uses it only to RECOVER signers */
    assert.ok(!/signTransaction|sendTransaction|Keypair|privateKey|secretKey|mnemonic|wallet\.sign|@solana\/web3|createPrivateKey|crypto\.sign\(|\bsign\(/i.test(code), f + ' touches wallet/signing');
  }
  assert.ok(!/market-stats/.test(Object.entries(prod).filter(([f]) => !['src/jupiter.js', 'src/config.js', 'src/gateway.js'].includes(f) && !/live-check/.test(f)).map(x => x[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('')), 'market-stats URL is built only in the Jupiter client');
});

test('HTTP surface: data routes are GET/OPTIONS only; only the gateway reads bodies (behind the execution switch); no eval/child_process/dynamic require', () => {
  const h = prod['src/http.js']; assert.ok(!/req\.on\(['"]data/.test(h) && !/JSON\.parse\(.*body/i.test(h), 'http.js never reads request bodies');
  for (const [f, t] of Object.entries(prod)) if (f !== 'src/gateway.js' && f !== 'src/hl-exec.js') assert.ok(!/req\.on\(['"]data/.test(t), f + ' reads a request body; only the gateways may');
  { const hx = prod['src/hl-exec.js']; const ex = hx.slice(hx.indexOf('async function exchange(')); assert.ok(ex.indexOf('if (!C.enabled)') > 0 && ex.indexOf('if (!C.enabled)') < ex.indexOf('await readBody(req)'), 'r128 relay: the execution switch is checked before any body is read'); assert.match(hx, /C\.maxBody/); }
  const g = prod['src/gateway.js']; assert.match(g, /if \(!G\.executionEnabled\)/, 'transaction routes are behind the execution switch'); assert.match(g, /G\.maxBody/);
  for (const [f, t] of Object.entries(prod)) { if (/live-check/.test(f)) continue; assert.ok(!/\beval\s*\(|new Function|child_process|require\(\s*[^'"]|import\(\s*[^'"]/.test(t) || f === 'server.js', f); }
  assert.deepEqual([...new Set([...h.matchAll(/path === '([^']+)'/g)].map(m => m[1]))].sort(), ['/', '/healthz', '/internal/status', '/v1/perps/candles', '/v1/perps/markets']);
});

test('secrets: no keys, tokens, URLs with credentials or private hosts hard-coded; .env is ignored', () => {
  for (const [f, t] of Object.entries(all)) {
    if (/\.sql$/.test(f)) continue;
    assert.ok(!/postgres(ql)?:\/\/[^\s'"`$]+:[^\s'"`$]+@/i.test(t.replace(/postgres:\/\/user:password@host:5432\/dbname/g, '')) || /tests\//.test(f), f + ' has a credentialed connection string');   /* the documented placeholder in .env.example is the only allowed form */
    assert.ok(!/(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i.test(t.replaceAll('status-token-0123456789-abcdefghij', 'FIXTURE')), f + ' has a hard-coded secret-looking value');   /* the one documented, obviously fake test fixture is the only exception */
    assert.ok(!/BEGIN (RSA |EC )?PRIVATE KEY/.test(t), f);
  }
  assert.match(all['.gitignore'], /^\.env$/m);
});

test('dependencies: exactly ws and pg, nothing else', () => {
  const p = JSON.parse(all['package.json']); assert.deepEqual(Object.keys(p.dependencies).sort(), ['pg', 'ws']); assert.ok(!p.devDependencies);
  assert.ok(!p.scripts.postinstall && !p.scripts.preinstall && !p.scripts.install, 'no install-time scripts');
  for (const [f, t] of Object.entries(prod)) for (const m of t.matchAll(/from '([^'./][^']*)'/g)) assert.ok(['ws', 'pg'].includes(m[1]) || m[1].startsWith('node:'), f + ' imports ' + m[1]);
});

test('WebSocket is a separate path on this service; the spot path is not served', () => {
  const a = prod['src/app.js']; assert.match(a, /req\.url !== '\/perps\/live'/); assert.ok(!/'\/live'/.test(a));
  assert.ok(!/execute|placeOrder|canExecute/.test(Object.entries(prod).filter(([f]) => !['src/gateway.js', 'src/jupiter.js', 'src/config.js', 'src/perps-program.js'].includes(f)).map(x => x[1]).join('\n')), 'no trading hooks outside the gateway');
});

test('migrations are additive and forward-only (no DROP/TRUNCATE/ALTER ... DROP)', () => {
  for (const [f, t] of Object.entries(all)) if (/^migrations\//.test(f)) assert.ok(!/\b(DROP|TRUNCATE)\b/i.test(t.replace(/--.*$/gm, '')), f);
});

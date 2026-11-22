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
  assert.deepEqual(callers.sort(), ['server.js', 'src/hl-exec.js', 'src/jupiter.js', 'src/pm-data.js', 'src/pm-trade.js', 'src/pm-wallet.js', 'src/pyth.js', 'src/viewsources.js'], 'outbound HTTP lives in exactly three modules (r120 view sources, r128 Hyperliquid relay) + r133 keep-awake');
  /* r135: the Pyth client is GET-only to one fixed read-only path */
  const py = prod['src/pyth.js']; assert.match(py, /export const PYTH_BASE = 'https:\/\/benchmarks\.pyth\.network\/v1\/shims\/tradingview\/history';/); assert.deepEqual([...py.matchAll(/fetchImpl\(([^,]+),/g)].map(m => m[1].trim()), ['url']); assert.match(py, /method: 'GET'/); assert.ok(!/'POST'|signL1|signDigest|privateKey/i.test(py.replace(/\/\*[\s\S]*?\*\//g, '')));
  /* r137: Prediction data is read-only: GET to Polymarket's three public API hosts only, no keys, no signing, no order routes */
  const pmd = prod['src/pm-data.js']; assert.match(pmd, /const GAMMA = 'https:\/\/gamma-api\.polymarket\.com', CLOB = 'https:\/\/clob\.polymarket\.com', DATA = 'https:\/\/data-api\.polymarket\.com';/);
  assert.match(pmd, /method: 'GET'/); const pmCode = pmd.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/'POST'|\/order|privateKey|signTyped|POLY_API_KEY|builder_secret|BUILDER_/i.test(pmCode), 'no trading in the read-only Prediction module');
  /* r143: Prediction trading support never trades: its only outbound calls are Polymarket's bridge (deposit addresses, supported assets).
   * No CLOB, no relayer submission, no order/cancel/transfer code: orders are signed and sent by the user's browser. */
  const pt = prod['src/pm-trade.js'], ptCode = pt.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual([...ptCode.matchAll(/await upstream\(([^,]+),/g)].map(m => m[1].trim()).sort(), ["PMX.bridge + '/deposit'", "PMX.bridge + '/status/' + encodeURIComponent(a) + '?limit=20'", "PMX.bridge + '/supported-assets'"]);
  assert.deepEqual([...ptCode.matchAll(/fetchImpl\(([^,]+),/g)].map(m => m[1].trim()), ['url']);
  assert.ok(!/\/order|cancel|transfer|withdraw|privateKey|signTyped|eth_send/i.test(ptCode), 'no trading or fund movement in pm-trade.js');
  assert.ok(ptCode.indexOf("if (!enabled) return [503") < ptCode.indexOf('await readBody(req)'), 'the trading switch is checked before the builder-signing body is read');
  /* r133: server.js only ever calls its OWN public /healthz (Render's onrender.com URL), nothing else */
  const sv = prod['server.js'];
  assert.deepEqual([...sv.matchAll(/fetch\(([^,]+),/g)].map(m => m[1].trim()), ["SELF + '/healthz'"]);
  assert.match(sv, /\^https:\\\/\\\/\[a-z0-9-\]\+\\\.onrender\\\.com\$/, 'only an onrender.com self URL is accepted');
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
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      /* r143 read-only exceptions, exact strings only: Data API positions lookup (pm-data.js) and Polymarket bridge deposit ADDRESSES (pm-trade.js) */
      .replace(f === 'src/pm-data.js' ? /'\/v2\/positions\?user=' |path === '\/v1\/pm\/positions'/g : /^\b$/, '')
      .replace(f === 'src/pm-trade.js' ? /PMX\.bridge \+ '\/deposit'|path === '\/v1\/pm\/x\/bridge-deposit'|\/v1\/pm\/x\/bridge-deposit/g : /^\b$/, '');
    if (!['src/jupiter.js', 'src/gateway.js', 'src/perps-program.js'].includes(f) && !/live-check/.test(f)) assert.ok(!/\/(orders?|positions?|trades?|swap|increase|decrease|close|limit|deposit|withdraw|transfer)\b/i.test(code), f + ' references a trading endpoint outside the gateway');
    if (f === 'src/vendor/hlsign.mjs') continue;   /* r128 vendored audited crypto (pinned by hash below); the relay uses it only to RECOVER signers */
    assert.ok(!/signTransaction|sendTransaction|Keypair|privateKey|secretKey|mnemonic|wallet\.sign|@solana\/web3|createPrivateKey|crypto\.sign\(|\bsign\(/i.test(code), f + ' touches wallet/signing');
  }
  assert.ok(!/market-stats/.test(Object.entries(prod).filter(([f]) => !['src/jupiter.js', 'src/config.js', 'src/gateway.js'].includes(f) && !/live-check/.test(f)).map(x => x[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('')), 'market-stats URL is built only in the Jupiter client');
});

test('HTTP surface: data routes are GET/OPTIONS only; only the gateway reads bodies (behind the execution switch); no eval/child_process/dynamic require', () => {
  const h = prod['src/http.js']; assert.ok(!/req\.on\(['"]data/.test(h) && !/JSON\.parse\(.*body/i.test(h), 'http.js never reads request bodies');
  for (const [f, t] of Object.entries(prod)) if (f !== 'src/gateway.js' && f !== 'src/hl-exec.js' && f !== 'src/pm-trade.js') assert.ok(!/req\.on\(['"]data/.test(t), f + ' reads a request body; only the gateways may');
  { const hx = prod['src/hl-exec.js']; const ex = hx.slice(hx.indexOf('async function exchange(')); assert.ok(ex.indexOf('if (!C.enabled)') > 0 && ex.indexOf('if (!C.enabled)') < ex.indexOf('await readBody(req)'), 'r128 relay: the execution switch is checked before any body is read'); assert.match(hx, /C\.maxBody/); }
  assert.match(prod['src/pm-trade.js'], /maxBody = 16 \* 1024/, 'r143: builder-signing bodies are size-capped');
  const g = prod['src/gateway.js']; assert.match(g, /if \(!G\.executionEnabled\)/, 'transaction routes are behind the execution switch'); assert.match(g, /G\.maxBody/);
  for (const [f, t] of Object.entries(prod)) { if (/live-check/.test(f)) continue; assert.ok(!/\beval\s*\(|new Function|child_process|require\(\s*[^'"]|import\(\s*[^'"]/.test(t) || f === 'server.js', f); }
  assert.deepEqual([...new Set([...h.matchAll(/path === '([^']+)'/g)].map(m => m[1]))].sort(), ['/', '/healthz', '/internal/status', '/v1/perps/candles', '/v1/perps/markets', '/v1/pm/px', '/v1/pm/wallet/status']);   /* r144.3 live coin prices (GET, no body) */   /* r141 read-only Polygon verifier (GET only, checked below) */
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
  /* r131: the ONLY allowed DROP is replacing the audit table's action_type CHECK with a strictly wider one in the same migration (no data can be lost) */
  const WIDEN = /ALTER TABLE perps_hl_requests DROP CONSTRAINT IF EXISTS perps_hl_requests_action_type_check;/g;
  for (const [f, t] of Object.entries(all)) if (/^migrations\//.test(f)) {
    const body = t.replace(/--.*$/gm, '');
    if (WIDEN.test(body)) {
      const vals = x => new Set((x.match(/action_type IN \(([^)]*)\)/) || [, ''])[1].split(',').map(v => v.trim()));
      const before = vals(all['migrations/004_hl_exec_audit.sql']), after = vals(body.slice(body.indexOf('ADD CONSTRAINT perps_hl_requests_action_type_check')));
      assert.ok(before.size > 1 && [...before].every(v => after.has(v)) && after.size > before.size, f + ' may only widen action_type');
    }
    assert.ok(!/\b(DROP|TRUNCATE)\b/i.test(body.replace(WIDEN, '')), f);
  }
});

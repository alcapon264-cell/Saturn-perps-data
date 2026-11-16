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
  assert.deepEqual(callers.sort(), ['src/jupiter.js'], 'outbound HTTP lives in exactly one module');
  const j = prod['src/jupiter.js'];
  const rec = j.slice(0, j.indexOf('createJupiterGateway')); assert.match(rec, /method: 'GET'/); assert.ok(!/method: '(POST|PUT|PATCH|DELETE)'/.test(rec), 'the market-stats recorder client is GET-only');
  assert.match(j, /GATEWAY_PATHS = Object\.freeze\(\{ positions: '\/positions', increase: '\/positions\/increase', decrease: '\/positions\/decrease', execute: '\/transaction\/execute' \}\)/, 'gateway upstream paths are a fixed allow-list');
  assert.match(j, /if \(!Object\.values\(GATEWAY_PATHS\)\.includes\(path\)\) throw/);
  for (const [f, t] of Object.entries(prod)) {
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (!['src/jupiter.js', 'src/gateway.js', 'src/perps-program.js'].includes(f) && !/live-check/.test(f)) assert.ok(!/\/(orders?|positions?|trades?|swap|increase|decrease|close|limit|deposit|withdraw|transfer)\b/i.test(code), f + ' references a trading endpoint outside the gateway');
    assert.ok(!/signTransaction|sendTransaction|Keypair|privateKey|secretKey|mnemonic|wallet\.sign|@solana\/web3|createPrivateKey|crypto\.sign\(|\bsign\(/i.test(code), f + ' touches wallet/signing');
  }
  assert.ok(!/market-stats/.test(Object.entries(prod).filter(([f]) => !['src/jupiter.js', 'src/config.js', 'src/gateway.js'].includes(f) && !/live-check/.test(f)).map(x => x[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('')), 'market-stats URL is built only in the Jupiter client');
});

test('HTTP surface: data routes are GET/OPTIONS only; only the gateway reads bodies (behind the execution switch); no eval/child_process/dynamic require', () => {
  const h = prod['src/http.js']; assert.ok(!/req\.on\(['"]data/.test(h) && !/JSON\.parse\(.*body/i.test(h), 'http.js never reads request bodies');
  for (const [f, t] of Object.entries(prod)) if (f !== 'src/gateway.js') assert.ok(!/req\.on\(['"]data/.test(t), f + ' reads a request body; only the gateway may');
  const g = prod['src/gateway.js']; assert.match(g, /if \(!G\.executionEnabled\)/, 'transaction routes are behind the execution switch'); assert.match(g, /G\.maxBody/);
  for (const [f, t] of Object.entries(prod)) { if (/live-check/.test(f)) continue; assert.ok(!/\beval\s*\(|new Function|child_process|require\(\s*[^'"]|import\(\s*[^'"]/.test(t) || f === 'server.js', f); }
  assert.deepEqual([...new Set([...h.matchAll(/path === '([^']+)'/g)].map(m => m[1]))].sort(), ['/', '/healthz', '/internal/status', '/v1/perps/candles', '/v1/perps/markets', '/v1/perps/readiness']);
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

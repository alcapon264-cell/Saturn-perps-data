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

test('read-only: the only outbound call is one GET to the fixed Jupiter host; no write verbs, no order/position endpoints', () => {
  const callers = Object.entries(prod).filter(([f, t]) => /\bfetch\s*\(|fetchImpl\s*\(|https?\.request|net\.connect|axios/.test(t) && !/live-check/.test(f)).map(([f]) => f);
  assert.deepEqual(callers.sort(), ['src/jupiter.js'], 'outbound HTTP lives in exactly one module');
  const j = prod['src/jupiter.js']; assert.match(j, /method: 'GET'/); assert.ok(!/method: '(POST|PUT|PATCH|DELETE)'/.test(j));
  for (const [f, t] of Object.entries(prod)) {
    assert.ok(!/\/(orders?|positions?|trades?|swap|increase|decrease|close|limit|deposit|withdraw|transfer)\b/i.test(t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')) || /live-check/.test(f), f + ' references a trading endpoint');
    assert.ok(!/signTransaction|sendTransaction|Keypair|privateKey|secretKey|mnemonic|wallet\.sign|@solana\/web3/i.test(t), f + ' touches wallet/signing');
  }
  assert.ok(!/market-stats/.test(Object.entries(prod).filter(([f]) => f !== 'src/jupiter.js' && f !== 'src/config.js' && !/live-check/.test(f)).map(x => x[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('')), 'market-stats URL is built only in the Jupiter client');
});

test('HTTP surface: only GET/OPTIONS routes; no body parsing; no eval/child_process/dynamic require', () => {
  const h = prod['src/http.js']; assert.ok(!/req\.on\(['"]data/.test(h) && !/JSON\.parse\(.*body/i.test(h), 'request bodies are never read');
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
  assert.ok(!/execute|placeOrder|canExecute/.test(Object.values(prod).join('\n')), 'no trading hooks in the service');
});

test('migrations are additive and forward-only (no DROP/TRUNCATE/ALTER ... DROP)', () => {
  for (const [f, t] of Object.entries(all)) if (/^migrations\//.test(f)) assert.ok(!/\b(DROP|TRUNCATE)\b/i.test(t.replace(/--.*$/gm, '')), f);
});

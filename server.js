import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, validateConfig } from './src/config.js';
import { createPgDb } from './src/db.js';
import { createApp } from './src/app.js';

const cfg = loadConfig();
const errs = validateConfig(cfg);
if (errs.length) { console.error('[saturn-perps-data] configuration errors: ' + errs.join('; ')); process.exit(1); }

const [{ default: pg }, { WebSocketServer }] = await Promise.all([import('pg'), import('ws')]);
const ssl = process.env.PGSSL === 'require';
const db = createPgDb({ Pool: pg.Pool, Client: pg.Client, connectionString: cfg.databaseUrl, ssl });
const readerDb = cfg.readerDatabaseUrl ? createPgDb({ Pool: pg.Pool, Client: pg.Client, connectionString: cfg.readerDatabaseUrl, ssl }) : null;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationFiles = readdirSync(dir).filter(f => f.endsWith('.sql')).map(name => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));

const app = createApp({ cfg, db, readerDb, WebSocketServer, migrationFiles });
app.start().catch(e => { console.error('[saturn-perps-data] startup_failed:', e && e.message); process.exit(1); });
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; app.shutdown().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);

/* r133 keep-awake: Render's free plan stops this service after 15 min without inbound traffic, so the recorder stops and every chart gets holes.
 * While running on Render (RENDER_EXTERNAL_URL is set by Render itself) the service calls its OWN public /healthz every 10 min through Render's
 * edge, which counts as inbound traffic. Only its own URL, no data sent. Set KEEP_AWAKE=0 to turn it off. */
const SELF = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(SELF) && process.env.KEEP_AWAKE !== '0') {
  const ping = () => fetch(SELF + '/healthz', { headers: { 'user-agent': 'saturn-perps-keepawake' }, signal: AbortSignal.timeout(15000) }).then(r => r.body?.cancel?.()).catch(() => {});
  setInterval(ping, 10 * 60 * 1000).unref(); setTimeout(ping, 60 * 1000).unref();
  console.log('[saturn-perps-data] keep-awake on: ' + SELF + '/healthz every 10 min');
}

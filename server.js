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

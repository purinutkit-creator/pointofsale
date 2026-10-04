import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

let db;

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  d.pragma('synchronous = NORMAL');
  migrate(d);
  return d;
}

function migrate(d) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  const done = new Set(d.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    d.transaction(() => {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
    })();
    if (!config.isTest) console.log(`[db] migrated ${f}`);
  }
}

export function initDb(file) {
  db = openDb(file);
  return db;
}

/** Replace the live connection (used by restore). */
export function swapDb(next) {
  const old = db;
  db = next;
  try { old?.close(); } catch { /* ignore */ }
}

export const getDb = () => db;

// ── tiny query helpers ─────────────────────────────────────────────────────
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s || s.database !== db) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
export const one = (sql, ...params) => stmt(sql).get(...params);
export const all = (sql, ...params) => stmt(sql).all(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);
// Transactions with post-commit hooks (socket emits, notifications, e-mails …)
let depth = 0;
const deferred = [];
export function tx(fn) {
  depth++;
  try {
    const r = db.transaction(fn)();
    depth--;
    if (depth === 0) flushDeferred();
    return r;
  } catch (e) {
    depth--;
    if (depth === 0) deferred.length = 0;
    throw e;
  }
}
/** Run `fn` after the outermost transaction commits (immediately when not in a transaction). */
export function afterCommit(fn) {
  if (depth > 0) deferred.push(fn);
  else setImmediate(() => safe(fn));
}
function flushDeferred() {
  const list = deferred.splice(0);
  setImmediate(() => list.forEach(safe));
}
function safe(fn) { try { const r = fn(); if (r?.catch) r.catch((e) => console.error('[afterCommit]', e)); } catch (e) { console.error('[afterCommit]', e); } }

/** INSERT helper from an object; returns lastInsertRowid. */
export function insert(table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return run(sql, ...keys.map((k) => normalize(obj[k]))).lastInsertRowid;
}

/** UPDATE helper from an object. */
export function update(table, id, obj, idCol = 'id') {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`;
  return run(sql, ...keys.map((k) => normalize(obj[k])), id).changes;
}

function normalize(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export const json = (v, fallback = null) => {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

export const nowIso = () => new Date().toISOString();
/** SQLite datetime('now') compatible UTC string */
export const sqlNow = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);

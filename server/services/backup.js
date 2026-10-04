// Backup / Restore using SQLite's online backup API (consistent snapshot while running).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { getDb, swapDb, openDb, insert, all, run } from '../db/index.js';
import { getSetting } from './settings.js';

export async function createBackup(kind = 'manual', staffId = null) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `pos-${kind}-${stamp}.db`;
  const target = path.join(config.backupDir, filename);
  await getDb().backup(target);
  const size = fs.statSync(target).size;
  insert('backups', { filename, size, kind, staff_id: staffId });
  pruneBackups();
  return { filename, size };
}

export function listBackups() {
  return all('SELECT * FROM backups ORDER BY id DESC').filter((b) => fs.existsSync(path.join(config.backupDir, b.filename)));
}

export function backupPath(filename) {
  const safe = path.basename(filename);
  const p = path.join(config.backupDir, safe);
  if (!fs.existsSync(p)) return null;
  return p;
}

function pruneBackups() {
  const keep = Number(getSetting('backup').keep) || 14;
  const autos = all("SELECT * FROM backups WHERE kind = 'auto' ORDER BY id DESC");
  for (const b of autos.slice(keep)) {
    try { fs.unlinkSync(path.join(config.backupDir, b.filename)); } catch { /* already gone */ }
    run('DELETE FROM backups WHERE id = ?', b.id);
  }
}

/** Validate an uploaded SQLite file and swap it in (a pre-restore backup is taken first). */
export async function restoreFrom(filePath, staffId) {
  let probe;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const ok = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orders','staff','settings','schema_migrations')").all().length === 4;
    const integrity = probe.pragma('integrity_check', { simple: true });
    if (!ok || integrity !== 'ok') throw new Error('ไฟล์สำรองข้อมูลไม่ถูกต้องหรือเสียหาย');
  } finally {
    probe?.close();
  }
  await createBackup('pre_restore', staffId);
  const db = getDb();
  db.pragma('wal_checkpoint(TRUNCATE)');
  swapDb(null);
  fs.copyFileSync(filePath, config.dbFile);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(config.dbFile + ext); } catch { /* none */ } }
  swapDb(openDb(config.dbFile));
}

let lastAutoDate = null;
export function scheduleAutoBackup() {
  setInterval(() => {
    try {
      const s = getSetting('backup');
      if (!s.auto) return;
      const now = new Date();
      const local = new Date(now.toLocaleString('en-US', { timeZone: getSetting('shop').timezone }));
      const day = local.toISOString().slice(0, 10);
      if (local.getHours() === Number(s.hour ?? 3) && lastAutoDate !== day) {
        lastAutoDate = day;
        createBackup('auto').catch((e) => console.error('[backup]', e));
      }
    } catch (e) { console.error('[backup]', e.message); }
  }, 60_000);
}

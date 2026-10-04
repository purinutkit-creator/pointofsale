import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Express "trust proxy": "true"/"false", a hop count ("1"), or IP/subnet names. */
function parseTrustProxy(v) {
  if (v == null || v === '') return 'loopback';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export const config = {
  root,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  get dbFile() { return path.join(this.dataDir, 'pos.db'); },
  get backupDir() { return path.join(this.dataDir, 'backups'); },
  fontsDir: path.join(root, 'assets', 'fonts'),
  clientDist: path.join(root, 'client', 'dist'),
  // public URL used in receipt QR codes (claim points) and member links
  publicUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  memberSessionDays: Number(process.env.MEMBER_SESSION_DAYS) || 60,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // LAN printer jobs are printed directly by the server process when enabled
  serverPrinting: process.env.SERVER_PRINTING !== '0',
  isTest: process.env.NODE_ENV === 'test',
};

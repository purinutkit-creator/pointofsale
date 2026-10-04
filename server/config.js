import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  publicUrl: process.env.PUBLIC_URL || '',
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  memberSessionDays: Number(process.env.MEMBER_SESSION_DAYS) || 60,
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  // LAN printer jobs are printed directly by the server process when enabled
  serverPrinting: process.env.SERVER_PRINTING !== '0',
  isTest: process.env.NODE_ENV === 'test',
};

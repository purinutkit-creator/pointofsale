// Staff notifications (bell in back-office / POS) — persisted + pushed in real time.
import { insert, one } from '../db/index.js';

let emitter = null;
export const setNotifyEmitter = (fn) => { emitter = fn; };

export function notifyStaff(branchId, kind, level, title, body = '', data = null, dedupeKey = null) {
  try {
    if (dedupeKey && one('SELECT id FROM notifications WHERE dedupe_key = ?', dedupeKey)) return null;
    const id = insert('notifications', { branch_id: branchId, kind, level, title, body, data, dedupe_key: dedupeKey });
    const n = { id, branch_id: branchId, kind, level, title, body, data, created_at: new Date().toISOString() };
    emitter?.(branchId, 'notification', n);
    return n;
  } catch (e) {
    console.error('[notify]', e.message);
    return null;
  }
}

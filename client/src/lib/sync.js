// Offline outbox: mutations made while offline are stored in IndexedDB and replayed
// in order when the connection returns. Every replayed call is idempotent on the server
// (client UUIDs for orders/items, Idempotency keys for payments) → no duplicate orders.
import { api, NetworkError } from './api.js';
import { outboxAdd, outboxAll, outboxDelete, outboxPut } from './db.js';
import { useApp } from './store.js';
import { onConnection } from './socket.js';

let flushing = false;
let started = false;
const subscribers = new Set();
export const onSynced = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };

export async function refreshCount() {
  const list = await outboxAll();
  useApp.setState({ outboxCount: list.filter((x) => x.status === 'pending').length, syncErrors: list.filter((x) => x.status === 'error') });
}

/** Queue an API call for later replay. */
export async function enqueue(path, method, body, label) {
  await outboxAdd({ path, method, body, label });
  await refreshCount();
}

/** Call the API; when the network is down, queue it instead (returns {queued:true}). */
export async function callOrQueue(path, method, body, label) {
  if (useApp.getState().online) {
    try { return await api(path, { method, body }); } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      setOnline(false);
    }
  }
  await enqueue(path, method, body, label);
  return { queued: true };
}

export async function flush() {
  if (flushing || !useApp.getState().online) return;
  flushing = true;
  useApp.setState({ syncing: true });
  try {
    const list = (await outboxAll()).filter((x) => x.status === 'pending').sort((a, b) => a.seq - b.seq);
    for (const entry of list) {
      try {
        const res = await api(entry.path, { method: entry.method, body: entry.body });
        await outboxDelete(entry.seq);
        subscribers.forEach((fn) => fn(entry, res));
      } catch (e) {
        if (e instanceof NetworkError) { setOnline(false); break; }
        // business conflict (e.g. table occupied, sold out): keep for manual resolution, continue with the rest
        await outboxPut({ ...entry, status: 'error', error: e.message, code: e.code, failedAt: Date.now() });
        useApp.getState().toast(`Sync ไม่สำเร็จ: ${entry.label || entry.path} — ${e.message}`, 'error', 6000);
      }
    }
  } finally {
    flushing = false;
    useApp.setState({ syncing: false });
    await refreshCount();
  }
}

export async function retryEntry(seq) {
  const e = (await outboxAll()).find((x) => x.seq === seq);
  if (e) { await outboxPut({ ...e, status: 'pending', error: null }); await refreshCount(); flush(); }
}
export async function discardEntry(seq) { await outboxDelete(seq); await refreshCount(); }

function setOnline(v) {
  if (useApp.getState().online !== v) useApp.setState({ online: v });
  if (v) flush();
}

async function ping() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    setOnline(r.ok);
  } catch { setOnline(false); }
}

export function startSync() {
  if (started) return;
  started = true;
  window.addEventListener('online', ping);
  window.addEventListener('offline', () => setOnline(false));
  onConnection((c) => { useApp.setState({ socketConnected: c }); if (c) setOnline(true); else ping(); });
  setInterval(ping, 15000);
  setInterval(() => { if (useApp.getState().online) flush(); }, 10000);
  refreshCount();
  ping();
}

/** 🟢 Online · 🟠 Syncing · 🔴 Offline */
export function connectivity(s) {
  if (!s.online) return { key: 'offline', label: 'Offline', color: 'red' };
  if (s.syncing || s.outboxCount > 0) return { key: 'syncing', label: `Syncing${s.outboxCount ? ` (${s.outboxCount})` : ''}`, color: 'orange' };
  return { key: 'online', label: 'Online', color: 'green' };
}

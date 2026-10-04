// IndexedDB (offline storage): catalog snapshot, outbox of queued mutations, local orders, local print log.
import { openDB } from 'idb';

let dbp;
export function idb() {
  dbp ||= openDB('pos-offline', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('orders')) db.createObjectStore('orders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('printlog')) db.createObjectStore('printlog', { keyPath: 'id', autoIncrement: true });
    },
  });
  return dbp;
}
export const kvGet = async (k) => (await idb()).get('kv', k);
export const kvSet = async (k, v) => (await idb()).put('kv', v, k);
export const outboxAll = async () => (await idb()).getAll('outbox');
export const outboxAdd = async (entry) => (await idb()).add('outbox', { ...entry, createdAt: Date.now(), status: 'pending' });
export const outboxPut = async (entry) => (await idb()).put('outbox', entry);
export const outboxDelete = async (seq) => (await idb()).delete('outbox', seq);
export const localOrderPut = async (o) => (await idb()).put('orders', o);
export const localOrderGet = async (id) => (await idb()).get('orders', id);
export const localOrderDelete = async (id) => (await idb()).delete('orders', id);
export const localOrdersAll = async () => (await idb()).getAll('orders');

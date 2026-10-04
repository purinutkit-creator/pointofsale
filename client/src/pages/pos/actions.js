// POS actions that work online (server authoritative) and offline (local print + outbox replay).
import { api, uid, NetworkError } from '../../lib/api.js';
import { enqueue } from '../../lib/sync.js';
import { kvGet, kvSet } from '../../lib/db.js';
import { useApp, toast } from '../../lib/store.js';
import { usePos, fromServer, queueOrderPut, finishOfflineOrder } from './posStore.js';
import { printKitchenOffline, buildReceiptDocOffline } from './offlineDocs.js';
import { printAgent } from '../../hw/printing.js';
import { EscPos } from '@shared/escpos.js';

const isOffline = () => !useApp.getState().online || usePos.getState().order?.offline;

export async function sendKitchen() {
  const pos = usePos.getState();
  await pos.flushSave();
  const o = usePos.getState().order;
  if (!o) return;
  if (!isOffline()) {
    try {
      const r = await api(`/orders/${o.id}/send-kitchen`, { method: 'POST', body: {} });
      usePos.setState({ order: fromServer(r.order) });
      toast(`ส่งครัวแล้ว${r.jobs.length ? ` · ${r.jobs.length} ใบ` : ''}`, 'success');
      return r;
    } catch (e) { if (!(e instanceof NetworkError)) throw e; useApp.setState({ online: false }); }
  }
  // offline: print on this device's kitchen printers and queue the server call
  const drafts = o.items.filter((i) => i.status === 'draft');
  const n = await printKitchenOffline(o, drafts, pos.catalog);
  const updated = { ...o, items: o.items.map((i) => (i.status === 'draft' ? { ...i, status: 'sent', kitchenStatus: 'new' } : i)) };
  usePos.setState({ order: updated });
  await usePos.getState().saveOffline();
  await queueOrderPut({ ...updated, items: o.items }); // drafts must reach the server before send-kitchen
  await enqueue(`/orders/${o.id}/send-kitchen`, 'POST', { offlinePrinted: true }, `ส่งครัว ${o.queueNo || o.orderNo}`);
  toast(`Offline: พิมพ์ใบครัว ${n} ใบ และรอ Sync`, 'warning');
}

export async function holdOrder() {
  await usePos.getState().flushSave();
  const o = usePos.getState().order;
  if (!o) return;
  if (!isOffline()) {
    try {
      const r = await api(`/orders/${o.id}`, { method: 'PUT', body: { id: o.id, status: 'held' } });
      toast(`พักบิล ${r.queue_no || (r.table_number ? `โต๊ะ ${r.table_number}` : `#${r.order_no}`)}`, 'success');
      usePos.getState().closeOrder();
      return;
    } catch (e) { if (!(e instanceof NetworkError)) throw e; }
  }
  usePos.setState({ order: { ...o, status: 'held' } });
  await usePos.getState().saveOffline();
  toast('Offline: พักบิลไว้ในเครื่อง', 'warning');
  usePos.getState().closeOrder();
}

/**
 * Pay. Online → server transaction (idempotent). Offline → local receipt + kitchen print, queued for sync.
 * @returns result {receiptNo, change, offline?}
 */
export async function payOrder({ idempotencyKey, payments, partial, docType, customer, copies, print, memberVia }) {
  const pos = usePos.getState();
  await pos.flushSave();
  const o = usePos.getState().order;
  const body = { idempotencyKey, payments, partial: !!partial, docType, customer: customer || undefined, copies, print, memberVia };
  if (!isOffline()) {
    try {
      const r = await api(`/orders/${o.id}/pay`, { method: 'POST', body });
      return r;
    } catch (e) { if (!(e instanceof NetworkError)) throw e; useApp.setState({ online: false }); }
  }
  if (partial) throw new Error('การแบ่งชำระต้องเชื่อมต่อเซิร์ฟเวอร์');
  const totals = usePos.getState().totals();
  const due = totals.remaining;
  const sum = payments.reduce((a, p) => a + p.amount, 0);
  if (Math.round(sum * 100) < Math.round(due * 100)) throw new Error('ยอดชำระยังไม่ครบ');
  const { device, settings } = useApp.getState();
  const seq = ((await kvGet('offlineReceiptSeq')) || 0) + 1;
  await kvSet('offlineReceiptSeq', seq);
  const receiptNo = `OFF-${(device?.code || 'POS').replace(/[^A-Za-z0-9]/g, '')}-${String(seq).padStart(5, '0')}`;
  // kitchen for unsent items
  const drafts = o.items.filter((i) => i.status === 'draft');
  if (drafts.length) await printKitchenOffline(o, drafts, pos.catalog);
  const change = payments.reduce((a, p) => a + (p.method === 'cash' && p.tendered ? p.tendered - p.amount : 0), 0);
  const received = payments.filter((p) => p.method === 'cash').reduce((a, p) => a + (p.tendered ?? p.amount), 0);
  const rc = settings.receipt || {};
  const n = copies ?? rc.copies ?? 1;
  let printed = false;
  const printer = printAgent.localPrinters('receipt')[0];
  if (printer && (rc.printMode === 'auto' || print)) {
    for (let c = 1; c <= n; c++) {
      try {
        await printAgent.printLocal(printer.id, buildReceiptDocOffline(o, totals, { receiptNo, payments: payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })), received: received || null, change, docType, customer, copy: { n: c, of: n } }), 'receipt');
        printed = true;
      } catch (e) { toast(`พิมพ์ใบเสร็จไม่สำเร็จ: ${e.message}`, 'error'); }
    }
    if (printer.has_drawer && payments.some((p) => p.method === 'cash')) printAgent.sendBytes(printer.id, new EscPos().init().drawer(printer.drawer_pin || 0).bytes()).catch(() => {});
  }
  await queueOrderPut(o);
  await enqueue(`/orders/${o.id}/pay`, 'POST', { ...body, offline: { receiptNo, paidAt: new Date().toISOString(), receiptPrinted: printed, kitchenPrinted: true } }, `ชำระเงิน ${receiptNo}`);
  usePos.setState({ order: { ...o, status: 'paid', items: o.items.map((i) => (i.status === 'draft' ? { ...i, status: 'sent' } : i)) } });
  await finishOfflineOrder(o.id);
  return { receiptNo, change, total: totals.total, offline: true, member: null };
}

export const newKey = () => `pay-${uid()}`;

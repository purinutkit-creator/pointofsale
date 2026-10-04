// Print queue: every print (receipt, kitchen sub-ticket, shift report, drawer kick, test)
// becomes a row in print_jobs. Jobs are executed by a print agent:
//   - LAN printers → server worker (server/print/worker.js) or Local Print Bridge
//   - Bluetooth (BLE / Classic) / USB / Serial printers → the POS browser that hosts the printer
// Retry/reprint re-uses the stored document payload, so it never creates orders or payments.
import { one, all, insert, run, afterCommit, json, sqlNow } from '../db/index.js';
import { uuid } from '../lib/security.js';
import { emitBranch } from '../realtime.js';
import { getSetting } from './settings.js';
import { notifyStaff } from './notify.js';

export function createPrintJob({ branchId, printerId, orderId = null, docType, payload, stationId = null, subTicketId = null, subIndex = null, subCount = null, copyIndex = 1, copyCount = 1, receiptId = null, reprintOf = null, staffId = null, status = 'waiting' }) {
  const jobUid = uuid();
  const id = insert('print_jobs', {
    job_uid: jobUid, branch_id: branchId, printer_id: printerId, order_id: orderId, doc_type: docType, payload,
    station_id: stationId, sub_ticket_id: subTicketId, sub_index: subIndex, sub_count: subCount,
    copy_index: copyIndex, copy_count: copyCount, receipt_id: receiptId, reprint_of: reprintOf, created_by: staffId, status,
    printed_at: status === 'printed' ? sqlNow() : null,
  });
  afterCommit(() => emitBranch(branchId, 'print:job', { id, printerId, docType, orderId, status }));
  return id;
}

export function shapeJob(j) {
  return j && { ...j, payload: json(j.payload, {}) };
}

/** Receipt printer for a device: device config → printer hosted by device → first receipt printer of branch. */
export function receiptPrinterFor(branchId, deviceId) {
  if (deviceId) {
    const dev = one('SELECT config FROM pos_devices WHERE id = ?', deviceId);
    const cfg = json(dev?.config, {});
    if (cfg.receiptPrinterId) {
      const p = one('SELECT * FROM printers WHERE id = ? AND active = 1', cfg.receiptPrinterId);
      if (p) return p;
    }
    const hosted = one("SELECT * FROM printers WHERE branch_id = ? AND host_device_id = ? AND role = 'receipt' AND active = 1 ORDER BY id LIMIT 1", branchId, deviceId);
    if (hosted) return hosted;
  }
  return one("SELECT * FROM printers WHERE branch_id = ? AND role = 'receipt' AND active = 1 ORDER BY id LIMIT 1", branchId);
}

/** Kitchen printers + copies for a station (or explicit printer override). */
export function kitchenTargets(branchId, stationId, printerOverrideId) {
  if (printerOverrideId) {
    const p = one('SELECT * FROM printers WHERE id = ? AND active = 1', printerOverrideId);
    if (!p) return [];
    const r = one("SELECT copies FROM printer_routes WHERE printer_id = ? AND station_id IS ? AND doc_type = 'kitchen'", p.id, stationId);
    return [{ printer: p, copies: r ? r.copies : p.kitchen_copies }];
  }
  if (!stationId) return [];
  return all(`SELECT p.*, r.copies AS route_copies FROM printer_routes r JOIN printers p ON p.id = r.printer_id
              WHERE r.station_id = ? AND r.doc_type = 'kitchen' AND p.active = 1 AND p.branch_id = ?`, stationId, branchId)
    .map((p) => ({ printer: p, copies: p.route_copies ?? p.kitchen_copies }));
}

/** Claim a waiting job atomically (prevents two agents printing the same job). */
export function claimJob(jobId, agent) {
  const ch = run(`UPDATE print_jobs SET status = 'printing', claimed_by = ?, claimed_at = datetime('now'), attempts = attempts + 1
                  WHERE id = ? AND status = 'waiting'`, agent, jobId).changes;
  if (!ch) return null;
  const j = one('SELECT * FROM print_jobs WHERE id = ?', jobId);
  emitBranch(j.branch_id, 'print:job', { id: j.id, printerId: j.printer_id, status: 'printing' });
  return shapeJob(j);
}

export function finishJob(jobId, { ok, error }) {
  const j = one('SELECT * FROM print_jobs WHERE id = ?', jobId);
  if (!j || j.status !== 'printing') return j;
  if (ok) {
    run("UPDATE print_jobs SET status = 'printed', error = NULL, printed_at = datetime('now') WHERE id = ?", jobId);
    if (j.receipt_id && j.doc_type === 'receipt') run('UPDATE receipts SET print_count = print_count + 1 WHERE id = ?', j.receipt_id);
  } else {
    run("UPDATE print_jobs SET status = 'failed', error = ? WHERE id = ?", String(error || 'unknown error').slice(0, 500), jobId);
    const p = one('SELECT name FROM printers WHERE id = ?', j.printer_id);
    const label = { receipt: 'ใบเสร็จ', kitchen: 'ใบครัว', kitchen_void: 'ใบยกเลิกครัว', shift_report: 'รายงานกะ', drawer: 'เปิดลิ้นชัก', test: 'ทดสอบ' }[j.doc_type] || j.doc_type;
    notifyStaff(j.branch_id, 'print_failed', 'error', `ไม่สามารถพิมพ์${label}ได้`, `เครื่องพิมพ์ ${p?.name || '-'}: ${error || ''}`, { jobId, printerId: j.printer_id, orderId: j.order_id });
  }
  const out = one('SELECT * FROM print_jobs WHERE id = ?', jobId);
  emitBranch(j.branch_id, 'print:job', { id: jobId, printerId: j.printer_id, status: out.status, error: out.error, orderId: j.order_id, docType: j.doc_type });
  return out;
}

/** Retry: put a failed/cancelled job back in the queue (same payload → no new order/payment). */
export function retryJob(jobId) {
  const j = one('SELECT * FROM print_jobs WHERE id = ?', jobId);
  if (!j) return null;
  run("UPDATE print_jobs SET status = 'waiting', error = NULL, claimed_by = NULL WHERE id = ? AND status IN ('failed','cancelled','printing')", jobId);
  emitBranch(j.branch_id, 'print:job', { id: jobId, printerId: j.printer_id, status: 'waiting' });
  return one('SELECT * FROM print_jobs WHERE id = ?', jobId);
}

export function cancelJob(jobId) {
  const j = one('SELECT * FROM print_jobs WHERE id = ?', jobId);
  if (!j) return null;
  run("UPDATE print_jobs SET status = 'cancelled' WHERE id = ? AND status IN ('waiting','failed','printing')", jobId);
  emitBranch(j.branch_id, 'print:job', { id: jobId, printerId: j.printer_id, status: 'cancelled' });
  return one('SELECT * FROM print_jobs WHERE id = ?', jobId);
}

/** Reprint: new job with the same document (flagged reprint), linked to the original. */
export function reprintJob(jobId, staffId, printerId = null) {
  const j = one('SELECT * FROM print_jobs WHERE id = ?', jobId);
  if (!j) return null;
  const payload = { ...json(j.payload, {}), reprint: true };
  return createPrintJob({
    branchId: j.branch_id, printerId: printerId || j.printer_id, orderId: j.order_id, docType: j.doc_type, payload,
    stationId: j.station_id, subTicketId: j.sub_ticket_id, subIndex: j.sub_index, subCount: j.sub_count,
    copyIndex: j.copy_index, copyCount: j.copy_count, receiptId: j.receipt_id, reprintOf: j.id, staffId,
  });
}

/** Stale "printing" jobs (agent died mid-print) → failed so staff can decide to retry. */
export function failStaleJobs() {
  for (const j of all("SELECT id FROM print_jobs WHERE status = 'printing' AND claimed_at < datetime('now', '-90 seconds')")) {
    finishJob(j.id, { ok: false, error: 'หมดเวลา (เครื่องพิมพ์ไม่ตอบสนอง)' });
  }
}

export function shopHeader(branchId) {
  const shop = getSetting('shop');
  const rc = getSetting('receipt', branchId);
  const b = one('SELECT * FROM branches WHERE id = ?', branchId) || {};
  return {
    name: shop.name, logoUrl: shop.logoUrl, address: b.address || shop.address, phone: b.phone || shop.phone,
    taxId: b.tax_id || shop.taxId, branchName: b.name ? `${b.name}${b.tax_branch ? ` (สาขา ${b.tax_branch})` : ''}` : '',
    header: rc.header, footer: rc.footer, social: rc.social, promotion: rc.promotion, qrText: rc.qrText, qrLabel: rc.qrLabel,
  };
}

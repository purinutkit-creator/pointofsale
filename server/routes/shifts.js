import { Router } from 'express';
import { z } from 'zod';
import { one, all, run, insert, tx, json } from '../db/index.js';
import { parse, notFound, bad, conflict, forbidden } from '../lib/errors.js';
import { requireStaff, requirePerm, gate, hasPerm } from '../middleware/auth.js';
import { createPrintJob, receiptPrinterFor } from '../services/printing.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { emitBranch } from '../realtime.js';

const r = Router();
r.use(requireStaff);

/**
 * Expected Cash = Opening Cash + Cash Sales + Cash In − Cash Refund − Cash Out
 */
export function shiftSummary(shiftId) {
  const s = one(`SELECT sh.*, COALESCE(st.nickname, st.first_name) AS staff_name, st.employee_code, d.name AS device_name, b.name AS branch_name
                 FROM shifts sh JOIN staff st ON st.id = sh.staff_id LEFT JOIN pos_devices d ON d.id = sh.device_id JOIN branches b ON b.id = sh.branch_id WHERE sh.id = ?`, shiftId);
  if (!s) return null;
  const pay = all("SELECT method, SUM(amount) amount FROM payment_transactions WHERE shift_id = ? AND kind = 'sale' GROUP BY method", shiftId);
  const refunds = all("SELECT method, SUM(-amount) amount FROM payment_transactions WHERE shift_id = ? AND kind = 'refund' GROUP BY method", shiftId);
  const cash = (rows) => Number(rows.find((x) => x.method === 'cash')?.amount || 0);
  const mv = (type) => Number(one('SELECT IFNULL(SUM(amount),0) v FROM cash_movements WHERE shift_id = ? AND type = ?', shiftId, type).v);
  const orders = one(`SELECT COUNT(*) n, IFNULL(SUM(subtotal),0) gross, IFNULL(SUM(discount),0) discount, IFNULL(SUM(service_charge),0) sc,
                             IFNULL(SUM(vat),0) vat, IFNULL(SUM(total),0) total FROM orders WHERE shift_id = ? AND status IN ('paid','refunded','partially_refunded')`, shiftId);
  const refundTotal = refunds.reduce((a, x) => a + Number(x.amount), 0);
  const r2 = (n) => Math.round(n * 100) / 100;
  const cashSales = cash(pay); const cashRefunds = cash(refunds); const cashIn = mv('cash_in'); const cashOut = mv('cash_out');
  const expected = r2(s.opening_cash + cashSales + cashIn - cashRefunds - cashOut);
  return {
    shift: s, orders: orders.n, grossSales: r2(orders.gross), discount: r2(orders.discount), serviceCharge: r2(orders.sc), vat: r2(orders.vat),
    netSales: r2(orders.total), refunds: r2(refundTotal), payments: pay.map((p) => ({ method: p.method, amount: r2(p.amount) })),
    openingCash: s.opening_cash, cashSales: r2(cashSales), cashIn: r2(cashIn), cashOut: r2(cashOut), cashRefunds: r2(cashRefunds), expectedCash: expected,
    actualCash: s.actual_cash, difference: s.difference, noSaleCount: one("SELECT COUNT(*) c FROM cash_movements WHERE shift_id = ? AND type = 'no_sale'", shiftId).c,
    movements: all('SELECT cm.*, COALESCE(st.nickname, st.first_name) AS staff_name FROM cash_movements cm JOIN staff st ON st.id = cm.staff_id WHERE shift_id = ? ORDER BY cm.id', shiftId),
  };
}

function reportDoc(sum) {
  const s = sum.shift;
  return {
    type: 'shift_report', shopName: getSetting('shop').name, branch: s.branch_name, staff: `${s.employee_code} ${s.staff_name}`, posName: s.device_name,
    openedAt: s.opened_at, closedAt: s.closed_at, tz: getSetting('shop').timezone, orders: sum.orders, grossSales: sum.grossSales, discount: sum.discount,
    serviceCharge: sum.serviceCharge, vat: sum.vat, netSales: sum.netSales, refunds: sum.refunds, payments: sum.payments, openingCash: sum.openingCash,
    cashSales: sum.cashSales, cashIn: sum.cashIn, cashOut: sum.cashOut, cashRefunds: sum.cashRefunds, expectedCash: sum.expectedCash,
    actualCash: s.actual_cash, difference: s.difference, note: s.note,
  };
}

r.get('/shifts/current', (req, res) => {
  const s = req.device
    ? one("SELECT * FROM shifts WHERE device_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", req.device.id)
    : one("SELECT * FROM shifts WHERE staff_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", req.staff.id);
  res.json({ shift: s ? shiftSummary(s.id) : null, required: !!getSetting('pos', req.staff.branchId).requireShift });
});

r.get('/shifts', (req, res) => {
  const all_ = hasPerm(req, 'shift.view_all');
  res.json(all(`SELECT sh.*, COALESCE(st.nickname, st.first_name) AS staff_name, st.employee_code, d.name AS device_name
                FROM shifts sh JOIN staff st ON st.id = sh.staff_id LEFT JOIN pos_devices d ON d.id = sh.device_id
                WHERE sh.branch_id = ? ${all_ ? '' : 'AND sh.staff_id = ?'} ORDER BY sh.id DESC LIMIT 200`, ...(all_ ? [req.staff.branchId] : [req.staff.branchId, req.staff.id])));
});
r.get('/shifts/:id', (req, res) => {
  const sum = shiftSummary(Number(req.params.id));
  if (!sum) throw notFound();
  if (sum.shift.staff_id !== req.staff.id && !hasPerm(req, 'shift.view_all')) throw forbidden();
  res.json(sum);
});

r.post('/shifts/open', requirePerm('shift.open_close'), (req, res) => {
  const b = parse(z.object({ openingCash: z.number().min(0).max(10_000_000), note: z.string().max(300).optional() }), req.body);
  const out = tx(() => {
    const existing = req.device ? one("SELECT id FROM shifts WHERE device_id = ? AND status = 'open'", req.device.id) : one("SELECT id FROM shifts WHERE staff_id = ? AND status = 'open'", req.staff.id);
    if (existing) throw conflict('มีกะที่เปิดอยู่แล้วบนเครื่องนี้', 'SHIFT_OPEN', { shiftId: existing.id });
    const id = insert('shifts', { branch_id: req.staff.branchId, device_id: req.device?.id ?? null, staff_id: req.staff.id, opening_cash: b.openingCash, note: b.note ?? null });
    audit(req, 'shift.open', { entity: 'shift', entityId: id, details: `opening ${b.openingCash}` });
    return shiftSummary(id);
  });
  emitBranch(req.staff.branchId, 'shift:changed', { shiftId: out.shift.id });
  res.json(out);
});

r.post('/shifts/:id/close', requirePerm('shift.open_close'), (req, res) => {
  const b = parse(z.object({ actualCash: z.number().min(0).max(10_000_000), note: z.string().max(300).optional(), print: z.boolean().optional() }), req.body);
  const out = tx(() => {
    const s = one('SELECT * FROM shifts WHERE id = ?', req.params.id);
    if (!s || s.branch_id !== req.staff.branchId) throw notFound();
    if (s.status !== 'open') throw conflict('กะนี้ปิดไปแล้ว');
    if (s.staff_id !== req.staff.id && !hasPerm(req, 'shift.view_all')) throw forbidden('ปิดได้เฉพาะกะของตัวเอง');
    const sum = shiftSummary(s.id);
    const diff = Math.round((b.actualCash - sum.expectedCash) * 100) / 100;
    run(`UPDATE shifts SET status = 'closed', closed_by = ?, closed_at = datetime('now'), expected_cash = ?, actual_cash = ?, difference = ?, note = COALESCE(?, note), summary = ? WHERE id = ?`,
      req.staff.id, sum.expectedCash, b.actualCash, diff, b.note ?? null, JSON.stringify({ ...sum, shift: undefined, movements: undefined }), s.id);
    audit(req, 'shift.close', { entity: 'shift', entityId: s.id, details: `expected ${sum.expectedCash} actual ${b.actualCash} diff ${diff}` });
    const final = shiftSummary(s.id);
    let jobId = null;
    if (b.print !== false) {
      const p = receiptPrinterFor(s.branch_id, req.device?.id);
      if (p) jobId = createPrintJob({ branchId: s.branch_id, printerId: p.id, docType: 'shift_report', payload: reportDoc(final), staffId: req.staff.id });
    }
    return { ...final, jobId };
  });
  emitBranch(req.staff.branchId, 'shift:changed', { shiftId: out.shift.id });
  res.json(out);
});

r.post('/shifts/:id/print', (req, res) => {
  const sum = shiftSummary(Number(req.params.id));
  if (!sum) throw notFound();
  const p = receiptPrinterFor(sum.shift.branch_id, req.device?.id);
  if (!p) throw bad('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ใบเสร็จ');
  res.json({ jobId: createPrintJob({ branchId: sum.shift.branch_id, printerId: p.id, docType: 'shift_report', payload: reportDoc(sum), staffId: req.staff.id }) });
});
r.get('/shifts/:id/doc', (req, res) => {
  const sum = shiftSummary(Number(req.params.id));
  if (!sum) throw notFound();
  res.json(reportDoc(sum));
});

// Cash In / Cash Out
r.post('/cash-movements', (req, res) => {
  const b = parse(z.object({ type: z.enum(['cash_in', 'cash_out']), amount: z.number().positive().max(10_000_000), reason: z.string().min(1).max(200) }), req.body);
  const out = tx(() => {
    const shift = req.device ? one("SELECT * FROM shifts WHERE device_id = ? AND status = 'open'", req.device.id) : one("SELECT * FROM shifts WHERE staff_id = ? AND status = 'open'", req.staff.id);
    if (!shift) throw conflict('กรุณาเปิดกะก่อน', 'SHIFT_REQUIRED');
    let g = { approvalId: null, approvedBy: null };
    if (b.type === 'cash_out') g = gate(req, 'cash_out', { perm: 'payment.cash_out' });
    else if (!hasPerm(req, 'payment.cash_in')) throw forbidden('ไม่มีสิทธิ์ Cash In');
    const id = insert('cash_movements', { branch_id: req.staff.branchId, shift_id: shift.id, device_id: req.device?.id ?? null, staff_id: req.staff.id, type: b.type, amount: b.amount, reason: b.reason, approval_id: g.approvalId });
    audit(req, b.type === 'cash_in' ? 'cash.in' : 'cash.out', { entity: 'shift', entityId: shift.id, details: `${b.amount}: ${b.reason}`, approvedBy: g.approvedBy });
    const p = receiptPrinterFor(req.staff.branchId, req.device?.id);
    if (p?.has_drawer) createPrintJob({ branchId: req.staff.branchId, printerId: p.id, docType: 'drawer', payload: { type: 'drawer' }, staffId: req.staff.id });
    if (p) createPrintJob({ branchId: req.staff.branchId, printerId: p.id, docType: 'slip', staffId: req.staff.id, payload: {
      type: 'slip', title: b.type === 'cash_in' ? 'นำเงินเข้า (Cash In)' : 'นำเงินออก (Cash Out)', tz: getSetting('shop').timezone, time: new Date().toISOString(),
      rows: [['จำนวนเงิน', b.amount.toFixed(2), true], ['เหตุผล', b.reason], ['พนักงาน', req.staff.code]],
    } });
    return { id };
  });
  res.json(out);
});

export default r;

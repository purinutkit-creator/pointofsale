import { Router } from 'express';
import { z } from 'zod';
import { one, all, json } from '../db/index.js';
import { parse, notFound, bad } from '../lib/errors.js';
import { requireStaff, requirePerm, gate, hasPerm } from '../middleware/auth.js';
import {
  loadOrder, saveOrder, sendKitchen, voidItem, voidOrder, mergeOrders, moveItems, attachMember,
  applyRedemption, removeRedemption, payOrder, refundOrder, reopenOrder, recalcOrder, buildReceiptPayload,
} from '../services/orders.js';
import { createPrintJob, receiptPrinterFor } from '../services/printing.js';
import { insert, run, tx } from '../db/index.js';
import { audit } from '../services/audit.js';
import { promptPayPayload } from '../../shared/codes.js';
import { getSetting } from '../services/settings.js';

const r = Router();
r.use(requireStaff);

const itemSchema = z.object({
  id: z.string().min(8).max(64).optional(),
  productId: z.number().int(),
  variantId: z.number().int().nullable().optional(),
  qty: z.number().positive().max(9999),
  modifiers: z.array(z.object({ modifierId: z.number().int(), qty: z.number().int().min(1).max(99).optional() })).max(50).optional(),
  note: z.string().max(300).nullable().optional(),
  priceOverride: z.union([z.number().min(0), z.null(), z.literal('')]).optional(),
  discounts: z.array(z.object({ type: z.enum(['pct', 'amount']), value: z.number().min(0), label: z.string().max(80).optional(), source: z.string().optional() })).max(5).optional(),
});
const discountSchema = z.object({ type: z.enum(['pct', 'amount']), value: z.number().min(0), label: z.string().max(80).optional(), source: z.string().optional(), redemptionId: z.number().optional() });
const orderSchema = z.object({
  id: z.string().min(8).max(64).optional(),
  type: z.enum(['dine_in', 'takeaway', 'delivery']).optional(),
  tableId: z.number().int().nullable().optional(),
  guests: z.number().int().min(0).max(999).nullable().optional(),
  customerName: z.string().max(120).nullable().optional(),
  customerPhone: z.string().max(30).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  items: z.array(itemSchema).max(500).optional(),
  billDiscounts: z.array(discountSchema).max(10).optional(),
  couponCodes: z.array(z.string().max(40)).max(10).optional(),
  scExempt: z.boolean().optional(),
  pointsToUse: z.number().int().min(0).optional(),
  status: z.enum(['open', 'held']).optional(),
  version: z.number().int().optional(),
  merge: z.boolean().optional(),
  offline: z.object({ orderNo: z.string().max(30).optional(), queueNo: z.string().max(20).optional(), createdAt: z.string().optional() }).optional(),
});

const branchOf = (req) => req.staff.branchId;

// list: open / held / paid … (with filters)
r.get('/orders', (req, res) => {
  const { status, type, q, date, tableId, limit = 100 } = req.query;
  const where = ['o.branch_id = ?']; const p = [branchOf(req)];
  if (status) { const list = String(status).split(','); where.push(`o.status IN (${list.map(() => '?').join(',')})`); p.push(...list); }
  if (type) { where.push('o.type = ?'); p.push(type); }
  if (tableId) { where.push('o.table_id = ?'); p.push(Number(tableId)); }
  if (date) { where.push('o.business_date = ?'); p.push(date); }
  if (q) { where.push('(o.order_no LIKE ? OR o.queue_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR EXISTS (SELECT 1 FROM receipts rc WHERE rc.order_id = o.id AND rc.receipt_no LIKE ?))'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (!hasPerm(req, 'report.other_staff') && status && /paid|refund/.test(status)) { where.push('o.staff_id = ?'); p.push(req.staff.id); }
  const rows = all(`SELECT o.id, o.order_no, o.queue_no, o.type, o.status, o.kitchen_status, o.total, o.paid_total, o.guests, o.customer_name, o.customer_phone,
                           o.created_at, o.updated_at, o.held_at, o.paid_at, o.table_id, t.number AS table_number, o.member_id, m.name AS member_name,
                           COALESCE(s.nickname, s.first_name) AS staff_name, s.employee_code AS staff_code,
                           (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.status <> 'voided') AS item_count,
                           (SELECT receipt_no FROM receipts rc WHERE rc.order_id = o.id AND rc.doc_type <> 'credit_note' ORDER BY rc.id LIMIT 1) AS receipt_no
                    FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN staff s ON s.id = o.staff_id LEFT JOIN members m ON m.id = o.member_id
                    WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ?`, ...p, Math.min(Number(limit) || 100, 500));
  res.json(rows);
});

r.get('/orders/:id', (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) throw notFound('ไม่พบ Order');
  res.json(o);
});

r.post('/orders', requirePerm('pos.access'), (req, res) => res.json(saveOrder(req, parse(orderSchema, req.body))));
r.put('/orders/:id', requirePerm('pos.access'), (req, res) => res.json(saveOrder(req, { ...parse(orderSchema, req.body), id: req.params.id })));

r.post('/orders/:id/send-kitchen', requirePerm('pos.send_kitchen'), (req, res) => res.json(sendKitchen(req, req.params.id)));

r.post('/orders/:id/items/:itemId/void', (req, res) => {
  const b = parse(z.object({ qty: z.number().positive().optional(), reason: z.string().max(300).optional() }), req.body || {});
  res.json(voidItem(req, req.params.id, req.params.itemId, b));
});
r.post('/orders/:id/void', (req, res) => {
  const b = parse(z.object({ reason: z.string().min(1).max(300) }), req.body);
  res.json(voidOrder(req, req.params.id, b));
});
r.post('/orders/:id/merge', requirePerm('pos.merge_table'), (req, res) => {
  const b = parse(z.object({ sourceIds: z.array(z.string()).min(1).max(20) }), req.body);
  res.json(mergeOrders(req, req.params.id, b.sourceIds));
});
r.post('/orders/:id/move-items', requirePerm('pos.move_table', 'pos.split_bill'), (req, res) => {
  const b = parse(z.object({
    items: z.array(z.object({ itemId: z.string(), qty: z.number().positive().optional() })).min(1),
    targetOrderId: z.string().optional(),
    newOrder: z.object({ id: z.string().optional(), type: z.enum(['dine_in', 'takeaway', 'delivery']).optional(), tableId: z.number().int().nullable().optional(), guests: z.number().int().nullable().optional(), customerName: z.string().nullable().optional() }).optional(),
  }), req.body);
  res.json(moveItems(req, req.params.id, b));
});
r.post('/orders/:id/member', (req, res) => {
  const b = parse(z.object({ memberId: z.number().int().nullable(), via: z.enum(['pos', 'display', 'scan']).optional() }), req.body);
  if (b.memberId && !hasPerm(req, 'member.search')) throw bad('ไม่มีสิทธิ์ค้นหาสมาชิก');
  res.json(attachMember(req, req.params.id, b.memberId, b.via));
});
r.post('/orders/:id/redemptions', (req, res) => {
  const b = parse(z.object({ code: z.string().min(4).max(20) }), req.body);
  res.json(applyRedemption(req, req.params.id, b.code));
});
r.delete('/orders/:id/redemptions/:rid', (req, res) => res.json(removeRedemption(req, req.params.id, Number(req.params.rid))));

r.post('/orders/:id/pay', (req, res) => {
  const b = parse(z.object({
    idempotencyKey: z.string().min(8).max(80),
    payments: z.array(z.object({ method: z.enum(['cash', 'qr', 'credit_card', 'debit_card', 'transfer', 'ewallet', 'other']), amount: z.number().positive(), tendered: z.number().min(0).optional().nullable(), reference: z.string().max(80).optional().nullable() })).min(1).max(10),
    partial: z.boolean().optional(),
    docType: z.enum(['receipt', 'abb_tax_invoice', 'full_tax_invoice']).optional(),
    customer: z.object({ name: z.string().max(200), taxId: z.string().max(20).optional(), branch: z.string().max(60).optional(), address: z.string().max(400).optional(), phone: z.string().max(30).optional(), email: z.string().max(120).optional() }).optional().nullable(),
    copies: z.number().int().min(0).max(10).optional(),
    print: z.boolean().optional(),
    memberVia: z.enum(['pos', 'display', 'scan']).optional(),
    offline: z.object({ receiptNo: z.string().max(40).optional(), paidAt: z.string().optional(), receiptPrinted: z.boolean().optional(), kitchenPrinted: z.boolean().optional() }).optional(),
  }), req.body);
  res.json(payOrder(req, req.params.id, b));
});

r.post('/orders/:id/refund', (req, res) => {
  const b = parse(z.object({
    idempotencyKey: z.string().min(8).max(80), type: z.enum(['full', 'partial', 'item']),
    items: z.array(z.object({ itemId: z.string(), qty: z.number().positive() })).optional(),
    amount: z.number().positive().optional(), method: z.string().max(20).optional(), reason: z.string().min(1).max(300), restock: z.boolean().optional(), print: z.boolean().optional(),
  }), req.body);
  res.json(refundOrder(req, req.params.id, b));
});
r.post('/orders/:id/reopen', (req, res) => {
  const b = parse(z.object({ reason: z.string().min(1).max(300) }), req.body);
  res.json(reopenOrder(req, req.params.id, b));
});

// PromptPay dynamic QR for the order's outstanding amount
r.get('/orders/:id/promptpay', (req, res) => {
  const o = one('SELECT total, paid_total, branch_id FROM orders WHERE id = ?', req.params.id);
  if (!o) throw notFound();
  const pp = getSetting('payment', o.branch_id).promptpay;
  if (!pp.enabled || !pp.id) return res.json({ enabled: false, qrImageUrl: pp.qrImageUrl || null, accountName: pp.accountName });
  const amount = req.query.amount ? Number(req.query.amount) : Math.round((o.total - o.paid_total) * 100) / 100;
  res.json({ enabled: true, payload: promptPayPayload(pp.id, pp.dynamic ? amount : undefined), amount, accountName: pp.accountName, qrImageUrl: pp.qrImageUrl || null });
});

// ── Receipts: search / reprint / tax invoice ──────────────────────────────
r.get('/receipts', (req, res) => {
  const { q, from, to } = req.query;
  const where = ['r.branch_id = ?']; const p = [branchOf(req)];
  if (q) { where.push('(r.receipt_no LIKE ? OR o.order_no LIKE ? OR o.queue_no LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (from) { where.push('r.created_at >= ?'); p.push(from); }
  if (to) { where.push('r.created_at <= ?'); p.push(to); }
  res.json(all(`SELECT r.id, r.receipt_no, r.doc_type, r.total, r.created_at, r.print_count, r.claim_status, o.order_no, o.queue_no, o.status AS order_status, o.id AS order_id
                FROM receipts r JOIN orders o ON o.id = r.order_id WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 200`, ...p));
});
r.get('/receipts/:id', (req, res) => {
  const rc = one('SELECT * FROM receipts WHERE id = ?', req.params.id);
  if (!rc) throw notFound();
  res.json({ ...rc, payload: json(rc.payload, {}), customer: json(rc.customer, null),
    reprints: all('SELECT rp.*, COALESCE(s.nickname, s.first_name) AS staff_name FROM reprints rp JOIN staff s ON s.id = rp.staff_id WHERE receipt_id = ? ORDER BY rp.id DESC', rc.id) });
});

r.post('/receipts/:id/reprint', (req, res) => {
  const b = parse(z.object({ reason: z.string().min(1).max(200), printerId: z.number().int().optional() }), req.body);
  const out = tx(() => {
    const rc = one('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!rc) throw notFound();
    const g = gate(req, 'reprint', { perm: 'receipt.reprint', orderId: rc.order_id });
    const printer = b.printerId ? one('SELECT * FROM printers WHERE id = ?', b.printerId) : receiptPrinterFor(rc.branch_id, req.device?.id);
    if (!printer) throw bad('ยังไม่ได้ตั้งค่าเครื่องพิมพ์ใบเสร็จ');
    const payload = { ...json(rc.payload, {}), reprint: true, copy: null };
    const jobId = createPrintJob({ branchId: rc.branch_id, printerId: printer.id, orderId: rc.order_id, docType: rc.doc_type === 'credit_note' ? 'slip' : 'receipt', receiptId: rc.id, payload, staffId: req.staff.id });
    insert('reprints', { receipt_id: rc.id, staff_id: req.staff.id, approval_id: g.approvalId, reason: b.reason });
    audit(req, 'receipt.reprint', { entity: 'receipt', entityId: rc.id, details: `${rc.receipt_no}: ${b.reason}`, approvedBy: g.approvedBy });
    return { jobId };
  });
  res.json(out);
});

// Issue a full tax invoice for an existing paid receipt
r.post('/receipts/:id/tax-invoice', (req, res) => {
  const b = parse(z.object({ customer: z.object({ name: z.string().min(1).max(200), taxId: z.string().min(10).max(20), branch: z.string().max(60).optional(), address: z.string().min(1).max(400), phone: z.string().max(30).optional(), email: z.string().max(120).optional() }), print: z.boolean().optional() }), req.body);
  const out = tx(() => {
    const rc = one('SELECT * FROM receipts WHERE id = ?', req.params.id);
    if (!rc || rc.doc_type === 'credit_note') throw notFound();
    const o = one('SELECT * FROM orders WHERE id = ?', rc.order_id);
    if (o.status !== 'paid') throw bad('ออกใบกำกับภาษีได้เฉพาะบิลที่ชำระแล้ว');
    const no = `TI${String(one('SELECT COUNT(*)+1 c FROM receipts WHERE doc_type = \'full_tax_invoice\'').c).padStart(6, '0')}`;
    const old = json(rc.payload, {});
    const payload = { ...buildReceiptPayload(o.id, { receiptNo: no, docType: 'full_tax_invoice', customer: b.customer, payments: old.payments, received: old.received, change: old.change, time: old.time, memberInfo: old.member }), refReceipt: rc.receipt_no };
    const id = insert('receipts', { receipt_no: no, order_id: o.id, payment_id: rc.payment_id, branch_id: rc.branch_id, doc_type: 'full_tax_invoice', customer: b.customer, payload, total: rc.total, ref_receipt_id: rc.id });
    const printer = receiptPrinterFor(rc.branch_id, req.device?.id);
    let jobId = null;
    if (printer && b.print !== false) jobId = createPrintJob({ branchId: rc.branch_id, printerId: printer.id, orderId: o.id, docType: 'receipt', receiptId: id, payload, staffId: req.staff.id });
    audit(req, 'receipt.tax_invoice', { entity: 'receipt', entityId: id, details: `${no} ref ${rc.receipt_no}` });
    return { id, receiptNo: no, jobId };
  });
  res.json(out);
});

r.post('/orders/:id/recalc', (req, res) => { recalcOrder(req.params.id); res.json(loadOrder(req.params.id)); });

// table helpers used by the POS floor plan
r.post('/tables/:id/status', requirePerm('pos.access'), (req, res) => {
  const b = parse(z.object({ status: z.enum(['reserved', 'cleaning']).nullable(), note: z.string().max(200).optional().nullable() }), req.body);
  run('UPDATE tables SET manual_status = ?, reserved_note = ? WHERE id = ? AND branch_id = ?', b.status, b.note ?? null, Number(req.params.id), branchOf(req));
  audit(req, 'table.status', { entity: 'table', entityId: req.params.id, details: String(b.status) });
  res.json({ ok: true });
});

export default r;

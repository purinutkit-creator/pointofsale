// Dashboard, Loyalty dashboard and Report Center (+ CSV / XLSX / PDF export).
// All figures come from the persisted order totals that were produced by shared/calc.js.
import { Router } from 'express';
import path from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { one, all } from '../db/index.js';
import { bad, forbidden } from '../lib/errors.js';
import { requireStaff, requirePerm, hasPerm } from '../middleware/auth.js';
import { getSetting } from '../services/settings.js';
import { config } from '../config.js';
import { audit } from '../services/audit.js';
import { PAYMENT_METHOD_LABEL } from '../../shared/format.js';

const r = Router();
r.use(requireStaff);

const SOLD = "o.status IN ('paid','refunded','partially_refunded')";

function tzOffsetMinutes(tz) {
  const d = new Date();
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local - utc) / 60000);
}

/** Build WHERE clause from common filters. */
function filters(req, alias = 'o', timeCol = 'paid_at') {
  const q = req.query;
  const tz = getSetting('shop').timezone;
  const off = `${tzOffsetMinutes(tz) >= 0 ? '+' : ''}${tzOffsetMinutes(tz)} minutes`;
  const local = `datetime(${alias}.${timeCol}, '${off}')`;
  const where = []; const p = [];
  const today = new Date(Date.now() + tzOffsetMinutes(tz) * 60e3).toISOString().slice(0, 10);
  const from = q.from || today; const to = q.to || from;
  where.push(`date(${local}) BETWEEN ? AND ?`); p.push(from, to);
  if (q.timeFrom) { where.push(`strftime('%H:%M', ${local}) >= ?`); p.push(q.timeFrom); }
  if (q.timeTo) { where.push(`strftime('%H:%M', ${local}) <= ?`); p.push(q.timeTo); }
  if (q.branchId === 'all') {
    if (!hasPerm(req, 'report.all_branches')) throw forbidden('ไม่มีสิทธิ์ดูทุกสาขา');
  } else {
    const b = Number(q.branchId) || req.staff.branchId;
    if (b !== req.staff.branchId && !hasPerm(req, 'report.all_branches')) throw forbidden('ไม่มีสิทธิ์ดูสาขาอื่น');
    where.push(`${alias}.branch_id = ?`); p.push(b);
  }
  if (q.deviceId && alias === 'o') { where.push('o.device_id = ?'); p.push(Number(q.deviceId)); }
  if (alias === 'o') {
    if (q.staffId) { where.push('o.staff_id = ?'); p.push(Number(q.staffId)); } else if (!hasPerm(req, 'report.other_staff')) { where.push('o.staff_id = ?'); p.push(req.staff.id); }
    if (q.method) { where.push("EXISTS (SELECT 1 FROM payment_transactions px WHERE px.order_id = o.id AND px.method = ? AND px.kind = 'sale')"); p.push(q.method); }
    if (q.productId) { where.push("EXISTS (SELECT 1 FROM order_items ix WHERE ix.order_id = o.id AND ix.product_id = ? AND ix.status <> 'voided')"); p.push(Number(q.productId)); }
    if (q.categoryId) { where.push("EXISTS (SELECT 1 FROM order_items ix WHERE ix.order_id = o.id AND ix.category_id = ? AND ix.status <> 'voided')"); p.push(Number(q.categoryId)); }
  }
  return { sql: where.join(' AND '), p, local, off, from, to };
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Dashboard ─────────────────────────────────────────────────────────────
r.get('/dashboard', requirePerm('report.dashboard'), (req, res) => {
  const f = filters(req);
  const k = one(`SELECT COUNT(*) orders, IFNULL(SUM(subtotal),0) gross, IFNULL(SUM(discount),0) discount, IFNULL(SUM(service_charge),0) sc,
                        IFNULL(SUM(vat),0) vat, IFNULL(SUM(total),0) total, IFNULL(SUM(refunded_total),0) refunds, IFNULL(SUM(cost_total),0) cost,
                        IFNULL(SUM(COALESCE(guests, 1)),0) customers, COUNT(DISTINCT member_id) members
                 FROM orders o WHERE ${SOLD} AND ${f.sql}`, ...f.p);
  const payments = all(`SELECT px.method, SUM(px.amount) amount, COUNT(DISTINCT px.order_id) n FROM payment_transactions px JOIN orders o ON o.id = px.order_id
                        WHERE ${SOLD} AND px.kind = 'sale' AND ${f.sql} GROUP BY px.method ORDER BY amount DESC`, ...f.p);
  const best = all(`SELECT i.product_id, i.name, SUM(i.qty - i.refunded_qty) qty, SUM(i.line_total) amount FROM order_items i JOIN orders o ON o.id = i.order_id
                    WHERE ${SOLD} AND i.status <> 'voided' AND ${f.sql} GROUP BY i.product_id, i.name ORDER BY qty DESC LIMIT 10`, ...f.p);
  const cats = all(`SELECT c.name, SUM(i.line_total) amount, SUM(i.qty) qty FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN categories c ON c.id = i.category_id
                    WHERE ${SOLD} AND i.status <> 'voided' AND ${f.sql} GROUP BY i.category_id ORDER BY amount DESC`, ...f.p);
  const hours = all(`SELECT CAST(strftime('%H', ${f.local}) AS INTEGER) hour, COUNT(*) orders, SUM(o.total) amount FROM orders o WHERE ${SOLD} AND ${f.sql} GROUP BY hour ORDER BY hour`, ...f.p);
  const staff = all(`SELECT o.staff_id, COALESCE(s.nickname, s.first_name) name, s.employee_code code, COUNT(*) orders, SUM(o.total) amount FROM orders o LEFT JOIN staff s ON s.id = o.staff_id
                     WHERE ${SOLD} AND ${f.sql} GROUP BY o.staff_id ORDER BY amount DESC`, ...f.p);
  const daily = all(`SELECT date(${f.local}) day, COUNT(*) orders, SUM(o.total) amount FROM orders o WHERE ${SOLD} AND ${f.sql} GROUP BY day ORDER BY day`, ...f.p);
  const branches = req.query.branchId === 'all' ? all(`SELECT b.name, COUNT(o.id) orders, IFNULL(SUM(o.total),0) amount FROM orders o JOIN branches b ON b.id = o.branch_id WHERE ${SOLD} AND ${f.sql} GROUP BY o.branch_id ORDER BY amount DESC`, ...f.p) : [];
  const fv = filters(req, 'o', 'voided_at');
  const voids = one(`SELECT COUNT(*) n, IFNULL(SUM(amount),0) amount FROM voids v JOIN orders o ON o.id = v.order_id WHERE ${fv.sql.replaceAll('o.voided_at', 'v.created_at')}`, ...fv.p);
  const open = one("SELECT COUNT(*) n, IFNULL(SUM(total),0) amount FROM orders WHERE branch_id = ? AND status IN ('open','held')", req.staff.branchId);
  const net = r2(k.total - k.refunds);
  res.json({
    range: { from: f.from, to: f.to },
    kpi: {
      grossSales: r2(k.gross), netSales: net, orders: k.orders, customers: k.customers, members: k.members, averageBill: k.orders ? r2(k.total / k.orders) : 0,
      discount: r2(k.discount), refund: r2(k.refunds), vat: r2(k.vat), serviceCharge: r2(k.sc), total: r2(k.total),
      cost: hasPerm(req, 'report.cost') ? r2(k.cost) : null, profit: hasPerm(req, 'report.profit') ? r2(k.total - k.vat - k.cost - k.refunds) : null,
      voids: voids.n, voidAmount: r2(voids.amount), openOrders: open.n, openAmount: r2(open.amount),
    },
    payments: payments.map((p) => ({ ...p, amount: r2(p.amount), label: PAYMENT_METHOD_LABEL[p.method] || p.method })),
    bestSellers: best.map((b) => ({ ...b, amount: r2(b.amount) })), categories: cats.map((c) => ({ ...c, name: c.name || 'ไม่ระบุหมวด', amount: r2(c.amount) })),
    hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hours.find((x) => x.hour === h)?.orders || 0, amount: r2(hours.find((x) => x.hour === h)?.amount) })),
    staff: staff.map((s) => ({ ...s, amount: r2(s.amount) })), daily: daily.map((d) => ({ ...d, amount: r2(d.amount) })), branches,
  });
});

// ── Loyalty dashboard ─────────────────────────────────────────────────────
r.get('/loyalty/dashboard', requirePerm('member.history', 'member.rewards', 'report.dashboard'), (req, res) => {
  const tz = getSetting('shop').timezone;
  const off = `${tzOffsetMinutes(tz)} minutes`;
  const days = Math.min(Number(req.query.days) || 30, 365);
  const c = (sql, ...p) => one(sql, ...p).c;
  const totals = {
    members: c('SELECT COUNT(*) c FROM members'),
    newToday: c(`SELECT COUNT(*) c FROM members WHERE date(datetime(created_at, '${off}')) = date(datetime('now', '${off}'))`),
    newMonth: c(`SELECT COUNT(*) c FROM members WHERE strftime('%Y-%m', datetime(created_at, '${off}')) = strftime('%Y-%m', datetime('now', '${off}'))`),
    active: c("SELECT COUNT(*) c FROM members WHERE last_visit_at >= datetime('now','-90 days')"),
    pointsIssued: c("SELECT IFNULL(SUM(points),0) c FROM point_transactions WHERE points > 0 AND type IN ('EARN','BONUS','BIRTHDAY','ADJUSTMENT')"),
    pointsRedeemed: c("SELECT IFNULL(SUM(-points),0) c FROM point_transactions WHERE type = 'REDEEM'"),
    pointsOutstanding: c('SELECT IFNULL(SUM(points),0) c FROM members WHERE points > 0'),
    rewardsUsed: c("SELECT COUNT(*) c FROM reward_redemptions WHERE status = 'used'"),
    memberSales: r2(c("SELECT IFNULL(SUM(total - refunded_total),0) c FROM orders o WHERE member_id IS NOT NULL AND " + SOLD)),
    memberOrders: c("SELECT COUNT(*) c FROM orders o WHERE member_id IS NOT NULL AND " + SOLD),
  };
  totals.inactive = totals.members - totals.active;
  totals.averageSpending = totals.memberOrders ? r2(totals.memberSales / totals.memberOrders) : 0;
  const buyers = c("SELECT COUNT(DISTINCT member_id) c FROM orders o WHERE member_id IS NOT NULL AND " + SOLD);
  const repeaters = c(`SELECT COUNT(*) c FROM (SELECT member_id FROM orders o WHERE member_id IS NOT NULL AND ${SOLD} GROUP BY member_id HAVING COUNT(*) >= 2)`);
  totals.repeatRate = buyers ? r2((repeaters / buyers) * 100) : 0;
  const since = `datetime('now', '-${days} days')`;
  const series = (sql) => all(sql.replaceAll('$OFF', off).replaceAll('$SINCE', since));
  res.json({
    totals,
    topMembers: all('SELECT m.id, m.name, m.phone, m.points, m.total_spend, m.visit_count, t.name AS tier_name, t.color AS tier_color FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id ORDER BY m.total_spend DESC LIMIT 10'),
    tiers: all('SELECT t.name, t.color, COUNT(m.id) n FROM member_tiers t LEFT JOIN members m ON m.tier_id = t.id WHERE t.active = 1 GROUP BY t.id ORDER BY t.min_points'),
    newMembers: series("SELECT date(datetime(created_at, '$OFF')) day, COUNT(*) n FROM members WHERE created_at >= $SINCE GROUP BY day ORDER BY day"),
    memberVsNon: series(`SELECT date(datetime(paid_at, '$OFF')) day, SUM(CASE WHEN member_id IS NOT NULL THEN total ELSE 0 END) member, SUM(CASE WHEN member_id IS NULL THEN total ELSE 0 END) non_member FROM orders o WHERE ${SOLD} AND paid_at >= $SINCE GROUP BY day ORDER BY day`),
    points: series("SELECT date(datetime(created_at, '$OFF')) day, SUM(CASE WHEN points > 0 AND type <> 'REFUND' THEN points ELSE 0 END) earned, SUM(CASE WHEN type = 'REDEEM' THEN -points ELSE 0 END) redeemed FROM point_transactions WHERE created_at >= $SINCE GROUP BY day ORDER BY day"),
    redemptions: series("SELECT date(datetime(used_at, '$OFF')) day, COUNT(*) n FROM reward_redemptions WHERE status = 'used' AND used_at >= $SINCE GROUP BY day ORDER BY day"),
    byBranch: all(`SELECT b.id, b.name,
                     (SELECT IFNULL(SUM(points),0) FROM point_transactions pt WHERE pt.branch_id = b.id AND pt.type IN ('EARN','BONUS')) AS points_earned,
                     (SELECT COUNT(*) FROM reward_redemptions rr WHERE rr.used_branch_id = b.id AND rr.status = 'used') AS rewards_redeemed,
                     (SELECT IFNULL(SUM(total - refunded_total),0) FROM orders o WHERE o.branch_id = b.id AND o.member_id IS NOT NULL AND ${SOLD}) AS member_sales
                   FROM branches b WHERE b.active = 1`),
    topByBranch: all(`SELECT b.name AS branch_name, m.name, m.phone, SUM(o.total) spend, COUNT(*) orders FROM orders o JOIN members m ON m.id = o.member_id JOIN branches b ON b.id = o.branch_id
                      WHERE ${SOLD} GROUP BY o.branch_id, o.member_id ORDER BY o.branch_id, spend DESC`).reduce((acc, x) => {
      const list = (acc[x.branch_name] ||= []); if (list.length < 5) list.push(x); return acc;
    }, {}),
  });
});

// ── Report Center ─────────────────────────────────────────────────────────
const money = { type: 'money' };
const REPORTS = {
  sales: { title: 'รายงานยอดขาย (Sales)', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'day', label: 'วันที่' }, { key: 'orders', label: 'บิล', type: 'int' }, { key: 'gross', label: 'Gross Sales', ...money }, { key: 'discount', label: 'Discount', ...money }, { key: 'sc', label: 'Service Charge', ...money }, { key: 'vat', label: 'VAT', ...money }, { key: 'total', label: 'ยอดรวม', ...money }, { key: 'refunds', label: 'Refund', ...money }, { key: 'net', label: 'Net Sales', ...money }],
    rows: all(`SELECT date(${f.local}) day, COUNT(*) orders, SUM(subtotal) gross, SUM(discount) discount, SUM(service_charge) sc, SUM(vat) vat, SUM(total) total, SUM(refunded_total) refunds, SUM(total - refunded_total) net FROM orders o WHERE ${SOLD} AND ${f.sql} GROUP BY day ORDER BY day`, ...f.p),
  }) },
  orders: { title: 'รายการบิลขาย', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'time', label: 'เวลา' }, { key: 'receipt_no', label: 'ใบเสร็จ' }, { key: 'order_no', label: 'Order' }, { key: 'queue_no', label: 'คิว' }, { key: 'type', label: 'ประเภท' }, { key: 'staff', label: 'พนักงาน' }, { key: 'member', label: 'สมาชิก' }, { key: 'total', label: 'ยอด', ...money }, { key: 'status', label: 'สถานะ' }],
    rows: all(`SELECT ${f.local} time, (SELECT receipt_no FROM receipts WHERE order_id = o.id AND doc_type <> 'credit_note' LIMIT 1) receipt_no, o.order_no, o.queue_no, o.type, s.employee_code staff, m.name member, o.total, o.status
               FROM orders o LEFT JOIN staff s ON s.id = o.staff_id LEFT JOIN members m ON m.id = o.member_id WHERE ${SOLD} AND ${f.sql} ORDER BY o.paid_at`, ...f.p),
  }) },
  product: { title: 'รายงานสินค้า (Product)', perm: 'report.sales', build: (f, req) => ({
    columns: [{ key: 'name', label: 'สินค้า' }, { key: 'category', label: 'หมวด' }, { key: 'qty', label: 'จำนวน', type: 'num' }, { key: 'gross', label: 'ยอดก่อนส่วนลด', ...money }, { key: 'discount', label: 'ส่วนลด', ...money }, { key: 'net', label: 'ยอดสุทธิ', ...money }, ...(hasPerm(req, 'report.cost') ? [{ key: 'cost', label: 'ต้นทุน', ...money }, { key: 'profit', label: 'กำไรขั้นต้น', ...money }] : [])],
    rows: all(`SELECT i.name, c.name category, SUM(i.qty) qty, SUM(i.unit_price * i.qty) gross, SUM(i.discount) discount, SUM(i.line_total) net, SUM(i.unit_cost * i.qty) cost, SUM(i.line_total - i.unit_cost * i.qty) profit
               FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN categories c ON c.id = i.category_id WHERE ${SOLD} AND i.status <> 'voided' AND ${f.sql} GROUP BY i.product_id, i.name ORDER BY net DESC`, ...f.p),
  }) },
  category: { title: 'รายงานหมวดสินค้า (Category)', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'name', label: 'หมวด' }, { key: 'qty', label: 'จำนวน', type: 'num' }, { key: 'net', label: 'ยอดสุทธิ', ...money }, { key: 'share', label: '% ยอดขาย', type: 'pct' }],
    rows: (() => { const rows = all(`SELECT IFNULL(c.name,'ไม่ระบุ') name, SUM(i.qty) qty, SUM(i.line_total) net FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN categories c ON c.id = i.category_id WHERE ${SOLD} AND i.status <> 'voided' AND ${f.sql} GROUP BY i.category_id ORDER BY net DESC`, ...f.p); const t = rows.reduce((a, x) => a + x.net, 0); return rows.map((x) => ({ ...x, share: t ? (x.net / t) * 100 : 0 })); })(),
  }) },
  modifier: { title: 'รายงานตัวเลือกสินค้า (Modifier)', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'group_name', label: 'กลุ่ม' }, { key: 'name', label: 'ตัวเลือก' }, { key: 'qty', label: 'จำนวน', type: 'num' }, { key: 'revenue', label: 'รายได้เพิ่ม', ...money }],
    rows: all(`SELECT m.group_name, m.name, SUM(m.qty * i.qty) qty, SUM(m.price * m.qty * i.qty) revenue FROM order_item_modifiers m JOIN order_items i ON i.id = m.order_item_id JOIN orders o ON o.id = i.order_id WHERE ${SOLD} AND i.status <> 'voided' AND ${f.sql} GROUP BY m.group_name, m.name ORDER BY qty DESC`, ...f.p),
  }) },
  payment: { title: 'รายงานการชำระเงิน (Payment)', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'label', label: 'ช่องทาง' }, { key: 'n', label: 'จำนวนรายการ', type: 'int' }, { key: 'sales', label: 'รับชำระ', ...money }, { key: 'refunds', label: 'คืนเงิน', ...money }, { key: 'net', label: 'สุทธิ', ...money }],
    rows: all(`SELECT px.method, COUNT(*) n, SUM(CASE WHEN px.kind='sale' THEN px.amount ELSE 0 END) sales, SUM(CASE WHEN px.kind='refund' THEN -px.amount ELSE 0 END) refunds, SUM(px.amount) net FROM payment_transactions px JOIN orders o ON o.id = px.order_id WHERE ${f.sql} GROUP BY px.method ORDER BY net DESC`, ...f.p).map((x) => ({ ...x, label: PAYMENT_METHOD_LABEL[x.method] || x.method })),
  }) },
  shift: { title: 'รายงานกะ (Shift)', perm: 'report.sales', alias: 'sh', time: 'opened_at', build: (f) => ({
    columns: [{ key: 'opened', label: 'เปิดกะ' }, { key: 'closed', label: 'ปิดกะ' }, { key: 'staff', label: 'พนักงาน' }, { key: 'device', label: 'เครื่อง' }, { key: 'opening_cash', label: 'Opening', ...money }, { key: 'expected_cash', label: 'Expected', ...money }, { key: 'actual_cash', label: 'Actual', ...money }, { key: 'difference', label: 'Over/Short', ...money }, { key: 'status', label: 'สถานะ' }],
    rows: all(`SELECT datetime(sh.opened_at, '${f.off}') opened, datetime(sh.closed_at, '${f.off}') closed, s.employee_code || ' ' || COALESCE(s.nickname, s.first_name) staff, d.name device, sh.opening_cash, sh.expected_cash, sh.actual_cash, sh.difference, sh.status
               FROM shifts sh JOIN staff s ON s.id = sh.staff_id LEFT JOIN pos_devices d ON d.id = sh.device_id WHERE ${f.sql} ORDER BY sh.id`, ...f.p),
  }) },
  discount: { title: 'รายงานส่วนลด (Discount)', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'time', label: 'เวลา' }, { key: 'order_no', label: 'Order' }, { key: 'staff', label: 'พนักงาน' }, { key: 'subtotal', label: 'ยอดก่อนลด', ...money }, { key: 'discount', label: 'ส่วนลด', ...money }, { key: 'detail', label: 'รายละเอียด' }],
    rows: all(`SELECT ${f.local} time, o.order_no, s.employee_code staff, o.subtotal, o.discount, o.bill_discounts, o.promotions FROM orders o LEFT JOIN staff s ON s.id = o.staff_id WHERE ${SOLD} AND o.discount > 0 AND ${f.sql} ORDER BY o.paid_at`, ...f.p)
      .map((x) => ({ ...x, detail: [...JSON.parse(x.bill_discounts || '[]').map((d) => d.label), ...JSON.parse(x.promotions || '[]').map((p) => p.name)].join(', ') })),
  }) },
  promotion: { title: 'รายงานโปรโมชั่น (Promotion)', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'name', label: 'โปรโมชั่น' }, { key: 'orders', label: 'จำนวนบิล', type: 'int' }, { key: 'amount', label: 'มูลค่าส่วนลด', ...money }],
    rows: all(`SELECT json_extract(j.value, '$.name') name, COUNT(*) orders, SUM(IFNULL(json_extract(j.value, '$.amount'),0)) amount FROM orders o, json_each(o.promotions) j WHERE ${SOLD} AND ${f.sql} GROUP BY name ORDER BY amount DESC`, ...f.p),
  }) },
  refund: { title: 'รายงานคืนเงิน (Refund)', perm: 'report.sales', alias: 'rf', time: 'created_at', build: (f) => ({
    columns: [{ key: 'time', label: 'เวลา' }, { key: 'refund_no', label: 'เลขที่' }, { key: 'receipt_no', label: 'ใบเสร็จเดิม' }, { key: 'type', label: 'ประเภท' }, { key: 'amount', label: 'ยอดคืน', ...money }, { key: 'method', label: 'ช่องทาง' }, { key: 'reason', label: 'เหตุผล' }, { key: 'staff', label: 'ผู้ทำ' }, { key: 'approver', label: 'ผู้อนุมัติ' }, { key: 'points_reversed', label: 'หักแต้ม', type: 'int' }],
    rows: all(`SELECT ${f.local} time, rf.refund_no, rc.receipt_no, rf.type, rf.amount, rf.method, rf.reason, s.employee_code staff, a.employee_code approver, rf.points_reversed
               FROM refunds rf LEFT JOIN receipts rc ON rc.id = rf.receipt_id JOIN staff s ON s.id = rf.staff_id LEFT JOIN staff a ON a.id = rf.approved_by WHERE ${f.sql} ORDER BY rf.id`, ...f.p),
  }) },
  void: { title: 'รายงาน Void', perm: 'report.sales', alias: 'v', time: 'created_at', build: (f) => ({
    columns: [{ key: 'time', label: 'เวลา' }, { key: 'order_no', label: 'Order' }, { key: 'scope', label: 'ประเภท' }, { key: 'item', label: 'รายการ' }, { key: 'qty', label: 'จำนวน', type: 'num' }, { key: 'amount', label: 'มูลค่า', ...money }, { key: 'reason', label: 'เหตุผล' }, { key: 'staff', label: 'ผู้ทำ' }, { key: 'approver', label: 'ผู้อนุมัติ' }],
    rows: all(`SELECT ${f.local} time, o.order_no, v.scope, i.name item, v.qty, v.amount, v.reason, s.employee_code staff, ap.employee_code approver
               FROM voids v JOIN orders o ON o.id = v.order_id LEFT JOIN order_items i ON i.id = v.order_item_id JOIN staff s ON s.id = v.staff_id
               LEFT JOIN approvals a ON a.id = v.approval_id LEFT JOIN staff ap ON ap.id = a.approved_by WHERE ${f.sql} ORDER BY v.id`, ...f.p),
  }) },
  vat: { title: 'รายงานภาษีขาย (VAT)', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'day', label: 'วันที่' }, { key: 'receipts', label: 'จำนวนใบเสร็จ', type: 'int' }, { key: 'vatable', label: 'มูลค่าที่ต้องเสียภาษี', ...money }, { key: 'exempt', label: 'มูลค่ายกเว้น VAT', ...money }, { key: 'before_vat', label: 'มูลค่าก่อน VAT', ...money }, { key: 'vat', label: 'VAT', ...money }, { key: 'total', label: 'รวม', ...money }],
    rows: all(`SELECT date(${f.local}) day, COUNT(*) receipts, SUM(json_extract(calc, '$.vatableBase')) vatable, SUM(json_extract(calc, '$.exemptAmount')) exempt, SUM(total - vat) before_vat, SUM(vat) vat, SUM(total) total FROM orders o WHERE ${SOLD} AND ${f.sql} GROUP BY day ORDER BY day`, ...f.p),
  }) },
  service_charge: { title: 'รายงาน Service Charge', perm: 'report.sales', build: (f) => ({
    columns: [{ key: 'day', label: 'วันที่' }, { key: 'orders', label: 'บิลที่มี SC', type: 'int' }, { key: 'base', label: 'ยอดฐาน', ...money }, { key: 'sc', label: 'Service Charge', ...money }],
    rows: all(`SELECT date(${f.local}) day, COUNT(*) orders, SUM(subtotal - discount) base, SUM(service_charge) sc FROM orders o WHERE ${SOLD} AND service_charge > 0 AND ${f.sql} GROUP BY day ORDER BY day`, ...f.p),
  }) },
  staff: { title: 'รายงานพนักงาน (Staff)', perm: 'report.other_staff', build: (f) => ({
    columns: [{ key: 'code', label: 'รหัส' }, { key: 'name', label: 'ชื่อ' }, { key: 'orders', label: 'บิล', type: 'int' }, { key: 'total', label: 'ยอดขาย', ...money }, { key: 'avg', label: 'เฉลี่ย/บิล', ...money }, { key: 'discount', label: 'ส่วนลด', ...money }, { key: 'refunds', label: 'คืนเงิน', ...money }],
    rows: all(`SELECT s.employee_code code, COALESCE(s.nickname, s.first_name) name, COUNT(*) orders, SUM(o.total) total, AVG(o.total) avg, SUM(o.discount) discount, SUM(o.refunded_total) refunds FROM orders o LEFT JOIN staff s ON s.id = o.staff_id WHERE ${SOLD} AND ${f.sql} GROUP BY o.staff_id ORDER BY total DESC`, ...f.p),
  }) },
  member: { title: 'รายงานสมาชิก (Member)', perm: 'member.history', build: (f) => ({
    columns: [{ key: 'member_code', label: 'Member ID' }, { key: 'name', label: 'ชื่อ' }, { key: 'phone', label: 'เบอร์' }, { key: 'tier', label: 'Tier' }, { key: 'orders', label: 'บิล', type: 'int' }, { key: 'spend', label: 'ยอดซื้อ', ...money }, { key: 'earned', label: 'แต้มที่ได้', type: 'int' }, { key: 'points', label: 'แต้มคงเหลือ', type: 'int' }],
    rows: all(`SELECT m.member_code, m.name, m.phone, t.name tier, COUNT(o.id) orders, SUM(o.total) spend, SUM(IFNULL(om.points_earned,0)) earned, m.points
               FROM orders o JOIN members m ON m.id = o.member_id LEFT JOIN member_tiers t ON t.id = m.tier_id LEFT JOIN order_members om ON om.order_id = o.id
               WHERE ${SOLD} AND ${f.sql} GROUP BY m.id ORDER BY spend DESC`, ...f.p),
  }) },
  point: { title: 'รายงานแต้ม (Point)', perm: 'member.history', alias: 'pt', time: 'created_at', build: (f) => ({
    columns: [{ key: 'time', label: 'เวลา' }, { key: 'type', label: 'ประเภท' }, { key: 'member', label: 'สมาชิก' }, { key: 'points', label: 'แต้ม', type: 'int' }, { key: 'balance', label: 'คงเหลือ', type: 'int' }, { key: 'order_no', label: 'Order' }, { key: 'staff', label: 'พนักงาน' }, { key: 'reason', label: 'เหตุผล' }, { key: 'txn_id', label: 'Transaction ID' }],
    rows: all(`SELECT ${f.local} time, pt.type, m.name || ' (' || m.phone || ')' member, pt.points, pt.balance, o.order_no, s.employee_code staff, pt.reason, pt.txn_id
               FROM point_transactions pt JOIN members m ON m.id = pt.member_id LEFT JOIN orders o ON o.id = pt.order_id LEFT JOIN staff s ON s.id = pt.staff_id WHERE ${f.sql.replace('pt.branch_id = ?', '(pt.branch_id = ? OR pt.branch_id IS NULL)')} ORDER BY pt.id`, ...f.p),
  }) },
  stock: { title: 'รายงานสต็อกคงเหลือ (Stock)', perm: 'stock.view', snapshot: true, build: (f, req) => ({
    columns: [{ key: 'type', label: 'ประเภท' }, { key: 'name', label: 'รายการ' }, { key: 'qty', label: 'คงเหลือ', type: 'num' }, { key: 'unit', label: 'หน่วย' }, { key: 'min_stock', label: 'ขั้นต่ำ', type: 'num' }, ...(hasPerm(req, 'stock.view_cost') ? [{ key: 'value', label: 'มูลค่า', ...money }] : []), { key: 'low', label: 'สถานะ' }],
    rows: all(`SELECT 'สินค้า' type, p.name, IFNULL(i.qty,0) qty, 'ชิ้น' unit, p.min_stock, IFNULL(i.qty,0) * p.cost value FROM products p LEFT JOIN inventory i ON i.item_type='product' AND i.item_id = p.id AND i.branch_id = ? WHERE p.track_stock = 1 AND p.deleted_at IS NULL
               UNION ALL SELECT 'วัตถุดิบ', g.name, IFNULL(i.qty,0), g.unit, g.min_stock, IFNULL(i.qty,0) * g.cost_per_unit FROM ingredients g LEFT JOIN inventory i ON i.item_type='ingredient' AND i.item_id = g.id AND i.branch_id = ? WHERE g.active = 1 ORDER BY 1, 2`, f.branch, f.branch)
      .map((x) => ({ ...x, low: x.min_stock > 0 && x.qty <= x.min_stock ? 'ต่ำกว่าขั้นต่ำ' : 'ปกติ' })),
  }) },
  ingredient: { title: 'รายงานการใช้วัตถุดิบ (Ingredient)', perm: 'stock.view', alias: 'sm', time: 'created_at', build: (f, req) => ({
    columns: [{ key: 'name', label: 'วัตถุดิบ' }, { key: 'unit', label: 'หน่วย' }, { key: 'used', label: 'ใช้ขาย', type: 'num' }, { key: 'waste', label: 'เสีย', type: 'num' }, { key: 'received', label: 'รับเข้า', type: 'num' }, ...(hasPerm(req, 'stock.view_cost') ? [{ key: 'cost', label: 'ต้นทุนที่ใช้', ...money }] : [])],
    rows: all(`SELECT g.name, g.unit, SUM(CASE WHEN sm.type IN ('sale') THEN -sm.qty WHEN sm.type = 'refund' THEN -sm.qty ELSE 0 END) used, SUM(CASE WHEN sm.type = 'waste' THEN -sm.qty ELSE 0 END) waste,
                      SUM(CASE WHEN sm.type IN ('in','po_receive') THEN sm.qty ELSE 0 END) received, SUM(CASE WHEN sm.type IN ('sale','refund','waste') THEN -sm.qty * sm.unit_cost ELSE 0 END) cost
               FROM stock_movements sm JOIN ingredients g ON g.id = sm.item_id WHERE sm.item_type = 'ingredient' AND ${f.sql} GROUP BY g.id ORDER BY used DESC`, ...f.p),
  }) },
  waste: { title: 'รายงานของเสีย (Waste)', perm: 'stock.view', alias: 'w', time: 'created_at', build: (f, req) => ({
    columns: [{ key: 'time', label: 'เวลา' }, { key: 'name', label: 'รายการ' }, { key: 'qty', label: 'จำนวน', type: 'num' }, { key: 'reason', label: 'สาเหตุ' }, ...(hasPerm(req, 'stock.view_cost') ? [{ key: 'cost', label: 'ต้นทุน', ...money }] : []), { key: 'staff', label: 'ผู้บันทึก' }, { key: 'note', label: 'หมายเหตุ' }],
    rows: all(`SELECT ${f.local} time, w.name, w.qty, w.reason, w.cost, s.employee_code staff, w.note FROM waste w LEFT JOIN staff s ON s.id = w.staff_id WHERE ${f.sql} ORDER BY w.id`, ...f.p)
      .map((x) => ({ ...x, reason: { expired: 'หมดอายุ', damaged: 'เสียหาย', wrong_preparation: 'ทำผิด', lost: 'สูญหาย', other: 'อื่นๆ' }[x.reason] || x.reason })),
  }) },
  cost: { title: 'รายงานต้นทุน (Cost / COGS)', perm: 'report.cost', build: (f) => ({
    columns: [{ key: 'day', label: 'วันที่' }, { key: 'cogs', label: 'ต้นทุนขาย', ...money }, { key: 'waste', label: 'ต้นทุนของเสีย', ...money }, { key: 'total', label: 'รวมต้นทุน', ...money }],
    rows: all(`SELECT date(${f.local}) day, SUM(cost_total) cogs FROM orders o WHERE ${SOLD} AND ${f.sql} GROUP BY day ORDER BY day`, ...f.p).map((x) => {
      const w = one(`SELECT IFNULL(SUM(cost),0) v FROM waste WHERE branch_id = ? AND date(datetime(created_at, '${f.off}')) = ?`, f.branch, x.day).v;
      return { ...x, waste: w, total: x.cogs + w };
    }),
  }) },
  profit: { title: 'รายงานกำไร (Profit)', perm: 'report.profit', build: (f) => ({
    columns: [{ key: 'day', label: 'วันที่' }, { key: 'net', label: 'ยอดขายสุทธิ (ไม่รวม VAT)', ...money }, { key: 'refunds', label: 'คืนเงิน', ...money }, { key: 'cogs', label: 'ต้นทุนขาย', ...money }, { key: 'gross_profit', label: 'กำไรขั้นต้น', ...money }, { key: 'margin', label: 'Margin %', type: 'pct' }],
    rows: all(`SELECT date(${f.local}) day, SUM(total - vat) net, SUM(refunded_total) refunds, SUM(cost_total) cogs FROM orders o WHERE ${SOLD} AND ${f.sql} GROUP BY day ORDER BY day`, ...f.p)
      .map((x) => { const gp = x.net - x.refunds - x.cogs; return { ...x, gross_profit: gp, margin: x.net ? (gp / x.net) * 100 : 0 }; }),
  }) },
};

export const REPORT_LIST = Object.entries(REPORTS).map(([key, v]) => ({ key, title: v.title, perm: v.perm }));

function runReport(req, key) {
  const def = REPORTS[key];
  if (!def) throw bad('ไม่พบรายงาน');
  if (!hasPerm(req, def.perm)) throw forbidden('ไม่มีสิทธิ์ดูรายงานนี้');
  const f = filters(req, def.alias || 'o', def.time || 'paid_at');
  f.branch = req.query.branchId === 'all' ? req.staff.branchId : Number(req.query.branchId) || req.staff.branchId;
  if (def.alias && def.alias !== 'o' && def.alias !== 'pt') {
    // these tables share branch_id; strip order-only filters already done in filters()
  }
  const out = def.build(f, req);
  const totals = {};
  for (const c of out.columns) if (c.type === 'money' || c.type === 'int' || c.type === 'num') totals[c.key] = out.rows.reduce((a, x) => a + (Number(x[c.key]) || 0), 0);
  for (const row of out.rows) for (const c of out.columns) if (c.type === 'money') row[c.key] = r2(row[c.key]);
  return { key, title: def.title, range: { from: f.from, to: f.to }, ...out, totals };
}

r.get('/reports', (req, res) => res.json(REPORT_LIST.filter((x) => hasPerm(req, x.perm))));
r.get('/reports/:key', (req, res) => {
  const rep = runReport(req, req.params.key);
  const format = req.query.format;
  if (!format || format === 'json') return res.json(rep);
  if (!hasPerm(req, 'report.export')) throw forbidden('ไม่มีสิทธิ์ Export');
  audit(req, 'report.export', { details: `${req.params.key} ${format} ${rep.range.from}..${rep.range.to}` });
  const fname = `${req.params.key}_${rep.range.from}_${rep.range.to}`;
  if (format === 'csv') return sendCsv(res, rep, fname);
  if (format === 'xlsx') return sendXlsx(res, rep, fname);
  if (format === 'pdf') return sendPdf(res, rep, fname, req);
  throw bad('format ไม่ถูกต้อง');
});

const cell = (c, v) => {
  if (v == null) return '';
  if (c.type === 'money') return Number(v).toFixed(2);
  if (c.type === 'pct') return `${Number(v).toFixed(1)}%`;
  if (c.type === 'num') return String(Math.round(Number(v) * 1000) / 1000);
  return String(v);
};

export function sendCsv(res, rep, fname) {
  const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [rep.columns.map((c) => esc(c.label)).join(',')];
  for (const row of rep.rows) lines.push(rep.columns.map((c) => esc(cell(c, row[c.key]))).join(','));
  if (Object.keys(rep.totals || {}).length) lines.push(rep.columns.map((c, i) => (i === 0 ? 'รวม' : rep.totals[c.key] != null ? cell(c, rep.totals[c.key]) : '')).map(esc).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${fname}.csv"`).send('﻿' + lines.join('\r\n'));
}

export async function sendXlsx(res, rep, fname) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'POS';
  const ws = wb.addWorksheet(rep.key || 'report');
  ws.addRow([rep.title]).font = { bold: true, size: 14, name: 'Sarabun' };
  if (rep.range) ws.addRow([`ช่วงวันที่ ${rep.range.from} ถึง ${rep.range.to}`]);
  ws.addRow([]);
  const header = ws.addRow(rep.columns.map((c) => c.label));
  header.font = { bold: true, name: 'Sarabun' };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F1F1' } };
  for (const row of rep.rows) {
    ws.addRow(rep.columns.map((c) => (['money', 'int', 'num', 'pct'].includes(c.type) ? Number(row[c.key]) || 0 : row[c.key] ?? ''))).font = { name: 'Sarabun' };
  }
  if (Object.keys(rep.totals || {}).length) {
    const t = ws.addRow(rep.columns.map((c, i) => (i === 0 ? 'รวม' : rep.totals[c.key] ?? '')));
    t.font = { bold: true, name: 'Sarabun' };
  }
  rep.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(12, Math.min(40, c.label.length * 2 + 4));
    if (c.type === 'money') col.numFmt = '#,##0.00';
  });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

export function sendPdf(res, rep, fname, req) {
  const doc = new PDFDocument({ size: 'A4', layout: rep.columns.length > 6 ? 'landscape' : 'portrait', margin: 36 });
  doc.registerFont('Sarabun', path.join(config.fontsDir, 'Sarabun-Regular.ttf'));
  doc.registerFont('Sarabun-Bold', path.join(config.fontsDir, 'Sarabun-Bold.ttf'));
  res.set('Content-Type', 'application/pdf').set('Content-Disposition', `attachment; filename="${fname}.pdf"`);
  doc.pipe(res);
  const shop = getSetting('shop');
  doc.font('Sarabun-Bold').fontSize(16).text(rep.title);
  doc.font('Sarabun').fontSize(10).text(`${shop.name}${rep.range ? ` · ${rep.range.from} ถึง ${rep.range.to}` : ''} · พิมพ์โดย ${req.staff.code} เมื่อ ${new Date().toLocaleString('th-TH', { timeZone: shop.timezone })}`);
  doc.moveDown(0.6);
  const W = doc.page.width - 72;
  const widths = rep.columns.map((c) => (['money', 'int', 'num', 'pct'].includes(c.type) ? 1 : 1.6));
  const sum = widths.reduce((a, b) => a + b, 0);
  const colW = widths.map((w) => (w / sum) * W);
  const drawRow = (vals, bold = false, fill = null) => {
    const h = 18;
    if (doc.y + h > doc.page.height - 40) doc.addPage();
    const y = doc.y;
    if (fill) doc.rect(36, y - 2, W, h).fill(fill).fillColor('#000');
    let x = 36;
    doc.font(bold ? 'Sarabun-Bold' : 'Sarabun').fontSize(8.5);
    vals.forEach((v, i) => {
      const c = rep.columns[i];
      doc.text(String(v ?? ''), x + 2, y, { width: colW[i] - 4, height: h, ellipsis: true, lineBreak: false, align: ['money', 'int', 'num', 'pct'].includes(c.type) ? 'right' : 'left' });
      x += colW[i];
    });
    doc.y = y + h;
  };
  drawRow(rep.columns.map((c) => c.label), true, '#EEEEEE');
  for (const row of rep.rows) drawRow(rep.columns.map((c) => (c.type === 'money' ? Number(row[c.key] || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : cell(c, row[c.key]))));
  if (Object.keys(rep.totals || {}).length) drawRow(rep.columns.map((c, i) => (i === 0 ? 'รวม' : rep.totals[c.key] != null ? (c.type === 'money' ? Number(rep.totals[c.key]).toLocaleString('th-TH', { minimumFractionDigits: 2 }) : cell(c, rep.totals[c.key])) : '')), true, '#F5F5F5');
  doc.end();
}

export default r;

// KDS (Kitchen Display System) + Queue Display
import { Router } from 'express';
import { z } from 'zod';
import { one, all, run, tx, json, afterCommit } from '../db/index.js';
import { parse, notFound } from '../lib/errors.js';
import { requireStaff, requirePerm, requireDevice } from '../middleware/auth.js';
import { refreshKitchenStatus } from '../services/orders.js';
import { emitBranch } from '../realtime.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';

const r = Router();

function kdsTickets(branchId, stationId, { includeDone = false } = {}) {
  const where = ["t.branch_id = ?", "t.created_at >= datetime('now', '-18 hours')", "o.status NOT IN ('voided','merged')"];
  const p = [branchId];
  if (stationId) { where.push('t.station_id = ?'); p.push(stationId); }
  if (!includeDone) where.push("t.status IN ('new','preparing','ready')");
  const tickets = all(`SELECT t.*, o.order_no, o.queue_no, o.type AS order_type, o.customer_name, o.note AS order_note, o.guests,
                              tb.number AS table_number, ks.name AS station_name, ks.color AS station_color,
                              COALESCE(s.nickname, s.first_name) AS staff_name, s.employee_code AS staff_code
                       FROM kitchen_tickets t JOIN orders o ON o.id = t.order_id
                       LEFT JOIN tables tb ON tb.id = o.table_id LEFT JOIN kitchen_stations ks ON ks.id = t.station_id
                       LEFT JOIN staff s ON s.id = t.created_by
                       WHERE ${where.join(' AND ')} ORDER BY t.created_at ASC LIMIT 200`, ...p);
  for (const t of tickets) {
    t.subs = all('SELECT * FROM kitchen_sub_tickets WHERE ticket_id = ? ORDER BY sub_index', t.id).map((s) => ({
      ...s, snapshot: json(s.items, []),
      items: all(`SELECT kti.*, oi.name, oi.variant_name, oi.note, oi.status AS item_status
                  FROM kitchen_ticket_items kti JOIN order_items oi ON oi.id = kti.order_item_id WHERE kti.sub_ticket_id = ? ORDER BY kti.id`, s.id)
        .map((it) => ({ ...it, modifiers: all('SELECT name, qty FROM order_item_modifiers WHERE order_item_id = ? ORDER BY id', it.order_item_id) })),
    }));
  }
  return tickets;
}

const kdsAuth = [requireDevice, requireStaff, requirePerm('kds.access')];

r.get('/kds/tickets', ...kdsAuth, (req, res) => {
  const stationId = req.query.stationId ? Number(req.query.stationId) : req.device.station_id || null;
  res.json({ tickets: kdsTickets(req.staff.branchId, stationId, { includeDone: req.query.done === '1' }), serverTime: new Date().toISOString() });
});

function ticketStatus(ticketId) {
  const st = all(`SELECT kti.status FROM kitchen_ticket_items kti JOIN kitchen_sub_tickets s ON s.id = kti.sub_ticket_id WHERE s.ticket_id = ? AND kti.status <> 'voided'`, ticketId).map((x) => x.status);
  if (!st.length) return 'voided';
  if (st.every((s) => s === 'served')) return 'served';
  if (st.every((s) => s === 'ready' || s === 'served')) return 'ready';
  if (st.some((s) => s !== 'new')) return 'preparing';
  return 'new';
}

function syncTicket(ticketId) {
  const t = one('SELECT * FROM kitchen_tickets WHERE id = ?', ticketId);
  const s = ticketStatus(ticketId);
  run(`UPDATE kitchen_tickets SET status = ?, started_at = CASE WHEN ? IN ('preparing','ready','served') THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
       ready_at = CASE WHEN ? IN ('ready','served') THEN COALESCE(ready_at, datetime('now')) ELSE NULL END,
       served_at = CASE WHEN ? = 'served' THEN COALESCE(served_at, datetime('now')) ELSE NULL END WHERE id = ?`, s, s, s, s, ticketId);
  for (const sub of all('SELECT id FROM kitchen_sub_tickets WHERE ticket_id = ?', ticketId)) {
    const ss = all("SELECT status FROM kitchen_ticket_items WHERE sub_ticket_id = ? AND status <> 'voided'", sub.id).map((x) => x.status);
    const v = !ss.length ? 'voided' : ss.every((x) => x === 'served') ? 'served' : ss.every((x) => x === 'ready' || x === 'served') ? 'ready' : ss.some((x) => x !== 'new') ? 'preparing' : 'new';
    run('UPDATE kitchen_sub_tickets SET status = ? WHERE id = ?', v, sub.id);
  }
  // order items kitchen_status mirrors the furthest KDS state
  for (const it of all('SELECT DISTINCT kti.order_item_id FROM kitchen_ticket_items kti JOIN kitchen_sub_tickets s ON s.id = kti.sub_ticket_id WHERE s.ticket_id = ?', ticketId)) {
    const ss = all("SELECT status FROM kitchen_ticket_items WHERE order_item_id = ? AND status <> 'voided'", it.order_item_id).map((x) => x.status);
    if (ss.length) run('UPDATE order_items SET kitchen_status = ? WHERE id = ?', ss.every((x) => x === 'served') ? 'served' : ss.every((x) => x === 'ready' || x === 'served') ? 'ready' : ss.some((x) => x !== 'new') ? 'preparing' : 'new', it.order_item_id);
  }
  refreshKitchenStatus(t.order_id);
  afterCommit(() => emitBranch(t.branch_id, 'kds:changed', { ticketId, orderId: t.order_id, status: s }));
  return s;
}

const statusSchema = z.object({ status: z.enum(['new', 'preparing', 'ready', 'served']) });

// bump a whole ticket (all its items)
r.post('/kds/tickets/:id/status', ...kdsAuth, requirePerm('kds.bump'), (req, res) => {
  const { status } = parse(statusSchema, req.body);
  const out = tx(() => {
    const t = one('SELECT * FROM kitchen_tickets WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
    if (!t) throw notFound();
    run(`UPDATE kitchen_ticket_items SET status = ?, updated_at = datetime('now')
         WHERE status <> 'voided' AND sub_ticket_id IN (SELECT id FROM kitchen_sub_tickets WHERE ticket_id = ?)`, status, t.id);
    audit(req, 'kds.ticket_status', { entity: 'kitchen_ticket', entityId: t.id, details: status });
    return syncTicket(t.id);
  });
  res.json({ status: out });
});
// bump a sub-ticket
r.post('/kds/subs/:id/status', ...kdsAuth, requirePerm('kds.bump'), (req, res) => {
  const { status } = parse(statusSchema, req.body);
  const out = tx(() => {
    const s = one('SELECT s.*, t.branch_id FROM kitchen_sub_tickets s JOIN kitchen_tickets t ON t.id = s.ticket_id WHERE s.id = ?', req.params.id);
    if (!s || s.branch_id !== req.staff.branchId) throw notFound();
    run("UPDATE kitchen_ticket_items SET status = ?, updated_at = datetime('now') WHERE sub_ticket_id = ? AND status <> 'voided'", status, s.id);
    return syncTicket(s.ticket_id);
  });
  res.json({ status: out });
});
// bump a single item
r.post('/kds/items/:id/status', ...kdsAuth, requirePerm('kds.bump'), (req, res) => {
  const { status } = parse(statusSchema, req.body);
  const out = tx(() => {
    const it = one(`SELECT kti.*, s.ticket_id, t.branch_id FROM kitchen_ticket_items kti JOIN kitchen_sub_tickets s ON s.id = kti.sub_ticket_id
                    JOIN kitchen_tickets t ON t.id = s.ticket_id WHERE kti.id = ?`, req.params.id);
    if (!it || it.branch_id !== req.staff.branchId) throw notFound();
    if (it.status === 'voided') return 'voided';
    run("UPDATE kitchen_ticket_items SET status = ?, updated_at = datetime('now') WHERE id = ?", status, it.id);
    return syncTicket(it.ticket_id);
  });
  res.json({ status: out });
});

// ── Queue display (takeaway / delivery orders) ───────────────────────────
function queueState(branchId) {
  const q = getSetting('queue', branchId);
  const rows = all(`SELECT id, order_no, queue_no, type, kitchen_status, status, customer_name, created_at, ready_at, called_at
                    FROM orders WHERE branch_id = ? AND queue_no IS NOT NULL AND status NOT IN ('voided','merged','refunded')
                    AND created_at >= datetime('now','-18 hours') AND kitchen_status <> 'served'
                    AND (status IN ('paid','partially_refunded') OR sent_at IS NOT NULL)
                    ORDER BY created_at`, branchId);
  const hideMs = (Number(q.readyHideMinutes) || 20) * 60e3;
  const now = Date.now();
  return {
    preparing: rows.filter((r) => ['none', 'new', 'preparing'].includes(r.kitchen_status)),
    ready: rows.filter((r) => r.kitchen_status === 'ready' && (!r.ready_at || now - new Date(r.ready_at.replace(' ', 'T') + 'Z').getTime() < hideMs)),
    settings: q,
  };
}

r.get('/queue', requireDevice, (req, res) => res.json(queueState(req.device.branch_id)));

// call queue (voice on Queue Display) — from POS or KDS
r.post('/queue/:orderId/call', requireStaff, requirePerm('queue.call', 'pos.access'), (req, res) => {
  const o = one('SELECT * FROM orders WHERE id = ? AND branch_id = ?', req.params.orderId, req.staff.branchId);
  if (!o) throw notFound();
  tx(() => {
    run("UPDATE orders SET called_at = datetime('now'), kitchen_status = CASE WHEN kitchen_status IN ('none','new','preparing') THEN 'ready' ELSE kitchen_status END, ready_at = COALESCE(ready_at, datetime('now')) WHERE id = ?", o.id);
    audit(req, 'queue.call', { entity: 'order', entityId: o.id, details: o.queue_no });
  });
  emitBranch(o.branch_id, 'queue:call', { orderId: o.id, queueNo: o.queue_no, orderNo: o.order_no });
  emitBranch(o.branch_id, 'queue:changed', { orderId: o.id });
  res.json({ ok: true });
});
// customer picked up → served
r.post('/queue/:orderId/served', requireStaff, requirePerm('queue.call', 'pos.access'), (req, res) => {
  const o = one('SELECT * FROM orders WHERE id = ? AND branch_id = ?', req.params.orderId, req.staff.branchId);
  if (!o) throw notFound();
  tx(() => {
    run("UPDATE kitchen_ticket_items SET status = 'served' WHERE status <> 'voided' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)", o.id);
    run("UPDATE kitchen_tickets SET status = 'served', served_at = datetime('now') WHERE order_id = ? AND status <> 'voided'", o.id);
    run("UPDATE orders SET kitchen_status = 'served' WHERE id = ?", o.id);
    audit(req, 'queue.served', { entity: 'order', entityId: o.id, details: o.queue_no });
  });
  emitBranch(o.branch_id, 'queue:changed', { orderId: o.id });
  emitBranch(o.branch_id, 'kds:changed', { orderId: o.id });
  res.json({ ok: true });
});

export default r;

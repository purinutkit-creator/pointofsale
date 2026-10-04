// Inventory: stock on hand, stock in/out/adjust, waste, ingredients, suppliers, purchase orders
import { Router } from 'express';
import { z } from 'zod';
import { one, all, run, insert, update, tx } from '../db/index.js';
import { parse, notFound, bad, conflict, forbidden } from '../lib/errors.js';
import { requireStaff, requirePerm, hasPerm } from '../middleware/auth.js';
import { moveStock, setStock, stockOf, unitCostOf } from '../services/inventory.js';
import { audit } from '../services/audit.js';
import { emitBranch } from '../realtime.js';
import { nextSeq } from '../services/orders.js';

const r = Router();
r.use(requireStaff);

const hideCost = (req, rows) => (hasPerm(req, 'stock.view_cost') ? rows : rows.map((x) => ({ ...x, cost: undefined, cost_per_unit: undefined, unit_cost: undefined, value: undefined })));

r.get('/inventory', requirePerm('stock.view'), (req, res) => {
  const b = Number(req.query.branchId) || req.staff.branchId;
  const products = all(`SELECT p.id, p.name, p.sku, p.min_stock, p.cost, 'product' AS item_type, 'ชิ้น' AS unit, IFNULL(i.qty,0) AS qty, c.name AS category_name,
                               (SELECT IFNULL(SUM(-qty),0) FROM stock_movements sm WHERE sm.branch_id = ? AND sm.item_type='product' AND sm.item_id = p.id AND sm.type = 'sale' AND sm.created_at >= datetime('now','-30 days')) AS sold_30d
                        FROM products p LEFT JOIN inventory i ON i.branch_id = ? AND i.item_type = 'product' AND i.item_id = p.id LEFT JOIN categories c ON c.id = p.category_id
                        WHERE p.deleted_at IS NULL AND p.track_stock = 1 ORDER BY p.name`, b, b);
  const ingredients = all(`SELECT g.id, g.name, g.sku, g.unit, g.min_stock, g.cost_per_unit AS cost, 'ingredient' AS item_type, IFNULL(i.qty,0) AS qty, s.name AS supplier_name,
                                  (SELECT IFNULL(SUM(-qty),0) FROM stock_movements sm WHERE sm.branch_id = ? AND sm.item_type='ingredient' AND sm.item_id = g.id AND sm.type = 'sale' AND sm.created_at >= datetime('now','-30 days')) AS sold_30d
                           FROM ingredients g LEFT JOIN inventory i ON i.branch_id = ? AND i.item_type = 'ingredient' AND i.item_id = g.id LEFT JOIN suppliers s ON s.id = g.supplier_id
                           WHERE g.active = 1 ORDER BY g.name`, b, b);
  const mark = (x) => ({ ...x, low: x.min_stock > 0 && x.qty <= x.min_stock, value: Math.round(x.qty * (x.cost || 0) * 100) / 100 });
  res.json({ products: hideCost(req, products.map(mark)), ingredients: hideCost(req, ingredients.map(mark)) });
});

r.get('/inventory/movements', requirePerm('stock.view'), (req, res) => {
  const { itemType, itemId, type, from, to } = req.query;
  const where = ['sm.branch_id = ?']; const p = [Number(req.query.branchId) || req.staff.branchId];
  if (itemType) { where.push('sm.item_type = ?'); p.push(itemType); }
  if (itemId) { where.push('sm.item_id = ?'); p.push(Number(itemId)); }
  if (type) { where.push('sm.type = ?'); p.push(type); }
  if (from) { where.push('sm.created_at >= ?'); p.push(from); }
  if (to) { where.push('sm.created_at <= ?'); p.push(to); }
  res.json(hideCost(req, all(`SELECT sm.*, CASE sm.item_type WHEN 'product' THEN (SELECT name FROM products WHERE id = sm.item_id) ELSE (SELECT name FROM ingredients WHERE id = sm.item_id) END AS item_name,
                                     CASE sm.item_type WHEN 'ingredient' THEN (SELECT unit FROM ingredients WHERE id = sm.item_id) ELSE 'ชิ้น' END AS unit,
                                     COALESCE(s.nickname, s.first_name) AS staff_name
                              FROM stock_movements sm LEFT JOIN staff s ON s.id = sm.staff_id WHERE ${where.join(' AND ')} ORDER BY sm.id DESC LIMIT 500`, ...p)));
});

const moveSchema = z.object({
  type: z.enum(['in', 'out', 'adjust']), reason: z.string().max(300).optional(),
  items: z.array(z.object({ itemType: z.enum(['product', 'ingredient']), itemId: z.number().int(), qty: z.number(), unitCost: z.number().min(0).optional() })).min(1).max(200),
});
r.post('/inventory/movements', (req, res) => {
  const b = parse(moveSchema, req.body);
  const perm = { in: 'stock.in', out: 'stock.out', adjust: 'stock.adjust' }[b.type];
  if (!hasPerm(req, perm)) throw forbidden(`ไม่มีสิทธิ์: ${perm}`);
  const branchId = req.staff.branchId;
  const out = tx(() => b.items.map((it) => {
    if (b.type === 'adjust') return { ...it, balance: setStock({ branchId, itemType: it.itemType, itemId: it.itemId, qty: it.qty, reason: b.reason || 'Stock count', staffId: req.staff.id }) };
    if (!(it.qty > 0)) throw bad('จำนวนต้องมากกว่า 0');
    if (b.type === 'in' && it.unitCost != null && it.itemType === 'ingredient') {
      // moving average cost
      const g = one('SELECT cost_per_unit FROM ingredients WHERE id = ?', it.itemId);
      const cur = Math.max(0, stockOf(branchId, 'ingredient', it.itemId));
      const avg = cur + it.qty > 0 ? (cur * g.cost_per_unit + it.qty * it.unitCost) / (cur + it.qty) : it.unitCost;
      run('UPDATE ingredients SET cost_per_unit = ? WHERE id = ?', Math.round(avg * 10000) / 10000, it.itemId);
    }
    const qty = b.type === 'in' ? it.qty : -it.qty;
    return { ...it, balance: moveStock({ branchId, itemType: it.itemType, itemId: it.itemId, qty, type: b.type, unitCost: it.unitCost ?? unitCostOf(it.itemType, it.itemId), reason: b.reason || null, staffId: req.staff.id }) };
  }));
  audit(req, `stock.${b.type}`, { details: `${b.items.length} items: ${b.reason || ''}` });
  emitBranch(branchId, 'stock:changed', {});
  res.json(out);
});

// ── Waste ─────────────────────────────────────────────────────────────────
r.get('/waste', requirePerm('stock.view'), (req, res) => {
  res.json(hideCost(req, all(`SELECT w.*, COALESCE(s.nickname, s.first_name) AS staff_name FROM waste w LEFT JOIN staff s ON s.id = w.staff_id WHERE w.branch_id = ? ORDER BY w.id DESC LIMIT 500`, req.staff.branchId)));
});
r.post('/waste', requirePerm('stock.waste'), (req, res) => {
  const b = parse(z.object({ itemType: z.enum(['product', 'ingredient']), itemId: z.number().int(), qty: z.number().positive(), reason: z.enum(['expired', 'damaged', 'wrong_preparation', 'lost', 'other']), note: z.string().max(300).optional() }), req.body);
  const branchId = req.staff.branchId;
  const out = tx(() => {
    const item = b.itemType === 'product' ? one('SELECT name FROM products WHERE id = ?', b.itemId) : one('SELECT name FROM ingredients WHERE id = ?', b.itemId);
    if (!item) throw notFound();
    const unitCost = unitCostOf(b.itemType, b.itemId);
    const id = insert('waste', { branch_id: branchId, item_type: b.itemType, item_id: b.itemId, name: item.name, qty: b.qty, unit_cost: unitCost, cost: Math.round(unitCost * b.qty * 100) / 100, reason: b.reason, note: b.note ?? null, staff_id: req.staff.id });
    // a wasted product with a recipe consumes its ingredients
    if (b.itemType === 'product') {
      const p = one('SELECT track_stock FROM products WHERE id = ?', b.itemId);
      if (p.track_stock) moveStock({ branchId, itemType: 'product', itemId: b.itemId, qty: -b.qty, type: 'waste', unitCost, refType: 'waste', refId: String(id), reason: b.reason, staffId: req.staff.id });
      for (const rc of all('SELECT * FROM recipes WHERE product_id = ? AND modifier_id IS NULL AND variant_id IS NULL', b.itemId)) {
        moveStock({ branchId, itemType: 'ingredient', itemId: rc.ingredient_id, qty: -rc.qty * b.qty, type: 'waste', unitCost: unitCostOf('ingredient', rc.ingredient_id), refType: 'waste', refId: String(id), reason: b.reason, staffId: req.staff.id });
      }
    } else moveStock({ branchId, itemType: 'ingredient', itemId: b.itemId, qty: -b.qty, type: 'waste', unitCost, refType: 'waste', refId: String(id), reason: b.reason, staffId: req.staff.id });
    return id;
  });
  audit(req, 'stock.waste', { entity: 'waste', entityId: out, details: `${b.qty} ${b.reason}` });
  emitBranch(branchId, 'stock:changed', {});
  res.json({ id: out });
});

// ── Ingredients ───────────────────────────────────────────────────────────
const ingSchema = z.object({ name: z.string().min(1).max(80), unit: z.string().min(1).max(20), costPerUnit: z.number().min(0).optional(), minStock: z.number().min(0).optional(), sku: z.string().max(40).optional().nullable(), supplierId: z.number().int().nullable().optional() });
r.get('/ingredients', requirePerm('stock.view', 'product.edit'), (req, res) => res.json(hideCost(req, all('SELECT g.*, g.cost_per_unit AS cost FROM ingredients g WHERE active = 1 ORDER BY name'))));
r.post('/ingredients', requirePerm('stock.in', 'stock.adjust', 'product.edit'), (req, res) => {
  const b = parse(ingSchema, req.body);
  const id = insert('ingredients', { name: b.name, unit: b.unit, cost_per_unit: b.costPerUnit ?? 0, min_stock: b.minStock ?? 0, sku: b.sku ?? null, supplier_id: b.supplierId ?? null });
  audit(req, 'ingredient.create', { entity: 'ingredient', entityId: id, details: b.name });
  res.json({ id });
});
r.put('/ingredients/:id', requirePerm('stock.adjust', 'product.edit'), (req, res) => {
  const b = parse(ingSchema, req.body);
  update('ingredients', Number(req.params.id), { name: b.name, unit: b.unit, cost_per_unit: hasPerm(req, 'stock.view_cost') ? b.costPerUnit ?? 0 : undefined, min_stock: b.minStock ?? 0, sku: b.sku ?? null, supplier_id: b.supplierId ?? null });
  res.json({ ok: true });
});
r.delete('/ingredients/:id', requirePerm('stock.adjust'), (req, res) => {
  if (one('SELECT COUNT(*) c FROM recipes WHERE ingredient_id = ?', req.params.id).c) throw conflict('วัตถุดิบนี้ถูกใช้ในสูตรสินค้า');
  run('UPDATE ingredients SET active = 0 WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ── Suppliers ─────────────────────────────────────────────────────────────
const supSchema = z.object({ name: z.string().min(1).max(120), contact: z.string().max(80).optional().nullable(), phone: z.string().max(30).optional().nullable(), email: z.string().max(120).optional().nullable(), address: z.string().max(400).optional().nullable(), taxId: z.string().max(20).optional().nullable(), note: z.string().max(400).optional().nullable() });
const supRow = (b) => ({ name: b.name, contact: b.contact ?? null, phone: b.phone ?? null, email: b.email ?? null, address: b.address ?? null, tax_id: b.taxId ?? null, note: b.note ?? null });
r.get('/suppliers', requirePerm('stock.supplier', 'stock.po', 'stock.view'), (_req, res) => res.json(all('SELECT * FROM suppliers WHERE active = 1 ORDER BY name')));
r.post('/suppliers', requirePerm('stock.supplier'), (req, res) => { const id = insert('suppliers', supRow(parse(supSchema, req.body))); audit(req, 'supplier.create', { entity: 'supplier', entityId: id }); res.json({ id }); });
r.put('/suppliers/:id', requirePerm('stock.supplier'), (req, res) => { update('suppliers', Number(req.params.id), supRow(parse(supSchema, req.body))); res.json({ ok: true }); });
r.delete('/suppliers/:id', requirePerm('stock.supplier'), (req, res) => { run('UPDATE suppliers SET active = 0 WHERE id = ?', req.params.id); res.json({ ok: true }); });

// ── Purchase orders ───────────────────────────────────────────────────────
const poSchema = z.object({
  supplierId: z.number().int().nullable().optional(), note: z.string().max(400).optional().nullable(), expectedAt: z.string().max(20).optional().nullable(),
  items: z.array(z.object({ itemType: z.enum(['product', 'ingredient']), itemId: z.number().int(), qty: z.number().positive(), unitCost: z.number().min(0) })).min(1).max(200),
});
const poDetail = (id) => {
  const po = one('SELECT po.*, s.name AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?', id);
  return po && { ...po, items: all('SELECT * FROM purchase_order_items WHERE po_id = ?', id) };
};
r.get('/purchase-orders', requirePerm('stock.po'), (req, res) => res.json(all(`SELECT po.*, s.name AS supplier_name, (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) AS item_count
  FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.branch_id = ? ORDER BY po.id DESC LIMIT 300`, req.staff.branchId)));
r.get('/purchase-orders/:id', requirePerm('stock.po'), (req, res) => { const po = poDetail(Number(req.params.id)); if (!po) throw notFound(); res.json(po); });
function savePoItems(poId, items) {
  run('DELETE FROM purchase_order_items WHERE po_id = ?', poId);
  let total = 0;
  for (const it of items) {
    const name = it.itemType === 'product' ? one('SELECT name FROM products WHERE id = ?', it.itemId)?.name : one('SELECT name FROM ingredients WHERE id = ?', it.itemId)?.name;
    if (!name) throw bad('ไม่พบสินค้า/วัตถุดิบ');
    insert('purchase_order_items', { po_id: poId, item_type: it.itemType, item_id: it.itemId, name, qty: it.qty, unit_cost: it.unitCost });
    total += it.qty * it.unitCost;
  }
  run('UPDATE purchase_orders SET total = ? WHERE id = ?', Math.round(total * 100) / 100, poId);
}
r.post('/purchase-orders', requirePerm('stock.po'), (req, res) => {
  const b = parse(poSchema, req.body);
  const id = tx(() => {
    const no = `PO${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(nextSeq(req.staff.branchId, 'po')).padStart(4, '0')}`;
    const id = insert('purchase_orders', { po_no: no, branch_id: req.staff.branchId, supplier_id: b.supplierId ?? null, note: b.note ?? null, expected_at: b.expectedAt ?? null, created_by: req.staff.id });
    savePoItems(id, b.items);
    return id;
  });
  audit(req, 'po.create', { entity: 'purchase_order', entityId: id });
  res.json(poDetail(id));
});
r.put('/purchase-orders/:id', requirePerm('stock.po'), (req, res) => {
  const b = parse(poSchema, req.body);
  const po = poDetail(Number(req.params.id));
  if (!po) throw notFound();
  if (!['draft', 'ordered'].includes(po.status)) throw conflict('แก้ไขได้เฉพาะ PO สถานะ Draft/Ordered');
  tx(() => { update('purchase_orders', po.id, { supplier_id: b.supplierId ?? null, note: b.note ?? null, expected_at: b.expectedAt ?? null }); savePoItems(po.id, b.items); });
  res.json(poDetail(po.id));
});
r.post('/purchase-orders/:id/status', requirePerm('stock.po'), (req, res) => {
  const b = parse(z.object({ status: z.enum(['ordered', 'cancelled']) }), req.body);
  const po = poDetail(Number(req.params.id));
  if (!po) throw notFound();
  if (b.status === 'ordered' && po.status !== 'draft') throw conflict('PO ต้องอยู่ในสถานะ Draft');
  if (b.status === 'cancelled' && ['received', 'cancelled'].includes(po.status)) throw conflict('ไม่สามารถยกเลิก PO นี้');
  run("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?", b.status, po.id);
  audit(req, `po.${b.status}`, { entity: 'purchase_order', entityId: po.id, details: po.po_no });
  res.json(poDetail(po.id));
});
// Receive (full or partial) → stock in + moving average cost
r.post('/purchase-orders/:id/receive', requirePerm('stock.in'), (req, res) => {
  const b = parse(z.object({ items: z.array(z.object({ id: z.number().int(), qty: z.number().min(0) })).min(1) }), req.body);
  const po = poDetail(Number(req.params.id));
  if (!po) throw notFound();
  if (!['ordered', 'partial', 'draft'].includes(po.status)) throw conflict('PO นี้ไม่สามารถรับสินค้าได้');
  tx(() => {
    for (const rcv of b.items) {
      const it = po.items.find((x) => x.id === rcv.id);
      if (!it || rcv.qty <= 0) continue;
      const qty = Math.min(rcv.qty, it.qty - it.received_qty);
      if (qty <= 0) continue;
      if (it.item_type === 'ingredient') {
        const g = one('SELECT cost_per_unit FROM ingredients WHERE id = ?', it.item_id);
        const cur = Math.max(0, stockOf(po.branch_id, 'ingredient', it.item_id));
        const avg = (cur * g.cost_per_unit + qty * it.unit_cost) / (cur + qty);
        run('UPDATE ingredients SET cost_per_unit = ? WHERE id = ?', Math.round(avg * 10000) / 10000, it.item_id);
      } else run('UPDATE products SET cost = ? WHERE id = ? AND cost = 0', it.unit_cost, it.item_id);
      moveStock({ branchId: po.branch_id, itemType: it.item_type, itemId: it.item_id, qty, type: 'po_receive', unitCost: it.unit_cost, refType: 'po', refId: String(po.id), reason: po.po_no, staffId: req.staff.id });
      run('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?', qty, it.id);
    }
    const left = one('SELECT COUNT(*) c FROM purchase_order_items WHERE po_id = ? AND received_qty < qty', po.id).c;
    run("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?", left ? 'partial' : 'received', po.id);
  });
  audit(req, 'po.receive', { entity: 'purchase_order', entityId: po.id, details: po.po_no });
  emitBranch(po.branch_id, 'stock:changed', {});
  res.json(poDetail(po.id));
});

export default r;

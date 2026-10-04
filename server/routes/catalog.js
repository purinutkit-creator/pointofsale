import { Router } from 'express';
import { z } from 'zod';
import { one, all, run, insert, update, tx } from '../db/index.js';
import { parse, notFound, bad, conflict } from '../lib/errors.js';
import { requireStaff, requirePerm, hasPerm } from '../middleware/auth.js';
import { posCatalog, branchProducts, modifierGroups, categories } from '../services/catalog.js';
import { audit } from '../services/audit.js';
import { emitBranch, emitAll } from '../realtime.js';
import { notifyStaff } from '../services/notify.js';

const r = Router();
r.use(requireStaff);

const changed = (branchId) => (branchId ? emitBranch(branchId, 'catalog:changed', {}) : emitAll('catalog:changed', {}));

r.get('/catalog', (req, res) => res.json(posCatalog(req.staff.branchId)));

// ── Categories ────────────────────────────────────────────────────────────
const catSchema = z.object({
  name: z.string().min(1).max(80), nameEn: z.string().max(80).optional().nullable(), color: z.string().max(20).optional().nullable(),
  imageUrl: z.string().max(1000).optional().nullable(), sortOrder: z.number().int().optional(), stationId: z.number().int().nullable().optional(),
  printerId: z.number().int().nullable().optional(), scExempt: z.boolean().optional(), pointMultiplier: z.number().min(0).max(100).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const catRow = (b) => ({ name: b.name, name_en: b.nameEn ?? null, color: b.color ?? null, image_url: b.imageUrl ?? null, sort_order: b.sortOrder ?? 0, station_id: b.stationId ?? null, printer_id: b.printerId ?? null, sc_exempt: b.scExempt ? 1 : 0, point_multiplier: b.pointMultiplier ?? null, status: b.status || 'active' });

r.get('/categories', (_req, res) => res.json(categories({ includeInactive: true })));
r.post('/categories', requirePerm('product.category'), (req, res) => {
  const b = parse(catSchema, req.body);
  const id = insert('categories', catRow(b));
  audit(req, 'category.create', { entity: 'category', entityId: id, details: b.name });
  changed(); res.json({ id });
});
r.put('/categories/:id', requirePerm('product.category'), (req, res) => {
  const b = parse(catSchema, req.body);
  update('categories', Number(req.params.id), catRow(b));
  audit(req, 'category.update', { entity: 'category', entityId: req.params.id, details: b.name });
  changed(); res.json({ ok: true });
});
r.post('/categories/reorder', requirePerm('product.category'), (req, res) => {
  const ids = parse(z.array(z.number().int()), req.body.ids);
  tx(() => ids.forEach((id, i) => run('UPDATE categories SET sort_order = ? WHERE id = ?', i, id)));
  changed(); res.json({ ok: true });
});
r.delete('/categories/:id', requirePerm('product.category'), (req, res) => {
  const id = Number(req.params.id);
  const n = one('SELECT COUNT(*) c FROM products WHERE category_id = ? AND deleted_at IS NULL', id).c;
  if (n) throw conflict(`ไม่สามารถลบได้ มีสินค้า ${n} รายการในหมวดนี้`);
  run("UPDATE categories SET deleted_at = datetime('now') WHERE id = ?", id);
  audit(req, 'category.delete', { entity: 'category', entityId: id });
  changed(); res.json({ ok: true });
});

// ── Products ──────────────────────────────────────────────────────────────
const productSchema = z.object({
  sku: z.string().max(40).optional().nullable(), barcode: z.string().max(60).optional().nullable(),
  name: z.string().min(1).max(120), nameEn: z.string().max(120).optional().nullable(), description: z.string().max(500).optional().nullable(),
  imageUrl: z.string().max(1000).optional().nullable(), categoryId: z.number().int().nullable().optional(),
  price: z.number().min(0), cost: z.number().min(0).optional(), vatExempt: z.boolean().optional(), scExempt: z.boolean().optional(),
  trackStock: z.boolean().optional(), minStock: z.number().min(0).optional(), autoSoldOut: z.boolean().optional(),
  stationId: z.number().int().nullable().optional(), printerId: z.number().int().nullable().optional(),
  cutMode: z.enum(['none', 'cut_after', 'cut_before', 'separate', 'each_qty']).optional(),
  pointMultiplier: z.number().min(0).max(100).nullable().optional(), noPromotion: z.boolean().optional(),
  status: z.enum(['available', 'sold_out', 'unavailable']).optional(), sortOrder: z.number().int().optional(),
  variants: z.array(z.object({ id: z.number().int().optional(), name: z.string().min(1).max(60), priceDelta: z.number(), sku: z.string().max(40).optional().nullable(), barcode: z.string().max(60).optional().nullable(), isDefault: z.boolean().optional() })).max(30).optional(),
  modifierGroupIds: z.array(z.number().int()).max(30).optional(),
  branchPrices: z.array(z.object({ branchId: z.number().int(), price: z.number().min(0).nullable(), status: z.enum(['available', 'sold_out', 'unavailable']).nullable().optional(), hidden: z.boolean().optional() })).optional(),
  recipe: z.array(z.object({ ingredientId: z.number().int(), qty: z.number().positive(), variantId: z.number().int().nullable().optional() })).optional(),
});

r.get('/products', (req, res) => res.json(branchProducts(Number(req.query.branchId) || req.staff.branchId, { includeHidden: true })));
r.get('/products/:id', (req, res) => {
  const p = one('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', req.params.id);
  if (!p) throw notFound();
  res.json({
    ...p,
    variants: all('SELECT * FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY sort_order, id', p.id),
    modifierGroupIds: all('SELECT group_id FROM product_modifier_groups WHERE product_id = ? ORDER BY sort_order', p.id).map((x) => x.group_id),
    branchPrices: all('SELECT * FROM product_branches WHERE product_id = ?', p.id),
    recipe: all('SELECT r.*, i.name AS ingredient_name, i.unit FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.product_id = ? AND r.modifier_id IS NULL', p.id),
  });
});

function saveProduct(req, id, b) {
  return tx(() => {
    if (b.sku) {
      const dup = one('SELECT id FROM products WHERE sku = ? AND deleted_at IS NULL AND id <> ?', b.sku, id || 0);
      if (dup) throw conflict(`SKU ${b.sku} ซ้ำกับสินค้าอื่น`);
    }
    if (id) {
      const cur = one('SELECT * FROM products WHERE id = ?', id);
      if (!cur) throw notFound();
      if (cur.price !== b.price && !hasPerm(req, 'product.edit_price')) throw bad('ไม่มีสิทธิ์แก้ราคา');
    }
    const row = {
      sku: b.sku || null, barcode: b.barcode || null, name: b.name, name_en: b.nameEn ?? null, description: b.description ?? null, image_url: b.imageUrl ?? null,
      category_id: b.categoryId ?? null, price: b.price, cost: b.cost ?? 0, vat_exempt: b.vatExempt ? 1 : 0, sc_exempt: b.scExempt ? 1 : 0,
      track_stock: b.trackStock ? 1 : 0, min_stock: b.minStock ?? 0, auto_sold_out: b.autoSoldOut === false ? 0 : 1, station_id: b.stationId ?? null,
      printer_id: b.printerId ?? null, cut_mode: b.cutMode || 'none', point_multiplier: b.pointMultiplier ?? null, no_promotion: b.noPromotion ? 1 : 0,
      status: b.status || 'available', sort_order: b.sortOrder ?? 0,
    };
    if (id) { update('products', id, { ...row, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }); } else id = insert('products', row);
    if (b.variants) {
      const keep = [];
      b.variants.forEach((v, i) => {
        if (v.id && one('SELECT id FROM product_variants WHERE id = ? AND product_id = ?', v.id, id)) {
          update('product_variants', v.id, { name: v.name, price_delta: v.priceDelta, sku: v.sku ?? null, barcode: v.barcode ?? null, is_default: v.isDefault ? 1 : 0, sort_order: i, active: 1 });
          keep.push(v.id);
        } else keep.push(insert('product_variants', { product_id: id, name: v.name, price_delta: v.priceDelta, sku: v.sku ?? null, barcode: v.barcode ?? null, is_default: v.isDefault ? 1 : 0, sort_order: i }));
      });
      run(`UPDATE product_variants SET active = 0 WHERE product_id = ? ${keep.length ? `AND id NOT IN (${keep.join(',')})` : ''}`, id);
    }
    if (b.modifierGroupIds) {
      run('DELETE FROM product_modifier_groups WHERE product_id = ?', id);
      b.modifierGroupIds.forEach((g, i) => run('INSERT INTO product_modifier_groups (product_id, group_id, sort_order) VALUES (?, ?, ?)', id, g, i));
    }
    if (b.branchPrices) {
      for (const bp of b.branchPrices) {
        if (bp.price == null && !bp.status && !bp.hidden) run('DELETE FROM product_branches WHERE product_id = ? AND branch_id = ?', id, bp.branchId);
        else run(`INSERT INTO product_branches (product_id, branch_id, price, status, hidden) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(product_id, branch_id) DO UPDATE SET price = excluded.price, status = excluded.status, hidden = excluded.hidden`, id, bp.branchId, bp.price, bp.status ?? null, bp.hidden ? 1 : 0);
      }
    }
    if (b.recipe) {
      run('DELETE FROM recipes WHERE product_id = ? AND modifier_id IS NULL', id);
      for (const x of b.recipe) insert('recipes', { product_id: id, variant_id: x.variantId ?? null, ingredient_id: x.ingredientId, qty: x.qty });
    }
    return id;
  });
}

r.post('/products', requirePerm('product.create'), (req, res) => {
  const b = parse(productSchema, req.body);
  const id = saveProduct(req, null, b);
  audit(req, 'product.create', { entity: 'product', entityId: id, details: `${b.name} ${b.price}` });
  changed(); res.json({ id });
});
r.put('/products/:id', requirePerm('product.edit'), (req, res) => {
  const b = parse(productSchema, req.body);
  const before = one('SELECT name, price FROM products WHERE id = ?', req.params.id);
  saveProduct(req, Number(req.params.id), b);
  audit(req, 'product.update', { entity: 'product', entityId: req.params.id, details: `${b.name}${before && before.price !== b.price ? ` ราคา ${before.price} → ${b.price}` : ''}` });
  changed(); res.json({ ok: true });
});
r.delete('/products/:id', requirePerm('product.delete'), (req, res) => {
  run("UPDATE products SET deleted_at = datetime('now') WHERE id = ?", req.params.id);
  audit(req, 'product.delete', { entity: 'product', entityId: req.params.id });
  changed(); res.json({ ok: true });
});
// quick Sold Out toggle (branch level)
r.post('/products/:id/status', requirePerm('product.sold_out'), (req, res) => {
  const b = parse(z.object({ status: z.enum(['available', 'sold_out', 'unavailable']), scope: z.enum(['branch', 'all']).optional() }), req.body);
  const id = Number(req.params.id);
  const p = one('SELECT name FROM products WHERE id = ?', id);
  if (!p) throw notFound();
  if (b.scope === 'all') { update('products', id, { status: b.status }); run('UPDATE product_branches SET status = NULL WHERE product_id = ?', id); } else {
    run(`INSERT INTO product_branches (product_id, branch_id, status) VALUES (?, ?, ?)
         ON CONFLICT(product_id, branch_id) DO UPDATE SET status = excluded.status`, id, req.staff.branchId, b.status);
  }
  audit(req, 'product.status', { entity: 'product', entityId: id, details: `${p.name}: ${b.status}` });
  if (b.status === 'sold_out') notifyStaff(req.staff.branchId, 'sold_out', 'warning', `สินค้าหมด: ${p.name}`, `ตั้งค่าโดย ${req.staff.displayName}`, { productId: id });
  changed(req.staff.branchId); emitAll('catalog:changed', {}); res.json({ ok: true });
});

// ── Modifier groups ───────────────────────────────────────────────────────
const groupSchema = z.object({
  name: z.string().min(1).max(60), required: z.boolean().optional(), multiple: z.boolean().optional(), min: z.number().int().min(0).max(50).optional(),
  max: z.number().int().min(0).max(50).optional(), allowQty: z.boolean().optional(), sortOrder: z.number().int().optional(),
  modifiers: z.array(z.object({ id: z.number().int().optional(), name: z.string().min(1).max(60), price: z.number(), isDefault: z.boolean().optional(),
    recipe: z.array(z.object({ ingredientId: z.number().int(), qty: z.number().positive() })).optional() })).max(60),
});
r.get('/modifier-groups', (_req, res) => {
  const groups = modifierGroups();
  for (const g of groups) for (const m of g.modifiers) m.recipe = all('SELECT ingredient_id AS ingredientId, qty FROM recipes WHERE modifier_id = ?', m.id);
  res.json(groups);
});
function saveGroup(id, b) {
  return tx(() => {
    const row = { name: b.name, required: b.required ? 1 : 0, multiple: b.multiple ? 1 : 0, min_select: b.min ?? (b.required ? 1 : 0), max_select: b.max ?? (b.multiple ? b.modifiers.length : 1), allow_qty: b.allowQty ? 1 : 0, sort_order: b.sortOrder ?? 0 };
    if (row.min_select > row.max_select && row.max_select > 0) throw bad('Min ต้องไม่มากกว่า Max');
    if (id) update('modifier_groups', id, row); else id = insert('modifier_groups', row);
    const keep = [];
    b.modifiers.forEach((m, i) => {
      let mid = m.id;
      if (mid && one('SELECT id FROM modifiers WHERE id = ? AND group_id = ?', mid, id)) update('modifiers', mid, { name: m.name, price: m.price, is_default: m.isDefault ? 1 : 0, sort_order: i, active: 1 });
      else mid = insert('modifiers', { group_id: id, name: m.name, price: m.price, is_default: m.isDefault ? 1 : 0, sort_order: i });
      keep.push(mid);
      if (m.recipe) {
        run('DELETE FROM recipes WHERE modifier_id = ?', mid);
        for (const x of m.recipe) insert('recipes', { modifier_id: mid, ingredient_id: x.ingredientId, qty: x.qty });
      }
    });
    run(`UPDATE modifiers SET active = 0 WHERE group_id = ? ${keep.length ? `AND id NOT IN (${keep.join(',')})` : ''}`, id);
    return id;
  });
}
r.post('/modifier-groups', requirePerm('product.modifier'), (req, res) => {
  const id = saveGroup(null, parse(groupSchema, req.body));
  audit(req, 'modifier_group.create', { entity: 'modifier_group', entityId: id });
  changed(); res.json({ id });
});
r.put('/modifier-groups/:id', requirePerm('product.modifier'), (req, res) => {
  saveGroup(Number(req.params.id), parse(groupSchema, req.body));
  audit(req, 'modifier_group.update', { entity: 'modifier_group', entityId: req.params.id });
  changed(); res.json({ ok: true });
});
r.delete('/modifier-groups/:id', requirePerm('product.modifier'), (req, res) => {
  run("UPDATE modifier_groups SET deleted_at = datetime('now') WHERE id = ?", req.params.id);
  run('DELETE FROM product_modifier_groups WHERE group_id = ?', req.params.id);
  audit(req, 'modifier_group.delete', { entity: 'modifier_group', entityId: req.params.id });
  changed(); res.json({ ok: true });
});

// ── Kitchen stations ──────────────────────────────────────────────────────
r.get('/stations', (req, res) => res.json(all('SELECT * FROM kitchen_stations WHERE active = 1 AND (branch_id IS NULL OR branch_id = ?) ORDER BY sort_order, id', req.staff.branchId)));
const stationSchema = z.object({ name: z.string().min(1).max(60), code: z.string().min(1).max(20), color: z.string().max(20).optional().nullable(), sortOrder: z.number().int().optional(), branchId: z.number().int().nullable().optional() });
r.post('/stations', requirePerm('settings.printer'), (req, res) => {
  const b = parse(stationSchema, req.body);
  const id = insert('kitchen_stations', { name: b.name, code: b.code, color: b.color ?? null, sort_order: b.sortOrder ?? 0, branch_id: b.branchId ?? null });
  audit(req, 'station.create', { entity: 'station', entityId: id, details: b.name });
  changed(); res.json({ id });
});
r.put('/stations/:id', requirePerm('settings.printer'), (req, res) => {
  const b = parse(stationSchema, req.body);
  update('kitchen_stations', Number(req.params.id), { name: b.name, code: b.code, color: b.color ?? null, sort_order: b.sortOrder ?? 0, branch_id: b.branchId ?? null });
  changed(); res.json({ ok: true });
});
r.delete('/stations/:id', requirePerm('settings.printer'), (req, res) => {
  update('kitchen_stations', Number(req.params.id), { active: 0 });
  audit(req, 'station.delete', { entity: 'station', entityId: req.params.id });
  changed(); res.json({ ok: true });
});

// ── Zones & Tables (Floor plan) ───────────────────────────────────────────
r.get('/floor', (req, res) => {
  const branchId = req.staff.branchId;
  const tables = all(`SELECT t.*, o.id AS order_id, o.order_no, o.status AS order_status, o.kitchen_status, o.total, o.guests AS order_guests,
                             o.created_at AS order_created_at, o.paid_total,
                             (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.status = 'draft') AS draft_items
                      FROM tables t LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('open','held')
                      WHERE t.branch_id = ? AND t.active = 1 ORDER BY t.number`, branchId);
  for (const t of tables) {
    // ว่าง / มีลูกค้า / รออาหาร / พร้อมคิดเงิน / จอง / ทำความสะอาด
    if (t.order_id) {
      if (t.kitchen_status === 'new' || t.kitchen_status === 'preparing') t.state = 'waiting_food';
      else if (t.kitchen_status === 'ready' || t.kitchen_status === 'served') t.state = 'ready_to_pay';
      else t.state = 'occupied';
    } else t.state = t.manual_status === 'reserved' ? 'reserved' : t.manual_status === 'cleaning' ? 'cleaning' : 'available';
  }
  res.json({ zones: all('SELECT * FROM zones WHERE branch_id = ? AND active = 1 ORDER BY sort_order, id', branchId), tables });
});
r.post('/zones', requirePerm('table.manage'), (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(40), sortOrder: z.number().int().optional() }), req.body);
  const id = insert('zones', { branch_id: req.staff.branchId, name: b.name, sort_order: b.sortOrder ?? 0 });
  changed(req.staff.branchId); res.json({ id });
});
r.put('/zones/:id', requirePerm('table.manage'), (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(40), sortOrder: z.number().int().optional() }), req.body);
  run('UPDATE zones SET name = ?, sort_order = ? WHERE id = ? AND branch_id = ?', b.name, b.sortOrder ?? 0, req.params.id, req.staff.branchId);
  changed(req.staff.branchId); res.json({ ok: true });
});
r.delete('/zones/:id', requirePerm('table.manage'), (req, res) => {
  run('UPDATE zones SET active = 0 WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  run('UPDATE tables SET zone_id = NULL WHERE zone_id = ?', req.params.id);
  changed(req.staff.branchId); res.json({ ok: true });
});
const tableSchema = z.object({ zoneId: z.number().int().nullable().optional(), number: z.string().min(1).max(20), seats: z.number().int().min(1).max(100), shape: z.enum(['square', 'round', 'rect']), posX: z.number().optional(), posY: z.number().optional(), width: z.number().min(40).max(600).optional(), height: z.number().min(40).max(600).optional() });
r.post('/tables', requirePerm('table.manage'), (req, res) => {
  const b = parse(tableSchema, req.body);
  if (one('SELECT id FROM tables WHERE branch_id = ? AND number = ? AND active = 1', req.staff.branchId, b.number)) throw conflict(`โต๊ะ ${b.number} มีอยู่แล้ว`);
  const id = insert('tables', { branch_id: req.staff.branchId, zone_id: b.zoneId ?? null, number: b.number, seats: b.seats, shape: b.shape, pos_x: b.posX ?? 20, pos_y: b.posY ?? 20, width: b.width ?? 90, height: b.height ?? 90 });
  audit(req, 'table.create', { entity: 'table', entityId: id, details: b.number });
  changed(req.staff.branchId); res.json({ id });
});
r.put('/tables/:id', requirePerm('table.manage'), (req, res) => {
  const b = parse(tableSchema, req.body);
  const dup = one('SELECT id FROM tables WHERE branch_id = ? AND number = ? AND active = 1 AND id <> ?', req.staff.branchId, b.number, Number(req.params.id));
  if (dup) throw conflict(`โต๊ะ ${b.number} มีอยู่แล้ว`);
  run('UPDATE tables SET zone_id = ?, number = ?, seats = ?, shape = ?, pos_x = ?, pos_y = ?, width = ?, height = ? WHERE id = ? AND branch_id = ?',
    b.zoneId ?? null, b.number, b.seats, b.shape, b.posX ?? 20, b.posY ?? 20, b.width ?? 90, b.height ?? 90, Number(req.params.id), req.staff.branchId);
  changed(req.staff.branchId); res.json({ ok: true });
});
r.post('/tables/layout', requirePerm('table.manage'), (req, res) => {
  const list = parse(z.array(z.object({ id: z.number().int(), posX: z.number(), posY: z.number(), width: z.number().optional(), height: z.number().optional() })), req.body.tables);
  tx(() => list.forEach((t) => run('UPDATE tables SET pos_x = ?, pos_y = ?, width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ? AND branch_id = ?', t.posX, t.posY, t.width ?? null, t.height ?? null, t.id, req.staff.branchId)));
  changed(req.staff.branchId); res.json({ ok: true });
});
r.delete('/tables/:id', requirePerm('table.manage'), (req, res) => {
  if (one("SELECT id FROM orders WHERE table_id = ? AND status IN ('open','held')", req.params.id)) throw conflict('โต๊ะนี้มีบิลเปิดอยู่');
  run('UPDATE tables SET active = 0 WHERE id = ? AND branch_id = ?', req.params.id, req.staff.branchId);
  changed(req.staff.branchId); res.json({ ok: true });
});

export default r;

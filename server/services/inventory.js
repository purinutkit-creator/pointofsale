// Inventory: product stock, ingredient stock (recipes), movements, low-stock alerts.
import { one, all, run, insert, afterCommit } from '../db/index.js';
import { notifyStaff } from './notify.js';

export function stockOf(branchId, itemType, itemId) {
  return Number(one('SELECT qty FROM inventory WHERE branch_id = ? AND item_type = ? AND item_id = ?', branchId, itemType, itemId)?.qty || 0);
}

/**
 * Apply a signed stock change and record the movement. Must run inside a transaction when part of a sale.
 * @returns new balance
 */
export function moveStock({ branchId, itemType, itemId, qty, type, unitCost = 0, refType = null, refId = null, reason = null, staffId = null }) {
  if (!qty) return stockOf(branchId, itemType, itemId);
  run(`INSERT INTO inventory (branch_id, item_type, item_id, qty, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(branch_id, item_type, item_id) DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at`,
  branchId, itemType, itemId, qty);
  const balance = stockOf(branchId, itemType, itemId);
  insert('stock_movements', { branch_id: branchId, item_type: itemType, item_id: itemId, type, qty, balance, unit_cost: unitCost, ref_type: refType, ref_id: refId, reason, staff_id: staffId });
  if (qty < 0) checkLow(branchId, itemType, itemId, balance);
  return balance;
}

/** Set absolute stock (stock count adjustment). */
export function setStock({ branchId, itemType, itemId, qty, reason, staffId }) {
  const cur = stockOf(branchId, itemType, itemId);
  return moveStock({ branchId, itemType, itemId, qty: qty - cur, type: 'adjust', reason, staffId, unitCost: unitCostOf(itemType, itemId) });
}

export function unitCostOf(itemType, itemId) {
  if (itemType === 'ingredient') return Number(one('SELECT cost_per_unit FROM ingredients WHERE id = ?', itemId)?.cost_per_unit || 0);
  return productUnitCost(itemId, null, []);
}

function checkLow(branchId, itemType, itemId, balance) {
  if (itemType === 'product') {
    const p = one('SELECT id, name, min_stock, auto_sold_out, status FROM products WHERE id = ?', itemId);
    if (!p) return;
    if (balance <= 0 && p.auto_sold_out) {
      run(`INSERT INTO product_branches (product_id, branch_id, status) VALUES (?, ?, 'sold_out')
           ON CONFLICT(product_id, branch_id) DO UPDATE SET status = 'sold_out'`, p.id, branchId);
      afterCommit(() => notifyStaff(branchId, 'sold_out', 'warning', `สินค้าหมด: ${p.name}`, 'ระบบตั้งสถานะ Sold Out อัตโนมัติ', { productId: p.id }, `sold_out:${branchId}:${p.id}:${new Date().toISOString().slice(0, 10)}`));
    } else if (p.min_stock > 0 && balance <= p.min_stock) {
      afterCommit(() => notifyStaff(branchId, 'stock_low', 'warning', `Stock ต่ำ: ${p.name}`, `คงเหลือ ${balance}`, { productId: p.id }, `low:${branchId}:p${p.id}:${new Date().toISOString().slice(0, 10)}`));
    }
  } else {
    const i = one('SELECT id, name, unit, min_stock FROM ingredients WHERE id = ?', itemId);
    if (i && i.min_stock > 0 && balance <= i.min_stock) {
      afterCommit(() => notifyStaff(branchId, 'stock_low', 'warning', `วัตถุดิบใกล้หมด: ${i.name}`, `คงเหลือ ${balance} ${i.unit}`, { ingredientId: i.id }, `low:${branchId}:i${i.id}:${new Date().toISOString().slice(0, 10)}`));
    }
  }
}

/** Ingredient requirements for one unit of an order item (base recipe + variant + modifiers). */
export function recipeFor(productId, variantId, modifiers) {
  const rows = all('SELECT * FROM recipes WHERE product_id = ? AND (variant_id IS NULL OR variant_id = ?) AND modifier_id IS NULL', productId, variantId ?? -1);
  const need = new Map();
  for (const r of rows) need.set(r.ingredient_id, (need.get(r.ingredient_id) || 0) + r.qty);
  for (const m of modifiers || []) {
    if (!m.modifier_id && !m.modifierId) continue;
    for (const r of all('SELECT * FROM recipes WHERE modifier_id = ?', m.modifier_id ?? m.modifierId)) {
      need.set(r.ingredient_id, (need.get(r.ingredient_id) || 0) + r.qty * (m.qty || 1));
    }
  }
  return need;
}

/** Cost of one unit: explicit product cost, else Σ recipe ingredient costs. */
export function productUnitCost(productId, variantId, modifiers) {
  const p = one('SELECT cost FROM products WHERE id = ?', productId);
  const costOf = (need) => {
    let c = 0;
    for (const [ingId, qty] of need) c += qty * Number(one('SELECT cost_per_unit FROM ingredients WHERE id = ?', ingId)?.cost_per_unit || 0);
    return c;
  };
  const baseCost = Number(p?.cost) > 0 ? Number(p.cost) : costOf(recipeFor(productId, variantId, []));
  const modCost = modifiers?.length ? costOf(recipeFor(-1, null, modifiers)) : 0;
  return Math.round((baseCost + modCost) * 100) / 100;
}

/** Deduct stock for sold items (product stock and/or recipe ingredients). sign=-1 sale, +1 return */
export function applyItemsStock({ branchId, items, sign = -1, type = 'sale', refType = 'order', refId, staffId }) {
  for (const it of items) {
    const qty = Number(it.qty);
    if (!it.product_id || !qty) continue;
    const p = one('SELECT id, track_stock FROM products WHERE id = ?', it.product_id);
    if (!p) continue;
    if (p.track_stock) moveStock({ branchId, itemType: 'product', itemId: p.id, qty: sign * qty, type, unitCost: it.unit_cost || 0, refType, refId, staffId });
    const mods = it.modifiers || all('SELECT modifier_id, qty FROM order_item_modifiers WHERE order_item_id = ?', it.id);
    for (const [ingId, perUnit] of recipeFor(p.id, it.variant_id, mods)) {
      const cost = Number(one('SELECT cost_per_unit FROM ingredients WHERE id = ?', ingId)?.cost_per_unit || 0);
      moveStock({ branchId, itemType: 'ingredient', itemId: ingId, qty: sign * perUnit * qty, type, unitCost: cost, refType, refId, staffId });
    }
  }
}

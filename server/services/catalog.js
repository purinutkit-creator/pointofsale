import { all, one, json } from '../db/index.js';

/** Products resolved for a branch (branch price/status override + stock). */
export function branchProducts(branchId, { includeHidden = false } = {}) {
  const rows = all(`
    SELECT p.*, pb.price AS b_price, pb.status AS b_status, pb.hidden AS b_hidden,
           c.name AS category_name, c.station_id AS c_station_id, c.printer_id AS c_printer_id,
           c.sc_exempt AS c_sc_exempt, c.point_multiplier AS c_point_multiplier,
           inv.qty AS stock_qty
    FROM products p
    LEFT JOIN product_branches pb ON pb.product_id = p.id AND pb.branch_id = ?
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory inv ON inv.branch_id = ? AND inv.item_type = 'product' AND inv.item_id = p.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.sort_order, p.name`, branchId, branchId);
  const variants = all('SELECT * FROM product_variants WHERE active = 1 ORDER BY sort_order, id');
  const links = all('SELECT * FROM product_modifier_groups ORDER BY sort_order');
  const vBy = groupBy(variants, 'product_id');
  const lBy = groupBy(links, 'product_id');
  return rows
    .filter((r) => includeHidden || !r.b_hidden)
    .map((r) => shapeProduct(r, vBy[r.id] || [], (lBy[r.id] || []).map((l) => l.group_id)));
}

function shapeProduct(r, variants, groupIds) {
  return {
    id: r.id, sku: r.sku, barcode: r.barcode, name: r.name, nameEn: r.name_en, description: r.description,
    imageUrl: r.image_url, categoryId: r.category_id, categoryName: r.category_name,
    price: r.b_price ?? r.price, basePrice: r.price, branchPrice: r.b_price, cost: r.cost,
    vatExempt: !!r.vat_exempt, scExempt: !!r.sc_exempt || !!r.c_sc_exempt,
    trackStock: !!r.track_stock, minStock: r.min_stock, autoSoldOut: !!r.auto_sold_out,
    stock: r.track_stock ? Number(r.stock_qty || 0) : null,
    stationId: r.station_id ?? r.c_station_id ?? null,
    printerId: r.printer_id ?? r.c_printer_id ?? null,
    ownStationId: r.station_id, ownPrinterId: r.printer_id,
    cutMode: r.cut_mode,
    pointMultiplier: r.point_multiplier ?? r.c_point_multiplier ?? null,
    noPromotion: !!r.no_promotion,
    status: r.b_status || r.status, globalStatus: r.status, branchStatus: r.b_status, hidden: !!r.b_hidden,
    sortOrder: r.sort_order,
    variants: variants.map((v) => ({ id: v.id, name: v.name, priceDelta: v.price_delta, sku: v.sku, barcode: v.barcode, isDefault: !!v.is_default })),
    modifierGroupIds: groupIds,
  };
}

export function modifierGroups() {
  const groups = all('SELECT * FROM modifier_groups WHERE deleted_at IS NULL ORDER BY sort_order, id');
  const mods = groupBy(all('SELECT * FROM modifiers WHERE active = 1 ORDER BY sort_order, id'), 'group_id');
  return groups.map((g) => ({
    id: g.id, name: g.name, required: !!g.required, multiple: !!g.multiple,
    min: g.min_select, max: g.max_select, allowQty: !!g.allow_qty, sortOrder: g.sort_order,
    modifiers: (mods[g.id] || []).map((m) => ({ id: m.id, name: m.name, price: m.price, isDefault: !!m.is_default })),
  }));
}

export function categories({ includeInactive = false } = {}) {
  return all(`SELECT * FROM categories WHERE deleted_at IS NULL ${includeInactive ? '' : "AND status = 'active'"} ORDER BY sort_order, id`)
    .map((c) => ({ id: c.id, name: c.name, nameEn: c.name_en, color: c.color, imageUrl: c.image_url, sortOrder: c.sort_order, stationId: c.station_id, printerId: c.printer_id, scExempt: !!c.sc_exempt, pointMultiplier: c.point_multiplier, status: c.status }));
}

export function activePromotions() {
  return all('SELECT * FROM promotions WHERE active = 1').map(shapePromotion);
}
export function shapePromotion(p) {
  return { ...p, rule: json(p.rule, {}), conditions: json(p.conditions, {}), stackable: !!p.stackable, active: !!p.active, auto_apply: !!p.auto_apply };
}

export function tiers() {
  const rules = groupBy(all('SELECT * FROM tier_rules'), 'tier_id');
  return all('SELECT * FROM member_tiers WHERE active = 1 ORDER BY min_points, sort_order').map((t) => ({ ...t, rules: rules[t.id] || [] }));
}

/** Full catalog snapshot for POS (also cached offline in IndexedDB). */
export function posCatalog(branchId) {
  return {
    categories: categories(),
    products: branchProducts(branchId),
    modifierGroups: modifierGroups(),
    stations: all('SELECT * FROM kitchen_stations WHERE active = 1 AND (branch_id IS NULL OR branch_id = ?) ORDER BY sort_order, id', branchId),
    zones: all('SELECT * FROM zones WHERE branch_id = ? AND active = 1 ORDER BY sort_order, id', branchId),
    tables: all('SELECT * FROM tables WHERE branch_id = ? AND active = 1 ORDER BY number', branchId),
    promotions: activePromotions(),
    tiers: tiers(),
    printers: all('SELECT id, name, role, connection, host_device_id, paper, dots_width, render_mode, codepage, has_cutter, cut_type, feed_lines, has_drawer, drawer_pin, beep, kitchen_copies, status, address FROM printers WHERE branch_id = ? AND active = 1', branchId),
    routes: all('SELECT r.* FROM printer_routes r JOIN printers p ON p.id = r.printer_id WHERE p.branch_id = ?', branchId),
    generatedAt: new Date().toISOString(),
  };
}

export function groupBy(rows, key) {
  const out = {};
  for (const r of rows) (out[r[key]] ||= []).push(r);
  return out;
}

export function productForBranch(productId, branchId) {
  const r = one(`
    SELECT p.*, pb.price AS b_price, pb.status AS b_status, pb.hidden AS b_hidden,
           c.station_id AS c_station_id, c.printer_id AS c_printer_id, c.sc_exempt AS c_sc_exempt,
           c.point_multiplier AS c_point_multiplier, c.name AS category_name, inv.qty AS stock_qty
    FROM products p
    LEFT JOIN product_branches pb ON pb.product_id = p.id AND pb.branch_id = ?
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory inv ON inv.branch_id = ? AND inv.item_type = 'product' AND inv.item_id = p.id
    WHERE p.id = ?`, branchId, branchId, productId);
  if (!r) return null;
  return shapeProduct(r, all('SELECT * FROM product_variants WHERE product_id = ? AND active = 1', r.id),
    all('SELECT group_id FROM product_modifier_groups WHERE product_id = ? ORDER BY sort_order', r.id).map((x) => x.group_id));
}

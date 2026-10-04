// ─────────────────────────────────────────────────────────────────────────────
// Order service — the heart of the POS.
// Prices are always re-derived from the database (never trusted from clients),
// totals always come from shared/calc.js, and every mutating call is idempotent
// (client generated UUIDs for orders/items, idempotency keys for payments/refunds).
// ─────────────────────────────────────────────────────────────────────────────
import { config } from '../config.js';
import { one, all, run, insert, tx, afterCommit, json, sqlNow } from '../db/index.js';
import { uuid, randomToken } from '../lib/security.js';
import { bad, conflict, notFound, forbidden } from '../lib/errors.js';
import { calculate, unitPriceOf } from '../../shared/calc.js';
import { evaluatePromotions } from '../../shared/promotions.js';
import { computeEarnPoints } from '../../shared/points.js';
import { planKitchenTickets, expandCopies } from '../../shared/kitchen.js';
import { businessDate } from '../../shared/format.js';
import { toSatang, toBaht } from '../../shared/money.js';
import { getSetting, calcSettings } from './settings.js';
import { productForBranch, activePromotions } from './catalog.js';
import { applyItemsStock, productUnitCost } from './inventory.js';
import { pointTx, recomputeTier, consumeRedemption, releaseRedemption, getMember } from './loyalty.js';
import { createPrintJob, receiptPrinterFor, kitchenTargets, shopHeader } from './printing.js';
import { notifyStaff } from './notify.js';
import { audit } from './audit.js';
import { emitBranch } from '../realtime.js';
import { gate, hasPerm } from '../middleware/auth.js';

const PAYMENT_PERM = { cash: 'payment.cash', qr: 'payment.qr', credit_card: 'payment.card', debit_card: 'payment.card', transfer: 'payment.other', ewallet: 'payment.other', other: 'payment.other', points: 'member.use_points' };

export function nextSeq(branchId, name, period = '') {
  run(`INSERT INTO sequences (branch_id, name, period, value) VALUES (?, ?, ?, 1)
       ON CONFLICT(branch_id, name, period) DO UPDATE SET value = value + 1`, branchId, name, period);
  return one('SELECT value FROM sequences WHERE branch_id = ? AND name = ? AND period = ?', branchId, name, period).value;
}

const tzOf = (branchId) => one('SELECT timezone FROM branches WHERE id = ?', branchId)?.timezone || getSetting('shop').timezone;

// ── Loading ───────────────────────────────────────────────────────────────
export function loadOrder(id) {
  const o = one(`SELECT o.*, t.number AS table_number, z.name AS zone_name, s.employee_code AS staff_code,
                        COALESCE(s.nickname, s.first_name) AS staff_name, d.name AS device_name
                 FROM orders o
                 LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN zones z ON z.id = t.zone_id
                 LEFT JOIN staff s ON s.id = o.staff_id LEFT JOIN pos_devices d ON d.id = o.device_id
                 WHERE o.id = ?`, id);
  if (!o) return null;
  const items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY seq, created_at', id);
  const mods = all('SELECT m.* FROM order_item_modifiers m JOIN order_items i ON i.id = m.order_item_id WHERE i.order_id = ? ORDER BY m.id', id);
  const byItem = {};
  for (const m of mods) (byItem[m.order_item_id] ||= []).push({ id: m.id, modifierId: m.modifier_id, groupId: m.group_id, groupName: m.group_name, name: m.name, price: m.price, qty: m.qty });
  return {
    ...o,
    bill_discounts: json(o.bill_discounts, []), coupon_codes: json(o.coupon_codes, []), promotions: json(o.promotions, []),
    calc: json(o.calc, null),
    items: items.map((it) => ({ ...it, discounts: json(it.discounts, []), modifiers: byItem[it.id] || [] })),
    member: o.member_id ? memberSummary(o.member_id) : null,
    payments: all('SELECT * FROM payment_transactions WHERE order_id = ? ORDER BY id', id),
    receipts: all('SELECT id, receipt_no, doc_type, total, created_at, claim_status FROM receipts WHERE order_id = ? ORDER BY id', id),
  };
}

function memberSummary(memberId) {
  const m = getMember(memberId);
  if (!m) return null;
  return { id: m.id, memberCode: m.member_code, name: m.name, phone: m.phone, points: m.points, tierId: m.tier_id, tierName: m.tier_name, tierColor: m.tier_color, tierDiscountPct: m.tier_discount_pct, tierPointMultiplier: m.tier_point_multiplier };
}

// ── Recalculation (single source: shared/calc.js) ─────────────────────────
export function recalcOrder(orderId) {
  const o = one('SELECT * FROM orders WHERE id = ?', orderId);
  const items = all(`SELECT i.*, p.vat_exempt, p.sc_exempt AS p_sc_exempt, p.no_promotion, p.point_multiplier AS p_mult,
                            c.sc_exempt AS c_sc_exempt, c.point_multiplier AS c_mult
                     FROM order_items i LEFT JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.category_id
                     WHERE i.order_id = ? AND i.status <> 'voided' ORDER BY i.seq`, orderId);
  const member = o.member_id ? one('SELECT m.*, t.discount_pct, t.point_multiplier AS tier_mult FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = ?', o.member_id) : null;
  const tz = tzOf(o.branch_id);
  const couponCodes = json(o.coupon_codes, []);
  const lines = items.map((it) => ({
    key: it.id, productId: it.product_id, categoryId: it.category_id, unitPrice: it.unit_price, qty: it.qty,
    noPromotion: !!it.no_promotion || !!it.reward_redemption_id || it.price_override != null,
  }));
  const promo = evaluatePromotions(lines, activePromotions(), { timezone: tz, branchId: o.branch_id, member, orderType: o.type, couponCodes, now: o.paid_at ? new Date(o.paid_at.replace(' ', 'T') + 'Z') : new Date() });

  const calcItems = items.map((it) => ({
    key: it.id, unitPrice: it.unit_price, qty: it.qty, vatExempt: !!it.vat_exempt, scExempt: !!it.p_sc_exempt || !!it.c_sc_exempt,
    discounts: [...json(it.discounts, []), ...(promo.itemDiscounts[it.id] || [])],
  }));
  const stored = json(o.bill_discounts, []);
  const bill = [
    ...promo.billDiscounts,
    ...stored.filter((d) => d.source === 'manual'),
    ...stored.filter((d) => d.source === 'reward'),
  ];
  if (member?.discount_pct > 0) bill.push({ type: 'pct', value: member.discount_pct, label: `ส่วนลดสมาชิก ${member.discount_pct}%`, source: 'tier' });
  const pts = getSetting('points');
  let pointsUsed = 0;
  if (member && o.points_to_use > 0 && pts.pointValue > 0) {
    pointsUsed = Math.min(o.points_to_use, Math.max(0, member.points));
    bill.push({ type: 'amount', value: pointsUsed * pts.pointValue, label: `ใช้ ${pointsUsed} แต้ม`, source: 'points' });
  }
  const calc = calculate({ items: calcItems, billDiscounts: bill, settings: calcSettings(o.branch_id), orderType: o.type, scExempt: !!o.sc_exempt });
  const multipliers = Object.fromEntries(items.map((it) => [it.id, it.reward_redemption_id ? 0 : (it.p_mult ?? it.c_mult ?? 1)]));
  const earn = member ? computeEarnPoints(calc, multipliers, pts, { tierMultiplier: member.tier_mult || 1, promoMultiplier: promo.pointMultiplier, bonusPoints: promo.bonusPoints }) : null;
  // points a non-member would earn (for "scan QR to collect" on the receipt)
  const guestEarn = computeEarnPoints(calc, multipliers, pts, { promoMultiplier: promo.pointMultiplier, bonusPoints: promo.bonusPoints });
  const full = { ...calc, promotions: promo.applied, pointsUsed, earnPoints: earn?.points ?? 0, guestEarnPoints: guestEarn.points };

  for (const l of calc.lines) {
    run('UPDATE order_items SET discount = ?, line_total = ? WHERE id = ?', toBaht(toSatang(l.itemDiscount) + toSatang(l.billDiscount)), l.total, l.key);
  }
  const cost = items.reduce((a, it) => a + (it.unit_cost || 0) * it.qty, 0);
  run(`UPDATE orders SET subtotal = ?, discount = ?, service_charge = ?, vat = ?, total = ?, cost_total = ?, calc = ?, promotions = ?, updated_at = datetime('now') WHERE id = ?`,
    calc.subtotal, calc.discount, calc.serviceCharge, calc.vat, calc.total, Math.round(cost * 100) / 100, JSON.stringify(full), JSON.stringify(promo.applied), orderId);
  return full;
}

// ── Save (create / update header + draft items) ───────────────────────────
function priceItem(branchId, input) {
  const p = productForBranch(input.productId, branchId);
  if (!p) throw bad('ไม่พบสินค้า', 'PRODUCT_NOT_FOUND');
  let variant = null;
  if (p.variants.length) {
    variant = p.variants.find((v) => v.id === input.variantId) || p.variants.find((v) => v.isDefault) || (input.variantId ? null : p.variants[0]);
    if (!variant) throw bad(`ตัวเลือกของ ${p.name} ไม่ถูกต้อง`);
  }
  const groups = p.modifierGroupIds.length ? all(`SELECT * FROM modifier_groups WHERE id IN (${p.modifierGroupIds.map(() => '?').join(',')}) AND deleted_at IS NULL`, ...p.modifierGroupIds) : [];
  const chosen = [];
  for (const m of input.modifiers || []) {
    const row = one('SELECT m.*, g.name AS group_name FROM modifiers m JOIN modifier_groups g ON g.id = m.group_id WHERE m.id = ? AND m.active = 1', m.modifierId);
    if (!row || !groups.some((g) => g.id === row.group_id)) throw bad(`ตัวเลือกไม่ถูกต้องสำหรับ ${p.name}`, 'MODIFIER_INVALID');
    chosen.push({ modifier_id: row.id, group_id: row.group_id, group_name: row.group_name, name: row.name, price: row.price, qty: Math.max(1, Math.floor(m.qty || 1)) });
  }
  for (const g of groups) {
    const n = chosen.filter((c) => c.group_id === g.id).reduce((a, c) => a + (g.allow_qty ? c.qty : 1), 0);
    const min = g.required ? Math.max(1, g.min_select) : g.min_select;
    if (n < min) throw bad(`กรุณาเลือก "${g.name}" อย่างน้อย ${min} รายการ`, 'MODIFIER_REQUIRED');
    const max = g.multiple ? g.max_select || 99 : 1;
    if (n > max) throw bad(`"${g.name}" เลือกได้สูงสุด ${max} รายการ`, 'MODIFIER_MAX');
  }
  const unit = unitPriceOf({ basePrice: p.price, variantPrice: variant?.priceDelta || 0, modifiers: chosen, priceOverride: input.priceOverride });
  return { product: p, variant, modifiers: chosen, unit };
}

function checkItemDiscounts(req, discounts, gross, existing) {
  const manual = (discounts || []).filter((d) => !d.source || d.source === 'manual');
  if (JSON.stringify(manual) === JSON.stringify((existing || []).filter((d) => !d.source || d.source === 'manual'))) return manual;
  if (manual.length && !hasPerm(req, 'discount.item')) gate(req, 'discount_over_limit', { perm: 'discount.item' });
  for (const d of manual) {
    const pct = d.type === 'pct' ? Number(d.value) : gross > 0 ? (Number(d.value) / gross) * 100 : 100;
    if (pct > req.staff.maxDiscountPct + 1e-9) gate(req, 'discount_over_limit', { force: true });
  }
  return manual.map((d) => ({ type: d.type === 'pct' ? 'pct' : 'amount', value: Math.max(0, Number(d.value) || 0), label: d.label || 'ส่วนลด', source: 'manual' }));
}

export function saveOrder(req, body) {
  const branchId = req.staff.branchId;
  return tx(() => {
    let o = body.id ? one('SELECT * FROM orders WHERE id = ?', body.id) : null;
    const isNew = !o;
    if (o && o.branch_id !== branchId) throw forbidden('Order นี้อยู่สาขาอื่น');
    if (o && !['open', 'held'].includes(o.status)) throw conflict('บิลนี้ปิดแล้ว ไม่สามารถแก้ไขได้', 'ORDER_CLOSED', { status: o.status });
    if (o && body.version && body.version !== o.version && !body.merge) {
      throw conflict('มีการแก้ไขบิลนี้จากเครื่องอื่น กรุณาโหลดใหม่', 'ORDER_CONFLICT', { order: loadOrder(o.id) });
    }
    const type = body.type || o?.type || 'takeaway';
    if (!['dine_in', 'takeaway', 'delivery'].includes(type)) throw bad('ประเภทบิลไม่ถูกต้อง');
    if (o && type !== o.type && !hasPerm(req, 'pos.change_type')) throw forbidden('ไม่มีสิทธิ์เปลี่ยนประเภทบิล');
    const tableId = type === 'dine_in' ? (body.tableId ?? o?.table_id ?? null) : null;
    if (tableId) {
      const t = one('SELECT * FROM tables WHERE id = ? AND branch_id = ? AND active = 1', tableId, branchId);
      if (!t) throw bad('ไม่พบโต๊ะ');
      const other = one("SELECT id, order_no FROM orders WHERE table_id = ? AND status IN ('open','held') AND id <> ?", tableId, body.id || '');
      if (other) throw conflict(`โต๊ะ ${t.number} มีบิลเปิดอยู่แล้ว (#${other.order_no})`, 'TABLE_OCCUPIED', { orderId: other.id });
      if (o && o.table_id && o.table_id !== tableId && !hasPerm(req, 'pos.move_table')) throw forbidden('ไม่มีสิทธิ์ย้ายโต๊ะ');
    }
    const tz = tzOf(branchId);
    if (isNew) {
      if (!hasPerm(req, 'pos.open_order')) throw forbidden('ไม่มีสิทธิ์เปิด Order');
      const id = body.id || uuid();
      const created = body.offline?.createdAt ? new Date(body.offline.createdAt) : new Date();
      const bd = businessDate(created, tz);
      const orderNo = body.offline?.orderNo || String(nextSeq(branchId, 'order', bd)).padStart(4, '0');
      const shift = req.device ? one("SELECT id FROM shifts WHERE device_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", req.device.id) : null;
      insert('orders', {
        id, order_no: orderNo, business_date: bd, branch_id: branchId, device_id: req.device?.id ?? null, shift_id: shift?.id ?? null,
        staff_id: req.staff.id, type, table_id: tableId, guests: body.guests ?? null, customer_name: body.customerName ?? null,
        customer_phone: body.customerPhone ?? null, note: body.note ?? null, offline: body.offline ? 1 : 0,
        created_at: sqlNow(created), status: 'open',
      });
      o = one('SELECT * FROM orders WHERE id = ?', id);
      audit(req, 'order.create', { entity: 'order', entityId: id, details: `#${orderNo} ${type}` });
    }
    // queue number for takeaway/delivery (kept forever once assigned)
    let queueNo = o.queue_no;
    if (!queueNo && type !== 'dine_in') {
      const b = one('SELECT queue_prefix FROM branches WHERE id = ?', branchId);
      queueNo = body.offline?.queueNo || `${b?.queue_prefix ?? 'Q'}${String(nextSeq(branchId, 'queue', o.business_date)).padStart(3, '0')}`;
    }
    // header
    const coupons = body.couponCodes ?? json(o.coupon_codes, []);
    if (JSON.stringify(coupons) !== o.coupon_codes && coupons.length) {
      const manualPromo = coupons.some((c) => c.startsWith('#'));
      if (manualPromo && !hasPerm(req, 'discount.promotion')) throw forbidden('ไม่มีสิทธิ์ใช้ Promotion');
      if (coupons.some((c) => !c.startsWith('#')) && !hasPerm(req, 'discount.coupon')) throw forbidden('ไม่มีสิทธิ์ใช้ Coupon');
    }
    let billDiscounts = json(o.bill_discounts, []);
    if (body.billDiscounts) {
      const manual = body.billDiscounts.filter((d) => !d.source || d.source === 'manual')
        .map((d) => ({ type: d.type === 'pct' ? 'pct' : 'amount', value: Math.max(0, Number(d.value) || 0), label: d.label || 'ส่วนลดท้ายบิล', source: 'manual' }));
      const before = billDiscounts.filter((d) => d.source === 'manual');
      if (JSON.stringify(manual) !== JSON.stringify(before)) {
        if (manual.length && !hasPerm(req, 'discount.bill')) gate(req, 'discount_over_limit', { perm: 'discount.bill', orderId: o.id });
        const sub = Number(o.subtotal) || 0;
        for (const d of manual) {
          const pct = d.type === 'pct' ? d.value : sub > 0 ? (d.value / sub) * 100 : 0;
          if (pct > req.staff.maxDiscountPct + 1e-9) gate(req, 'discount_over_limit', { force: true, orderId: o.id });
        }
        audit(req, 'discount.bill', { entity: 'order', entityId: o.id, details: JSON.stringify(manual) });
      }
      billDiscounts = [...billDiscounts.filter((d) => d.source !== 'manual'), ...manual];
    }
    let scExempt = o.sc_exempt;
    if (body.scExempt != null && !!body.scExempt !== !!o.sc_exempt) {
      if (body.scExempt) gate(req, 'sc_exempt', { orderId: o.id });
      scExempt = body.scExempt ? 1 : 0;
      audit(req, 'order.sc_exempt', { entity: 'order', entityId: o.id, details: String(scExempt) });
    }
    let pointsToUse = o.points_to_use;
    if (body.pointsToUse != null && body.pointsToUse !== o.points_to_use) {
      if (body.pointsToUse > 0 && !hasPerm(req, 'member.use_points')) throw forbidden('ไม่มีสิทธิ์ใช้แต้ม');
      pointsToUse = Math.max(0, Math.floor(body.pointsToUse));
    }
    run(`UPDATE orders SET type = ?, table_id = ?, queue_no = ?, guests = ?, customer_name = ?, customer_phone = ?, note = ?,
           coupon_codes = ?, bill_discounts = ?, sc_exempt = ?, points_to_use = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`,
    type, tableId, queueNo, body.guests ?? o.guests, body.customerName ?? o.customer_name, body.customerPhone ?? o.customer_phone,
    body.note ?? o.note, JSON.stringify(coupons), JSON.stringify(billDiscounts), scExempt, pointsToUse, o.id);
    if (o.table_id && o.table_id !== tableId) audit(req, 'table.move', { entity: 'order', entityId: o.id, details: `${o.table_id} → ${tableId}` });

    // items
    if (Array.isArray(body.items)) {
      const existing = new Map(all('SELECT * FROM order_items WHERE order_id = ?', o.id).map((r) => [r.id, r]));
      const seen = new Set();
      let seq = Number(one('SELECT IFNULL(MAX(seq),0) s FROM order_items WHERE order_id = ?', o.id).s);
      for (const input of body.items) {
        const id = input.id || uuid();
        seen.add(id);
        const ex = existing.get(id);
        if (ex && ex.order_id !== o.id) throw conflict('รายการซ้ำกับบิลอื่น');
        if (ex && (ex.status !== 'draft' || ex.reward_redemption_id)) continue; // sent / reward lines are immutable here
        if (!ex) {
          const other = one('SELECT order_id FROM order_items WHERE id = ?', id);
          if (other) continue; // already moved/merged elsewhere (offline replay)
        }
        const qty = Number(input.qty);
        if (!(qty > 0) || qty > 9999) throw bad('จำนวนไม่ถูกต้อง');
        if (!ex && !hasPerm(req, 'pos.add_item')) throw forbidden('ไม่มีสิทธิ์เพิ่มสินค้า');
        const priced = priceItem(branchId, input);
        if (!ex && priced.product.status !== 'available' && !body.offline) throw conflict(`${priced.product.name} ${priced.product.status === 'sold_out' ? 'หมดแล้ว (Sold Out)' : 'งดจำหน่ายชั่วคราว'}`, 'SOLD_OUT', { productId: priced.product.id });
        const override = input.priceOverride === '' || input.priceOverride == null ? null : Number(input.priceOverride);
        if (override != null && override !== (ex?.price_override ?? null)) {
          if (!(override >= 0)) throw bad('ราคาไม่ถูกต้อง');
          const g = gate(req, 'override_price', { orderId: o.id });
          audit(req, 'item.override_price', { entity: 'order', entityId: o.id, details: `${priced.product.name}: ${override}`, approvedBy: g.approvedBy });
        }
        if (ex && ex.qty !== qty && !hasPerm(req, 'pos.edit_qty')) throw forbidden('ไม่มีสิทธิ์แก้จำนวน');
        const discounts = checkItemDiscounts(req, input.discounts, priced.unit * qty, ex ? json(ex.discounts, []) : []);
        const row = {
          product_id: priced.product.id, variant_id: priced.variant?.id ?? null, name: priced.product.name,
          variant_name: priced.variant?.name ?? null, category_id: priced.product.categoryId, station_id: priced.product.stationId,
          qty, base_price: priced.product.price, variant_price: priced.variant?.priceDelta || 0, unit_price: priced.unit,
          price_override: override, discounts, note: input.note ?? null,
          unit_cost: productUnitCost(priced.product.id, priced.variant?.id, priced.modifiers),
        };
        if (ex) {
          run(`UPDATE order_items SET product_id=?, variant_id=?, name=?, variant_name=?, category_id=?, station_id=?, qty=?, base_price=?, variant_price=?,
               unit_price=?, price_override=?, discounts=?, note=?, unit_cost=? WHERE id = ?`,
          row.product_id, row.variant_id, row.name, row.variant_name, row.category_id, row.station_id, row.qty, row.base_price, row.variant_price,
          row.unit_price, row.price_override, JSON.stringify(row.discounts), row.note, row.unit_cost, id);
          run('DELETE FROM order_item_modifiers WHERE order_item_id = ?', id);
        } else {
          insert('order_items', { id, order_id: o.id, seq: ++seq, ...row, status: 'draft', added_by: req.staff.id });
        }
        for (const m of priced.modifiers) insert('order_item_modifiers', { order_item_id: id, ...m });
      }
      if (!body.merge) {
        for (const [id, ex] of existing) {
          if (seen.has(id) || ex.status !== 'draft' || ex.reward_redemption_id) continue;
          if (!hasPerm(req, 'pos.remove_item')) throw forbidden('ไม่มีสิทธิ์ลบสินค้า');
          run('DELETE FROM order_items WHERE id = ?', id);
        }
      }
    }
    if (body.status === 'held' && o.status !== 'held') {
      if (!hasPerm(req, 'pos.hold_bill')) throw forbidden('ไม่มีสิทธิ์พักบิล');
      run("UPDATE orders SET status = 'held', held_at = datetime('now') WHERE id = ?", o.id);
      audit(req, 'order.hold', { entity: 'order', entityId: o.id });
    } else if (body.status === 'open' && o.status === 'held') {
      if (!hasPerm(req, 'pos.retrieve_bill')) throw forbidden('ไม่มีสิทธิ์เรียกบิล');
      run("UPDATE orders SET status = 'open', held_at = NULL WHERE id = ?", o.id);
      audit(req, 'order.retrieve', { entity: 'order', entityId: o.id });
    }
    recalcOrder(o.id);
    const after = one('SELECT paid_total, total FROM orders WHERE id = ?', o.id);
    if (after.paid_total > 0 && toSatang(after.total) < toSatang(after.paid_total)) throw conflict('ยอดบิลต่ำกว่ายอดที่ชำระไปแล้ว', 'BELOW_PAID');
    const full = loadOrder(o.id);
    afterCommit(() => emitBranch(branchId, 'order:updated', { id: o.id, status: full.status, tableId: full.table_id, version: full.version }));
    return full;
  });
}

// ── Kitchen ───────────────────────────────────────────────────────────────
function kitchenItem(it) {
  const p = one('SELECT cut_mode, printer_id, category_id FROM products WHERE id = ?', it.product_id) || {};
  const c = p.category_id ? one('SELECT printer_id FROM categories WHERE id = ?', p.category_id) : null;
  const mods = all('SELECT name, qty FROM order_item_modifiers WHERE order_item_id = ? ORDER BY id', it.id);
  return {
    orderItemId: it.id, name: it.name, variant: it.variant_name, qty: it.qty, note: it.note,
    modifiers: mods.map((m) => ({ name: m.name, qty: m.qty })), cutMode: p.cut_mode || 'none',
    stationId: it.station_id ?? null, printerId: p.printer_id ?? c?.printer_id ?? null,
  };
}

function kitchenHeader(o, staffCode) {
  const t = o.table_id ? one('SELECT number FROM tables WHERE id = ?', o.table_id) : null;
  return {
    type: 'kitchen', orderNo: o.order_no, queueNo: o.queue_no, table: t?.number || null, guests: o.guests, orderType: o.type,
    customerName: o.customer_name, staff: staffCode, orderNote: o.note, tz: tzOf(o.branch_id),
  };
}

/**
 * Send draft items to the kitchen: KDS tickets per station, sub-tickets via cut rules,
 * print jobs per routed printer × copies. Only new items are printed (additions are flagged).
 */
export function sendItemsToKitchen(req, orderId, { itemIds = null, offlinePrinted = false } = {}) {
  const o = one('SELECT * FROM orders WHERE id = ?', orderId);
  let items = all("SELECT * FROM order_items WHERE order_id = ? AND status = 'draft' ORDER BY seq", orderId);
  if (itemIds) items = items.filter((i) => itemIds.includes(i.id));
  if (!items.length) return { tickets: [], jobs: [] };
  const hadSent = one("SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status <> 'draft' AND sent_at IS NOT NULL", orderId).c > 0;
  const batch = Number(one('SELECT IFNULL(MAX(batch_no),0) b FROM kitchen_tickets WHERE order_id = ?', orderId).b) + 1;
  const kSettings = getSetting('kitchen', o.branch_id);
  const header = kitchenHeader(o, req.staff?.code);
  const now = new Date().toISOString();
  const kItems = items.map(kitchenItem);
  const routed = kItems.filter((k) => k.stationId || k.printerId);
  const plan = planKitchenTickets(routed);
  const result = { tickets: [], jobs: [] };

  for (const g of plan) {
    const station = g.stationId ? one('SELECT name FROM kitchen_stations WHERE id = ?', g.stationId) : null;
    const ticketId = insert('kitchen_tickets', {
      order_id: orderId, branch_id: o.branch_id, station_id: g.stationId, batch_no: batch, is_addition: hadSent ? 1 : 0,
      sub_count: g.subTickets.length, created_by: req.staff?.id ?? null,
    });
    result.tickets.push(ticketId);
    const subIds = [];
    g.subTickets.forEach((sub, i) => {
      const snapshot = sub.map((s) => ({ name: s.name, variant: s.variant, qty: s.qty, note: s.note, modifiers: s.modifiers, unitIndex: s.unitIndex, unitCount: s.unitCount, orderItemId: s.orderItemId }));
      const subId = insert('kitchen_sub_tickets', { ticket_id: ticketId, order_id: orderId, sub_index: i + 1, sub_count: g.subTickets.length, items: JSON.stringify(snapshot) });
      subIds.push(subId);
      for (const s of sub) insert('kitchen_ticket_items', { sub_ticket_id: subId, order_item_id: s.orderItemId, qty: s.qty, unit_index: s.unitIndex ?? null, unit_count: s.unitCount ?? null });
    });
    if (kSettings.printOnSend) {
      for (const target of kitchenTargets(o.branch_id, g.stationId, g.printerId)) {
        for (const c of expandCopies(g.subTickets, target.copies)) {
          const payload = {
            ...header, kind: 'order', isAddition: hadSent, station: station?.name || target.printer.name, time: now,
            sub: { n: c.subIndex, of: c.subCount }, copy: { n: c.copyIndex, of: c.copyCount },
            items: c.items.map((s) => ({ name: s.name, variant: s.variant, qty: s.qty, note: s.note, modifiers: s.modifiers, unitIndex: s.unitIndex, unitCount: s.unitCount })),
          };
          result.jobs.push(createPrintJob({
            branchId: o.branch_id, printerId: target.printer.id, orderId, docType: 'kitchen', payload, stationId: g.stationId,
            subTicketId: subIds[c.subIndex - 1], subIndex: c.subIndex, subCount: c.subCount, copyIndex: c.copyIndex, copyCount: c.copyCount,
            staffId: req.staff?.id, status: offlinePrinted ? 'printed' : 'waiting',
          }));
        }
      }
    }
  }
  const ids = items.map((i) => i.id);
  const routedIds = new Set(routed.map((r) => r.orderItemId));
  for (const id of ids) {
    run(`UPDATE order_items SET status = 'sent', sent_at = datetime('now'), kitchen_status = ? WHERE id = ?`, routedIds.has(id) ? 'new' : 'served', id);
  }
  run(`UPDATE orders SET sent_at = COALESCE(sent_at, datetime('now')), kitchen_status = CASE WHEN ? THEN 'new' ELSE kitchen_status END, version = version + 1 WHERE id = ?`, routed.length ? 1 : 0, orderId);
  if (!routed.length) refreshKitchenStatus(orderId);
  afterCommit(() => {
    emitBranch(o.branch_id, 'kds:changed', { orderId, tickets: result.tickets, isNew: true });
    emitBranch(o.branch_id, 'queue:changed', { orderId });
    if (result.tickets.length) notifyStaff(o.branch_id, 'new_order', 'info', `Order ใหม่ ${o.queue_no || (o.table_id ? `โต๊ะ ${header.table}` : `#${o.order_no}`)}`, `${items.length} รายการ${hadSent ? ' (รายการเพิ่ม)' : ''}`, { orderId });
  });
  audit(req, 'order.send_kitchen', { entity: 'order', entityId: orderId, details: `batch ${batch}, ${items.length} items, ${result.jobs.length} print jobs` });
  return result;
}

export function sendKitchen(req, orderId, { offlinePrinted = false } = {}) {
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) throw notFound('ไม่พบ Order');
    if (!['open', 'held'].includes(o.status)) {
      // offline replay after the order was already paid: nothing left to send
      if (offlinePrinted && o.status === 'paid') return { tickets: [], jobs: [], order: loadOrder(orderId) };
      throw conflict('บิลนี้ปิดแล้ว');
    }
    const r = sendItemsToKitchen(req, orderId, { offlinePrinted });
    if (o.status === 'held') run("UPDATE orders SET status = 'open' WHERE id = ?", orderId);
    return { ...r, order: loadOrder(orderId) };
  });
}

/** Aggregate KDS item statuses into the order kitchen_status (drives Queue Display). */
export function refreshKitchenStatus(orderId) {
  const o = one('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return;
  const st = all(`SELECT kti.status FROM kitchen_ticket_items kti JOIN kitchen_sub_tickets s ON s.id = kti.sub_ticket_id
                  JOIN kitchen_tickets t ON t.id = s.ticket_id WHERE t.order_id = ? AND t.kind = 'order' AND kti.status <> 'voided'`, orderId).map((r) => r.status);
  let next;
  if (!st.length) next = o.sent_at ? 'ready' : 'none';
  else if (st.every((s) => s === 'served')) next = 'served';
  else if (st.every((s) => s === 'ready' || s === 'served')) next = 'ready';
  else if (st.some((s) => s !== 'new')) next = 'preparing';
  else next = 'new';
  if (next === o.kitchen_status) return;
  run(`UPDATE orders SET kitchen_status = ?, ready_at = CASE WHEN ? = 'ready' THEN datetime('now') ELSE ready_at END WHERE id = ?`, next, next, orderId);
  afterCommit(() => {
    emitBranch(o.branch_id, 'queue:changed', { orderId, kitchenStatus: next });
    emitBranch(o.branch_id, 'order:updated', { id: orderId, kitchenStatus: next });
    if (next === 'ready') {
      emitBranch(o.branch_id, 'queue:ready', { orderId, queueNo: o.queue_no, orderNo: o.order_no, type: o.type });
      const t = o.table_id ? one('SELECT number FROM tables WHERE id = ?', o.table_id) : null;
      notifyStaff(o.branch_id, 'food_ready', 'success', `อาหารพร้อมเสิร์ฟ ${o.queue_no || (t ? `โต๊ะ ${t.number}` : `#${o.order_no}`)}`, '', { orderId });
    }
  });
}

// ── Void ──────────────────────────────────────────────────────────────────
function printVoidTicket(req, o, voided) {
  if (!getSetting('kitchen', o.branch_id).voidTicket) return;
  const header = kitchenHeader(o, req.staff?.code);
  const byStation = new Map();
  for (const v of voided) {
    if (!v.item.station_id && !v.k.printerId) continue;
    const key = `${v.item.station_id}|${v.k.printerId || ''}`;
    if (!byStation.has(key)) byStation.set(key, { stationId: v.item.station_id, printerId: v.k.printerId, items: [] });
    byStation.get(key).items.push({ ...v.k, qty: v.qty, voidReason: v.reason });
  }
  for (const g of byStation.values()) {
    const station = g.stationId ? one('SELECT name FROM kitchen_stations WHERE id = ?', g.stationId) : null;
    for (const t of kitchenTargets(o.branch_id, g.stationId, g.printerId)) {
      createPrintJob({ branchId: o.branch_id, printerId: t.printer.id, orderId: o.id, docType: 'kitchen_void', stationId: g.stationId, staffId: req.staff.id,
        payload: { ...header, kind: 'void', station: station?.name, time: new Date().toISOString(), items: g.items } });
    }
  }
}

export function voidItem(req, orderId, itemId, { qty, reason }) {
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    const it = one('SELECT * FROM order_items WHERE id = ? AND order_id = ?', itemId, orderId);
    if (!o || !it) throw notFound();
    if (!['open', 'held'].includes(o.status)) throw conflict('บิลปิดแล้ว ใช้การคืนเงิน (Refund) แทน');
    if (it.status === 'voided') return loadOrder(orderId);
    const n = qty ? Math.min(Number(qty), it.qty) : it.qty;
    if (it.status === 'draft') {
      if (!hasPerm(req, 'pos.remove_item')) throw forbidden('ไม่มีสิทธิ์ลบสินค้า');
      if (it.reward_redemption_id) releaseRedemption(it.reward_redemption_id);
      if (n >= it.qty) run('DELETE FROM order_items WHERE id = ?', itemId);
      else run('UPDATE order_items SET qty = qty - ? WHERE id = ?', n, itemId);
    } else {
      if (!reason) throw bad('กรุณาระบุเหตุผลการ Void');
      const g = gate(req, 'void_item', { orderId });
      let voidedId = itemId;
      if (n < it.qty) {
        // split the line: keep remaining qty, create voided line for n
        voidedId = uuid();
        run('UPDATE order_items SET qty = qty - ? WHERE id = ?', n, itemId);
        insert('order_items', { ...it, id: voidedId, qty: n, status: 'voided', voided_at: sqlNow(), seq: it.seq, discounts: it.discounts });
        for (const m of all('SELECT * FROM order_item_modifiers WHERE order_item_id = ?', itemId)) {
          insert('order_item_modifiers', { order_item_id: voidedId, modifier_id: m.modifier_id, group_id: m.group_id, group_name: m.group_name, name: m.name, price: m.price, qty: m.qty });
        }
      } else {
        run("UPDATE order_items SET status = 'voided', voided_at = datetime('now') WHERE id = ?", itemId);
        run("UPDATE kitchen_ticket_items SET status = 'voided', updated_at = datetime('now') WHERE order_item_id = ?", itemId);
      }
      if (it.reward_redemption_id && n >= it.qty) releaseRedemption(it.reward_redemption_id);
      const vid = insert('voids', { order_id: orderId, order_item_id: voidedId, scope: 'item', qty: n, amount: Math.round(it.unit_price * n * 100) / 100, reason, staff_id: req.staff.id, approval_id: g.approvalId, branch_id: o.branch_id });
      printVoidTicket(req, o, [{ item: it, k: kitchenItem(it), qty: n, reason }]);
      audit(req, 'void.item', { entity: 'order', entityId: orderId, details: `${it.name} x${n}: ${reason} (void #${vid})`, approvedBy: g.approvedBy });
      afterCommit(() => emitBranch(o.branch_id, 'kds:changed', { orderId }));
    }
    recalcOrder(orderId);
    refreshKitchenStatus(orderId);
    afterCommit(() => emitBranch(o.branch_id, 'order:updated', { id: orderId }));
    return loadOrder(orderId);
  });
}

export function voidOrder(req, orderId, { reason }) {
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) throw notFound();
    if (!['open', 'held'].includes(o.status)) throw conflict('บิลนี้ไม่สามารถ Void ได้ (ใช้ Refund สำหรับบิลที่ชำระแล้ว)');
    if (o.paid_total > 0) throw conflict('บิลนี้มีการชำระเงินบางส่วนแล้ว กรุณาคืนเงินก่อน');
    if (!reason) throw bad('กรุณาระบุเหตุผลการ Void');
    const items = all("SELECT * FROM order_items WHERE order_id = ? AND status <> 'voided'", orderId);
    const sent = items.filter((i) => i.status === 'sent');
    const g = sent.length || items.length ? gate(req, 'void_order', { orderId }) : { approvalId: null };
    run("UPDATE order_items SET status = 'voided', voided_at = datetime('now') WHERE order_id = ? AND status <> 'voided'", orderId);
    run(`UPDATE kitchen_ticket_items SET status = 'voided' WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`, orderId);
    run(`UPDATE kitchen_tickets SET status = 'voided' WHERE order_id = ?`, orderId);
    run("UPDATE orders SET status = 'voided', voided_at = datetime('now'), version = version + 1 WHERE id = ?", orderId);
    for (const r of all("SELECT id FROM reward_redemptions WHERE order_id = ? AND status = 'used'", orderId)) releaseRedemption(r.id, 'order voided');
    insert('voids', { order_id: orderId, scope: 'order', amount: o.total, reason, staff_id: req.staff.id, approval_id: g.approvalId, branch_id: o.branch_id });
    if (sent.length) printVoidTicket(req, o, sent.map((it) => ({ item: it, k: kitchenItem(it), qty: it.qty, reason })));
    audit(req, 'void.order', { entity: 'order', entityId: orderId, details: `#${o.order_no} ${o.total}: ${reason}`, approvedBy: g.approvedBy });
    afterCommit(() => {
      emitBranch(o.branch_id, 'order:updated', { id: orderId, status: 'voided', tableId: o.table_id });
      emitBranch(o.branch_id, 'kds:changed', { orderId });
      emitBranch(o.branch_id, 'queue:changed', { orderId });
    });
    return loadOrder(orderId);
  });
}

// ── Tables: move / merge / split ──────────────────────────────────────────
export function mergeOrders(req, targetId, sourceIds) {
  return tx(() => {
    const target = one('SELECT * FROM orders WHERE id = ?', targetId);
    if (!target || !['open', 'held'].includes(target.status)) throw bad('บิลปลายทางไม่ถูกต้อง');
    for (const sid of sourceIds) {
      const s = one('SELECT * FROM orders WHERE id = ?', sid);
      if (!s || sid === targetId || !['open', 'held'].includes(s.status) || s.branch_id !== target.branch_id) throw bad('บิลที่ต้องการรวมไม่ถูกต้อง');
      if (s.paid_total > 0) throw conflict('ไม่สามารถรวมบิลที่ชำระบางส่วนแล้ว');
      let seq = Number(one('SELECT IFNULL(MAX(seq),0) s FROM order_items WHERE order_id = ?', targetId).s);
      for (const it of all('SELECT id FROM order_items WHERE order_id = ? ORDER BY seq', sid)) run('UPDATE order_items SET order_id = ?, seq = ? WHERE id = ?', targetId, ++seq, it.id);
      if (!target.member_id && s.member_id) run('UPDATE orders SET member_id = ? WHERE id = ?', s.member_id, targetId);
      run("UPDATE orders SET status = 'merged', parent_order_id = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?", targetId, sid);
      run('UPDATE orders SET guests = IFNULL(guests,0) + IFNULL(?,0) WHERE id = ?', s.guests, targetId);
      audit(req, 'table.merge', { entity: 'order', entityId: targetId, details: `merged #${s.order_no}` });
    }
    run('UPDATE orders SET version = version + 1 WHERE id = ?', targetId);
    recalcOrder(targetId);
    afterCommit(() => emitBranch(target.branch_id, 'order:updated', { id: targetId, merged: sourceIds }));
    return loadOrder(targetId);
  });
}

/**
 * Move items (with optional partial qty) to another order or a brand-new order.
 * Used for "ย้ายสินค้า", "แยกโต๊ะ" and "Split Bill ตามสินค้า / เลือกรายการ".
 */
export function moveItems(req, orderId, { items, targetOrderId, newOrder }) {
  return tx(() => {
    const src = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!src || !['open', 'held'].includes(src.status)) throw bad('บิลต้นทางไม่ถูกต้อง');
    if (src.paid_total > 0) throw conflict('บิลนี้ชำระบางส่วนแล้ว ไม่สามารถแยกได้');
    let target;
    if (targetOrderId) {
      target = one('SELECT * FROM orders WHERE id = ?', targetOrderId);
      if (!target || !['open', 'held'].includes(target.status)) throw bad('บิลปลายทางไม่ถูกต้อง');
    } else {
      const created = saveOrder(req, { id: newOrder?.id || uuid(), type: newOrder?.type || src.type, tableId: newOrder?.tableId ?? null, guests: newOrder?.guests ?? null, customerName: newOrder?.customerName ?? src.customer_name, items: [] });
      target = one('SELECT * FROM orders WHERE id = ?', created.id);
    }
    let seq = Number(one('SELECT IFNULL(MAX(seq),0) s FROM order_items WHERE order_id = ?', target.id).s);
    for (const m of items) {
      const it = one("SELECT * FROM order_items WHERE id = ? AND order_id = ? AND status <> 'voided'", m.itemId, orderId);
      if (!it) throw bad('ไม่พบรายการ');
      const q = Math.min(Number(m.qty) || it.qty, it.qty);
      if (q >= it.qty) run('UPDATE order_items SET order_id = ?, seq = ? WHERE id = ?', target.id, ++seq, it.id);
      else {
        const nid = uuid();
        run('UPDATE order_items SET qty = qty - ? WHERE id = ?', q, it.id);
        insert('order_items', { ...it, id: nid, order_id: target.id, qty: q, seq: ++seq });
        for (const mod of all('SELECT * FROM order_item_modifiers WHERE order_item_id = ?', it.id)) {
          insert('order_item_modifiers', { order_item_id: nid, modifier_id: mod.modifier_id, group_id: mod.group_id, group_name: mod.group_name, name: mod.name, price: mod.price, qty: mod.qty });
        }
      }
    }
    if (one('SELECT sent_at FROM orders WHERE id = ?', orderId).sent_at) run("UPDATE orders SET sent_at = COALESCE(sent_at, datetime('now')), kitchen_status = CASE WHEN kitchen_status = 'none' THEN 'new' ELSE kitchen_status END WHERE id = ?", target.id);
    run('UPDATE orders SET version = version + 1 WHERE id IN (?, ?)', orderId, target.id);
    recalcOrder(orderId); recalcOrder(target.id);
    refreshKitchenStatus(orderId); refreshKitchenStatus(target.id);
    audit(req, 'order.move_items', { entity: 'order', entityId: orderId, details: `→ #${target.order_no}: ${items.length} lines` });
    // empty source (no active items) → close as merged
    const left = one("SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status <> 'voided'", orderId).c;
    if (!left) run("UPDATE orders SET status = 'merged', parent_order_id = ? WHERE id = ?", target.id, orderId);
    afterCommit(() => emitBranch(src.branch_id, 'order:updated', { id: orderId, moved: target.id }));
    return { source: loadOrder(orderId), target: loadOrder(target.id) };
  });
}

// ── Member / Reward on order ──────────────────────────────────────────────
export function attachMember(req, orderId, memberId, via = 'pos') {
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || !['open', 'held'].includes(o.status)) throw bad('บิลไม่ถูกต้อง');
    if (memberId) {
      const m = one("SELECT id FROM members WHERE id = ? AND status = 'active'", memberId);
      if (!m) throw notFound('ไม่พบสมาชิก');
    }
    run('UPDATE orders SET member_id = ?, points_to_use = CASE WHEN ? IS NULL THEN 0 ELSE points_to_use END, version = version + 1 WHERE id = ?', memberId || null, memberId || null, orderId);
    audit(req, memberId ? 'order.member_attach' : 'order.member_detach', { entity: 'order', entityId: orderId, details: `${memberId || ''} via ${via}` });
    recalcOrder(orderId);
    afterCommit(() => emitBranch(o.branch_id, 'order:updated', { id: orderId }));
    return loadOrder(orderId);
  });
}

export function applyRedemption(req, orderId, code) {
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || !['open', 'held'].includes(o.status)) throw bad('บิลไม่ถูกต้อง');
    const r = consumeRedemption(code, { orderId, staffId: req.staff.id, deviceId: req.device?.id ?? null, branchId: o.branch_id });
    if (r.min_spend > 0 && o.subtotal < r.min_spend) throw bad(`ต้องมียอดซื้อขั้นต่ำ ${r.min_spend} บาท`);
    if (!r.combinable && json(o.promotions, []).length) throw bad('Reward นี้ใช้ร่วมกับโปรโมชั่นอื่นไม่ได้');
    if (r.reward_type === 'free_product') {
      if (!r.product_id) throw bad('Reward ไม่ได้ผูกสินค้า');
      const p = productForBranch(r.product_id, o.branch_id);
      const seq = Number(one('SELECT IFNULL(MAX(seq),0) s FROM order_items WHERE order_id = ?', orderId).s) + 1;
      insert('order_items', {
        id: uuid(), order_id: orderId, seq, product_id: p.id, variant_id: null, name: p.name, category_id: p.categoryId, station_id: p.stationId,
        qty: 1, base_price: p.price, unit_price: 0, price_override: 0, discounts: [], note: `Reward: ${r.reward_name}`,
        unit_cost: productUnitCost(p.id, null, []), status: 'draft', reward_redemption_id: r.id, added_by: req.staff.id,
      });
    } else {
      const bd = json(o.bill_discounts, []);
      if (r.reward_type === 'discount_amount') bd.push({ type: 'amount', value: r.discount_value, label: `Reward: ${r.reward_name}`, source: 'reward', redemptionId: r.id });
      else {
        let value = r.discount_value;
        if (r.max_discount) value = Math.min(value, (r.max_discount / Math.max(o.subtotal, 0.01)) * 100);
        bd.push({ type: 'pct', value, label: `Reward: ${r.reward_name}`, source: 'reward', redemptionId: r.id });
      }
      run('UPDATE orders SET bill_discounts = ? WHERE id = ?', JSON.stringify(bd), orderId);
    }
    if (!o.member_id) run('UPDATE orders SET member_id = ? WHERE id = ?', r.member_id, orderId);
    run('UPDATE orders SET version = version + 1 WHERE id = ?', orderId);
    audit(req, 'reward.use', { entity: 'redemption', entityId: r.id, details: `${r.reward_name} code ${r.code} member ${r.member_name} order ${o.order_no}` });
    recalcOrder(orderId);
    afterCommit(() => emitBranch(o.branch_id, 'order:updated', { id: orderId }));
    return { order: loadOrder(orderId), redemption: r };
  });
}

export function removeRedemption(req, orderId, redemptionId) {
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || !['open', 'held'].includes(o.status)) throw bad('บิลไม่ถูกต้อง');
    const bd = json(o.bill_discounts, []).filter((d) => d.redemptionId !== redemptionId);
    run('UPDATE orders SET bill_discounts = ?, version = version + 1 WHERE id = ?', JSON.stringify(bd), orderId);
    run("DELETE FROM order_items WHERE order_id = ? AND reward_redemption_id = ? AND status = 'draft'", orderId, redemptionId);
    releaseRedemption(redemptionId);
    audit(req, 'reward.release', { entity: 'redemption', entityId: redemptionId, details: `order ${o.order_no}` });
    recalcOrder(orderId);
    return loadOrder(orderId);
  });
}

// ── Payment (transaction-safe, idempotent) ────────────────────────────────
const DOC_TITLES = { receipt: 'ใบเสร็จรับเงิน', abb_tax_invoice: 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ', full_tax_invoice: 'ใบเสร็จรับเงิน/ใบกำกับภาษีเต็มรูป', credit_note: 'ใบลดหนี้ / ใบคืนเงิน' };

export function buildReceiptPayload(orderId, { receiptNo, docType = 'receipt', customer = null, memberInfo = null, claimUrl = null, claimPoints = 0, payments, received, change, time }) {
  const o = loadOrder(orderId);
  const calc = o.calc || {};
  const lineBy = Object.fromEntries((calc.lines || []).map((l) => [l.key, l]));
  const rc = getSetting('receipt', o.branch_id);
  const vat = getSetting('vat', o.branch_id);
  return {
    type: 'receipt', title: DOC_TITLES[docType] || DOC_TITLES.receipt, docType, receiptNo, orderNo: o.order_no, queueNo: o.queue_no,
    time: time || new Date().toISOString(), tz: tzOf(o.branch_id), staff: o.staff_code ? `${o.staff_code} ${o.staff_name || ''}`.trim() : '',
    posName: o.device_name, table: o.table_number, orderType: o.type, customer, vatMode: vat.mode,
    shop: shopHeader(o.branch_id), sections: { ...rc.sections, claimQr: rc.claimQr && rc.sections?.claimQr !== false },
    items: o.items.filter((i) => i.status !== 'voided').map((i) => {
      const l = lineBy[i.id] || {};
      return {
        qty: i.qty, name: i.name, variant: i.variant_name, note: i.note, lineTotal: l.gross ?? i.unit_price * i.qty,
        modifiers: i.modifiers.map((m) => ({ name: m.name, price: m.price, qty: m.qty })),
        discount: l.itemDiscount || 0, discountLabel: (l.discountDetail || []).map((d) => d.label).join(', '), reward: !!i.reward_redemption_id,
      };
    }),
    totals: {
      subtotal: calc.subtotal, itemDiscount: calc.itemDiscount, billDiscountLines: calc.billDiscountLines, discount: calc.discount,
      serviceCharge: calc.serviceCharge, serviceChargeRate: calc.serviceChargeRate, vat: calc.vat, vatRate: calc.vatRate, vatMode: calc.vatMode,
      beforeVat: calc.beforeVat, total: calc.total,
    },
    payments, received, change, member: memberInfo, claimUrl, claimPoints,
  };
}

export function publicBaseUrl(req) {
  const shop = getSetting('shop');
  return (shop.publicUrl || config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/**
 * Payment steps (single SQLite transaction → all-or-nothing):
 * 1 Validate order · 2 Validate staff permission · 3 Validate payment · 4 Create transaction · 5 Mark order paid
 * 6 Generate receipt · 7 Deduct inventory · 8 Member points · 9 Create print jobs · 10 Commit
 * Idempotency-Key prevents double click / double payment; print failures never touch the payment.
 */
export function payOrder(req, orderId, body) {
  const key = body.idempotencyKey;
  if (!key) throw bad('missing idempotencyKey');
  const prev = one('SELECT result FROM payments WHERE idempotency_key = ?', key);
  if (prev) return { ...json(prev.result, {}), duplicate: true };

  return tx(() => {
    // 1) validate order
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) throw notFound('ไม่พบ Order');
    if (o.branch_id !== req.staff.branchId) throw forbidden('Order นี้อยู่สาขาอื่น');
    if (o.status === 'paid') throw conflict('บิลนี้ชำระเงินแล้ว', 'ALREADY_PAID');
    if (!['open', 'held'].includes(o.status)) throw conflict('บิลนี้ไม่สามารถชำระเงินได้', 'ORDER_CLOSED');
    if (!one("SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status <> 'voided'", orderId).c) throw bad('ไม่มีรายการในบิล');
    const pos = getSetting('pos', o.branch_id);
    let shift = req.device ? one("SELECT * FROM shifts WHERE device_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", req.device.id) : null;
    if (!shift) shift = one("SELECT * FROM shifts WHERE staff_id = ? AND branch_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", req.staff.id, o.branch_id);
    if (pos.requireShift && !shift && !body.offline) throw conflict('กรุณาเปิดกะ (Open Shift) ก่อนรับชำระเงิน', 'SHIFT_REQUIRED');
    const calc = recalcOrder(orderId);
    const order = one('SELECT * FROM orders WHERE id = ?', orderId);
    const remaining = toSatang(order.total) - toSatang(order.paid_total);

    // 2 + 3) validate payments & permissions
    const methods = getSetting('payment', o.branch_id).methods || {};
    const pays = (body.payments || []).map((p) => ({ method: p.method, amount: toSatang(p.amount), tendered: p.tendered != null ? toSatang(p.tendered) : null, reference: p.reference || null }));
    if (!pays.length) throw bad('กรุณาเลือกช่องทางชำระเงิน');
    if (pays.length > 1 && !hasPerm(req, 'payment.split')) throw forbidden('ไม่มีสิทธิ์ Split Payment');
    for (const p of pays) {
      if (!PAYMENT_PERM[p.method]) throw bad(`ช่องทางชำระเงินไม่ถูกต้อง: ${p.method}`);
      if (p.method !== 'points' && methods[p.method] === false) throw bad('ช่องทางชำระเงินนี้ถูกปิดใช้งาน');
      if (!hasPerm(req, PAYMENT_PERM[p.method])) throw forbidden(`ไม่มีสิทธิ์รับชำระด้วย ${p.method}`);
      if (!(p.amount > 0)) throw bad('ยอดชำระต้องมากกว่า 0');
      if (p.method === 'cash' && p.tendered != null && p.tendered < p.amount) throw bad('เงินที่รับน้อยกว่ายอดชำระ');
    }
    const sum = pays.reduce((a, p) => a + p.amount, 0);
    if (sum > remaining) throw bad(`ยอดชำระเกินยอดค้างชำระ (${toBaht(remaining)})`, 'OVERPAY');
    const partial = sum < remaining;
    if (partial && !body.partial) throw bad(`ยอดชำระยังไม่ครบ ขาดอีก ${toBaht(remaining - sum)} บาท`, 'UNDERPAY');
    if (partial && !hasPerm(req, 'payment.split')) throw forbidden('ไม่มีสิทธิ์แบ่งชำระ');
    const received = pays.reduce((a, p) => a + (p.method === 'cash' ? p.tendered ?? p.amount : p.amount), 0);
    const change = pays.reduce((a, p) => a + (p.method === 'cash' && p.tendered != null ? p.tendered - p.amount : 0), 0);

    // 4) payment + transactions
    const paymentId = insert('payments', {
      idempotency_key: key, order_id: orderId, branch_id: o.branch_id, shift_id: shift?.id ?? null, device_id: req.device?.id ?? null,
      staff_id: req.staff.id, total: toBaht(sum), received: toBaht(received), change: toBaht(change),
      created_at: body.offline?.paidAt ? sqlNow(new Date(body.offline.paidAt)) : undefined,
    });
    for (const p of pays) {
      insert('payment_transactions', { payment_id: paymentId, order_id: orderId, branch_id: o.branch_id, shift_id: shift?.id ?? null, method: p.method, amount: toBaht(p.amount), tendered: p.tendered != null ? toBaht(p.tendered) : null, reference: p.reference });
    }
    audit(req, 'payment.create', { entity: 'order', entityId: orderId, details: pays.map((p) => `${p.method}:${toBaht(p.amount)}`).join(', ') });

    if (partial) {
      run('UPDATE orders SET paid_total = paid_total + ?, version = version + 1 WHERE id = ?', toBaht(sum), orderId);
      const printer = receiptPrinterFor(o.branch_id, req.device?.id);
      let jobId = null;
      if (printer) {
        jobId = createPrintJob({ branchId: o.branch_id, printerId: printer.id, orderId, docType: 'slip', staffId: req.staff.id, payload: {
          type: 'slip', title: 'ใบรับเงินบางส่วน', tz: tzOf(o.branch_id), time: new Date().toISOString(),
          rows: [['Order', o.queue_no || `#${o.order_no}`], ['ยอดบิลทั้งหมด', toBaht(toSatang(order.total)).toFixed(2)], ...pays.map((p) => [p.method, toBaht(p.amount).toFixed(2)]), ['คงค้าง', toBaht(remaining - sum).toFixed(2), true]],
          note: 'ใบรับเงินนี้ไม่ใช่ใบเสร็จรับเงิน ใบเสร็จจะออกเมื่อชำระครบ',
        } });
      }
      const result = { orderId, paymentId, partial: true, paid: toBaht(toSatang(order.paid_total) + sum), remaining: toBaht(remaining - sum), change: toBaht(change), printJobs: jobId ? [jobId] : [] };
      run('UPDATE payments SET result = ? WHERE id = ?', JSON.stringify(result), paymentId);
      afterCommit(() => emitBranch(o.branch_id, 'order:updated', { id: orderId }));
      return result;
    }

    // auto-send unsent items to the kitchen (quick service)
    const kitchen = sendItemsToKitchen(req, orderId, { offlinePrinted: !!body.offline?.kitchenPrinted });

    // 5) mark paid
    const paidAt = body.offline?.paidAt ? sqlNow(new Date(body.offline.paidAt)) : sqlNow();
    run(`UPDATE orders SET status = 'paid', paid_total = total, paid_at = ?, shift_id = COALESCE(shift_id, ?), version = version + 1, updated_at = datetime('now') WHERE id = ?`, paidAt, shift?.id ?? null, orderId);
    if (o.table_id && pos.cleanTableAfterPay !== false) run("UPDATE tables SET manual_status = 'cleaning' WHERE id = ?", o.table_id);

    // 8) member points (computed before receipt so it can be printed)
    const pts = getSetting('points');
    let memberInfo = null;
    if (order.member_id) {
      const m = one('SELECT m.*, t.name AS tier_name FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = ?', order.member_id);
      const before = m.points;
      if (calc.pointsUsed > 0) pointTx({ memberId: m.id, type: 'REDEEM', points: -calc.pointsUsed, txnId: `use:${orderId}`, orderId, branchId: o.branch_id, staffId: req.staff.id, deviceId: req.device?.id, reason: `ใช้แต้มเป็นส่วนลด #${o.order_no}`, notify: false });
      const earned = calc.earnPoints || 0;
      run("UPDATE members SET total_spend = total_spend + ?, visit_count = visit_count + 1, last_visit_at = datetime('now') WHERE id = ?", order.total, m.id);
      if (earned > 0) pointTx({ memberId: m.id, type: 'EARN', points: earned, txnId: `earn:${orderId}`, orderId, branchId: o.branch_id, staffId: req.staff.id, deviceId: req.device?.id, amount: order.total, reason: `ซื้อสินค้า #${o.order_no}` });
      else recomputeTier(m.id);
      const after = one('SELECT points FROM members WHERE id = ?', m.id).points;
      insert('order_members', { order_id: orderId, member_id: m.id, points_before: before, points_used: calc.pointsUsed || 0, points_earned: earned, tier_name: m.tier_name, attached_via: body.memberVia || 'pos' });
      memberInfo = { name: m.name, tier: m.tier_name, before, used: calc.pointsUsed || 0, earned, balance: after };
    }

    // 6) receipt
    const branch = one('SELECT * FROM branches WHERE id = ?', o.branch_id);
    const docType = ['receipt', 'abb_tax_invoice', 'full_tax_invoice'].includes(body.docType) ? body.docType : getSetting('receipt', o.branch_id).docType || 'receipt';
    if (docType === 'full_tax_invoice' && !body.customer?.name) throw bad('ใบกำกับภาษีเต็มรูปต้องระบุชื่อลูกค้า/บริษัท และเลขผู้เสียภาษี');
    const receiptNo = body.offline?.receiptNo || `${branch.receipt_prefix}${String(nextSeq(o.branch_id, 'receipt')).padStart(6, '0')}`;
    let claimToken = null; let claimUrl = null;
    const claimPoints = calc.guestEarnPoints || 0;
    if (!order.member_id && pts.enabled && claimPoints > 0 && getSetting('receipt', o.branch_id).claimQr) {
      claimToken = randomToken(18);
      claimUrl = `${publicBaseUrl(req)}/m/claim/${claimToken}`;
    }
    const cashTendered = pays.filter((p) => p.method === 'cash').reduce((a, p) => a + (p.tendered ?? p.amount), 0);
    const allPays = all("SELECT method, SUM(amount) amount, MAX(reference) reference FROM payment_transactions WHERE order_id = ? AND kind = 'sale' GROUP BY method ORDER BY MIN(id)", orderId);
    const payload = buildReceiptPayload(orderId, {
      receiptNo, docType, customer: body.customer || null, memberInfo, claimUrl, claimPoints,
      payments: allPays, received: cashTendered ? toBaht(cashTendered) : null, change: toBaht(change), time: body.offline?.paidAt,
    });
    const receiptId = insert('receipts', {
      receipt_no: receiptNo, order_id: orderId, payment_id: paymentId, branch_id: o.branch_id, doc_type: docType,
      customer: body.customer || null, payload, total: order.total,
      claim_token: claimToken, claim_points: claimToken ? claimPoints : 0, claim_status: claimToken ? 'available' : null,
      claim_expires_at: claimToken ? sqlNow(new Date(Date.now() + (Number(pts.claimDays) || 7) * 86400e3)) : null,
    });

    // 7) inventory
    const soldItems = all("SELECT * FROM order_items WHERE order_id = ? AND status <> 'voided'", orderId);
    applyItemsStock({ branchId: o.branch_id, items: soldItems, sign: -1, type: 'sale', refType: 'order', refId: orderId, staffId: req.staff.id });

    // 9) print jobs (receipt copies share the same receipt number)
    const rc = getSetting('receipt', o.branch_id);
    let copies = Number(rc.copies) || 0;
    if (body.copies != null && rc.staffCanChangeCopies) copies = Math.max(0, Math.min(10, Number(body.copies)));
    const shouldPrint = rc.printMode === 'auto' || (rc.printMode === 'ask' && body.print === true) || (rc.printMode === 'none' && body.print === true);
    const jobs = [...kitchen.jobs];
    const printer = receiptPrinterFor(o.branch_id, req.device?.id);
    if (shouldPrint && printer && copies > 0) {
      for (let c = 1; c <= copies; c++) {
        jobs.push(createPrintJob({
          branchId: o.branch_id, printerId: printer.id, orderId, docType: 'receipt', receiptId, copyIndex: c, copyCount: copies,
          payload: { ...payload, copy: { n: c, of: copies } }, staffId: req.staff.id, status: body.offline?.receiptPrinted ? 'printed' : 'waiting',
        }));
      }
    }
    // cash drawer kick for cash sales
    if (printer?.has_drawer && pays.some((p) => p.method === 'cash') && !body.offline) {
      createPrintJob({ branchId: o.branch_id, printerId: printer.id, orderId, docType: 'drawer', payload: { type: 'drawer' }, staffId: req.staff.id });
    }

    const result = {
      orderId, paymentId, receiptId, receiptNo, total: order.total, received: toBaht(received), change: toBaht(change),
      printJobs: jobs, kitchenTickets: kitchen.tickets, member: memberInfo, claimUrl, receiptPayload: payload,
    };
    run('UPDATE payments SET result = ? WHERE id = ?', JSON.stringify(result), paymentId);
    audit(req, 'order.paid', { entity: 'order', entityId: orderId, details: `${receiptNo} ${order.total}` });
    // 10) commit → notify
    afterCommit(() => {
      emitBranch(o.branch_id, 'order:updated', { id: orderId, status: 'paid', tableId: o.table_id });
      emitBranch(o.branch_id, 'sales:changed', { orderId, total: order.total });
      emitBranch(o.branch_id, 'stock:changed', { orderId });
      emitBranch(o.branch_id, 'queue:changed', { orderId });
    });
    return result;
  });
}

// ── Refund ────────────────────────────────────────────────────────────────
export function refundOrder(req, orderId, body) {
  const key = body.idempotencyKey;
  if (!key) throw bad('missing idempotencyKey');
  const prev = one('SELECT * FROM refunds WHERE idempotency_key = ?', key);
  if (prev) return { refund: prev, duplicate: true, order: loadOrder(orderId) };
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) throw notFound();
    if (!['paid', 'partially_refunded'].includes(o.status)) throw conflict('บิลนี้ไม่สามารถคืนเงินได้');
    if (!body.reason) throw bad('กรุณาระบุเหตุผลการคืนเงิน');
    const type = body.type;
    if (!hasPerm(req, type === 'full' ? 'refund.full' : 'refund.partial') && !req.get('x-approval-token')) throw forbidden('ไม่มีสิทธิ์คืนเงิน', 'APPROVAL_REQUIRED', { action: 'refund', perm: type === 'full' ? 'refund.full' : 'refund.partial' });
    const g = gate(req, 'refund', { perm: type === 'full' ? 'refund.full' : 'refund.partial', orderId });
    const refundable = toSatang(o.total) - toSatang(o.refunded_total);
    let amount; const lines = [];
    if (type === 'full') {
      amount = refundable;
      for (const it of all("SELECT * FROM order_items WHERE order_id = ? AND status <> 'voided'", orderId)) {
        const q = it.qty - it.refunded_qty;
        if (q > 0) lines.push({ it, qty: q, amount: Math.round((toSatang(it.line_total) / it.qty) * q) });
      }
    } else if (type === 'item') {
      for (const r of body.items || []) {
        const it = one("SELECT * FROM order_items WHERE id = ? AND order_id = ? AND status <> 'voided'", r.itemId, orderId);
        if (!it) throw bad('ไม่พบรายการ');
        const q = Math.min(Number(r.qty) || 0, it.qty - it.refunded_qty);
        if (q <= 0) throw bad(`${it.name} คืนครบแล้ว`);
        lines.push({ it, qty: q, amount: Math.round((toSatang(it.line_total) / it.qty) * q) });
      }
      amount = lines.reduce((a, l) => a + l.amount, 0);
    } else {
      amount = toSatang(body.amount);
    }
    if (!(amount > 0)) throw bad('ยอดคืนเงินไม่ถูกต้อง');
    if (amount > refundable) throw bad(`ยอดคืนเกินยอดที่คืนได้ (${toBaht(refundable)})`);
    const method = body.method || one("SELECT method FROM payment_transactions WHERE order_id = ? AND kind = 'sale' ORDER BY amount DESC LIMIT 1", orderId)?.method || 'cash';
    let shift = req.device ? one("SELECT * FROM shifts WHERE device_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", req.device.id) : null;
    if (!shift) shift = one("SELECT * FROM shifts WHERE staff_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", req.staff.id);
    const receipt = one("SELECT * FROM receipts WHERE order_id = ? AND doc_type <> 'credit_note' ORDER BY id LIMIT 1", orderId);
    const refundNo = `CN${String(nextSeq(o.branch_id, 'refund')).padStart(6, '0')}`;
    const restock = body.restock !== false;

    // points reversal (proportional to refunded amount)
    let pointsReversed = 0;
    const om = one('SELECT * FROM order_members WHERE order_id = ?', orderId);
    if (om) {
      const remainingEarned = om.points_earned - om.points_reversed;
      const fullNow = amount >= refundable;
      pointsReversed = fullNow ? remainingEarned : Math.min(remainingEarned, Math.round((om.points_earned * amount) / toSatang(o.total)));
      if (pointsReversed > 0) pointTx({ memberId: om.member_id, type: 'REFUND', points: -pointsReversed, txnId: `refund:${key}`, orderId, branchId: o.branch_id, staffId: req.staff.id, reason: `คืนเงิน ${refundNo}`, notify: false });
      if (fullNow && om.points_used > 0) pointTx({ memberId: om.member_id, type: 'REFUND', points: om.points_used, txnId: `refund-used:${key}`, orderId, branchId: o.branch_id, staffId: req.staff.id, reason: `คืนแต้มที่ใช้ ${refundNo}`, notify: false });
      run('UPDATE order_members SET points_reversed = points_reversed + ? WHERE order_id = ?', pointsReversed, orderId);
      run('UPDATE members SET total_spend = MAX(0, total_spend - ?) WHERE id = ?', toBaht(amount), om.member_id);
      recomputeTier(om.member_id);
    }
    const refundId = insert('refunds', {
      refund_no: refundNo, idempotency_key: key, order_id: orderId, receipt_id: receipt?.id ?? null, branch_id: o.branch_id, shift_id: shift?.id ?? null,
      type, amount: toBaht(amount), method, reason: body.reason, restock: restock ? 1 : 0, points_reversed: pointsReversed,
      staff_id: req.staff.id, approval_id: g.approvalId, approved_by: g.approvedBy,
    });
    for (const l of lines) {
      insert('refund_items', { refund_id: refundId, order_item_id: l.it.id, qty: l.qty, amount: toBaht(l.amount) });
      run('UPDATE order_items SET refunded_qty = refunded_qty + ? WHERE id = ?', l.qty, l.it.id);
    }
    if (restock && lines.length) applyItemsStock({ branchId: o.branch_id, items: lines.map((l) => ({ ...l.it, qty: l.qty })), sign: 1, type: 'refund', refType: 'refund', refId: String(refundId), staffId: req.staff.id });
    insert('payment_transactions', { order_id: orderId, branch_id: o.branch_id, shift_id: shift?.id ?? null, method, amount: -toBaht(amount), kind: 'refund', refund_id: refundId });
    const newRefunded = toSatang(o.refunded_total) + amount;
    run(`UPDATE orders SET refunded_total = ?, status = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`, toBaht(newRefunded), newRefunded >= toSatang(o.total) ? 'refunded' : 'partially_refunded', orderId);
    if (receipt?.claim_status === 'available') run("UPDATE receipts SET claim_status = 'void' WHERE id = ?", receipt.id);
    // credit note document
    const cnPayload = {
      type: 'slip', title: 'ใบลดหนี้ / ใบคืนเงิน (Refund)', tz: tzOf(o.branch_id), time: new Date().toISOString(),
      rows: [['เลขที่', refundNo, true], ['อ้างอิงใบเสร็จ', receipt?.receipt_no || '-'], ['Order', o.queue_no || `#${o.order_no}`],
        ...lines.map((l) => [`${l.qty} × ${l.it.name}`, toBaht(l.amount).toFixed(2)]), ['ยอดคืนเงิน', toBaht(amount).toFixed(2), true], ['ช่องทาง', method],
        ['เหตุผล', body.reason], ['พนักงาน', req.staff.code], ...(pointsReversed ? [['หักแต้มคืน', `-${pointsReversed}`]] : [])],
    };
    const cnId = insert('receipts', { receipt_no: refundNo, order_id: orderId, branch_id: o.branch_id, doc_type: 'credit_note', payload: cnPayload, total: -toBaht(amount), ref_receipt_id: receipt?.id ?? null });
    const printer = receiptPrinterFor(o.branch_id, req.device?.id);
    if (printer && body.print !== false) createPrintJob({ branchId: o.branch_id, printerId: printer.id, orderId, docType: 'slip', receiptId: cnId, payload: cnPayload, staffId: req.staff.id });
    if (printer?.has_drawer && method === 'cash') createPrintJob({ branchId: o.branch_id, printerId: printer.id, orderId, docType: 'drawer', payload: { type: 'drawer' }, staffId: req.staff.id });
    audit(req, type === 'full' ? 'refund.full' : 'refund.partial', { entity: 'order', entityId: orderId, details: `${refundNo} ${toBaht(amount)} ${method}: ${body.reason}`, approvedBy: g.approvedBy });
    afterCommit(() => {
      emitBranch(o.branch_id, 'sales:changed', { orderId });
      emitBranch(o.branch_id, 'order:updated', { id: orderId });
      emitBranch(o.branch_id, 'stock:changed', { orderId });
    });
    return { refund: one('SELECT * FROM refunds WHERE id = ?', refundId), order: loadOrder(orderId) };
  });
}

/** แก้ Closed Bill: full refund (credit note) + reopen a copy of the order for correction. */
export function reopenOrder(req, orderId, { reason }) {
  return tx(() => {
    const g = gate(req, 'edit_closed_bill', { orderId });
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o || o.status !== 'paid') throw conflict('แก้ไขได้เฉพาะบิลที่ชำระแล้วและยังไม่คืนเงิน');
    const fakeReq = Object.create(req);
    fakeReq.staff = { ...req.staff, perms: new Set([...req.staff.perms, 'refund.full']), roleLevel: 100 };
    refundOrder(fakeReq, orderId, { type: 'full', reason: `แก้ไขบิล: ${reason}`, idempotencyKey: `reopen:${orderId}`, restock: true, print: true });
    const nid = uuid();
    const items = all("SELECT * FROM order_items WHERE order_id = ? AND status <> 'voided'", orderId);
    const created = saveOrder(Object.assign(Object.create(req), { staff: { ...req.staff, perms: new Set(['*']) } }), {
      id: nid, type: o.type, tableId: null, guests: o.guests, customerName: o.customer_name, note: o.note,
      items: items.map((it) => ({ productId: it.product_id, variantId: it.variant_id, qty: it.qty, note: it.note, priceOverride: it.price_override, discounts: json(it.discounts, []), modifiers: all('SELECT modifier_id AS modifierId, qty FROM order_item_modifiers WHERE order_item_id = ?', it.id) })),
    });
    // items were already prepared → mark as sent so the kitchen is not printed again
    run("UPDATE order_items SET status = 'sent', sent_at = datetime('now'), kitchen_status = 'served' WHERE order_id = ?", nid);
    run("UPDATE orders SET sent_at = datetime('now'), kitchen_status = 'served', parent_order_id = ?, member_id = ? WHERE id = ?", orderId, o.member_id, nid);
    if (o.queue_no) run('UPDATE orders SET queue_no = ? WHERE id = ?', o.queue_no, nid);
    audit(req, 'order.edit_closed', { entity: 'order', entityId: orderId, details: `reopened as ${created.order_no}: ${reason}`, approvedBy: g.approvedBy });
    recalcOrder(nid);
    return loadOrder(nid);
  });
}

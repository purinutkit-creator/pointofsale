// POS state: catalog (cached offline), current order (local-first), totals via the shared calculation engine.
import { create } from 'zustand';
import { api, uid, NetworkError } from '../../lib/api.js';
import { kvGet, kvSet, localOrderPut, localOrderDelete, outboxAll, outboxPut } from '../../lib/db.js';
import { enqueue, flush } from '../../lib/sync.js';
import { useApp, toast } from '../../lib/store.js';
import { calculate, unitPriceOf } from '@shared/calc.js';
import { evaluatePromotions } from '@shared/promotions.js';
import { computeEarnPoints } from '@shared/points.js';
import { businessDate } from '@shared/format.js';

export const emptyCatalog = { categories: [], products: [], modifierGroups: [], stations: [], zones: [], tables: [], promotions: [], tiers: [], printers: [], routes: [] };

/** Server order → client order model */
export function fromServer(o) {
  return {
    id: o.id, version: o.version, orderNo: o.order_no, queueNo: o.queue_no, type: o.type, tableId: o.table_id, tableNumber: o.table_number,
    guests: o.guests, customerName: o.customer_name, customerPhone: o.customer_phone, note: o.note, status: o.status, kitchenStatus: o.kitchen_status,
    memberId: o.member_id, member: o.member, pointsToUse: o.points_to_use || 0, scExempt: !!o.sc_exempt, billDiscounts: o.bill_discounts || [],
    couponCodes: o.coupon_codes || [], paidTotal: o.paid_total || 0, total: o.total, serverCalc: o.calc, createdAt: o.created_at, sentAt: o.sent_at,
    receipts: o.receipts || [], payments: o.payments || [],
    items: (o.items || []).map((i) => ({
      id: i.id, productId: i.product_id, variantId: i.variant_id, name: i.name, variantName: i.variant_name, qty: i.qty, note: i.note,
      basePrice: i.base_price, variantPrice: i.variant_price, unitPrice: i.unit_price, priceOverride: i.price_override, discounts: i.discounts || [],
      modifiers: (i.modifiers || []).map((m) => ({ modifierId: m.modifierId, groupId: m.groupId, name: m.name, price: m.price, qty: m.qty })),
      status: i.status, kitchenStatus: i.kitchen_status, rewardRedemptionId: i.reward_redemption_id, refundedQty: i.refunded_qty, categoryId: i.category_id,
    })),
    saved: true, dirty: false, offline: false,
  };
}

function toPayload(o) {
  return {
    type: o.type, tableId: o.tableId ?? null, guests: o.guests ?? null, customerName: o.customerName || null, customerPhone: o.customerPhone || null,
    note: o.note || null, billDiscounts: o.billDiscounts.filter((d) => d.source === 'manual'), couponCodes: o.couponCodes, scExempt: !!o.scExempt,
    pointsToUse: o.pointsToUse || 0, version: o.version || undefined,
    items: o.items.filter((i) => i.status !== 'voided' && !i.rewardRedemptionId).map((i) => ({
      id: i.id, productId: i.productId, variantId: i.variantId ?? null, qty: i.qty, note: i.note || null,
      priceOverride: i.priceOverride ?? null, discounts: (i.discounts || []).filter((d) => !d.source || d.source === 'manual'),
      modifiers: i.modifiers.map((m) => ({ modifierId: m.modifierId, qty: m.qty || 1 })),
    })),
  };
}

let saveTimer = null;
let saving = null;

export const usePos = create((set, get) => ({
  catalog: emptyCatalog,
  order: null,
  shift: null,
  shiftRequired: false,
  view: 'sell', // sell | floor
  selectedCategory: 'all',
  search: '',

  async loadCatalog() {
    try {
      const c = await api('/catalog');
      set({ catalog: c });
      kvSet('catalog', c);
      return c;
    } catch (e) {
      const c = await kvGet('catalog');
      if (c) set({ catalog: c });
      if (!(e instanceof NetworkError)) toast(e.message, 'error');
      return c;
    }
  },
  async loadShift() {
    try {
      const r = await api('/shifts/current');
      set({ shift: r.shift, shiftRequired: r.required });
      kvSet('shift', r);
    } catch {
      const r = await kvGet('shift');
      if (r) set({ shift: r.shift, shiftRequired: r.required });
    }
  },

  productById(id) { return get().catalog.products.find((p) => p.id === id); },

  /** Start a new local order (saved to server immediately when online to lock table / get queue no.) */
  async newOrder({ type, tableId = null, tableNumber = null, guests = null, customerName = null, customerPhone = null, note = null }) {
    const o = {
      id: uid(), type, tableId, tableNumber, guests, customerName, customerPhone, note, status: 'open', items: [], billDiscounts: [], couponCodes: [],
      memberId: null, member: null, pointsToUse: 0, scExempt: false, paidTotal: 0, saved: false, dirty: true, offline: false, createdAt: new Date().toISOString(),
    };
    set({ order: o, view: 'sell' });
    await get().save({ immediate: true });
    return get().order;
  },

  async openOrder(id) {
    await get().flushSave();
    const o = await api(`/orders/${id}`);
    set({ order: fromServer(o), view: 'sell' });
    return o;
  },
  closeOrder() { clearTimeout(saveTimer); set({ order: null }); },

  update(patch) {
    const o = get().order;
    if (!o) return;
    set({ order: { ...o, ...(typeof patch === 'function' ? patch(o) : patch), dirty: true } });
    get().scheduleSave();
  },

  addItem(product, { variant = null, modifiers = [], qty = 1, note = '' } = {}) {
    const o = get().order;
    if (!o) return;
    const mods = modifiers.map((m) => ({ modifierId: m.id ?? m.modifierId, groupId: m.groupId, name: m.name, price: Number(m.price) || 0, qty: m.qty || 1 }));
    const sig = (i) => `${i.productId}|${i.variantId ?? ''}|${i.modifiers.map((m) => `${m.modifierId}x${m.qty}`).sort().join(',')}|${i.note || ''}|${i.priceOverride ?? ''}`;
    const draft = { id: uid(), productId: product.id, variantId: variant?.id ?? null, name: product.name, variantName: variant?.name ?? null, qty, note: note || null,
      basePrice: product.price, variantPrice: variant?.priceDelta || 0, modifiers: mods, priceOverride: null, discounts: [], status: 'draft', categoryId: product.categoryId };
    draft.unitPrice = unitPriceOf(draft);
    const same = o.items.find((i) => i.status === 'draft' && !i.rewardRedemptionId && sig(i) === sig(draft) && !(i.discounts || []).length);
    const items = same ? o.items.map((i) => (i === same ? { ...i, qty: i.qty + qty } : i)) : [...o.items, draft];
    get().update({ items });
    return same?.id || draft.id;
  },
  setItem(id, patch) {
    get().update((o) => ({ items: o.items.map((i) => (i.id === id ? (() => { const n = { ...i, ...patch }; n.unitPrice = unitPriceOf(n); return n; })() : i)) }));
  },
  removeDraft(id) { get().update((o) => ({ items: o.items.filter((i) => i.id !== id) })); },

  /** Local totals (instant) via the shared Calculation Engine + Promotion Engine. */
  totals() {
    const { order, catalog } = get();
    const settings = useApp.getState().settings;
    if (!order || !settings) return null;
    const items = order.items.filter((i) => i.status !== 'voided');
    const prodOf = (id) => catalog.products.find((p) => p.id === id) || {};
    const catOf = (id) => catalog.categories.find((c) => c.id === id) || {};
    const tier = order.member?.tierId ? catalog.tiers.find((t) => t.id === order.member.tierId) : null;
    const lines = items.map((i) => ({ key: i.id, productId: i.productId, categoryId: prodOf(i.productId).categoryId, unitPrice: i.unitPrice, qty: i.qty, noPromotion: !!prodOf(i.productId).noPromotion || !!i.rewardRedemptionId || i.priceOverride != null }));
    const promo = evaluatePromotions(lines, catalog.promotions, { timezone: settings.shop?.timezone, branchId: useApp.getState().branch?.id, member: order.member ? { ...order.member, tier_id: order.member.tierId } : null, orderType: order.type, couponCodes: order.couponCodes });
    const bill = [...promo.billDiscounts, ...order.billDiscounts.filter((d) => d.source === 'manual'), ...order.billDiscounts.filter((d) => d.source === 'reward')];
    if (tier?.discount_pct > 0) bill.push({ type: 'pct', value: tier.discount_pct, label: `ส่วนลดสมาชิก ${tier.discount_pct}%`, source: 'tier' });
    const pv = Number(settings.points?.pointValue) || 0;
    const pointsUsed = order.member && pv > 0 ? Math.min(order.pointsToUse || 0, order.member.points || 0) : 0;
    if (pointsUsed > 0) bill.push({ type: 'amount', value: pointsUsed * pv, label: `ใช้ ${pointsUsed} แต้ม`, source: 'points' });
    const calc = calculate({
      items: items.map((i) => ({ key: i.id, unitPrice: i.unitPrice, qty: i.qty, vatExempt: !!prodOf(i.productId).vatExempt, scExempt: !!prodOf(i.productId).scExempt || !!catOf(prodOf(i.productId).categoryId).scExempt, discounts: [...(i.discounts || []), ...(promo.itemDiscounts[i.id] || [])] })),
      billDiscounts: bill, settings: { vat: settings.vat, serviceCharge: settings.serviceCharge }, orderType: order.type, scExempt: order.scExempt,
    });
    const mult = Object.fromEntries(items.map((i) => [i.id, i.rewardRedemptionId ? 0 : (prodOf(i.productId).pointMultiplier ?? catOf(prodOf(i.productId).categoryId).pointMultiplier ?? 1)]));
    const earn = computeEarnPoints(calc, mult, settings.points, { tierMultiplier: order.member ? tier?.point_multiplier || 1 : 1, promoMultiplier: promo.pointMultiplier, bonusPoints: promo.bonusPoints });
    return { ...calc, promotions: promo.applied, earnPoints: earn.points, pointsUsed, remaining: Math.max(0, Math.round((calc.total - (order.paidTotal || 0)) * 100) / 100) };
  },

  scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().save(), 900);
  },
  async flushSave() { clearTimeout(saveTimer); if (get().order?.dirty) await get().save({ immediate: true }); else if (saving) await saving; },

  /** Persist the order. Online → server (authoritative totals). Offline → IndexedDB + outbox. */
  async save({ immediate = false } = {}) {
    clearTimeout(saveTimer);
    if (saving) { await saving; if (!get().order?.dirty) return get().order; }
    const o = get().order;
    if (!o || ['paid', 'voided'].includes(o.status)) return o;
    const sentIds = new Set(o.items.map((i) => i.id));
    const run = async () => {
      if (useApp.getState().online && !o.offline) {
        try {
          const res = await api(o.saved ? `/orders/${o.id}` : '/orders', { method: o.saved ? 'PUT' : 'POST', body: { ...toPayload(o), id: o.id } });
          const cur = get().order;
          if (!cur || cur.id !== o.id) return;
          const server = fromServer(res);
          // keep items added locally while the request was in flight
          const late = cur.items.filter((i) => !sentIds.has(i.id));
          const changedDuring = cur !== o && cur.items.some((i) => { const before = o.items.find((x) => x.id === i.id); return before && before !== i; });
          set({ order: { ...server, items: [...server.items, ...late], dirty: late.length > 0 || changedDuring, member: server.member ?? cur.member } });
          if (late.length || changedDuring) get().scheduleSave();
          return;
        } catch (e) {
          if (e.code === 'ORDER_CONFLICT' && e.data?.order) {
            const server = fromServer(e.data.order);
            const localDrafts = o.items.filter((i) => i.status === 'draft' && !server.items.some((s) => s.id === i.id));
            set({ order: { ...server, items: [...server.items, ...localDrafts], dirty: localDrafts.length > 0 } });
            toast('บิลถูกแก้ไขจากเครื่องอื่น — โหลดข้อมูลล่าสุดแล้ว', 'warning');
            if (localDrafts.length) get().scheduleSave();
            return;
          }
          if (!(e instanceof NetworkError)) {
            // resync with the server state (e.g. approval cancelled, sold out, permission denied)
            if (o.saved) { try { set({ order: fromServer(await api(`/orders/${o.id}`)) }); } catch { set({ order: { ...get().order, dirty: false } }); } } else set({ order: { ...get().order, dirty: false } });
            if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error');
            if (e.code === 'SOLD_OUT' || e.code === 'TABLE_OCCUPIED') get().loadCatalog();
            throw e;
          }
          useApp.setState({ online: false });
        }
      }
      await get().saveOffline();
    };
    saving = run().finally(() => { saving = null; });
    if (immediate) await saving; else saving.catch(() => {});
    return get().order;
  },

  /** Offline: assign local numbers, keep in IndexedDB and queue a (merged) PUT for replay. */
  async saveOffline() {
    let o = get().order;
    if (!o) return;
    if (!o.orderNo) {
      const { device, branch, settings } = useApp.getState();
      const seq = ((await kvGet('offlineSeq')) || 0) + 1;
      await kvSet('offlineSeq', seq);
      const code = (device?.code || 'POS').replace(/[^A-Za-z0-9]/g, '');
      o = { ...o, offline: true, orderNo: `${code}-${String(seq).padStart(4, '0')}`, queueNo: o.type !== 'dine_in' ? `${branch?.queuePrefix ?? 'Q'}-${code}${String(seq).padStart(3, '0')}` : null, businessDate: businessDate(new Date(), settings?.shop?.timezone) };
    }
    o = { ...o, offline: true, dirty: false };
    set({ order: o });
    await localOrderPut(o);
    await queueOrderPut(o);
  },
}));

/** Replace a pending PUT for the same order instead of stacking many (keeps the outbox small). */
export async function queueOrderPut(o) {
  const path = `/orders/${o.id}`;
  const body = { ...toPayload(o), id: o.id, merge: true, version: undefined, status: ['open', 'held'].includes(o.status) ? o.status : undefined, offline: { orderNo: o.orderNo, queueNo: o.queueNo || undefined, createdAt: o.createdAt } };
  const pending = (await outboxAll()).filter((x) => x.status === 'pending');
  const last = pending[pending.length - 1];
  if (last && last.path === path && last.method === 'PUT') { await outboxPut({ ...last, body }); return; }
  await enqueue(path, 'PUT', body, `บันทึกบิล ${o.queueNo || o.orderNo}`);
}

export async function finishOfflineOrder(id) { await localOrderDelete(id); flush(); }

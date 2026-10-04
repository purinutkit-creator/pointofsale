// ─────────────────────────────────────────────────────────────────────────────
// Central Calculation Engine
// Subtotal → Discount (item, then bill) → Service Charge → VAT → Grand Total
// Used by POS, Customer Display, receipts, server payment commit and reports.
// Never compute totals anywhere else.
// ─────────────────────────────────────────────────────────────────────────────
import { toSatang, toBaht, allocate } from './money.js';

/**
 * @param {object} input
 * @param {Array<{key:string, unitPrice:number, qty:number, vatExempt?:boolean, scExempt?:boolean,
 *   discounts?:Array<{type:'pct'|'amount', value:number, label?:string, source?:string}>, voided?:boolean}>} input.items
 *   unitPrice = base price + variant delta + modifier prices (per unit, baht)
 * @param {Array<{type:'pct'|'amount', value:number, label?:string, source?:string}>} [input.billDiscounts]
 * @param {{vat:{enabled:boolean, rate:number, mode:'inclusive'|'exclusive'}, serviceCharge:{enabled:boolean, rate:number, applyTo:'all'|'dine_in'|'takeaway'}}} input.settings
 * @param {'dine_in'|'takeaway'|'delivery'} input.orderType
 * @param {boolean} [input.scExempt] order level service-charge exemption
 */
export function calculate({ items = [], billDiscounts = [], settings = {}, orderType = 'takeaway', scExempt = false }) {
  const vat = { enabled: false, rate: 7, mode: 'inclusive', ...(settings.vat || {}) };
  const sc = { enabled: false, rate: 10, applyTo: 'dine_in', ...(settings.serviceCharge || {}) };

  const active = items.filter((it) => !it.voided && Number(it.qty) > 0);

  // 1) line gross + item discounts
  const lines = active.map((it) => {
    const unit = toSatang(it.unitPrice);
    const gross = unit * Number(it.qty);
    let remaining = gross;
    const discountDetail = [];
    for (const d of it.discounts || []) {
      let amt = d.type === 'pct' ? Math.round((remaining * Number(d.value)) / 100) : toSatang(d.value);
      amt = Math.max(0, Math.min(amt, remaining));
      if (amt > 0) discountDetail.push({ label: d.label || 'ส่วนลด', source: d.source || 'manual', amount: amt });
      remaining -= amt;
    }
    return {
      key: it.key, vatExempt: !!it.vatExempt, scExempt: !!it.scExempt,
      gross, itemDiscount: gross - remaining, afterItem: remaining, discountDetail,
    };
  });

  const subtotal = lines.reduce((a, l) => a + l.gross, 0);
  const itemDiscount = lines.reduce((a, l) => a + l.itemDiscount, 0);
  let running = subtotal - itemDiscount;

  // 2) bill discounts applied sequentially on the running amount, allocated to lines
  const billLines = [];
  const lineBill = lines.map(() => 0);
  for (const d of billDiscounts) {
    let amt = d.type === 'pct' ? Math.round((running * Number(d.value)) / 100) : toSatang(d.value);
    amt = Math.max(0, Math.min(amt, running));
    if (amt <= 0) continue;
    const weights = lines.map((l, i) => l.afterItem - lineBill[i]);
    allocate(amt, weights).forEach((a, i) => (lineBill[i] += a));
    billLines.push({ label: d.label || 'ส่วนลดท้ายบิล', source: d.source || 'manual', amount: toBaht(amt) });
    running -= amt;
  }
  lines.forEach((l, i) => { l.billDiscount = lineBill[i]; l.net = l.afterItem - lineBill[i]; });
  const billDiscount = lineBill.reduce((a, b) => a + b, 0);
  const afterDiscount = subtotal - itemDiscount - billDiscount;

  // 3) service charge
  const scApplies = sc.enabled && !scExempt && Number(sc.rate) > 0 &&
    (sc.applyTo === 'all' || sc.applyTo === orderType);
  const scBase = scApplies ? lines.filter((l) => !l.scExempt).reduce((a, l) => a + l.net, 0) : 0;
  const serviceCharge = scApplies ? Math.round((scBase * Number(sc.rate)) / 100) : 0;
  const scAlloc = allocate(serviceCharge, lines.map((l) => (scApplies && !l.scExempt ? l.net : 0)));
  lines.forEach((l, i) => (l.sc = scAlloc[i]));

  // 4) VAT (service charge follows the VAT status of the line it was charged on)
  const rate = vat.enabled ? Number(vat.rate) || 0 : 0;
  const vatableBase = lines.filter((l) => !l.vatExempt).reduce((a, l) => a + l.net + l.sc, 0);
  const exemptAmount = lines.filter((l) => l.vatExempt).reduce((a, l) => a + l.net + l.sc, 0);
  let vatAmount = 0;
  let total;
  if (rate > 0 && vat.mode === 'exclusive') {
    vatAmount = Math.round((vatableBase * rate) / 100);
    total = afterDiscount + serviceCharge + vatAmount;
  } else {
    vatAmount = rate > 0 ? Math.round((vatableBase * rate) / (100 + rate)) : 0;
    total = afterDiscount + serviceCharge;
  }
  const vatAlloc = allocate(vatAmount, lines.map((l) => (l.vatExempt ? 0 : l.net + l.sc)));
  lines.forEach((l, i) => {
    l.vat = vatAlloc[i];
    l.total = l.net + l.sc + (vat.mode === 'exclusive' ? l.vat : 0);
    l.beforeVat = l.total - l.vat;
  });

  return {
    lines: lines.map((l) => ({
      key: l.key,
      gross: toBaht(l.gross), itemDiscount: toBaht(l.itemDiscount), billDiscount: toBaht(l.billDiscount),
      net: toBaht(l.net), serviceCharge: toBaht(l.sc), vat: toBaht(l.vat), total: toBaht(l.total),
      beforeVat: toBaht(l.beforeVat),
      discountDetail: l.discountDetail.map((d) => ({ ...d, amount: toBaht(d.amount) })),
    })),
    subtotal: toBaht(subtotal),
    itemDiscount: toBaht(itemDiscount),
    billDiscount: toBaht(billDiscount),
    billDiscountLines: billLines,
    discount: toBaht(itemDiscount + billDiscount),
    afterDiscount: toBaht(afterDiscount),
    serviceCharge: toBaht(serviceCharge),
    serviceChargeRate: scApplies ? Number(sc.rate) : 0,
    vat: toBaht(vatAmount),
    vatRate: rate,
    vatMode: vat.mode,
    vatableBase: toBaht(vatableBase),
    exemptAmount: toBaht(exemptAmount),
    beforeVat: toBaht(total - vatAmount),
    total: toBaht(total),
    itemCount: active.reduce((a, it) => a + Number(it.qty), 0),
  };
}

/** Unit price of a cart line: base (or override) + variant delta + Σ modifier price × modifier qty */
export function unitPriceOf(item) {
  if (item.priceOverride != null && item.priceOverride !== '') return Number(item.priceOverride);
  const base = Number(item.basePrice) || 0;
  const variant = Number(item.variantPrice) || 0;
  const mods = (item.modifiers || []).reduce((a, m) => a + (Number(m.price) || 0) * (Number(m.qty) || 1), 0);
  return Math.round((base + variant + mods) * 100) / 100;
}

/** Change for cash payments */
export function cashChange(total, received) {
  return toBaht(Math.max(0, toSatang(received) - toSatang(total)));
}

/** Sum of tendered payments, used to validate split payment completeness. */
export function paymentsCover(total, payments) {
  const paid = payments.reduce((a, p) => a + toSatang(p.amount), 0);
  return { paid: toBaht(paid), remaining: toBaht(Math.max(0, toSatang(total) - paid)), complete: paid >= toSatang(total) };
}

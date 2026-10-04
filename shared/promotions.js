// ─────────────────────────────────────────────────────────────────────────────
// Promotion Engine
// Evaluates active promotions against a cart and returns item / bill discounts,
// point multipliers and bonus points. The server re-evaluates on commit.
// ─────────────────────────────────────────────────────────────────────────────
import { zonedParts } from './format.js';
import { toSatang, toBaht, allocate } from './money.js';

export const PROMOTION_TYPES = {
  bogo: 'ซื้อ X แถม Y (Buy 1 Get 1)',
  qty_discount: 'ซื้อ X ชิ้น ลด %/บาท',
  spend_discount: 'ซื้อครบ X ลด Y',
  bundle: 'Bundle / ชุดราคาพิเศษ',
  happy_hour: 'Happy Hour',
  member_price: 'ราคาสมาชิก',
  coupon: 'Coupon',
  point_multiplier: 'Double Point / ตัวคูณแต้ม',
  bonus_points: 'ซื้อครบรับแต้มพิเศษ',
};

const inList = (list, v) => !list || !list.length || list.map(String).includes(String(v));

/** Is the promotion active right now for this context? (date, day, time, branch, member/tier, coupon) */
export function promotionActive(p, ctx) {
  if (!p || p.status === 'inactive' || p.active === 0 || p.active === false) return false;
  const now = ctx.now ? new Date(ctx.now) : new Date();
  if (p.start_at && now < new Date(p.start_at)) return false;
  if (p.end_at && now > new Date(p.end_at)) return false;
  const z = zonedParts(now, ctx.timezone);
  const c = p.conditions || {};
  if (c.days && c.days.length && !c.days.map(Number).includes(z.weekday)) return false;
  if (c.timeStart && c.timeEnd) {
    const cur = z.hour * 60 + z.minute;
    const [h1, m1] = c.timeStart.split(':').map(Number);
    const [h2, m2] = c.timeEnd.split(':').map(Number);
    const a = h1 * 60 + m1; const b = h2 * 60 + m2;
    const ok = a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
    if (!ok) return false;
  }
  if (c.branchIds?.length && !inList(c.branchIds, ctx.branchId)) return false;
  if ((c.memberOnly || c.tierIds?.length || p.type === 'member_price') && !ctx.member) return false;
  if (c.tierIds?.length && !inList(c.tierIds, ctx.member?.tier_id)) return false;
  if (c.orderTypes?.length && !c.orderTypes.includes(ctx.orderType)) return false;
  const codes = (ctx.couponCodes || []).map((x) => String(x).trim().toUpperCase());
  // promotions that are not auto-applied must be picked by staff (stored as "#<id>")
  if ((p.auto_apply === false || p.auto_apply === 0) && p.type !== 'coupon' && !codes.includes(`#${p.id}`)) return false;
  if (p.type === 'coupon' || c.couponCode) {
    const code = (p.rule?.code || c.couponCode || '').trim().toUpperCase();
    if (!code || !codes.includes(code)) return false;
  }
  return true;
}

function eligibleLine(line, p) {
  const r = p.rule || {};
  const products = r.productIds || p.conditions?.productIds;
  const cats = r.categoryIds || p.conditions?.categoryIds;
  if ((!products || !products.length) && (!cats || !cats.length)) return true;
  return (products?.length && inList(products, line.productId)) || (cats?.length && inList(cats, line.categoryId));
}

/**
 * @param {Array<{key, productId, categoryId, unitPrice, qty, noPromotion?:boolean}>} lines
 * @param {Array} promotions rows (with parsed rule/conditions JSON)
 * @param {object} ctx {now, timezone, branchId, member, orderType, couponCodes}
 * @returns {{itemDiscounts: Record<string, Array>, billDiscounts: Array, pointMultiplier:number, bonusPoints:number, applied:Array}}
 */
export function evaluatePromotions(lines, promotions, ctx = {}) {
  const itemDiscounts = {}; // key -> [{type:'amount', value, label, source, promotionId}]
  const billDiscounts = [];
  const applied = [];
  let pointMultiplier = 1;
  let bonusPoints = 0;
  const locked = new Set(); // lines taken by a non-stackable promotion
  const remaining = {}; // satang remaining per line after promo discounts
  for (const l of lines) remaining[l.key] = toSatang(l.unitPrice) * l.qty;

  const addItem = (p, key, satang) => {
    satang = Math.min(satang, remaining[key]);
    if (satang <= 0) return 0;
    remaining[key] -= satang;
    (itemDiscounts[key] ||= []).push({ type: 'amount', value: toBaht(satang), label: p.name, source: 'promotion', promotionId: p.id });
    if (!p.stackable) locked.add(key);
    return satang;
  };

  const active = promotions
    .filter((p) => promotionActive(p, ctx))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const subtotalSat = () => lines.reduce((a, l) => a + remaining[l.key], 0);

  for (const p of active) {
    const r = p.rule || {};
    const minSpend = toSatang(p.conditions?.minSpend || 0);
    if (minSpend && subtotalSat() < minSpend) continue;
    const pool = lines.filter((l) => !l.noPromotion && eligibleLine(l, p) && (p.stackable ? true : !locked.has(l.key)));
    let total = 0;

    switch (p.type) {
      case 'bogo': {
        const buy = Math.max(1, Number(r.buyQty) || 1);
        const get = Math.max(1, Number(r.getQty) || 1);
        const pct = r.getDiscountPct == null ? 100 : Number(r.getDiscountPct);
        // expand to units, most expensive first; cheapest of each group is discounted
        const units = pool.flatMap((l) => Array.from({ length: l.qty }, () => ({ key: l.key, price: toSatang(l.unitPrice) })))
          .sort((a, b) => b.price - a.price);
        const groups = Math.floor(units.length / (buy + get));
        const maxSets = r.maxSets ? Number(r.maxSets) : Infinity;
        const freeUnits = units.slice(units.length - Math.min(groups, maxSets) * get);
        // free units come from the cheapest part of the list
        for (const u of freeUnits) total += addItem(p, u.key, Math.round((u.price * pct) / 100));
        break;
      }
      case 'qty_discount': {
        const qty = pool.reduce((a, l) => a + l.qty, 0);
        if (qty < (Number(r.minQty) || 1)) break;
        if (r.discountType === 'amount') {
          const amt = toSatang(r.value);
          const parts = allocate(amt, pool.map((l) => remaining[l.key]));
          pool.forEach((l, i) => (total += addItem(p, l.key, parts[i])));
        } else {
          pool.forEach((l) => (total += addItem(p, l.key, Math.round((remaining[l.key] * Number(r.value)) / 100))));
        }
        break;
      }
      case 'happy_hour':
      case 'member_price': {
        pool.forEach((l) => {
          let amt;
          if (r.discountType === 'amount') amt = toSatang(r.value) * l.qty; // per unit
          else if (r.discountType === 'price') amt = Math.max(0, (toSatang(l.unitPrice) - toSatang(r.value)) * l.qty);
          else amt = Math.round((remaining[l.key] * Number(r.value)) / 100);
          total += addItem(p, l.key, amt);
        });
        break;
      }
      case 'bundle': {
        const req = (r.items || []).filter((x) => x.productId);
        if (!req.length) break;
        const avail = {};
        for (const l of pool) avail[l.productId] = (avail[l.productId] || 0) + l.qty;
        const sets = Math.min(...req.map((x) => Math.floor((avail[x.productId] || 0) / (Number(x.qty) || 1))),
          r.maxSets ? Number(r.maxSets) : Infinity);
        if (!sets || !isFinite(sets)) break;
        let setPrice = 0;
        const usage = [];
        for (const x of req) {
          let need = (Number(x.qty) || 1) * sets;
          for (const l of pool.filter((ln) => String(ln.productId) === String(x.productId))) {
            const take = Math.min(need, l.qty);
            if (take <= 0) continue;
            usage.push({ key: l.key, sat: toSatang(l.unitPrice) * take });
            setPrice += toSatang(l.unitPrice) * take;
            need -= take;
          }
        }
        const discount = Math.max(0, setPrice - toSatang(r.bundlePrice) * sets);
        const parts = allocate(discount, usage.map((u) => u.sat));
        usage.forEach((u, i) => (total += addItem(p, u.key, parts[i])));
        break;
      }
      case 'spend_discount':
      case 'coupon': {
        const restricted = (r.productIds?.length || r.categoryIds?.length);
        if (restricted) {
          const base = pool.reduce((a, l) => a + remaining[l.key], 0);
          let amt = r.discountType === 'amount' ? toSatang(r.value) : Math.round((base * Number(r.value)) / 100);
          if (r.maxDiscount) amt = Math.min(amt, toSatang(r.maxDiscount));
          const parts = allocate(Math.min(amt, base), pool.map((l) => remaining[l.key]));
          pool.forEach((l, i) => (total += addItem(p, l.key, parts[i])));
        } else {
          const base = subtotalSat();
          if (r.minSpend && base < toSatang(r.minSpend)) break;
          let amt = r.discountType === 'amount' ? toSatang(r.value) : Math.round((base * Number(r.value)) / 100);
          if (r.maxDiscount) amt = Math.min(amt, toSatang(r.maxDiscount));
          amt = Math.min(amt, base);
          if (amt > 0) {
            billDiscounts.push({ type: 'amount', value: toBaht(amt), label: p.name, source: p.type === 'coupon' ? 'coupon' : 'promotion', promotionId: p.id });
            total += amt;
          }
        }
        break;
      }
      case 'point_multiplier': {
        const m = Number(r.multiplier) || 2;
        if (m > pointMultiplier) { pointMultiplier = m; applied.push({ id: p.id, name: p.name, type: p.type, multiplier: m }); }
        continue;
      }
      case 'bonus_points': {
        const pts = Number(r.points) || 0;
        if (pts > 0) { bonusPoints += pts; applied.push({ id: p.id, name: p.name, type: p.type, points: pts }); }
        continue;
      }
      default:
        continue;
    }
    if (total > 0) applied.push({ id: p.id, name: p.name, type: p.type, amount: toBaht(total) });
  }

  return { itemDiscounts, billDiscounts, pointMultiplier, bonusPoints, applied };
}

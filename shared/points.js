// Loyalty point calculation shared by POS (preview "+12 Points"), Customer Display and server commit.

export const DEFAULT_POINT_SETTINGS = {
  enabled: true,
  earnAmount: 25, // บาท
  earnPoints: 1, // แต้ม
  base: 'after_discount', // before_discount | after_discount | before_vat | after_vat | grand_total
  rounding: 'floor', // floor | ceil | round
  minSpend: 0,
  expiry: { mode: 'none', months: 12, date: null }, // none | months | fixed
  negativePolicy: 'allow_negative', // allow_negative | debt
  pointValue: 0, // บาท ต่อ 1 แต้ม เมื่อใช้แต้มเป็นส่วนลดโดยตรง (0 = ปิด)
  tierBasis: 'lifetime', // current | lifetime — คะแนนที่ใช้ตัดสิน Tier
  claimDays: 7, // QR ท้ายใบเสร็จใช้สะสมได้ภายในกี่วัน
};

export const POINT_TX_TYPES = {
  EARN: 'ได้แต้มจากการซื้อ', REDEEM: 'ใช้แต้ม', BONUS: 'แต้มโปรโมชั่น', BIRTHDAY: 'แต้มวันเกิด',
  ADJUSTMENT: 'ปรับแต้มโดยแอดมิน', REFUND: 'หักแต้มจากการคืนสินค้า', EXPIRED: 'แต้มหมดอายุ',
};

const lineBase = (line, base) => {
  switch (base) {
    case 'before_discount': return line.gross;
    case 'before_vat': return line.beforeVat;
    case 'after_vat':
    case 'grand_total': return line.total;
    case 'after_discount':
    default: return line.net;
  }
};

/**
 * @param {object} calc result of calculate()
 * @param {Record<string, number>} multipliers line key -> product/category multiplier (0 = no point)
 * @param {object} settings point settings
 * @param {{tierMultiplier?:number, promoMultiplier?:number, bonusPoints?:number}} extra
 */
export function computeEarnPoints(calc, multipliers, settings, extra = {}) {
  const s = { ...DEFAULT_POINT_SETTINGS, ...(settings || {}) };
  if (!s.enabled || !calc || !(Number(s.earnAmount) > 0)) return { points: 0, base: 0, bonus: 0 };
  const baseTotal = calc.lines.reduce((a, l) => a + lineBase(l, s.base), 0);
  if (Number(s.minSpend) > 0 && baseTotal < Number(s.minSpend)) return { points: 0, base: baseTotal, bonus: 0 };
  const weighted = calc.lines.reduce((a, l) => {
    const m = multipliers?.[l.key];
    return a + lineBase(l, s.base) * (m == null ? 1 : Number(m));
  }, 0);
  const mult = (Number(extra.tierMultiplier) || 1) * (Number(extra.promoMultiplier) || 1);
  const raw = (weighted / Number(s.earnAmount)) * Number(s.earnPoints) * mult;
  const fn = s.rounding === 'ceil' ? Math.ceil : s.rounding === 'round' ? Math.round : Math.floor;
  // guard against float noise such as 3.9999999 → 3
  const points = Math.max(0, fn(Math.round(raw * 1e6) / 1e6));
  const bonus = Math.max(0, Math.floor(Number(extra.bonusPoints) || 0));
  return { points: points + bonus, earned: points, bonus, base: Math.round(baseTotal * 100) / 100 };
}

/** Expiry date for points earned at `from` according to settings (ISO string or null). */
export function pointExpiry(settings, from = new Date()) {
  const e = { ...DEFAULT_POINT_SETTINGS.expiry, ...(settings?.expiry || {}) };
  if (e.mode === 'months') {
    const d = new Date(from);
    d.setMonth(d.getMonth() + (Number(e.months) || 12));
    return d.toISOString();
  }
  if (e.mode === 'fixed' && e.date) return new Date(`${e.date}T23:59:59+07:00`).toISOString();
  return null;
}

/** Find the tier a member qualifies for (tiers sorted by min_points asc). */
export function resolveTier(tiers, stats) {
  const sorted = [...tiers].filter((t) => t.active !== 0).sort((a, b) => (a.min_points || 0) - (b.min_points || 0));
  let found = null;
  for (const t of sorted) {
    const pts = stats.points ?? 0;
    if (pts < (t.min_points || 0)) continue;
    const rules = t.rules || [];
    const ok = rules.every((r) => {
      const v = Number(r.value) || 0;
      if (r.type === 'total_spend') return (stats.totalSpend || 0) >= v;
      if (r.type === 'visits') return (stats.visits || 0) >= v;
      if (r.type === 'period_spend') return (stats.periodSpend?.[r.days || 365] || 0) >= v;
      if (r.type === 'points') return pts >= v;
      return true;
    });
    if (ok) found = t;
  }
  return found || sorted[0] || null;
}

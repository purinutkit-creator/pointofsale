// Unit tests for the shared engines (calculation, kitchen split, promotions, points, ESC/POS, PromptPay)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../shared/calc.js';
import { splitTickets, expandCopies, planKitchenTickets } from '../shared/kitchen.js';
import { evaluatePromotions } from '../shared/promotions.js';
import { computeEarnPoints, resolveTier } from '../shared/points.js';
import { EscPos, toMonochrome, encodeTIS620 } from '../shared/escpos.js';
import { promptPayPayload, code128 } from '../shared/codes.js';

const S = (vat, sc) => ({ vat, serviceCharge: sc });

test('calc: discount → service charge → VAT exclusive', () => {
  const c = calculate({ items: [{ key: 'a', unitPrice: 100, qty: 2 }], billDiscounts: [{ type: 'pct', value: 10 }], settings: S({ enabled: true, rate: 7, mode: 'exclusive' }, { enabled: true, rate: 10, applyTo: 'all' }), orderType: 'dine_in' });
  assert.equal(c.subtotal, 200); assert.equal(c.discount, 20); assert.equal(c.serviceCharge, 18);
  assert.equal(c.vat, 13.86); assert.equal(c.total, 211.86);
});

test('calc: VAT inclusive extracts VAT, exempt items excluded, SC only dine-in', () => {
  const c = calculate({ items: [{ key: 'a', unitPrice: 107, qty: 1 }, { key: 'b', unitPrice: 50, qty: 1, vatExempt: true }], settings: S({ enabled: true, rate: 7, mode: 'inclusive' }, { enabled: true, rate: 10, applyTo: 'dine_in' }), orderType: 'takeaway' });
  assert.equal(c.serviceCharge, 0); assert.equal(c.vat, 7); assert.equal(c.total, 157); assert.equal(c.exemptAmount, 50);
});

test('calc: item discount + allocation sums exactly', () => {
  const c = calculate({ items: [{ key: 'a', unitPrice: 33.33, qty: 3, discounts: [{ type: 'amount', value: 10 }] }, { key: 'b', unitPrice: 10, qty: 1 }], billDiscounts: [{ type: 'amount', value: 7.77 }], settings: S({ enabled: false }, { enabled: false }), orderType: 'takeaway' });
  assert.equal(c.total, Math.round((99.99 + 10 - 10 - 7.77) * 100) / 100);
  assert.equal(Math.round(c.lines.reduce((a, l) => a + l.total, 0) * 100) / 100, c.total);
});

test('kitchen: cut after, cut before, separate, each qty', () => {
  const t = splitTickets([{ n: 'กะเพรา', qty: 1 }, { n: 'ไข่ดาว', qty: 1 }, { n: 'A', qty: 1, cutMode: 'cut_after' }, { n: 'ชาไทย', qty: 1 }, { n: 'เค้ก', qty: 1 }]);
  assert.deepEqual(t.map((x) => x.map((i) => i.n)), [['กะเพรา', 'ไข่ดาว', 'A'], ['ชาไทย', 'เค้ก']]);
  const t2 = splitTickets([{ n: 'x', qty: 1 }, { n: 'b', qty: 1, cutMode: 'cut_before' }, { n: 's', qty: 1, cutMode: 'separate' }, { n: 'y', qty: 1 }]);
  assert.deepEqual(t2.map((x) => x.map((i) => i.n)), [['x'], ['b'], ['s'], ['y']]);
  const t3 = splitTickets([{ n: 'Steak', qty: 3, cutMode: 'each_qty' }]);
  assert.equal(t3.length, 3); assert.deepEqual(t3.map((x) => `${x[0].unitIndex}/${x[0].unitCount}`), ['1/3', '2/3', '3/3']);
  const copies = expandCopies(t, 2);
  assert.deepEqual(copies.map((c) => `${c.subIndex}/${c.subCount}-${c.copyIndex}/${c.copyCount}`), ['1/2-1/2', '1/2-2/2', '2/2-1/2', '2/2-2/2']);
  assert.equal(expandCopies(t, 0).length, 0);
  const plan = planKitchenTickets([{ stationId: 1, qty: 1 }, { stationId: 2, qty: 1 }, { stationId: 1, qty: 1, cutMode: 'cut_before' }]);
  assert.equal(plan.length, 2); assert.equal(plan[0].subTickets.length, 2);
});

test('promotions: BOGO, spend discount, coupon, double point', () => {
  const lines = [{ key: 'a', productId: 1, categoryId: 1, unitPrice: 50, qty: 2 }, { key: 'b', productId: 2, categoryId: 2, unitPrice: 100, qty: 1 }];
  const promos = [
    { id: 1, name: 'BOGO', type: 'bogo', rule: { buyQty: 1, getQty: 1, productIds: [1] }, conditions: {}, active: true, stackable: true },
    { id: 2, name: 'ครบ 150 ลด 20', type: 'spend_discount', rule: { minSpend: 150, discountType: 'amount', value: 20 }, conditions: {}, active: true, stackable: true },
    { id: 3, name: 'SAVE10', type: 'coupon', rule: { code: 'SAVE10', discountType: 'pct', value: 10 }, conditions: {}, active: true, stackable: true },
    { id: 4, name: 'Double', type: 'point_multiplier', rule: { multiplier: 2 }, conditions: { days: [new Date().getDay()] }, active: true },
  ];
  const r = evaluatePromotions(lines, promos, { couponCodes: [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  assert.equal(r.itemDiscounts.a[0].value, 50);
  assert.equal(r.billDiscounts.length, 1); // coupon not entered
  assert.equal(r.pointMultiplier, 2);
  const r2 = evaluatePromotions(lines, promos, { couponCodes: ['save10'], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  assert.equal(r2.billDiscounts.length, 2);
});

test('points: base, multipliers, rounding, minimum spend', () => {
  const c = calculate({ items: [{ key: 'a', unitPrice: 100, qty: 1 }, { key: 'b', unitPrice: 60, qty: 1 }], settings: S({ enabled: false }, { enabled: false }), orderType: 'takeaway' });
  assert.equal(computeEarnPoints(c, {}, { enabled: true, earnAmount: 50, earnPoints: 1 }).points, 3);
  assert.equal(computeEarnPoints(c, { b: 0 }, { enabled: true, earnAmount: 50, earnPoints: 1 }).points, 2);
  assert.equal(computeEarnPoints(c, {}, { enabled: true, earnAmount: 50, earnPoints: 1, rounding: 'ceil' }).points, 4);
  assert.equal(computeEarnPoints(c, {}, { enabled: true, earnAmount: 25, earnPoints: 1, minSpend: 200 }).points, 0);
  assert.equal(computeEarnPoints(c, {}, { enabled: true, earnAmount: 50, earnPoints: 1 }, { tierMultiplier: 1.5, bonusPoints: 10 }).points, 14);
  const tiers = [{ id: 1, min_points: 0, rules: [] }, { id: 2, min_points: 101, rules: [] }, { id: 3, min_points: 301, rules: [{ type: 'total_spend', value: 5000 }] }];
  assert.equal(resolveTier(tiers, { points: 350, totalSpend: 100 }).id, 2);
  assert.equal(resolveTier(tiers, { points: 350, totalSpend: 6000 }).id, 3);
});

test('escpos: raster, cut, feed-only without cutter, TIS-620', () => {
  const rgba = new Uint8ClampedArray(16 * 2 * 4).fill(255);
  for (let i = 0; i < 8; i++) { rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; }
  const m = toMonochrome(rgba, 16, 2, { dither: false });
  assert.equal(m.widthBytes, 2); assert.equal(m.bits[0], 0xff); assert.equal(m.bits[1], 0);
  const withCut = new EscPos().init().cut({ hasCutter: true, cutType: 'full', feedLines: 3 }).bytes();
  assert.deepEqual([...withCut.slice(-4)], [0x1d, 0x56, 0x41, 0]);
  const noCut = new EscPos().init().cut({ hasCutter: false, feedLines: 3 }).bytes();
  assert.ok(!noCut.includes(0x56));
  assert.deepEqual([...encodeTIS620('ก')], [0xa1]);
});

test('PromptPay payload (EMVCo) and Code128', () => {
  const p = promptPayPayload('0812345678', 100);
  assert.ok(p.startsWith('000201010212'));
  assert.ok(p.includes('0066812345678'));
  assert.ok(p.includes('5406100.00'));
  assert.match(p, /6304[0-9A-F]{4}$/);
  assert.ok(code128('00000001').length > 20);
});

// ─────────────────────────────────────────────────────────────────────────────
// Document renderer — receipts, kitchen tickets, shift reports, test pages.
// Draws with the Sarabun font onto a canvas (browser HTMLCanvas / OffscreenCanvas
// or @napi-rs/canvas on the server). The bitmap is then converted to ESC/POS
// raster (shared/escpos.js) so every thermal printer prints Sarabun Thai text.
// ─────────────────────────────────────────────────────────────────────────────
import { money } from './money.js';
import { fmtDate, fmtTime, ORDER_TYPE_LABEL, PAYMENT_METHOD_LABEL } from './format.js';
import { drawQR, drawCode128, code128Width } from './codes.js';

const wordSeg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const graphSeg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
const segments = (s, seg) => (seg ? [...seg.segment(s)].map((x) => x.segment) : [...s]);

class Layout {
  constructor(ctx, width, family) {
    this.ctx = ctx; this.width = width; this.family = family;
    this.pad = Math.round(width * 0.02);
    this.inner = width - this.pad * 2;
    this.ops = []; this.y = 0;
    this.base = width <= 400 ? 22 : 26;
  }
  font(size, bold) { return `${bold ? 'bold ' : ''}${size}px ${this.family}`; }
  measure(text, size, bold) { this.ctx.font = this.font(size, bold); return this.ctx.measureText(text).width; }

  wrap(text, maxW, size, bold) {
    const out = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      for (const w of segments(para, wordSeg)) {
        if (this.measure(line + w, size, bold) <= maxW) { line += w; continue; }
        if (line.trim()) out.push(line.trimEnd());
        line = w.trimStart();
        if (this.measure(line, size, bold) > maxW) { // very long word → break by grapheme
          let part = '';
          for (const g of segments(line, graphSeg)) {
            if (this.measure(part + g, size, bold) > maxW && part) { out.push(part); part = g; } else part += g;
          }
          line = part;
        }
      }
      out.push(line);
    }
    return out;
  }
  lh(size) { return Math.round(size * 1.42); }

  text(t, { size = this.base, bold = false, align = 'left', indent = 0, invert = false } = {}) {
    if (t == null || t === '') return this;
    const lines = this.wrap(t, this.inner - indent - (invert ? 16 : 0), size, bold);
    const h = this.lh(size);
    if (invert) {
      this.ops.push({ k: 'rect', y: this.y, h: lines.length * h + 8 });
      this.y += 4;
    }
    for (const l of lines) {
      this.ops.push({ k: 'text', t: l, y: this.y, size, bold, align, indent, color: invert ? '#fff' : '#000' });
      this.y += h;
    }
    if (invert) this.y += 8;
    return this;
  }
  row(left, right, { size = this.base, bold = false, indent = 0 } = {}) {
    const rw = right ? this.measure(right, size, bold) + 12 : 0;
    const lines = this.wrap(left, this.inner - indent - rw, size, bold);
    const h = this.lh(size);
    lines.forEach((l, i) => {
      this.ops.push({ k: 'text', t: l, y: this.y, size, bold, align: 'left', indent });
      if (i === 0 && right) this.ops.push({ k: 'text', t: right, y: this.y, size, bold, align: 'right' });
      this.y += h;
    });
    return this;
  }
  hr(dashed = true) { this.ops.push({ k: 'hr', y: this.y + 6, dashed }); this.y += 14; return this; }
  space(h = 8) { this.y += h; return this; }
  image(img, maxW, maxH = 160) {
    if (!img) return this;
    const s = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = Math.round(img.width * s); const h = Math.round(img.height * s);
    this.ops.push({ k: 'img', img, y: this.y, w, h });
    this.y += h + 8;
    return this;
  }
  qr(text, px) { this.ops.push({ k: 'qr', t: text, y: this.y, px }); this.y += px + 6; return this; }
  barcode(text, h = 70) {
    let module = 3;
    while (module > 1 && code128Width(text, module) > this.inner) module--;
    this.ops.push({ k: 'bar', t: text, y: this.y, h, module });
    this.y += h + 6;
    return this;
  }

  draw(ctx) {
    const W = this.width;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, this.y + 4);
    ctx.textBaseline = 'alphabetic';
    for (const op of this.ops) {
      if (op.k === 'text') {
        ctx.font = this.font(op.size, op.bold);
        ctx.fillStyle = op.color || '#000';
        const tw = ctx.measureText(op.t).width;
        const x = op.align === 'center' ? (W - tw) / 2 : op.align === 'right' ? W - this.pad - tw : this.pad + op.indent;
        ctx.fillText(op.t, Math.round(x), Math.round(op.y + op.size * 1.08));
      } else if (op.k === 'rect') {
        ctx.fillStyle = '#000';
        ctx.fillRect(this.pad, op.y, this.inner, op.h);
      } else if (op.k === 'hr') {
        ctx.fillStyle = '#000';
        if (op.dashed) for (let x = this.pad; x < W - this.pad; x += 12) ctx.fillRect(x, op.y, 7, 2);
        else ctx.fillRect(this.pad, op.y, this.inner, 3);
      } else if (op.k === 'img') {
        ctx.drawImage(op.img, Math.round((W - op.w) / 2), op.y, op.w, op.h);
      } else if (op.k === 'qr') {
        drawQR(ctx, op.t, Math.round((W - op.px) / 2), op.y, op.px);
      } else if (op.k === 'bar') {
        const w = code128Width(op.t, op.module);
        drawCode128(ctx, op.t, Math.round((W - w) / 2), op.y, op.h, op.module);
      }
    }
  }
}

const fmtQty = (q) => (Number.isInteger(Number(q)) ? String(q) : Number(q).toFixed(2));

function receiptLayout(L, d, assets) {
  const s = d.sections || {};
  const on = (k) => s[k] !== false;
  const big = L.base + 8;
  const shop = d.shop || {};
  if (d.reprint) L.text('*** REPRINT / พิมพ์ซ้ำ ***', { align: 'center', bold: true });
  if (on('logo') && assets.logo) L.image(assets.logo, L.inner * 0.6, 150);
  if (on('shopName')) L.text(shop.name, { size: big, bold: true, align: 'center' });
  if (on('branch') && shop.branchName) L.text(shop.branchName, { align: 'center' });
  if (on('address')) L.text(shop.address, { size: L.base - 2, align: 'center' });
  if (on('phone') && shop.phone) L.text(`โทร ${shop.phone}`, { size: L.base - 2, align: 'center' });
  if (on('taxId') && shop.taxId) L.text(`เลขประจำตัวผู้เสียภาษี ${shop.taxId}`, { size: L.base - 2, align: 'center' });
  if (on('header') && shop.header) L.text(shop.header, { size: L.base - 2, align: 'center' });
  L.space(4);
  L.text(d.title || 'ใบเสร็จรับเงิน', { bold: true, align: 'center', size: L.base + 2 });
  if (d.vatMode === 'inclusive' && d.totals?.vat > 0) L.text('(VAT Included)', { size: L.base - 4, align: 'center' });
  L.hr();
  L.row(`ใบเสร็จ: ${d.receiptNo}`, '', { bold: true });
  L.row(`Order: ${d.queueNo || d.orderNo}`, d.queueNo ? `#${d.orderNo}` : '');
  L.row(`วันที่ ${fmtDate(d.time, d.tz)}`, `เวลา ${fmtTime(d.time, d.tz)}`);
  if (d.staff) L.row(`พนักงาน: ${d.staff}`, d.posName || '');
  const tq = d.table ? `โต๊ะ ${d.table}` : d.queueNo ? `คิว ${d.queueNo}` : '';
  L.row(`ประเภท: ${ORDER_TYPE_LABEL[d.orderType] || d.orderType || ''}`, tq);
  if (d.customer?.name) {
    L.hr();
    L.text(`ลูกค้า: ${d.customer.name}`);
    if (d.customer.taxId) L.text(`เลขผู้เสียภาษี: ${d.customer.taxId}${d.customer.branch ? ` (${d.customer.branch})` : ''}`, { size: L.base - 2 });
    if (d.customer.address) L.text(d.customer.address, { size: L.base - 2 });
    if (d.customer.phone) L.text(`โทร ${d.customer.phone}`, { size: L.base - 2 });
  }
  L.hr();
  for (const it of d.items || []) {
    const name = `${fmtQty(it.qty)} × ${it.name}${it.variant ? ` ${it.variant}` : ''}`;
    L.row(name, money(it.lineTotal ?? it.total), { bold: false });
    for (const m of it.modifiers || []) {
      L.row(`${m.price ? '+ ' : ''}${m.name}${m.qty > 1 ? ` x${m.qty}` : ''}`, m.price ? money(m.price * (m.qty || 1) * it.qty) : '', { size: L.base - 3, indent: 24 });
    }
    if (it.note) L.text(`* ${it.note}`, { size: L.base - 3, indent: 24 });
    if (it.discount > 0) L.row(`ส่วนลด${it.discountLabel ? ` (${it.discountLabel})` : ''}`, `-${money(it.discount)}`, { size: L.base - 3, indent: 24 });
    if (it.reward) L.text('Reward Redemption', { size: L.base - 3, indent: 24 });
  }
  L.hr();
  const t = d.totals || {};
  L.row('Subtotal', money(t.subtotal));
  if (t.itemDiscount > 0) L.row('ส่วนลดรายการสินค้า', `-${money(t.itemDiscount)}`);
  if (t.billDiscountLines?.length) for (const b of t.billDiscountLines) L.row(b.label, `-${money(b.amount)}`);
  if (t.discount > 0 && (t.itemDiscount > 0) + (t.billDiscountLines?.length || 0) > 1) L.row('Discount รวม', `-${money(t.discount)}`, { bold: true });
  if (t.serviceCharge > 0) L.row(`Service Charge ${t.serviceChargeRate}%`, money(t.serviceCharge));
  if (t.vatRate > 0) {
    if (t.vatMode === 'exclusive') L.row(`VAT ${t.vatRate}%`, money(t.vat));
    else { L.row(`มูลค่าก่อน VAT`, money(t.beforeVat), { size: L.base - 2 }); L.row(`VAT ${t.vatRate}% (รวมในราคา)`, money(t.vat), { size: L.base - 2 }); }
  }
  L.hr(false);
  L.row('TOTAL', money(t.total), { size: big + 4, bold: true });
  L.hr(false);
  for (const p of d.payments || []) {
    L.row(PAYMENT_METHOD_LABEL[p.method] || p.method, money(p.amount));
    if (p.reference) L.text(`Ref: ${p.reference}`, { size: L.base - 4, indent: 24 });
  }
  if (d.received != null && d.received > 0) L.row('รับเงิน (Received)', money(d.received));
  if (d.change != null && d.change > 0) L.row('เงินทอน (Change)', money(d.change), { bold: true });
  if (on('member') && d.member) {
    L.hr();
    L.text(`สมาชิก: ${d.member.name}${d.member.tier ? ` (${d.member.tier})` : ''}`, { bold: true });
    L.row('แต้มเดิม', `${d.member.before}`);
    if (d.member.used) L.row('ใช้แต้ม', `-${d.member.used}`);
    L.row('ได้รับ', `+${d.member.earned}`);
    L.row('คงเหลือ', `${d.member.balance}`, { bold: true });
  }
  if (d.claimUrl && on('claimQr')) {
    L.hr();
    L.text('สแกนเพื่อสะสมแต้ม', { align: 'center', bold: true });
    if (d.claimPoints) L.text(`รับ ${d.claimPoints} คะแนน (ใช้ได้ 1 ครั้ง)`, { align: 'center', size: L.base - 2 });
    L.qr(d.claimUrl, Math.min(240, Math.round(L.inner * 0.55)));
  }
  if (on('qr') && shop.qrText) {
    L.hr();
    if (shop.qrLabel) L.text(shop.qrLabel, { align: 'center', size: L.base - 2 });
    L.qr(shop.qrText, Math.min(200, Math.round(L.inner * 0.45)));
  }
  if (on('social') && shop.social) L.text(shop.social, { align: 'center', size: L.base - 2 });
  if (on('promotion') && shop.promotion) { L.space(4); L.text(shop.promotion, { align: 'center', size: L.base - 2, bold: true }); }
  if (on('footer')) { L.space(6); L.text(shop.footer || 'ขอบคุณที่ใช้บริการ', { align: 'center', bold: true }); }
  if (d.copy && d.copy.of > 1) L.text(`สำเนา ${d.copy.n}/${d.copy.of}`, { align: 'center', size: L.base - 4 });
  L.space(10);
}

function kitchenLayout(L, d) {
  const xl = L.width <= 400 ? 54 : 66;
  const lg = L.width <= 400 ? 32 : 38;
  const md = L.width <= 400 ? 28 : 32;
  const ref = d.queueNo || d.table && `โต๊ะ ${d.table}` || `#${d.orderNo}`;
  L.text(ref, { size: xl, bold: true, align: 'center' });
  if (d.sub) L.text(`ใบย่อยที่ ${d.sub.n}/${d.sub.of}`, { size: lg, bold: true, align: 'center' });
  if (d.copy && d.copy.of > 1) L.text(`สำเนา ${d.copy.n}/${d.copy.of}`, { size: md, align: 'center' });
  if (d.kind === 'void') L.text('ยกเลิกรายการ / VOID', { size: md, bold: true, align: 'center', invert: true });
  else if (d.isAddition) L.text('รายการเพิ่ม / NEW ITEM', { size: md, bold: true, align: 'center', invert: true });
  if (d.reprint) L.text('พิมพ์ซ้ำ / REPRINT', { size: L.base, bold: true, align: 'center' });
  L.space(4);
  const type = ORDER_TYPE_LABEL[d.orderType] || d.orderType;
  L.text(d.table ? `${type} — โต๊ะ ${d.table}${d.guests ? ` (${d.guests} ท่าน)` : ''}` : type, { size: md, bold: true, align: 'center' });
  if (d.customerName) L.text(`ลูกค้า: ${d.customerName}`, { size: L.base, align: 'center' });
  if (d.station) L.text(`ครัว: ${d.station}`, { size: L.base, align: 'center' });
  L.row(`เวลา ${fmtTime(d.time, d.tz)}`, fmtDate(d.time, d.tz), { size: L.base });
  if (d.staff) L.row(`พนักงาน: ${d.staff}`, d.queueNo && d.table ? `โต๊ะ ${d.table}` : '', { size: L.base });
  L.hr(false);
  for (const it of d.items || []) {
    const unit = it.unitCount > 1 ? `  (${it.unitIndex}/${it.unitCount})` : '';
    L.text(`${fmtQty(it.qty)} × ${it.name}${it.variant ? ` ${it.variant}` : ''}${unit}`, { size: md, bold: true });
    for (const m of it.modifiers || []) L.text(`• ${m.name}${m.qty > 1 ? ` x${m.qty}` : ''}`, { size: L.base + 2, indent: 28 });
    if (it.note) L.text(`» ${it.note}`, { size: L.base + 2, indent: 28, bold: true });
    if (it.voidReason) L.text(`เหตุผล: ${it.voidReason}`, { size: L.base, indent: 28 });
    L.space(6);
  }
  if (d.orderNote) { L.hr(); L.text(`หมายเหตุ: ${d.orderNote}`, { size: md, bold: true }); }
  L.hr();
  L.text(`Order #${d.orderNo}${d.sub ? ` · ใบย่อย ${d.sub.n}/${d.sub.of}` : ''}${d.copy?.of > 1 ? ` · สำเนา ${d.copy.n}/${d.copy.of}` : ''}`, { size: L.base - 4, align: 'center' });
  L.space(8);
}

function shiftLayout(L, d) {
  L.text('รายงานปิดกะ / Shift Report', { size: L.base + 6, bold: true, align: 'center' });
  if (d.shopName) L.text(d.shopName, { align: 'center' });
  if (d.branch) L.text(d.branch, { align: 'center' });
  L.hr();
  L.row('พนักงาน', d.staff || '');
  if (d.posName) L.row('เครื่อง POS', d.posName);
  L.row('เปิดกะ', `${fmtDate(d.openedAt, d.tz)} ${fmtTime(d.openedAt, d.tz)}`);
  if (d.closedAt) L.row('ปิดกะ', `${fmtDate(d.closedAt, d.tz)} ${fmtTime(d.closedAt, d.tz)}`);
  L.hr();
  L.text('ยอดขาย', { bold: true });
  L.row('จำนวนบิล', String(d.orders ?? 0));
  L.row('Gross Sales', money(d.grossSales));
  L.row('Discount', `-${money(d.discount)}`);
  L.row('Service Charge', money(d.serviceCharge));
  L.row('VAT', money(d.vat));
  L.row('Net Sales', money(d.netSales), { bold: true });
  L.row('Refund', `-${money(d.refunds)}`);
  L.hr();
  L.text('แยกตามช่องทางชำระ', { bold: true });
  for (const p of d.payments || []) L.row(PAYMENT_METHOD_LABEL[p.method] || p.method, money(p.amount));
  L.hr();
  L.text('เงินสดในลิ้นชัก', { bold: true });
  L.row('Opening Cash', money(d.openingCash));
  L.row('+ Cash Sales', money(d.cashSales));
  L.row('+ Cash In', money(d.cashIn));
  L.row('- Cash Refund', money(d.cashRefunds));
  L.row('- Cash Out', money(d.cashOut));
  L.row('= Expected Cash', money(d.expectedCash), { bold: true });
  if (d.actualCash != null) {
    L.row('Actual Cash', money(d.actualCash), { bold: true });
    const diff = Number(d.difference || 0);
    L.row(diff > 0 ? 'Over (เงินเกิน)' : diff < 0 ? 'Short (เงินขาด)' : 'Difference', money(diff), { bold: true });
  }
  if (d.note) { L.hr(); L.text(`หมายเหตุ: ${d.note}`); }
  L.hr();
  L.text(`พิมพ์เมื่อ ${fmtDate(new Date(), d.tz)} ${fmtTime(new Date(), d.tz)}`, { size: L.base - 4, align: 'center' });
  L.space(8);
}

function testLayout(L, d) {
  L.text('ทดสอบเครื่องพิมพ์', { size: L.base + 10, bold: true, align: 'center' });
  L.text('PRINTER TEST', { size: L.base + 4, bold: true, align: 'center' });
  L.hr();
  L.row('เครื่องพิมพ์', d.printerName || '-');
  L.row('การเชื่อมต่อ', d.connection || '-');
  L.row('กระดาษ', `${d.paper || 80}mm · ${L.width} dots`);
  L.row('เวลา', `${fmtDate(new Date(), d.tz)} ${fmtTime(new Date(), d.tz)}`);
  L.hr();
  L.text('ฟอนต์ Sarabun: กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ');
  L.text('สระและวรรณยุกต์: กิ กี กึ กื กุ กู เก แก โก ไก ใก ก่ ก้ ก๊ ก๋ ก็ ก์ ฤ ฦ ๑๒๓๔๕๖๗๘๙๐', { size: L.base - 2 });
  L.text('ตัวหนา Bold — 1,234.50 บาท', { bold: true });
  L.row('ซ้าย / Left', 'ขวา / Right');
  L.hr();
  L.barcode('TEST-12345');
  L.qr('https://example.com/printer-test', 160);
  L.text(d.cutInfo || '', { align: 'center', size: L.base - 4 });
  L.text('✓ หากอ่านข้อความนี้ได้ แสดงว่าพิมพ์สำเร็จ', { align: 'center' });
  L.space(8);
}

function slipLayout(L, d) {
  L.text(d.title || 'เอกสาร', { size: L.base + 6, bold: true, align: 'center' });
  L.hr();
  for (const r of d.rows || []) L.row(r[0], r[1] ?? '', { bold: !!r[2] });
  if (d.note) { L.hr(); L.text(d.note); }
  if (d.barcode) { L.hr(); L.barcode(d.barcode); }
  L.text(`${fmtDate(d.time || new Date(), d.tz)} ${fmtTime(d.time || new Date(), d.tz)}`, { size: L.base - 4, align: 'center' });
  L.space(8);
}

/**
 * Render a print document to a canvas.
 * @param {object} doc {type:'receipt'|'kitchen'|'shift_report'|'test'|'slip', ...}
 * @param {{width:number, createCanvas:(w:number,h:number)=>any, loadImage?:(url:string)=>Promise<any>, fontFamily?:string}} env
 */
export async function renderDocument(doc, env) {
  const width = env.width || 576;
  const family = env.fontFamily || 'Sarabun';
  const scratch = env.createCanvas(width, 10).getContext('2d');
  const L = new Layout(scratch, width, family);
  const assets = {};
  if (doc.type === 'receipt' && doc.shop?.logoUrl && env.loadImage && doc.sections?.logo !== false) {
    try { assets.logo = await env.loadImage(doc.shop.logoUrl); } catch { assets.logo = null; }
  }
  switch (doc.type) {
    case 'receipt': receiptLayout(L, doc, assets); break;
    case 'kitchen': kitchenLayout(L, doc); break;
    case 'shift_report': shiftLayout(L, doc); break;
    case 'test': testLayout(L, doc); break;
    default: slipLayout(L, doc);
  }
  const canvas = env.createCanvas(width, Math.max(20, Math.ceil(L.y + 4)));
  L.draw(canvas.getContext('2d'));
  return canvas;
}

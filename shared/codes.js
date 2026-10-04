// Barcode (Code 128-B), QR matrix and PromptPay (EMVCo) payload generation.
// Pure functions usable in browser and Node so receipts, member cards and
// redemption codes render identically everywhere.
import QRCode from 'qrcode';

// Code 128 bar/space widths, index 0..106
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];

/** Encode text as Code 128-B. Returns array of module widths (bar, space, bar, ...). */
export function code128(text) {
  const codes = [104];
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error('Code128-B supports ASCII 32-126 only');
    codes.push(c - 32);
  }
  let sum = 104;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, 106);
  return codes.flatMap((c) => C128[c].split('').map(Number));
}

/** Draw Code128 into a 2D context at (x,y) with given height and module width. */
export function drawCode128(ctx, text, x, y, height, module = 2) {
  const widths = code128(text);
  let cx = x;
  ctx.fillStyle = '#000';
  widths.forEach((w, i) => {
    if (i % 2 === 0) ctx.fillRect(cx, y, w * module, height);
    cx += w * module;
  });
  return cx - x;
}
export const code128Width = (text, module = 2) => code128(text).reduce((a, b) => a + b, 0) * module;

/** QR module matrix {size, get(x,y)}. */
export function qrMatrix(text, ecc = 'M') {
  const q = QRCode.create(String(text), { errorCorrectionLevel: ecc });
  const { size, data } = q.modules;
  return { size, get: (x, y) => !!data[y * size + x] };
}

export function drawQR(ctx, text, x, y, px, ecc = 'M') {
  const m = qrMatrix(text, ecc);
  const cell = Math.max(1, Math.floor(px / (m.size + 2)));
  const off = Math.floor((px - cell * m.size) / 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) {
    if (m.get(c, r)) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
  }
}

/** SVG string for QR (used in React views). */
export function qrSvg(text, ecc = 'M') {
  const m = qrMatrix(text, ecc);
  let d = '';
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(c, r)) d += `M${c + 1},${r + 1}h1v1h-1z`;
  const s = m.size + 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export function barcodeSvg(text, height = 60) {
  const widths = code128(text);
  let x = 10; let d = '';
  widths.forEach((w, i) => { if (i % 2 === 0) d += `M${x},0h${w}v${height}h-${w}z`; x += w; });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 10} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${x + 10}" height="${height}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// ── PromptPay (Thai QR Payment, EMVCo MPM) ────────────────────────────────────
const f = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * PromptPay payload. `id` = mobile number (10 digits), national ID / tax ID (13 digits) or e-wallet ID (15 digits).
 * When `amount` is given, a dynamic (one-time) QR with the amount is produced.
 */
export function promptPayPayload(id, amount) {
  const digits = String(id || '').replace(/[^0-9]/g, '');
  if (!digits) throw new Error('PromptPay ID is empty');
  let target;
  if (digits.length >= 15) target = f('03', digits);
  else if (digits.length >= 13) target = f('02', digits);
  else target = f('01', ('0000000000000' + digits.replace(/^0/, '66')).slice(-13));
  const merchant = f('29', f('00', 'A000000677010111') + target);
  let payload = f('00', '01') + f('01', amount ? '12' : '11') + merchant + f('53', '764') + f('58', 'TH');
  if (amount) payload += f('54', Number(amount).toFixed(2));
  payload += '6304';
  return payload + crc16(payload);
}

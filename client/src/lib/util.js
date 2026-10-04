export { money, int, baht, round2 } from '@shared/money.js';
export { fmtDate, fmtTime, fmtDateTime, fmtThaiLong, fmtThaiShort, elapsed, toDate, businessDate, ORDER_TYPE_LABEL, PAYMENT_METHOD_LABEL } from '@shared/format.js';

export const cls = (...a) => a.filter(Boolean).join(' ');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const daysAgo = (n) => new Date(Date.now() - n * 86400e3 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export const KDS_LABEL = { new: 'ใหม่', preparing: 'กำลังทำ', ready: 'พร้อม', served: 'เสิร์ฟแล้ว', voided: 'ยกเลิก', none: '-' };
export const TABLE_STATE = {
  available: 'ว่าง', occupied: 'มีลูกค้า', waiting_food: 'รออาหาร', ready_to_pay: 'พร้อมคิดเงิน', reserved: 'จอง', cleaning: 'ทำความสะอาด',
};
export const ORDER_STATUS = { open: 'เปิดอยู่', held: 'พักบิล', paid: 'ชำระแล้ว', voided: 'Void', refunded: 'คืนเงินแล้ว', partially_refunded: 'คืนเงินบางส่วน', merged: 'รวมบิลแล้ว' };
export const PRINT_STATUS = { waiting: 'รอพิมพ์', printing: 'กำลังพิมพ์', printed: 'พิมพ์แล้ว', failed: 'ล้มเหลว', cancelled: 'ยกเลิก' };
export const DOC_LABEL = { receipt: 'ใบเสร็จ', kitchen: 'ใบครัว', kitchen_void: 'ใบยกเลิกครัว', shift_report: 'รายงานกะ', test: 'ทดสอบ', drawer: 'เปิดลิ้นชัก', slip: 'สลิป' };

/** Fetch a remote image (by URL) through the server proxy so canvases can read it. */
export async function proxiedImage(url) {
  const { api } = await import('./api.js');
  const res = await api(`/media/proxy?url=${encodeURIComponent(url)}`, { raw: true });
  const blob = await res.blob();
  return createImageBitmap(blob);
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Hash PIN locally (PBKDF2) for offline lock-screen unlock. */
export async function pinDigest(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 120000 }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

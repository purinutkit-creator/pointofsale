// Date/time formatting helpers shared by client, server and printed documents.

const pad = (n) => String(n).padStart(2, '0');

export function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    // SQLite datetime strings are stored as UTC "YYYY-MM-DD HH:MM:SS"
    const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? v.replace(' ', 'T') + 'Z' : v;
    return new Date(s);
  }
  return new Date();
}

/** Parts of a date in a given IANA timezone. */
export function zonedParts(v, timeZone = 'Asia/Bangkok') {
  const d = toDate(v);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    year: +get('year'), month: +get('month'), day: +get('day'),
    hour: +get('hour'), minute: +get('minute'), second: +get('second'), weekday: wd,
  };
}

export function fmtDate(v, tz) {
  const p = zonedParts(v, tz);
  return `${pad(p.day)}/${pad(p.month)}/${p.year}`;
}
export function fmtTime(v, tz) {
  const p = zonedParts(v, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}
export function fmtDateTime(v, tz) {
  return `${fmtDate(v, tz)} ${fmtTime(v, tz)}`;
}
/** YYYY-MM-DD in timezone (business date). */
export function businessDate(v = new Date(), tz) {
  const p = zonedParts(v, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function fmtThaiLong(v, tz, withTime = false) {
  const p = zonedParts(v, tz);
  const s = `${p.day} ${TH_MONTHS[p.month - 1]} ${p.year}`;
  return withTime ? `${s} เวลา ${pad(p.hour)}:${pad(p.minute)}` : s;
}
export function fmtThaiShort(v, tz) {
  const p = zonedParts(v, tz);
  return `${p.day} ${TH_MONTHS_SHORT[p.month - 1]}`;
}

/** Elapsed mm:ss (or h:mm:ss) since a date. */
export function elapsed(from, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - toDate(from).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const ORDER_TYPE_LABEL = { dine_in: 'ทานที่ร้าน', takeaway: 'กลับบ้าน', delivery: 'เดลิเวอรี่' };
export const PAYMENT_METHOD_LABEL = {
  cash: 'เงินสด', qr: 'QR / PromptPay', credit_card: 'บัตรเครดิต', debit_card: 'บัตรเดบิต',
  transfer: 'โอนเงิน', ewallet: 'E-Wallet', other: 'อื่นๆ', points: 'ใช้แต้ม',
};

import { one, all, run, json } from '../db/index.js';
import { DEFAULT_POINT_SETTINGS } from '../../shared/points.js';

export const DEFAULT_SETTINGS = {
  shop: {
    name: 'ร้านของฉัน', nameEn: '', logoUrl: '', coverImageUrl: '', faviconUrl: '',
    phone: '', address: '', taxId: '', currency: 'THB', currencySymbol: '฿', timezone: 'Asia/Bangkok',
    publicUrl: '', memberFontUrl: '',
    theme: { primary: '#E4572E', accent: '#1F7A8C', mode: 'light', radius: 14, memberPrimary: '#1D1D1F', memberAccent: '#C8A96A' },
  },
  vat: { enabled: true, rate: 7, mode: 'inclusive' },
  serviceCharge: { enabled: false, rate: 10, applyTo: 'dine_in' },
  receipt: {
    copies: 1, printMode: 'auto', staffCanChangeCopies: true, docType: 'receipt',
    header: '', footer: 'ขอบคุณที่ใช้บริการ', social: '', promotion: '', qrText: '', qrLabel: '',
    claimQr: true,
    sections: { logo: true, shopName: true, branch: true, address: true, phone: true, taxId: true, header: true, qr: true, social: true, promotion: true, footer: true, member: true, claimQr: true },
  },
  kitchen: { printOnSend: true, voidTicket: true, kdsSound: true, autoServeOnPay: false },
  pos: {
    requireShift: true, autoLogoutMinutes: 30, lockAfterMinutes: 5, quickCash: [100, 500, 1000],
    defaultOrderType: 'dine_in', askGuests: true, employeeCodeMode: 'auto', employeeCodePrefix: 'EMP', employeeCodeDigits: 3,
    showStock: true, allowNegativeStock: true, loginMode: 'both', cleanTableAfterPay: true,
  },
  payment: {
    methods: { cash: true, qr: true, credit_card: true, debit_card: true, transfer: true, ewallet: true, other: true },
    promptpay: { enabled: false, id: '', accountName: '', qrImageUrl: '', dynamic: true },
  },
  points: DEFAULT_POINT_SETTINGS,
  member: {
    enabled: true, termsText: 'ข้าพเจ้ายินยอมให้ร้านเก็บและใช้ข้อมูลเพื่อการให้บริการสมาชิกและสะสมแต้ม',
    welcomePoints: 0, redemptionCodeLength: 6,
  },
  approval: { actions: ['void_item', 'void_order', 'refund', 'discount_over_limit', 'override_price', 'cash_out', 'open_drawer', 'edit_closed_bill'] },
  display: { images: [], intervalSec: 8, welcomeText: 'ยินดีต้อนรับ', showPromptPay: true, allowMemberInput: true },
  queue: { voice: true, voiceTemplate: 'ขอเชิญหมายเลข {queue} รับสินค้าที่เคาน์เตอร์ค่ะ', readyHideMinutes: 20, title: 'สถานะคิว' },
  notifications: {
    channels: { inapp: true, email: false, sms: false, line: false },
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    sms: { url: '', method: 'POST', headers: '{"Content-Type":"application/json"}', body: '{"to":"{phone}","message":"{message}"}' },
    line: { channelAccessToken: '' },
    lowStock: true,
  },
  backup: { auto: true, hour: 3, keep: 14 },
};

// keys that may be overridden per branch
export const BRANCH_SCOPED = ['vat', 'serviceCharge', 'receipt', 'kitchen', 'pos', 'payment', 'display', 'queue'];
// secrets never sent to clients without settings permission
const SECRET_PATHS = [['notifications', 'smtp', 'pass'], ['notifications', 'line', 'channelAccessToken']];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}

export function getSetting(key, branchId = null) {
  const g = one('SELECT value FROM settings WHERE branch_id IS NULL AND key = ?', key);
  let v = deepMerge(DEFAULT_SETTINGS[key] ?? {}, json(g?.value, {}));
  if (branchId && BRANCH_SCOPED.includes(key)) {
    const b = one('SELECT value FROM settings WHERE branch_id = ? AND key = ?', branchId, key);
    if (b) v = deepMerge(v, json(b.value, {}));
  }
  return v;
}

export function getAllSettings(branchId = null) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k, branchId);
  return out;
}

/** Settings safe for any authenticated device (POS, KDS, displays). */
export function publicSettings(branchId) {
  const s = getAllSettings(branchId);
  const copy = JSON.parse(JSON.stringify(s));
  for (const p of SECRET_PATHS) {
    let o = copy;
    for (let i = 0; i < p.length - 1; i++) o = o?.[p[i]];
    if (o && o[p.at(-1)]) o[p.at(-1)] = '••••••';
  }
  return copy;
}

export function setSetting(key, value, branchId = null, staffId = null) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting ${key}`);
  // keep stored secrets when the masked placeholder is sent back
  for (const p of SECRET_PATHS) {
    if (p[0] !== key) continue;
    let o = value;
    for (let i = 1; i < p.length - 1; i++) o = o?.[p[i]];
    if (o && o[p.at(-1)] === '••••••') {
      const cur = getSetting(key);
      let c = cur;
      for (let i = 1; i < p.length - 1; i++) c = c?.[p[i]];
      o[p.at(-1)] = c?.[p.at(-1)] || '';
    }
  }
  run(`INSERT INTO settings (branch_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(IFNULL(branch_id, 0), key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  branchId, key, JSON.stringify(value), staffId);
}

export function clearBranchSetting(key, branchId) {
  run('DELETE FROM settings WHERE branch_id = ? AND key = ?', branchId, key);
}

export function branchOverrides(branchId) {
  return Object.fromEntries(all('SELECT key, value FROM settings WHERE branch_id = ?', branchId).map((r) => [r.key, json(r.value, {})]));
}

export function calcSettings(branchId) {
  return { vat: getSetting('vat', branchId), serviceCharge: getSetting('serviceCharge', branchId) };
}

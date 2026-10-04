// Member notifications: in-app inbox (always) + Email (SMTP) / SMS (HTTP gateway) / LINE Messaging API
// delivered according to the channels the shop enabled in Settings → Notifications.
import nodemailer from 'nodemailer';
import { insert, one, run, afterCommit, json } from '../db/index.js';
import { getSetting } from './settings.js';
import { emitMember } from '../realtime.js';

export function notifyMember(memberId, kind, title, body = '', dedupeKey = null) {
  if (dedupeKey && one('SELECT id FROM member_notifications WHERE dedupe_key = ?', dedupeKey)) return;
  const cfg = getSetting('notifications');
  const m = one('SELECT id, name, phone, email, line_user_id, notify_channels FROM members WHERE id = ?', memberId);
  if (!m) return;
  const wanted = json(m.notify_channels, ['inapp']);
  const channels = ['inapp', ...['email', 'sms', 'line'].filter((c) => cfg.channels?.[c] && wanted.includes(c))];
  const id = insert('member_notifications', { member_id: memberId, kind, title, body, channels, dedupe_key: dedupeKey });
  afterCommit(async () => {
    emitMember(memberId, 'member:notification', { id, kind, title, body, created_at: new Date().toISOString() });
    const delivery = {};
    for (const c of channels.filter((x) => x !== 'inapp')) {
      try {
        if (c === 'email' && m.email) await sendEmail(cfg.smtp, m.email, title, body);
        else if (c === 'sms' && m.phone) await sendSms(cfg.sms, m.phone, `${title} ${body}`.trim());
        else if (c === 'line' && m.line_user_id) await sendLine(cfg.line, m.line_user_id, `${title}\n${body}`.trim());
        else { delivery[c] = 'skipped'; continue; }
        delivery[c] = 'sent';
      } catch (e) {
        delivery[c] = `failed: ${e.message}`.slice(0, 200);
      }
    }
    if (Object.keys(delivery).length) run('UPDATE member_notifications SET delivery = ? WHERE id = ?', JSON.stringify(delivery), id);
  });
}

let transport = null; let transportKey = '';
export async function sendEmail(smtp, to, subject, text) {
  if (!smtp?.host) throw new Error('SMTP not configured');
  const key = JSON.stringify(smtp);
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({ host: smtp.host, port: Number(smtp.port) || 587, secure: !!smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined });
    transportKey = key;
  }
  await transport.sendMail({ from: smtp.from || smtp.user, to, subject, text });
}

const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '').toString().replace(/["\\]/g, '\\$&'));

/** Generic SMS gateway: configurable URL/headers/body template with {phone} and {message}. */
export async function sendSms(sms, phone, message) {
  if (!sms?.url) throw new Error('SMS gateway not configured');
  const headers = json(sms.headers, {}) || {};
  const res = await fetch(fill(sms.url, { phone: encodeURIComponent(phone), message: encodeURIComponent(message) }), {
    method: sms.method || 'POST', headers, body: sms.method === 'GET' ? undefined : fill(sms.body, { phone, message }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`SMS HTTP ${res.status}`);
}

/** LINE Messaging API push message (requires member.line_user_id). */
export async function sendLine(line, userId, text) {
  if (!line?.channelAccessToken) throw new Error('LINE not configured');
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${line.channelAccessToken}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`LINE HTTP ${res.status}`);
}

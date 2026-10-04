// Member Web App API (customer side, mobile first) + Customer Display member lookup.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, all, run, insert, json, sqlNow } from '../db/index.js';
import { parse, HttpError, notFound, bad } from '../lib/errors.js';
import { hashSecret, verifySecret, randomToken, sha256, uuid } from '../lib/security.js';
import { requireDevice } from '../middleware/auth.js';
import { createRedemption, redemptionDetail, shapeReward, rewardBlocker, claimReceipt, claimBirthday, birthdayEligible } from '../services/loyalty.js';
import { memberFull, registerMember, normPhone } from './members.js';
import { getSetting } from '../services/settings.js';
import { config } from '../config.js';
import { zonedParts } from '../../shared/format.js';

const r = Router();
const authLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'ลองหลายครั้งเกินไป กรุณารอ 10 นาที', code: 'RATE_LIMIT' } });
const lookupLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'ค้นหาบ่อยเกินไป', code: 'RATE_LIMIT' } });

function memberSession(memberId) {
  const token = randomToken(32);
  insert('member_sessions', { token_hash: sha256(token), member_id: memberId, expires_at: sqlNow(new Date(Date.now() + config.memberSessionDays * 86400e3)) });
  return token;
}

function requireMember(req, _res, next) {
  const h = req.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = t && one("SELECT member_id FROM member_sessions WHERE token_hash = ? AND expires_at > datetime('now')", sha256(t));
  if (!s) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบสมาชิก', 'MEMBER_LOGIN_REQUIRED'));
  const m = one("SELECT * FROM members WHERE id = ? AND status = 'active'", s.member_id);
  if (!m) return next(new HttpError(401, 'บัญชีสมาชิกถูกปิดใช้งาน', 'MEMBER_LOGIN_REQUIRED'));
  req.member = m;
  next();
}

// shop branding for the member app (public)
r.get('/m/shop', (_req, res) => {
  const shop = getSetting('shop');
  const member = getSetting('member');
  res.json({ name: shop.name, logoUrl: shop.logoUrl, coverImageUrl: shop.coverImageUrl, theme: shop.theme, memberFontUrl: shop.memberFontUrl, termsText: member.termsText, tiers: all('SELECT id, name, min_points, max_points, color, icon, badge_url, benefits, discount_pct, point_multiplier FROM member_tiers WHERE active = 1 ORDER BY min_points') });
});

const registerSchema = z.object({
  phone: z.string().min(9).max(20), name: z.string().min(1).max(100), gender: z.enum(['male', 'female', 'other', 'unspecified']),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('')), pin: z.string().regex(/^\d{4,6}$/), acceptTerms: z.literal(true),
  email: z.string().email().optional().or(z.literal('')),
});

r.post('/m/register', authLimiter, (req, res) => {
  const b = parse(registerSchema, req.body);
  const id = registerMember(b, { via: 'member_web' });
  res.json({ token: memberSession(id), member: memberFull(id) });
});

r.post('/m/login', authLimiter, (req, res) => {
  const b = parse(z.object({ phone: z.string().min(9).max(20), pin: z.string().max(6) }), req.body);
  const m = one('SELECT * FROM members WHERE phone = ?', normPhone(b.phone));
  if (!m) throw new HttpError(404, 'ยังไม่พบสมาชิก', 'MEMBER_NOT_FOUND');
  if (!m.pin_hash) throw new HttpError(409, 'บัญชีนี้ยังไม่ได้ตั้ง PIN กรุณาติดต่อพนักงานเพื่อตั้ง PIN', 'PIN_NOT_SET');
  if (!verifySecret(b.pin, m.pin_hash)) throw new HttpError(401, 'PIN ไม่ถูกต้อง', 'PIN_INVALID');
  if (m.status !== 'active') throw new HttpError(403, 'บัญชีถูกปิดใช้งาน');
  res.json({ token: memberSession(m.id), member: memberFull(m.id) });
});

// tells the login screen whether to show "login" or "register" (no personal data exposed)
r.post('/m/check-phone', authLimiter, (req, res) => {
  const b = parse(z.object({ phone: z.string().min(9).max(20) }), req.body);
  const m = one('SELECT id, pin_hash FROM members WHERE phone = ?', normPhone(b.phone));
  res.json({ exists: !!m, hasPin: !!m?.pin_hash });
});

r.post('/m/logout', requireMember, (req, res) => {
  const t = (req.get('authorization') || '').slice(7);
  run('DELETE FROM member_sessions WHERE token_hash = ?', sha256(t));
  res.json({ ok: true });
});

r.get('/m/me', requireMember, (req, res) => res.json(memberFull(req.member.id)));

r.put('/m/me', requireMember, (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(100), email: z.string().email().optional().or(z.literal('')), gender: z.enum(['male', 'female', 'other', 'unspecified']).optional(), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), notifyChannels: z.array(z.enum(['inapp', 'email', 'sms', 'line'])).optional() }), req.body);
  // birthday can be set once by the member (prevents abusing birthday rewards)
  const birthday = req.member.birthday || b.birthday || null;
  run("UPDATE members SET name = ?, email = ?, gender = COALESCE(?, gender), birthday = ?, notify_channels = COALESCE(?, notify_channels), updated_at = datetime('now') WHERE id = ?",
    b.name, b.email || null, b.gender ?? null, birthday, b.notifyChannels ? JSON.stringify(b.notifyChannels) : null, req.member.id);
  res.json(memberFull(req.member.id));
});

r.post('/m/me/pin', authLimiter, requireMember, (req, res) => {
  const b = parse(z.object({ currentPin: z.string(), newPin: z.string().regex(/^\d{4,6}$/) }), req.body);
  if (!verifySecret(b.currentPin, req.member.pin_hash)) throw new HttpError(401, 'PIN เดิมไม่ถูกต้อง', 'PIN_INVALID');
  run('UPDATE members SET pin_hash = ? WHERE id = ?', hashSecret(b.newPin), req.member.id);
  res.json({ ok: true });
});

r.get('/m/rewards', requireMember, (req, res) => {
  const rewards = all("SELECT * FROM rewards WHERE active = 1 AND hidden = 0 AND is_birthday = 0 AND (end_at IS NULL OR end_at > datetime('now')) ORDER BY sort_order, points_required")
    .map(shapeReward).map((rw) => ({ id: rw.id, name: rw.name, description: rw.description, imageUrl: rw.image_url, type: rw.type, pointsRequired: rw.points_required, discountValue: rw.discount_value, endAt: rw.end_at, minSpend: rw.min_spend, codeValidDays: rw.code_valid_days, remaining: rw.total_quota != null ? Math.max(0, rw.total_quota - rw.used_count) : null, blocker: rewardBlocker(rw, req.member) }));
  res.json(rewards);
});

r.post('/m/rewards/:id/redeem', requireMember, (req, res) => {
  const b = parse(z.object({ txnId: z.string().min(8).max(80) }), req.body);
  const red = createRedemption({ memberId: req.member.id, rewardId: Number(req.params.id), via: 'member', txnId: `m:${req.member.id}:${b.txnId}` });
  res.json(redemptionDetail('rr.id = ?', red.id));
});

r.get('/m/redemptions', requireMember, (req, res) => {
  run("UPDATE reward_redemptions SET status = 'expired' WHERE member_id = ? AND status = 'active' AND expires_at < datetime('now')", req.member.id);
  res.json(all(`SELECT rr.id, rr.code, rr.status, rr.expires_at, rr.used_at, rr.points_used, rr.created_at, rr.created_via, r.name, r.type, r.discount_value, r.image_url, r.description, b.name AS used_branch
                FROM reward_redemptions rr JOIN rewards r ON r.id = rr.reward_id LEFT JOIN branches b ON b.id = rr.used_branch_id
                WHERE rr.member_id = ? ORDER BY CASE rr.status WHEN 'active' THEN 0 ELSE 1 END, rr.id DESC LIMIT 100`, req.member.id));
});

r.get('/m/history', requireMember, (req, res) => {
  res.json(all(`SELECT pt.id, pt.type, pt.points, pt.balance, pt.amount, pt.reason, pt.created_at, o.order_no, b.name AS branch_name
                FROM point_transactions pt LEFT JOIN orders o ON o.id = pt.order_id LEFT JOIN branches b ON b.id = pt.branch_id
                WHERE pt.member_id = ? ORDER BY pt.id DESC LIMIT 200`, req.member.id));
});

r.get('/m/notifications', requireMember, (req, res) => {
  res.json(all('SELECT id, kind, title, body, read_at, created_at FROM member_notifications WHERE member_id = ? ORDER BY id DESC LIMIT 100', req.member.id));
});
r.post('/m/notifications/read', requireMember, (req, res) => {
  run("UPDATE member_notifications SET read_at = datetime('now') WHERE member_id = ? AND read_at IS NULL", req.member.id);
  res.json({ ok: true });
});

r.get('/m/promotions', (_req, res) => {
  res.json(all("SELECT id, name, description, image_url, type, start_at, end_at, conditions FROM promotions WHERE active = 1 AND show_member = 1 AND (end_at IS NULL OR end_at > datetime('now')) ORDER BY priority DESC, id DESC").map((p) => ({ ...p, conditions: json(p.conditions, {}) })));
});

r.get('/m/birthday', requireMember, (req, res) => {
  const tz = getSetting('shop').timezone;
  const year = zonedParts(new Date(), tz).year;
  res.json(all('SELECT c.*, r.name AS reward_name, r.image_url AS reward_image FROM birthday_campaigns c LEFT JOIN rewards r ON r.id = c.reward_id WHERE c.active = 1').map((c) => ({
    id: c.id, name: c.name, message: c.message, imageUrl: c.image_url || c.reward_image, benefit: c.benefit, points: c.points, rewardName: c.reward_name, windowType: c.window_type,
    eligible: birthdayEligible(req.member, c, new Date(), tz), claimed: !!one('SELECT id FROM birthday_claims WHERE campaign_id = ? AND member_id = ? AND year = ?', c.id, req.member.id, year),
  })));
});
r.post('/m/birthday/:id/claim', requireMember, (req, res) => {
  const out = claimBirthday(req.member.id, Number(req.params.id));
  res.json({ ...out, redemption: out.redemption ? redemptionDetail('rr.id = ?', out.redemption.id) : null, member: memberFull(req.member.id) });
});

// Receipt QR claim (scan QR at the bottom of the receipt)
r.get('/m/claim/:token', lookupLimiter, (req, res) => {
  const rc = one(`SELECT r.receipt_no, r.total, r.claim_points, r.claim_status, r.claim_expires_at, r.created_at, b.name AS branch_name
                  FROM receipts r JOIN branches b ON b.id = r.branch_id WHERE r.claim_token = ?`, req.params.token);
  if (!rc) throw notFound('QR Code ไม่ถูกต้อง');
  res.json(rc);
});
r.post('/m/claim/:token', requireMember, (req, res) => {
  const out = claimReceipt(req.params.token, req.member.id);
  res.json({ ...out, member: memberFull(req.member.id) });
});

// ── Customer Display: member lookup / self-registration (device token required) ──
r.post('/display/member-lookup', lookupLimiter, requireDevice, (req, res) => {
  const b = parse(z.object({ phone: z.string().min(9).max(20) }), req.body);
  const m = one("SELECT id FROM members WHERE phone = ? AND status = 'active'", normPhone(b.phone));
  if (!m) return res.json({ found: false });
  const full = memberFull(m.id);
  res.json({ found: true, member: { id: full.id, name: full.name, tier: full.tier, points: full.points, nextTier: full.nextTier, activeRedemptions: full.activeRedemptions.length } });
});
r.post('/display/member-register', lookupLimiter, requireDevice, (req, res) => {
  const b = parse(registerSchema.extend({ pin: z.string().regex(/^\d{4,6}$/).optional().or(z.literal('')) }), req.body);
  const id = registerMember(b, { branchId: req.device.branch_id, via: 'display' });
  const full = memberFull(id);
  res.json({ found: true, member: { id: full.id, name: full.name, tier: full.tier, points: full.points, nextTier: full.nextTier, activeRedemptions: 0 } });
});
r.get('/display/member/:id/redemptions', requireDevice, (req, res) => {
  res.json(all(`SELECT rr.id, rr.code, rr.expires_at, r.name, r.type, r.discount_value FROM reward_redemptions rr JOIN rewards r ON r.id = rr.reward_id
                WHERE rr.member_id = ? AND rr.status = 'active' AND rr.expires_at > datetime('now') ORDER BY rr.expires_at`, Number(req.params.id)));
});

export { requireMember, uuid };
export default r;

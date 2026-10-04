// Member & Loyalty administration (POS + Admin dashboard side)
import { Router } from 'express';
import { z } from 'zod';
import { one, all, run, insert, update, tx, json } from '../db/index.js';
import { parse, notFound, bad, conflict } from '../lib/errors.js';
import { hashSecret, uuid } from '../lib/security.js';
import { requireStaff, requirePerm, hasPerm } from '../middleware/auth.js';
import { getMember, publicMember, pointTx, recomputeTier, createRedemption, verifyRedemption, redemptionDetail, shapeReward, rewardBlocker, birthdayEligible } from '../services/loyalty.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { emitMember, emitAll } from '../realtime.js';
import { notifyMember } from '../services/messaging.js';

const r = Router();
r.use(requireStaff);

export const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^66/, '0');

export function nextMemberCode() {
  const n = Number(one("SELECT IFNULL(MAX(CAST(member_code AS INTEGER)),0) m FROM members WHERE member_code GLOB '[0-9]*'").m) + 1;
  return String(n).padStart(8, '0');
}

export function memberFull(id) {
  const m = getMember(id);
  if (!m) return null;
  const pm = publicMember(m);
  const tiers = all('SELECT * FROM member_tiers WHERE active = 1 ORDER BY min_points');
  const basis = getSetting('points').tierBasis === 'current' ? m.points : m.lifetime_points;
  const next = tiers.find((t) => t.min_points > basis);
  return {
    ...pm, lineUserId: m.line_user_id, tierLocked: !!m.tier_locked, hasPin: !!one('SELECT pin_hash FROM members WHERE id = ?', id)?.pin_hash,
    notifyChannels: json(m.notify_channels, ['inapp']),
    nextTier: next ? { id: next.id, name: next.name, minPoints: next.min_points, need: next.min_points - basis, color: next.color } : null,
    tierProgressBasis: basis,
    avgOrder: m.visit_count ? Math.round((m.total_spend / m.visit_count) * 100) / 100 : 0,
    orderCount: one("SELECT COUNT(*) c FROM orders WHERE member_id = ? AND status IN ('paid','partially_refunded','refunded')", id).c,
    activeRedemptions: all(`SELECT rr.id, rr.code, rr.status, rr.expires_at, r.name, r.type, r.discount_value FROM reward_redemptions rr JOIN rewards r ON r.id = rr.reward_id
                            WHERE rr.member_id = ? AND rr.status = 'active' AND rr.expires_at > datetime('now') ORDER BY rr.expires_at`, id),
  };
}

// search: phone / member code / name / barcode / QR
r.get('/members', requirePerm('member.search'), (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  if (!q) {
    return res.json(all(`SELECT m.id, m.member_code, m.name, m.phone, m.points, m.total_spend, m.visit_count, m.last_visit_at, m.created_at, m.status, t.name AS tier_name, t.color AS tier_color
                         FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id ORDER BY m.id DESC LIMIT ?`, limit));
  }
  const digits = q.replace(/\D/g, '');
  const code = q.replace(/^M[:-]?/i, '');
  res.json(all(`SELECT m.id, m.member_code, m.name, m.phone, m.points, m.total_spend, m.visit_count, m.last_visit_at, m.created_at, m.status, t.name AS tier_name, t.color AS tier_color
                FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id
                WHERE m.phone = ? OR m.member_code = ? OR (? <> '' AND m.phone LIKE ?) OR m.name LIKE ?
                ORDER BY CASE WHEN m.phone = ? OR m.member_code = ? THEN 0 ELSE 1 END, m.name LIMIT ?`,
  normPhone(q), code, digits, `%${digits}%`, `%${q}%`, normPhone(q), code, limit));
});

r.get('/members/:id', requirePerm('member.search'), (req, res) => {
  const m = memberFull(Number(req.params.id));
  if (!m) throw notFound('ไม่พบสมาชิก');
  res.json(m);
});

const memberSchema = z.object({
  phone: z.string().min(9).max(20), name: z.string().min(1).max(100), gender: z.enum(['male', 'female', 'other', 'unspecified']).optional().nullable(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('')), email: z.string().email().max(120).optional().nullable().or(z.literal('')),
  lineUserId: z.string().max(80).optional().nullable(), pin: z.string().regex(/^\d{4,6}$/).optional().nullable().or(z.literal('')),
  note: z.string().max(500).optional().nullable(), status: z.enum(['active', 'inactive']).optional(),
  notifyChannels: z.array(z.enum(['inapp', 'email', 'sms', 'line'])).optional(), acceptTerms: z.boolean().optional(),
});

export function registerMember(b, { branchId = null, via = 'pos' } = {}) {
  return tx(() => {
    const phone = normPhone(b.phone);
    if (!/^0\d{8,9}$/.test(phone)) throw bad('เบอร์โทรศัพท์ไม่ถูกต้อง');
    if (one('SELECT id FROM members WHERE phone = ?', phone)) throw conflict('เบอร์โทรศัพท์นี้เป็นสมาชิกอยู่แล้ว', 'PHONE_EXISTS');
    const tier = all('SELECT id FROM member_tiers WHERE active = 1 ORDER BY min_points LIMIT 1')[0];
    const id = insert('members', {
      member_code: nextMemberCode(), phone, name: b.name.trim(), gender: b.gender || 'unspecified', birthday: b.birthday || null, email: b.email || null,
      line_user_id: b.lineUserId || null, pin_hash: b.pin ? hashSecret(b.pin) : null, tier_id: tier?.id ?? null, join_branch_id: branchId,
      accepted_terms_at: b.acceptTerms ? new Date().toISOString() : null, note: b.note ?? null,
      notify_channels: b.notifyChannels || ['inapp'],
    });
    const welcome = Number(getSetting('member').welcomePoints) || 0;
    if (welcome > 0) pointTx({ memberId: id, type: 'BONUS', points: welcome, txnId: `welcome:${id}`, branchId, reason: 'แต้มต้อนรับสมาชิกใหม่' });
    notifyMember(id, 'welcome', `ยินดีต้อนรับ คุณ${b.name}`, 'สมัครสมาชิกสำเร็จ เริ่มสะสมแต้มได้ทันที', `welcome:${id}`);
    emitAll('loyalty:changed', { memberId: id, created: true, via });
    return id;
  });
}

r.post('/members', requirePerm('member.create'), (req, res) => {
  const b = parse(memberSchema, req.body);
  const id = registerMember(b, { branchId: req.staff.branchId });
  audit(req, 'member.create', { entity: 'member', entityId: id, details: `${b.name} ${b.phone}` });
  res.json(memberFull(id));
});

r.put('/members/:id', requirePerm('member.edit'), (req, res) => {
  const b = parse(memberSchema, req.body);
  const id = Number(req.params.id);
  const phone = normPhone(b.phone);
  if (one('SELECT id FROM members WHERE phone = ? AND id <> ?', phone, id)) throw conflict('เบอร์โทรศัพท์นี้ถูกใช้โดยสมาชิกอื่น', 'PHONE_EXISTS');
  update('members', id, {
    phone, name: b.name, gender: b.gender || 'unspecified', birthday: b.birthday || null, email: b.email || null, line_user_id: b.lineUserId || null,
    note: b.note ?? null, status: b.status || 'active', notify_channels: b.notifyChannels ? JSON.stringify(b.notifyChannels) : undefined,
    pin_hash: b.pin ? hashSecret(b.pin) : undefined, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  audit(req, 'member.update', { entity: 'member', entityId: id, details: b.pin ? 'with PIN reset' : '' });
  emitMember(id, 'member:updated', {});
  res.json(memberFull(id));
});

// Manual point adjustment (+/−) with reason — always audited
r.post('/members/:id/points', requirePerm('member.adjust_points'), (req, res) => {
  const b = parse(z.object({ action: z.enum(['add', 'remove']), points: z.number().int().positive().max(1_000_000), reason: z.string().min(1).max(300), txnId: z.string().max(80).optional() }), req.body);
  const id = Number(req.params.id);
  const before = one('SELECT points FROM members WHERE id = ?', id);
  if (!before) throw notFound();
  const row = pointTx({ memberId: id, type: 'ADJUSTMENT', points: b.action === 'add' ? b.points : -b.points, txnId: b.txnId || uuid(), branchId: req.staff.branchId, staffId: req.staff.id, deviceId: req.device?.id, reason: b.reason, notify: false });
  audit(req, 'member.points_adjust', { entity: 'member', entityId: id, details: `${b.action === 'add' ? '+' : '-'}${b.points} (${before.points} → ${row.balance}): ${b.reason}` });
  notifyMember(id, 'adjust', `${b.action === 'add' ? 'ได้รับ' : 'ปรับลด'} ${b.points} คะแนน`, b.reason, `adjust:${row.txn_id}`);
  res.json({ transaction: row, member: memberFull(id) });
});

r.post('/members/:id/tier', requirePerm('member.edit_tier'), (req, res) => {
  const b = parse(z.object({ tierId: z.number().int().nullable(), locked: z.boolean() }), req.body);
  const id = Number(req.params.id);
  if (b.locked && b.tierId) run('UPDATE members SET tier_id = ?, tier_locked = 1 WHERE id = ?', b.tierId, id);
  else { run('UPDATE members SET tier_locked = 0 WHERE id = ?', id); recomputeTier(id); }
  audit(req, 'member.tier', { entity: 'member', entityId: id, details: `tier ${b.tierId} locked=${b.locked}` });
  res.json(memberFull(id));
});

// Timeline: orders + point transactions + redemptions
r.get('/members/:id/timeline', requirePerm('member.history'), (req, res) => {
  const id = Number(req.params.id);
  const pts = all(`SELECT pt.*, COALESCE(s.nickname, s.first_name) AS staff_name, s.employee_code, o.order_no, b.name AS branch_name
                   FROM point_transactions pt LEFT JOIN staff s ON s.id = pt.staff_id LEFT JOIN orders o ON o.id = pt.order_id LEFT JOIN branches b ON b.id = pt.branch_id
                   WHERE pt.member_id = ? ORDER BY pt.id DESC LIMIT 300`, id);
  const orders = all(`SELECT o.id, o.order_no, o.queue_no, o.total, o.status, o.paid_at, b.name AS branch_name, om.points_earned, om.points_used
                      FROM orders o LEFT JOIN order_members om ON om.order_id = o.id LEFT JOIN branches b ON b.id = o.branch_id
                      WHERE o.member_id = ? AND o.status IN ('paid','refunded','partially_refunded') ORDER BY o.paid_at DESC LIMIT 200`, id);
  const redemptions = all(`SELECT rr.*, r.name AS reward_name, COALESCE(s.nickname, s.first_name) AS used_by_name, d.name AS device_name, b.name AS branch_name
                           FROM reward_redemptions rr JOIN rewards r ON r.id = rr.reward_id LEFT JOIN staff s ON s.id = rr.used_by_staff_id
                           LEFT JOIN pos_devices d ON d.id = rr.used_device_id LEFT JOIN branches b ON b.id = rr.used_branch_id
                           WHERE rr.member_id = ? ORDER BY rr.id DESC LIMIT 200`, id);
  res.json({ points: pts, orders, redemptions });
});

// POS: preview member for current cart (tier, points, rewards available)
r.get('/members/:id/pos-summary', requirePerm('member.search'), (req, res) => {
  const m = memberFull(Number(req.params.id));
  if (!m) throw notFound();
  const memberRow = one('SELECT * FROM members WHERE id = ?', m.id);
  const rewards = all('SELECT * FROM rewards WHERE active = 1 AND hidden = 0 ORDER BY points_required').map(shapeReward)
    .map((rw) => ({ ...rw, blocker: rewardBlocker(rw, memberRow, req.staff.branchId) }));
  res.json({ member: m, rewards, redeemableCount: rewards.filter((x) => !x.blocker).length + m.activeRedemptions.length });
});

// POS: staff redeems a reward on behalf of the member (creates a code, then apply to order)
r.post('/members/:id/redeem', requirePerm('member.use_points'), (req, res) => {
  const b = parse(z.object({ rewardId: z.number().int(), txnId: z.string().max(80).optional() }), req.body);
  const red = createRedemption({ memberId: Number(req.params.id), rewardId: b.rewardId, via: 'pos', staffId: req.staff.id, deviceId: req.device?.id, branchId: req.staff.branchId, txnId: b.txnId || uuid() });
  audit(req, 'reward.redeem', { entity: 'member', entityId: req.params.id, details: `reward ${b.rewardId} code ${red.code}` });
  res.json(redemptionDetail('rr.id = ?', red.id));
});

// verify code (Scan Barcode / QR / typed)
r.get('/redemptions/verify/:code', (req, res) => {
  const r_ = verifyRedemption(req.params.code, req.staff.branchId);
  res.json(r_);
});
r.get('/redemptions', requirePerm('member.history', 'member.rewards'), (req, res) => {
  res.json(all(`SELECT rr.*, r.name AS reward_name, m.name AS member_name, m.phone, COALESCE(s.nickname, s.first_name) AS used_by_name, s.employee_code AS used_by_code,
                       d.name AS device_name, d.code AS device_code, b.name AS branch_name, o.order_no
                FROM reward_redemptions rr JOIN rewards r ON r.id = rr.reward_id JOIN members m ON m.id = rr.member_id
                LEFT JOIN staff s ON s.id = rr.used_by_staff_id LEFT JOIN pos_devices d ON d.id = rr.used_device_id
                LEFT JOIN branches b ON b.id = rr.used_branch_id LEFT JOIN orders o ON o.id = rr.order_id
                ORDER BY rr.id DESC LIMIT 500`));
});
r.post('/redemptions/:id/cancel', requirePerm('member.rewards'), (req, res) => {
  const b = parse(z.object({ refundPoints: z.boolean().optional(), reason: z.string().min(1).max(200) }), req.body);
  tx(() => {
    const rr = one('SELECT * FROM reward_redemptions WHERE id = ?', req.params.id);
    if (!rr || rr.status !== 'active') throw bad('ยกเลิกได้เฉพาะรหัสที่ยังไม่ถูกใช้');
    run("UPDATE reward_redemptions SET status = 'cancelled' WHERE id = ?", rr.id);
    if (b.refundPoints && rr.points_used > 0) pointTx({ memberId: rr.member_id, type: 'ADJUSTMENT', points: rr.points_used, txnId: `cancel-redeem:${rr.id}`, staffId: req.staff.id, reason: `คืนแต้มจากการยกเลิก Reward: ${b.reason}` });
    audit(req, 'reward.cancel', { entity: 'redemption', entityId: rr.id, details: b.reason });
  });
  res.json({ ok: true });
});

// ── Tiers ─────────────────────────────────────────────────────────────────
const tierSchema = z.object({
  name: z.string().min(1).max(40), minPoints: z.number().int().min(0), maxPoints: z.number().int().nullable().optional(), color: z.string().max(20),
  icon: z.string().max(40).optional().nullable(), badgeUrl: z.string().max(1000).optional().nullable(), benefits: z.string().max(1000).optional().nullable(),
  discountPct: z.number().min(0).max(100).optional(), pointMultiplier: z.number().min(0).max(20).optional(), birthdayRewardId: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(), rules: z.array(z.object({ type: z.enum(['total_spend', 'visits', 'points', 'period_spend']), value: z.number().min(0), days: z.number().int().nullable().optional() })).optional(),
});
r.get('/tiers', (_req, res) => {
  const rules = all('SELECT * FROM tier_rules');
  res.json(all('SELECT t.*, (SELECT COUNT(*) FROM members m WHERE m.tier_id = t.id) AS member_count FROM member_tiers t WHERE active = 1 ORDER BY min_points').map((t) => ({ ...t, rules: rules.filter((x) => x.tier_id === t.id) })));
});
function saveTier(id, b) {
  return tx(() => {
    const row = { name: b.name, min_points: b.minPoints, max_points: b.maxPoints ?? null, color: b.color, icon: b.icon ?? null, badge_url: b.badgeUrl ?? null, benefits: b.benefits ?? null, discount_pct: b.discountPct ?? 0, point_multiplier: b.pointMultiplier ?? 1, birthday_reward_id: b.birthdayRewardId ?? null, sort_order: b.sortOrder ?? 0 };
    if (id) update('member_tiers', id, row); else id = insert('member_tiers', row);
    if (b.rules) { run('DELETE FROM tier_rules WHERE tier_id = ?', id); for (const x of b.rules) insert('tier_rules', { tier_id: id, type: x.type, value: x.value, days: x.days ?? null }); }
    return id;
  });
}
const recomputeAll = () => setImmediate(() => { for (const m of all("SELECT id FROM members WHERE status = 'active'")) recomputeTier(m.id); });
r.post('/tiers', requirePerm('member.rewards'), (req, res) => { const id = saveTier(null, parse(tierSchema, req.body)); audit(req, 'tier.create', { entity: 'tier', entityId: id }); recomputeAll(); emitAll('catalog:changed', {}); res.json({ id }); });
r.put('/tiers/:id', requirePerm('member.rewards'), (req, res) => { saveTier(Number(req.params.id), parse(tierSchema, req.body)); audit(req, 'tier.update', { entity: 'tier', entityId: req.params.id }); recomputeAll(); emitAll('catalog:changed', {}); res.json({ ok: true }); });
r.delete('/tiers/:id', requirePerm('member.rewards'), (req, res) => {
  run('UPDATE member_tiers SET active = 0 WHERE id = ?', req.params.id);
  run('UPDATE members SET tier_id = NULL, tier_locked = 0 WHERE tier_id = ?', req.params.id);
  audit(req, 'tier.delete', { entity: 'tier', entityId: req.params.id }); recomputeAll(); res.json({ ok: true });
});

// ── Rewards ───────────────────────────────────────────────────────────────
const rewardSchema = z.object({
  name: z.string().min(1).max(100), description: z.string().max(1000).optional().nullable(), imageUrl: z.string().max(1000).optional().nullable(),
  type: z.enum(['discount_amount', 'discount_pct', 'free_product']), pointsRequired: z.number().int().min(0), discountValue: z.number().min(0).optional(),
  maxDiscount: z.number().min(0).nullable().optional(), productId: z.number().int().nullable().optional(), totalQuota: z.number().int().min(0).nullable().optional(),
  perMemberLimit: z.number().int().min(0).nullable().optional(), startAt: z.string().nullable().optional(), endAt: z.string().nullable().optional(),
  codeValidDays: z.number().int().min(1).max(3650).optional(), branchIds: z.array(z.number().int()).optional(), tierIds: z.array(z.number().int()).optional(),
  productIds: z.array(z.number().int()).optional(), minSpend: z.number().min(0).optional(), combinable: z.boolean().optional(), active: z.boolean().optional(),
  hidden: z.boolean().optional(), isBirthday: z.boolean().optional(), sortOrder: z.number().int().optional(),
});
const rewardRow = (b) => ({
  name: b.name, description: b.description ?? null, image_url: b.imageUrl ?? null, type: b.type, points_required: b.pointsRequired, discount_value: b.discountValue ?? 0,
  max_discount: b.maxDiscount ?? null, product_id: b.productId ?? null, total_quota: b.totalQuota ?? null, per_member_limit: b.perMemberLimit ?? null,
  start_at: b.startAt || null, end_at: b.endAt || null, code_valid_days: b.codeValidDays ?? 30, branch_ids: b.branchIds || [], tier_ids: b.tierIds || [],
  product_ids: b.productIds || [], min_spend: b.minSpend ?? 0, combinable: b.combinable === false ? 0 : 1, active: b.active === false ? 0 : 1,
  hidden: b.hidden ? 1 : 0, is_birthday: b.isBirthday ? 1 : 0, sort_order: b.sortOrder ?? 0,
});
r.get('/rewards', (_req, res) => res.json(all('SELECT r.*, p.name AS product_name FROM rewards r LEFT JOIN products p ON p.id = r.product_id ORDER BY r.sort_order, r.points_required').map(shapeReward)));
r.post('/rewards', requirePerm('member.rewards'), (req, res) => {
  const b = parse(rewardSchema, req.body);
  if (b.type === 'free_product' && !b.productId) throw bad('กรุณาเลือกสินค้าฟรี');
  const id = insert('rewards', rewardRow(b)); audit(req, 'reward.create', { entity: 'reward', entityId: id, details: b.name }); emitAll('loyalty:changed', {}); res.json({ id });
});
r.put('/rewards/:id', requirePerm('member.rewards'), (req, res) => {
  const b = parse(rewardSchema, req.body);
  update('rewards', Number(req.params.id), rewardRow(b)); audit(req, 'reward.update', { entity: 'reward', entityId: req.params.id }); emitAll('loyalty:changed', {}); res.json({ ok: true });
});
r.delete('/rewards/:id', requirePerm('member.rewards'), (req, res) => { run('UPDATE rewards SET active = 0, hidden = 1 WHERE id = ?', req.params.id); audit(req, 'reward.delete', { entity: 'reward', entityId: req.params.id }); res.json({ ok: true }); });

// ── Birthday campaigns ────────────────────────────────────────────────────
const campaignSchema = z.object({ name: z.string().min(1).max(100), message: z.string().max(500).optional().nullable(), imageUrl: z.string().max(1000).optional().nullable(), windowType: z.enum(['day', '3days', '7days', 'month']), benefit: z.enum(['points', 'reward']), points: z.number().int().min(0).optional(), rewardId: z.number().int().nullable().optional(), tierIds: z.array(z.number().int()).optional(), active: z.boolean().optional() });
const campRow = (b) => ({ name: b.name, message: b.message ?? null, image_url: b.imageUrl ?? null, window_type: b.windowType, benefit: b.benefit, points: b.points ?? 0, reward_id: b.rewardId ?? null, tier_ids: b.tierIds || [], active: b.active === false ? 0 : 1 });
r.get('/birthday-campaigns', (_req, res) => res.json(all('SELECT c.*, r.name AS reward_name, (SELECT COUNT(*) FROM birthday_claims bc WHERE bc.campaign_id = c.id) AS claims FROM birthday_campaigns c LEFT JOIN rewards r ON r.id = c.reward_id ORDER BY c.id DESC').map((c) => ({ ...c, tier_ids: json(c.tier_ids, []) }))));
r.post('/birthday-campaigns', requirePerm('member.rewards'), (req, res) => {
  const b = parse(campaignSchema, req.body);
  if (b.benefit === 'reward' && !b.rewardId) throw bad('กรุณาเลือก Reward');
  const id = insert('birthday_campaigns', campRow(b)); audit(req, 'birthday.create', { entity: 'birthday_campaign', entityId: id }); res.json({ id });
});
r.put('/birthday-campaigns/:id', requirePerm('member.rewards'), (req, res) => { update('birthday_campaigns', Number(req.params.id), campRow(parse(campaignSchema, req.body))); res.json({ ok: true }); });
r.delete('/birthday-campaigns/:id', requirePerm('member.rewards'), (req, res) => { run('UPDATE birthday_campaigns SET active = 0 WHERE id = ?', req.params.id); res.json({ ok: true }); });
r.get('/birthday-campaigns/eligible', requirePerm('member.search'), (_req, res) => {
  const tz = getSetting('shop').timezone;
  const camps = all('SELECT * FROM birthday_campaigns WHERE active = 1');
  const out = [];
  for (const m of all("SELECT * FROM members WHERE status = 'active' AND birthday IS NOT NULL")) for (const c of camps) if (birthdayEligible(m, c, new Date(), tz)) out.push({ memberId: m.id, name: m.name, phone: m.phone, birthday: m.birthday, campaign: c.name });
  res.json(out);
});

// ── Point ledger (all members) ────────────────────────────────────────────
r.get('/point-transactions', requirePerm('member.history'), (req, res) => {
  const { type, from, to, branchId } = req.query;
  const where = ['1=1']; const p = [];
  if (type) { where.push('pt.type = ?'); p.push(type); }
  if (from) { where.push('pt.created_at >= ?'); p.push(from); }
  if (to) { where.push('pt.created_at <= ?'); p.push(to); }
  if (branchId) { where.push('pt.branch_id = ?'); p.push(Number(branchId)); }
  res.json(all(`SELECT pt.*, m.name AS member_name, m.phone, m.member_code, COALESCE(s.nickname, s.first_name) AS staff_name, s.employee_code, b.name AS branch_name, o.order_no
                FROM point_transactions pt JOIN members m ON m.id = pt.member_id LEFT JOIN staff s ON s.id = pt.staff_id
                LEFT JOIN branches b ON b.id = pt.branch_id LEFT JOIN orders o ON o.id = pt.order_id
                WHERE ${where.join(' AND ')} ORDER BY pt.id DESC LIMIT 1000`, ...p));
});

export default r;

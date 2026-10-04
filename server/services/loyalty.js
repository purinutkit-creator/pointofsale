// ─────────────────────────────────────────────────────────────────────────────
// Loyalty engine: point ledger (FIFO lots + expiry), tiers, rewards & redemption
// codes, birthday campaigns, receipt QR claims. Every point transaction and
// redemption carries a unique txn_id so retries can never double-apply.
// ─────────────────────────────────────────────────────────────────────────────
import { one, all, run, insert, tx, afterCommit, json, sqlNow } from '../db/index.js';
import { randomDigits, uuid } from '../lib/security.js';
import { bad, conflict, notFound } from '../lib/errors.js';
import { getSetting } from './settings.js';
import { pointExpiry, resolveTier } from '../../shared/points.js';
import { zonedParts } from '../../shared/format.js';
import { tiers as loadTiers } from './catalog.js';
import { emitMember, emitAll } from '../realtime.js';
import { notifyMember } from './messaging.js';

const POSITIVE_LIFETIME = new Set(['EARN', 'BONUS', 'BIRTHDAY']);

export function getMember(id) {
  const m = one('SELECT m.*, t.name AS tier_name, t.color AS tier_color, t.icon AS tier_icon, t.badge_url AS tier_badge, t.discount_pct AS tier_discount_pct, t.point_multiplier AS tier_point_multiplier FROM members m LEFT JOIN member_tiers t ON t.id = m.tier_id WHERE m.id = ?', id);
  if (!m) return null;
  delete m.pin_hash;
  return m;
}

export function publicMember(m) {
  if (!m) return null;
  return {
    id: m.id, memberCode: m.member_code, name: m.name, phone: m.phone, email: m.email, gender: m.gender, birthday: m.birthday,
    points: m.points, pointDebt: m.point_debt, lifetimePoints: m.lifetime_points, totalSpend: m.total_spend, visitCount: m.visit_count,
    lastVisitAt: m.last_visit_at, createdAt: m.created_at, status: m.status, note: m.note,
    tier: m.tier_id ? { id: m.tier_id, name: m.tier_name, color: m.tier_color, icon: m.tier_icon, badgeUrl: m.tier_badge, discountPct: m.tier_discount_pct, pointMultiplier: m.tier_point_multiplier } : null,
    hasPin: undefined,
  };
}

/**
 * Append a point transaction (signed). Idempotent on txnId.
 * Handles FIFO lot consumption, negative balance policy / point debt, lifetime points and tier recompute.
 */
export function pointTx({ memberId, type, points, txnId = uuid(), orderId = null, redemptionId = null, branchId = null, staffId = null, deviceId = null, amount = null, reason = null, notify = true }) {
  return tx(() => {
    const existing = one('SELECT * FROM point_transactions WHERE txn_id = ?', txnId);
    if (existing) return existing;
    points = Math.trunc(Number(points) || 0);
    if (!points) return null;
    const m = one('SELECT * FROM members WHERE id = ?', memberId);
    if (!m) throw notFound('ไม่พบสมาชิก');
    const settings = getSetting('points');
    let balance = m.points;
    let debt = m.point_debt;
    let lifetime = m.lifetime_points;

    if (points > 0) {
      let credit = points;
      if (debt > 0) { const pay = Math.min(debt, credit); debt -= pay; credit -= pay; }
      if (balance < 0) { const pay = Math.min(-balance, credit); balance += pay; credit -= pay; }
      balance += credit;
      if (credit > 0) {
        insert('member_points', { member_id: memberId, points: credit, remaining: credit, expires_at: expiryFor(settings, type) });
      }
      if (POSITIVE_LIFETIME.has(type) || type === 'ADJUSTMENT') lifetime += points;
    } else {
      const need = -points;
      if (type === 'REDEEM' && need > balance) throw bad(`แต้มไม่พอ (มี ${balance} ต้องใช้ ${need})`, 'INSUFFICIENT_POINTS');
      const fromBalance = Math.max(0, Math.min(need, balance));
      consumeLots(memberId, fromBalance);
      const shortage = need - fromBalance;
      balance -= fromBalance;
      if (shortage > 0) {
        if (settings.negativePolicy === 'debt') debt += shortage;
        else balance -= shortage;
      }
      if (type === 'REFUND' || type === 'ADJUSTMENT') lifetime = Math.max(0, lifetime - need);
    }

    const id = insert('point_transactions', {
      txn_id: txnId, member_id: memberId, type, points, balance, order_id: orderId, redemption_id: redemptionId,
      branch_id: branchId, staff_id: staffId, device_id: deviceId, amount, reason,
    });
    run("UPDATE members SET points = ?, point_debt = ?, lifetime_points = ?, updated_at = datetime('now') WHERE id = ?", balance, debt, lifetime, memberId);
    const tierChange = recomputeTier(memberId);
    const row = one('SELECT * FROM point_transactions WHERE id = ?', id);
    afterCommit(() => {
      emitMember(memberId, 'member:updated', { points: balance, tx: row });
      emitAll('loyalty:changed', { memberId });
    });
    if (notify) {
      if (type === 'EARN' && points > 0) notifyMember(memberId, 'earn', `คุณได้รับ ${points} คะแนน`, `จากการซื้อ${amount ? ` ยอด ${Number(amount).toLocaleString('th-TH')} บาท` : ''} คะแนนคงเหลือ ${balance}`, `earn:${txnId}`);
      if (tierChange?.up) notifyMember(memberId, 'tier', `ยินดีด้วย! คุณเลื่อนเป็น ${tierChange.name}`, 'รับสิทธิประโยชน์ใหม่ได้ทันที', `tier:${memberId}:${tierChange.id}:${txnId}`);
      else if (points > 0) nextTierHint(memberId);
    }
    return row;
  });
}

function expiryFor(settings, type) {
  const iso = pointExpiry(settings, new Date());
  return iso ? sqlNow(new Date(iso)) : null;
}

function consumeLots(memberId, qty) {
  let left = qty;
  const lots = all(`SELECT id, remaining FROM member_points WHERE member_id = ? AND remaining > 0
                    ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, id`, memberId);
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining);
    run('UPDATE member_points SET remaining = remaining - ? WHERE id = ?', take, l.id);
    left -= take;
  }
}

/** Recompute tier from points / spend / visits. Returns {up, id, name} when changed. */
export function recomputeTier(memberId) {
  const m = one('SELECT * FROM members WHERE id = ?', memberId);
  if (!m || m.tier_locked) return null;
  const list = loadTiers();
  if (!list.length) return null;
  const s = getSetting('points');
  const periodSpend = {};
  for (const t of list) for (const r of t.rules) if (r.type === 'period_spend') {
    const days = r.days || 365;
    periodSpend[days] = Number(one(`SELECT IFNULL(SUM(total - refunded_total),0) v FROM orders WHERE member_id = ? AND status IN ('paid','partially_refunded') AND paid_at >= datetime('now', ?)`, memberId, `-${days} days`)?.v || 0);
  }
  const tier = resolveTier(list, {
    points: s.tierBasis === 'current' ? m.points : m.lifetime_points,
    totalSpend: m.total_spend, visits: m.visit_count, periodSpend,
  });
  if (!tier || tier.id === m.tier_id) return null;
  const old = list.find((t) => t.id === m.tier_id);
  run("UPDATE members SET tier_id = ?, updated_at = datetime('now') WHERE id = ?", tier.id, memberId);
  return { id: tier.id, name: tier.name, up: !old || (tier.min_points || 0) > (old.min_points || 0) };
}

function nextTierHint(memberId) {
  const m = one('SELECT * FROM members WHERE id = ?', memberId);
  const s = getSetting('points');
  const basis = s.tierBasis === 'current' ? m.points : m.lifetime_points;
  const next = loadTiers().find((t) => (t.min_points || 0) > basis);
  if (next && next.min_points - basis <= Math.max(20, next.min_points * 0.1)) {
    notifyMember(memberId, 'tier_hint', `อีกเพียง ${next.min_points - basis} คะแนน คุณจะเลื่อนเป็น ${next.name}`, '', `hint:${memberId}:${next.id}:${new Date().toISOString().slice(0, 7)}`);
  }
}

// ── Rewards & redemption codes ────────────────────────────────────────────
export function shapeReward(r) {
  return { ...r, branch_ids: json(r.branch_ids, []), tier_ids: json(r.tier_ids, []), product_ids: json(r.product_ids, []), combinable: !!r.combinable, active: !!r.active, hidden: !!r.hidden, is_birthday: !!r.is_birthday };
}

/** Why a member can't redeem a reward right now (null = OK). */
export function rewardBlocker(reward, member, branchId = null) {
  const r = shapeReward(reward);
  const now = new Date();
  if (!r.active) return 'Reward ปิดใช้งาน';
  if (r.start_at && now < new Date(r.start_at)) return 'ยังไม่ถึงวันเริ่มต้น';
  if (r.end_at && now > new Date(r.end_at)) return 'Reward หมดอายุแล้ว';
  if (r.total_quota != null && r.used_count >= r.total_quota) return 'สิทธิ์เต็มแล้ว';
  if (r.tier_ids.length && !r.tier_ids.map(Number).includes(Number(member.tier_id))) return 'เฉพาะ Tier ที่กำหนด';
  if (branchId && r.branch_ids.length && !r.branch_ids.map(Number).includes(Number(branchId))) return 'ไม่สามารถใช้ที่สาขานี้';
  if (r.per_member_limit) {
    const n = one("SELECT COUNT(*) c FROM reward_redemptions WHERE reward_id = ? AND member_id = ? AND status <> 'cancelled'", r.id, member.id).c;
    if (n >= r.per_member_limit) return `แลกได้สูงสุด ${r.per_member_limit} ครั้งต่อคน`;
  }
  if (member.points < r.points_required) return `แต้มไม่พอ (ต้องใช้ ${r.points_required})`;
  return null;
}

function newCode() {
  const len = Math.max(6, Number(getSetting('member').redemptionCodeLength) || 6);
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = randomDigits(attempt < 20 ? len : len + 2);
    if (!one('SELECT id FROM reward_redemptions WHERE code = ?', code)) return code;
  }
  throw new Error('cannot allocate redemption code');
}

/** Member (or staff on behalf of member) redeems a reward → points deducted, single-use code created. */
export function createRedemption({ memberId, rewardId, via = 'member', staffId = null, deviceId = null, branchId = null, txnId = uuid(), campaignId = null, free = false }) {
  return tx(() => {
    const dup = one('SELECT * FROM reward_redemptions WHERE txn_id = ?', txnId);
    if (dup) return dup;
    const member = one('SELECT * FROM members WHERE id = ?', memberId);
    if (!member || member.status !== 'active') throw notFound('ไม่พบสมาชิก');
    const reward = one('SELECT * FROM rewards WHERE id = ?', rewardId);
    if (!reward) throw notFound('ไม่พบ Reward');
    const blocker = free ? null : rewardBlocker(reward, member, via === 'pos' ? branchId : null);
    if (blocker) throw bad(blocker, 'REWARD_NOT_AVAILABLE');
    const code = newCode();
    const days = Number(reward.code_valid_days) || 30;
    let exp = new Date(Date.now() + days * 86400e3);
    if (reward.end_at && new Date(reward.end_at) < exp) exp = new Date(reward.end_at);
    // end of day in shop timezone (23:59)
    const tz = getSetting('shop').timezone;
    const z = zonedParts(exp, tz);
    exp = new Date(`${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}T23:59:59+07:00`);
    const pts = free ? 0 : reward.points_required;
    const id = insert('reward_redemptions', {
      txn_id: txnId, code, reward_id: reward.id, member_id: memberId, campaign_id: campaignId, points_used: pts,
      status: 'active', expires_at: sqlNow(exp), created_via: via,
    });
    if (pts > 0) pointTx({ memberId, type: 'REDEEM', points: -pts, txnId: `redeem:${txnId}`, redemptionId: id, branchId, staffId, deviceId, reason: `แลก ${reward.name}`, notify: false });
    run('UPDATE rewards SET used_count = used_count + 1 WHERE id = ?', reward.id);
    const red = one('SELECT * FROM reward_redemptions WHERE id = ?', id);
    afterCommit(() => emitMember(memberId, 'member:redemption', { id, status: 'active' }));
    return red;
  });
}

export function redemptionDetail(where, ...params) {
  const r = one(`SELECT rr.*, r.name AS reward_name, r.type AS reward_type, r.discount_value, r.max_discount, r.product_id,
                        r.image_url AS reward_image, r.min_spend, r.combinable, r.branch_ids, r.product_ids, r.description AS reward_description,
                        m.name AS member_name, m.phone AS member_phone, m.member_code, m.tier_id
                 FROM reward_redemptions rr JOIN rewards r ON r.id = rr.reward_id JOIN members m ON m.id = rr.member_id
                 WHERE ${where}`, ...params);
  if (r && r.status === 'active' && new Date(r.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    run("UPDATE reward_redemptions SET status = 'expired' WHERE id = ?", r.id);
    r.status = 'expired';
  }
  return r;
}

/** POS verification of a code (scan barcode / QR / typed). */
export function verifyRedemption(code, branchId) {
  const clean = String(code || '').replace(/\D/g, '');
  const r = redemptionDetail('rr.code = ?', clean);
  if (!r) throw notFound('ไม่พบรหัสนี้ในระบบ');
  if (r.status === 'used') throw conflict(`รหัสนี้ถูกใช้แล้วเมื่อ ${r.used_at}`, 'REDEMPTION_USED');
  if (r.status === 'expired') throw conflict('รหัสหมดอายุแล้ว', 'REDEMPTION_EXPIRED');
  if (r.status === 'cancelled') throw conflict('รหัสถูกยกเลิกแล้ว', 'REDEMPTION_CANCELLED');
  const branches = json(r.branch_ids, []);
  if (branches.length && !branches.map(Number).includes(Number(branchId))) throw conflict('Reward นี้ใช้ไม่ได้ที่สาขานี้', 'REDEMPTION_BRANCH');
  return r;
}

/** Mark code USED immediately (atomic). Returns redemption detail. */
export function consumeRedemption(code, { orderId, staffId, deviceId, branchId }) {
  return tx(() => {
    const r = verifyRedemption(code, branchId);
    const ch = run(`UPDATE reward_redemptions SET status = 'used', used_at = datetime('now'), order_id = ?, used_by_staff_id = ?, used_device_id = ?, used_branch_id = ?
                    WHERE id = ? AND status = 'active'`, orderId, staffId, deviceId, branchId, r.id).changes;
    if (!ch) throw conflict('รหัสนี้ถูกใช้แล้ว', 'REDEMPTION_USED');
    afterCommit(() => emitMember(r.member_id, 'member:redemption', { id: r.id, status: 'used' }));
    return { ...r, status: 'used' };
  });
}

/** Return a code to ACTIVE when it is removed from an unpaid / voided order. */
export function releaseRedemption(id, reason = 'removed') {
  const r = one('SELECT * FROM reward_redemptions WHERE id = ?', id);
  if (!r || r.status !== 'used') return;
  run("UPDATE reward_redemptions SET status = 'active', used_at = NULL, order_id = NULL, used_by_staff_id = NULL, used_device_id = NULL, used_branch_id = NULL WHERE id = ?", id);
  afterCommit(() => emitMember(r.member_id, 'member:redemption', { id, status: 'active', reason }));
}

// ── Birthday campaigns ────────────────────────────────────────────────────
export function birthdayEligible(member, campaign, now = new Date(), tz = 'Asia/Bangkok') {
  if (!member.birthday || !campaign.active) return false;
  const tierIds = json(campaign.tier_ids, []);
  if (tierIds.length && !tierIds.map(Number).includes(Number(member.tier_id))) return false;
  const [, bm, bd] = member.birthday.split('-').map(Number);
  const z = zonedParts(now, tz);
  if (campaign.window_type === 'month') return z.month === bm;
  const days = campaign.window_type === 'day' ? 0 : campaign.window_type === '3days' ? 3 : 7;
  const today = Date.UTC(z.year, z.month - 1, z.day);
  return [z.year - 1, z.year, z.year + 1].some((y) => Math.abs(Date.UTC(y, bm - 1, bd) - today) <= days * 86400e3);
}

export function claimBirthday(memberId, campaignId) {
  return tx(() => {
    const member = one('SELECT * FROM members WHERE id = ?', memberId);
    const c = one('SELECT * FROM birthday_campaigns WHERE id = ?', campaignId);
    if (!member || !c) throw notFound();
    const tz = getSetting('shop').timezone;
    if (!birthdayEligible(member, c, new Date(), tz)) throw bad('ยังไม่อยู่ในช่วงวันเกิด หรือไม่ตรงเงื่อนไข');
    const year = zonedParts(new Date(), tz).year;
    if (one('SELECT id FROM birthday_claims WHERE campaign_id = ? AND member_id = ? AND year = ?', c.id, memberId, year)) throw conflict('รับสิทธิ์วันเกิดปีนี้แล้ว');
    let redemption = null;
    if (c.benefit === 'points') {
      pointTx({ memberId, type: 'BIRTHDAY', points: c.points, txnId: `birthday:${c.id}:${memberId}:${year}`, reason: c.name });
    } else {
      redemption = createRedemption({ memberId, rewardId: c.reward_id, via: 'birthday', txnId: `birthday:${c.id}:${memberId}:${year}`, campaignId: c.id, free: true });
    }
    insert('birthday_claims', { campaign_id: c.id, member_id: memberId, year, redemption_id: redemption?.id ?? null });
    return { campaign: c, redemption };
  });
}

// ── Receipt QR claim (สะสมแต้มจาก QR ท้ายใบเสร็จ — ใช้ได้ครั้งเดียว) ────────────
export function claimReceipt(token, memberId) {
  return tx(() => {
    const r = one('SELECT r.*, o.status AS order_status, o.member_id AS order_member_id FROM receipts r JOIN orders o ON o.id = r.order_id WHERE r.claim_token = ?', token);
    if (!r) throw notFound('QR Code ไม่ถูกต้อง');
    if (r.claim_status === 'used') throw conflict('ใบเสร็จนี้สะสมแต้มไปแล้ว', 'CLAIM_USED');
    if (r.claim_status !== 'available' || ['refunded', 'voided'].includes(r.order_status)) throw conflict('ใบเสร็จนี้ไม่สามารถสะสมแต้มได้', 'CLAIM_VOID');
    if (r.order_member_id) throw conflict('ใบเสร็จนี้ถูกสะสมแต้มให้สมาชิกแล้ว', 'CLAIM_USED');
    if (r.claim_expires_at && new Date(r.claim_expires_at.replace(' ', 'T') + 'Z') < new Date()) throw conflict('QR Code หมดอายุแล้ว', 'CLAIM_EXPIRED');
    const ch = run("UPDATE receipts SET claim_status = 'used', claimed_member_id = ?, claimed_at = datetime('now') WHERE id = ? AND claim_status = 'available'", memberId, r.id).changes;
    if (!ch) throw conflict('ใบเสร็จนี้สะสมแต้มไปแล้ว', 'CLAIM_USED');
    const m = one('SELECT * FROM members WHERE id = ?', memberId);
    run('UPDATE orders SET member_id = ? WHERE id = ?', memberId, r.order_id);
    const net = r.total;
    run("UPDATE members SET total_spend = total_spend + ?, visit_count = visit_count + 1, last_visit_at = datetime('now') WHERE id = ?", net, memberId);
    insert('order_members', { order_id: r.order_id, member_id: memberId, points_before: m.points, points_earned: r.claim_points, attached_via: 'claim' });
    if (r.claim_points > 0) pointTx({ memberId, type: 'EARN', points: r.claim_points, txnId: `earn:${r.order_id}`, orderId: r.order_id, branchId: r.branch_id, amount: net, reason: `สะสมแต้มจาก QR ใบเสร็จ ${r.receipt_no}` });
    else recomputeTier(memberId);
    return { receiptNo: r.receipt_no, points: r.claim_points, total: net };
  });
}

/** Daily maintenance: expire point lots & redemption codes, warn about expiring points, birthday greetings. */
export function loyaltyDailyJob() {
  const expiredLots = all("SELECT member_id, SUM(remaining) pts FROM member_points WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at < datetime('now') GROUP BY member_id");
  for (const l of expiredLots) {
    tx(() => {
      run("UPDATE member_points SET remaining = 0 WHERE member_id = ? AND remaining > 0 AND expires_at IS NOT NULL AND expires_at < datetime('now')", l.member_id);
      const m = one('SELECT points FROM members WHERE id = ?', l.member_id);
      const take = Math.min(l.pts, Math.max(0, m.points));
      if (take > 0) {
        const bal = m.points - take;
        insert('point_transactions', { txn_id: `expire:${l.member_id}:${new Date().toISOString().slice(0, 10)}`, member_id: l.member_id, type: 'EXPIRED', points: -take, balance: bal, reason: 'แต้มหมดอายุ' });
        run('UPDATE members SET points = ? WHERE id = ?', bal, l.member_id);
      }
    });
  }
  run("UPDATE reward_redemptions SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')");
  run("UPDATE receipts SET claim_status = 'void' WHERE claim_status = 'available' AND claim_expires_at < datetime('now')");
  // warn 7 days before expiry
  for (const w of all("SELECT member_id, SUM(remaining) pts, MIN(expires_at) exp FROM member_points WHERE remaining > 0 AND expires_at BETWEEN datetime('now') AND datetime('now','+7 days') GROUP BY member_id")) {
    notifyMember(w.member_id, 'expiring', `คะแนน ${w.pts} คะแนนกำลังจะหมดอายุ`, `หมดอายุ ${w.exp.slice(0, 10)} รีบใช้ก่อนหมดอายุนะ`, `expiring:${w.member_id}:${w.exp.slice(0, 10)}`);
  }
  // birthday greetings
  const tz = getSetting('shop').timezone;
  const campaigns = all('SELECT * FROM birthday_campaigns WHERE active = 1');
  if (campaigns.length) {
    const z = zonedParts(new Date(), tz);
    const mm = String(z.month).padStart(2, '0');
    for (const m of all("SELECT * FROM members WHERE status = 'active' AND birthday IS NOT NULL AND substr(birthday, 6, 2) IN (?, ?, ?)", mm, String(((z.month + 10) % 12) + 1).padStart(2, '0'), String((z.month % 12) + 1).padStart(2, '0'))) {
      for (const c of campaigns) {
        if (birthdayEligible(m, c, new Date(), tz)) notifyMember(m.id, 'birthday', c.message || 'สุขสันต์วันเกิด รับ Reward ฟรีจากเรา 🎂', c.name, `bday:${c.id}:${m.id}:${z.year}`);
      }
    }
  }
}

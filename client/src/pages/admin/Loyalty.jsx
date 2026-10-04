// Loyalty Program admin: dashboard, tiers, rewards, birthday campaigns, point ledger, redemption log
import { useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { api, download } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Kpi, BarList, VIZ } from './Dashboard.jsx';
import { Button, Modal, Input, Select, Toggle, TextArea, DataTable, useAsync, Badge, Seg, Check, Spinner } from '../../components/ui.jsx';
import { money, int, fmtDateTime } from '../../lib/util.js';
import { POINT_TX_TYPES } from '@shared/points.js';

const tip = { contentStyle: { borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', fontFamily: 'Sarabun' }, cursor: { fill: 'rgba(127,127,127,.08)' } };
const axis = { tick: { fill: 'var(--muted)', fontSize: 12, fontFamily: 'Sarabun' }, axisLine: false, tickLine: false };

export default function Loyalty() {
  const [tab, setTab] = useState('dashboard');
  return (
    <Page title="Loyalty Program" tab={tab} onTab={setTab} tabs={[{ value: 'dashboard', label: 'Dashboard' }, { value: 'tiers', label: 'Tier' }, { value: 'rewards', label: 'Rewards' }, { value: 'birthday', label: 'Birthday Campaign' }, { value: 'points', label: 'Points / Transactions' }, { value: 'redemptions', label: 'Reward Redemption Log' }]}>
      {tab === 'dashboard' && <LoyaltyDashboard />}
      {tab === 'tiers' && <Tiers />}
      {tab === 'rewards' && <Rewards />}
      {tab === 'birthday' && <Birthday />}
      {tab === 'points' && <Points />}
      {tab === 'redemptions' && <Redemptions />}
    </Page>
  );
}

function LoyaltyDashboard() {
  const [days, setDays] = useState(30);
  const d = useAsync(() => api(`/loyalty/dashboard?days=${days}`), [days]);
  if (!d.data) return <div className="center"><Spinner /></div>;
  const t = d.data.totals;
  const chart = (title, data, bars) => (
    <div className="card"><div className="card-h"><b>{title}</b></div><div className="card-b" style={{ height: 240 }}>
      <ResponsiveContainer><BarChart data={data} barCategoryGap={3}><CartesianGrid vertical={false} stroke={VIZ.grid} /><XAxis dataKey="day" {...axis} tickFormatter={(x) => String(x).slice(5)} /><YAxis {...axis} width={50} />
        <Tooltip {...tip} />{bars.length > 1 && <Legend />}
        {bars.map((b) => <Bar key={b.key} dataKey={b.key} name={b.name} fill={b.color} radius={[4, 4, 0, 0]} stackId={b.stack} />)}
      </BarChart></ResponsiveContainer></div></div>
  );
  return (
    <div className="col gap-l">
      <Seg value={days} onChange={setDays} options={[{ value: 7, label: '7 วัน' }, { value: 30, label: '30 วัน' }, { value: 90, label: '90 วัน' }, { value: 365, label: '1 ปี' }]} />
      <div className="grid-4">
        <Kpi label="สมาชิกทั้งหมด" value={int(t.members)} />
        <Kpi label="สมาชิกใหม่วันนี้" value={int(t.newToday)} sub={`เดือนนี้ ${int(t.newMonth)}`} />
        <Kpi label="Active (90 วัน)" value={int(t.active)} sub={`Inactive ${int(t.inactive)}`} />
        <Kpi label="Repeat Customer Rate" value={`${t.repeatRate}%`} />
        <Kpi label="คะแนนที่แจกทั้งหมด" value={int(t.pointsIssued)} sub={`คงค้าง ${int(t.pointsOutstanding)}`} />
        <Kpi label="คะแนนที่ถูกใช้" value={int(t.pointsRedeemed)} />
        <Kpi label="Reward ที่ถูกใช้" value={int(t.rewardsUsed)} />
        <Kpi label="ยอดขายจากสมาชิก" value={`฿${money(t.memberSales)}`} sub={`Average ฿${money(t.averageSpending)}`} />
      </div>
      <div className="grid-2">
        {chart('สมาชิกใหม่รายวัน', d.data.newMembers, [{ key: 'n', name: 'สมาชิกใหม่', color: VIZ.s1 }])}
        {chart('ยอดขาย Member vs Non-Member', d.data.memberVsNon, [{ key: 'member', name: 'Member', color: VIZ.s1 }, { key: 'non_member', name: 'Non-Member', color: VIZ.s2 }])}
        {chart('Point Earned / Redeemed', d.data.points, [{ key: 'earned', name: 'Earned', color: VIZ.s1 }, { key: 'redeemed', name: 'Redeemed', color: VIZ.s2 }])}
        {chart('Reward Redemption', d.data.redemptions, [{ key: 'n', name: 'จำนวนครั้ง', color: VIZ.s1 }])}
      </div>
      <div className="grid-2">
        <BarList title="Top Members" rows={d.data.topMembers.map((m) => ({ label: `${m.name} (${m.tier_name || '-'})`, value: m.total_spend, sub: `${m.phone} · ${int(m.points)} pts · ${m.visit_count} ครั้ง` }))} />
        <BarList title="สมาชิกตาม Tier" unit="คน" rows={d.data.tiers.map((x) => ({ label: x.name, value: x.n }))} />
      </div>
      <div className="card"><div className="card-h"><b>แยกตามสาขา</b></div><div className="card-b">
        <DataTable search={false} rows={d.data.byBranch} columns={[{ key: 'name', label: 'สาขา' }, { key: 'points_earned', label: 'Points Earned', num: true, render: (r) => int(r.points_earned) }, { key: 'rewards_redeemed', label: 'Rewards Redeemed', num: true }, { key: 'member_sales', label: 'Sales by Member', num: true, render: (r) => money(r.member_sales) }, { key: 'top', label: 'Top Members', render: (r) => (d.data.topByBranch[r.name] || []).map((x) => x.name).join(', ') }]} />
      </div></div>
    </div>
  );
}

function Tiers() {
  const list = useAsync(() => api('/tiers'));
  const rewards = useAsync(() => api('/rewards'));
  const [edit, setEdit] = useState(null);
  const save = async () => {
    const b = { name: edit.name, minPoints: Number(edit.min_points) || 0, maxPoints: edit.max_points === '' || edit.max_points == null ? null : Number(edit.max_points), color: edit.color, icon: edit.icon || null, badgeUrl: edit.badge_url || null, benefits: edit.benefits || null, discountPct: Number(edit.discount_pct) || 0, pointMultiplier: Number(edit.point_multiplier) || 1, birthdayRewardId: edit.birthday_reward_id ? Number(edit.birthday_reward_id) : null, sortOrder: 0, rules: (edit.rules || []).map((r) => ({ type: r.type, value: Number(r.value) || 0, days: r.days ? Number(r.days) : null })) };
    try { if (edit.id) await api(`/tiers/${edit.id}`, { method: 'PUT', body: b }); else await api('/tiers', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const RULE = { total_spend: 'ยอดซื้อสะสม ≥ (บาท)', visits: 'จำนวนครั้งที่มา ≥', points: 'คะแนน ≥', period_spend: 'ยอดซื้อในช่วงเวลา ≥ (บาท)' };
  return (
    <div className="col">
      <div className="small muted">ระบบเปลี่ยน Tier ให้อัตโนมัติเมื่อคะแนน (ตามตั้งค่า: คะแนนสะสมตลอดชีพ/คงเหลือ) และเงื่อนไขเพิ่มเติมครบ</div>
      <DataTable rows={list.data || []} search={false} onRow={(t) => setEdit({ ...t })} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', min_points: 0, max_points: '', color: '#D4A017', discount_pct: 0, point_multiplier: 1, rules: [] })}>เพิ่ม Tier</Button>}
        columns={[{ key: 'name', label: 'Tier', render: (t) => <Badge style={{ background: t.color, color: '#fff' }}>{t.icon} {t.name}</Badge> }, { key: 'range', label: 'คะแนน', render: (t) => `${int(t.min_points)}–${t.max_points != null ? int(t.max_points) : 'ขึ้นไป'}` }, { key: 'discount_pct', label: 'ส่วนลด', render: (t) => (t.discount_pct ? `${t.discount_pct}%` : '-') }, { key: 'point_multiplier', label: 'คะแนน', render: (t) => `x${t.point_multiplier}` }, { key: 'benefits', label: 'สิทธิประโยชน์' }, { key: 'member_count', label: 'สมาชิก', num: true }]} />
      {edit && (
        <Modal title={edit.id ? `Tier: ${edit.name}` : 'เพิ่ม Tier'} size="wide" onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/tiers/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); }}>ลบ</Button>}<Button variant="primary" onClick={save} disabled={!edit.name}>บันทึก</Button></>}>
          <div className="col">
            <div className="grid-3">
              <Input label="ชื่อ Tier" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
              <Input label="Minimum Point" type="number" value={edit.min_points} onValue={(v) => setEdit({ ...edit, min_points: v })} />
              <Input label="Maximum Point" type="number" value={edit.max_points ?? ''} onValue={(v) => setEdit({ ...edit, max_points: v })} hint="ว่าง = ไม่จำกัด" />
              <Input label="สีประจำ Tier" type="color" value={edit.color} onValue={(v) => setEdit({ ...edit, color: v })} />
              <Input label="Icon (emoji)" value={edit.icon || ''} onValue={(v) => setEdit({ ...edit, icon: v })} />
              <Input label="รูป Badge (URL)" value={edit.badge_url || ''} onValue={(v) => setEdit({ ...edit, badge_url: v })} />
              <Input label="ส่วนลดพิเศษ %" type="number" value={edit.discount_pct} onValue={(v) => setEdit({ ...edit, discount_pct: v })} />
              <Input label="คะแนนพิเศษ (ตัวคูณ)" type="number" step="0.1" value={edit.point_multiplier} onValue={(v) => setEdit({ ...edit, point_multiplier: v })} />
              <Select label="Birthday Reward" value={edit.birthday_reward_id ?? ''} onValue={(v) => setEdit({ ...edit, birthday_reward_id: v })} placeholder="— ไม่มี —" options={(rewards.data || []).map((r) => ({ value: r.id, label: r.name }))} />
            </div>
            <TextArea label="รายละเอียดสิทธิประโยชน์" value={edit.benefits || ''} onValue={(v) => setEdit({ ...edit, benefits: v })} />
            <div className="row between"><b>เงื่อนไขเพิ่มเติม (ต้องครบทุกข้อ)</b><Button size="sm" icon="plus" onClick={() => setEdit({ ...edit, rules: [...(edit.rules || []), { type: 'total_spend', value: 0 }] })}>เพิ่มเงื่อนไข</Button></div>
            {(edit.rules || []).map((r, i) => (
              <div key={i} className="row">
                <Select value={r.type} onValue={(v) => setEdit({ ...edit, rules: edit.rules.map((x, k) => (k === i ? { ...x, type: v } : x)) })} options={Object.entries(RULE).map(([value, label]) => ({ value, label }))} />
                <Input type="number" value={r.value} onValue={(v) => setEdit({ ...edit, rules: edit.rules.map((x, k) => (k === i ? { ...x, value: v } : x)) })} style={{ maxWidth: 140 }} />
                {r.type === 'period_spend' && <Input type="number" placeholder="ภายในกี่วัน" value={r.days || ''} onValue={(v) => setEdit({ ...edit, rules: edit.rules.map((x, k) => (k === i ? { ...x, days: v } : x)) })} style={{ maxWidth: 120 }} />}
                <Button size="sm" variant="ghost" icon="trash" onClick={() => setEdit({ ...edit, rules: edit.rules.filter((_, k) => k !== i) })} />
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

const RTYPE = { discount_amount: 'ส่วนลด (บาท)', discount_pct: 'ส่วนลด (%)', free_product: 'สินค้าฟรี' };
function Rewards() {
  const list = useAsync(() => api('/rewards'));
  const refs = useAsync(async () => ({ products: await api('/products'), tiers: await api('/tiers'), branches: await api('/branches') }));
  const [edit, setEdit] = useState(null);
  const save = async () => {
    const e = edit;
    const b = { name: e.name, description: e.description || null, imageUrl: e.image_url || null, type: e.type, pointsRequired: Number(e.points_required) || 0, discountValue: Number(e.discount_value) || 0, maxDiscount: e.max_discount ? Number(e.max_discount) : null, productId: e.product_id ? Number(e.product_id) : null, totalQuota: e.total_quota === '' || e.total_quota == null ? null : Number(e.total_quota), perMemberLimit: e.per_member_limit === '' || e.per_member_limit == null ? null : Number(e.per_member_limit), startAt: e.start_at || null, endAt: e.end_at || null, codeValidDays: Number(e.code_valid_days) || 30, branchIds: e.branch_ids || [], tierIds: e.tier_ids || [], productIds: e.product_ids || [], minSpend: Number(e.min_spend) || 0, combinable: e.combinable !== false, active: e.active !== false, hidden: !!e.hidden, isBirthday: !!e.is_birthday };
    try { if (e.id) await api(`/rewards/${e.id}`, { method: 'PUT', body: b }); else await api('/rewards', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (err) { toast(err.message, 'error'); }
  };
  const ids = (k) => (edit?.[k] || []).map(Number);
  const toggleId = (k, id, on) => setEdit({ ...edit, [k]: on ? [...ids(k), id] : ids(k).filter((x) => x !== id) });
  return (
    <div className="col">
      <DataTable rows={list.data || []} onRow={(r) => setEdit({ ...r })} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', type: 'discount_amount', points_required: 50, discount_value: 20, code_valid_days: 30, active: true, combinable: true, branch_ids: [], tier_ids: [], product_ids: [] })}>สร้าง Reward</Button>}
        columns={[{ key: 'img', label: '', render: (r) => (r.image_url ? <img src={r.image_url} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} /> : null) }, { key: 'name', label: 'Reward', render: (r) => <b>{r.name}</b> }, { key: 'type', label: 'ประเภท', render: (r) => RTYPE[r.type] }, { key: 'points_required', label: 'แต้มที่ใช้', num: true }, { key: 'used', label: 'ใช้ไป/สิทธิ์', render: (r) => `${r.used_count}/${r.total_quota ?? '∞'}` }, { key: 'end_at', label: 'หมดอายุ', render: (r) => r.end_at || '-' }, { key: 'active', label: 'สถานะ', render: (r) => <Badge tone={r.active ? 'success' : ''}>{r.active ? 'เปิด' : 'ปิด'}</Badge> }]} />
      {edit && refs.data && (
        <Modal title={edit.id ? `Reward: ${edit.name}` : 'สร้าง Reward'} size="xwide" onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/rewards/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); }}>ปิด/ลบ</Button>}<Button variant="primary" onClick={save} disabled={!edit.name}>บันทึก</Button></>}>
          <div className="col">
            <div className="grid-3">
              <Input label="ชื่อ Reward" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
              <Select label="ประเภท" value={edit.type} onValue={(v) => setEdit({ ...edit, type: v })} options={Object.entries(RTYPE).map(([value, label]) => ({ value, label }))} />
              <Input label="จำนวนแต้มที่ใช้" type="number" value={edit.points_required} onValue={(v) => setEdit({ ...edit, points_required: v })} />
              {edit.type !== 'free_product' && <Input label={edit.type === 'discount_pct' ? 'ส่วนลด %' : 'ส่วนลด (บาท)'} type="number" value={edit.discount_value} onValue={(v) => setEdit({ ...edit, discount_value: v })} />}
              {edit.type === 'discount_pct' && <Input label="ส่วนลดสูงสุด (บาท)" type="number" value={edit.max_discount ?? ''} onValue={(v) => setEdit({ ...edit, max_discount: v })} />}
              {edit.type === 'free_product' && <Select label="สินค้าฟรี" value={edit.product_id ?? ''} onValue={(v) => setEdit({ ...edit, product_id: v })} placeholder="— เลือก —" options={refs.data.products.map((p) => ({ value: p.id, label: p.name }))} />}
              <Input label="รูปภาพ (URL)" value={edit.image_url || ''} onValue={(v) => setEdit({ ...edit, image_url: v })} />
              <Input label="จำนวนสิทธิ์ทั้งหมด" type="number" value={edit.total_quota ?? ''} onValue={(v) => setEdit({ ...edit, total_quota: v })} hint="ว่าง = ไม่จำกัด" />
              <Input label="จำกัดจำนวนครั้งต่อคน" type="number" value={edit.per_member_limit ?? ''} onValue={(v) => setEdit({ ...edit, per_member_limit: v })} />
              <Input label="วันเริ่มต้น" type="date" value={(edit.start_at || '').slice(0, 10)} onValue={(v) => setEdit({ ...edit, start_at: v })} />
              <Input label="วันหมดอายุ" type="date" value={(edit.end_at || '').slice(0, 10)} onValue={(v) => setEdit({ ...edit, end_at: v ? `${v}T23:59:59+07:00` : '' })} />
              <Input label="รหัสใช้ได้กี่วันหลังแลก" type="number" value={edit.code_valid_days} onValue={(v) => setEdit({ ...edit, code_valid_days: v })} />
              <Input label="Minimum Spending" type="number" value={edit.min_spend || 0} onValue={(v) => setEdit({ ...edit, min_spend: v })} />
            </div>
            <TextArea label="รายละเอียด" value={edit.description || ''} onValue={(v) => setEdit({ ...edit, description: v })} />
            <div className="grid-3">
              <Toggle label="เปิดใช้งาน" checked={edit.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} />
              <Toggle label="ใช้ร่วมกับโปรโมชั่นอื่นได้" checked={edit.combinable !== false} onChange={(v) => setEdit({ ...edit, combinable: v })} />
              <Toggle label="Reward วันเกิด (ไม่แสดงในรายการแลก)" checked={!!edit.is_birthday} onChange={(v) => setEdit({ ...edit, is_birthday: v })} />
            </div>
            <div className="grid-2">
              <div className="card pad"><b>จำกัด Tier</b> <span className="xs muted">(ไม่เลือก = ทุก Tier)</span><div className="row wrap">{refs.data.tiers.map((t) => <Check key={t.id} label={t.name} checked={ids('tier_ids').includes(t.id)} onChange={(on) => toggleId('tier_ids', t.id, on)} />)}</div></div>
              <div className="card pad"><b>ใช้ได้ที่สาขา</b> <span className="xs muted">(ไม่เลือก = ทุกสาขา)</span><div className="row wrap">{refs.data.branches.map((b) => <Check key={b.id} label={b.name} checked={ids('branch_ids').includes(b.id)} onChange={(on) => toggleId('branch_ids', b.id, on)} />)}</div></div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Birthday() {
  const list = useAsync(() => api('/birthday-campaigns'));
  const rewards = useAsync(() => api('/rewards'));
  const tiers = useAsync(() => api('/tiers'));
  const eligible = useAsync(() => api('/birthday-campaigns/eligible'));
  const [edit, setEdit] = useState(null);
  const W = { day: 'เฉพาะวันเกิด', '3days': '3 วันก่อนและหลังวันเกิด', '7days': '7 วันก่อนและหลังวันเกิด', month: 'ตลอดเดือนเกิด' };
  const save = async () => {
    const b = { name: edit.name, message: edit.message || null, imageUrl: edit.image_url || null, windowType: edit.window_type, benefit: edit.benefit, points: Number(edit.points) || 0, rewardId: edit.reward_id ? Number(edit.reward_id) : null, tierIds: (edit.tier_ids || []).map(Number), active: edit.active !== false };
    try { if (edit.id) await api(`/birthday-campaigns/${edit.id}`, { method: 'PUT', body: b }); else await api('/birthday-campaigns', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="col gap-l">
      <DataTable rows={list.data || []} search={false} onRow={(c) => setEdit({ ...c })} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: 'สุขสันต์วันเกิด 🎂', message: 'รับฟรีเครื่องดื่ม 1 แก้ว', window_type: 'month', benefit: 'reward', points: 0, tier_ids: [], active: true })}>สร้าง Birthday Campaign</Button>}
        columns={[{ key: 'name', label: 'Campaign', render: (c) => <b>{c.name}</b> }, { key: 'window_type', label: 'ช่วงเวลา', render: (c) => W[c.window_type] }, { key: 'benefit', label: 'สิทธิ์', render: (c) => (c.benefit === 'points' ? `${c.points} คะแนน` : c.reward_name) }, { key: 'claims', label: 'รับสิทธิ์แล้ว', num: true }, { key: 'active', label: 'สถานะ', render: (c) => <Badge tone={c.active ? 'success' : ''}>{c.active ? 'เปิด' : 'ปิด'}</Badge> }]} />
      <div className="card"><div className="card-h"><b>สมาชิกที่อยู่ในช่วงวันเกิดตอนนี้</b></div><div className="card-b"><DataTable rows={eligible.data || []} search={false} columns={[{ key: 'name', label: 'ชื่อ' }, { key: 'phone', label: 'เบอร์' }, { key: 'birthday', label: 'วันเกิด' }, { key: 'campaign', label: 'Campaign' }]} /></div></div>
      {edit && (
        <Modal title="Birthday Campaign" onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/birthday-campaigns/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); }}>ปิด</Button>}<Button variant="primary" onClick={save}>บันทึก</Button></>}>
          <div className="col">
            <Input label="ชื่อ" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            <TextArea label="ข้อความ" value={edit.message || ''} onValue={(v) => setEdit({ ...edit, message: v })} />
            <Input label="รูป (URL)" value={edit.image_url || ''} onValue={(v) => setEdit({ ...edit, image_url: v })} />
            <Select label="ให้สิทธิ์ในช่วง" value={edit.window_type} onValue={(v) => setEdit({ ...edit, window_type: v })} options={Object.entries(W).map(([value, label]) => ({ value, label }))} />
            <Seg value={edit.benefit} onChange={(v) => setEdit({ ...edit, benefit: v })} options={[{ value: 'reward', label: 'Reward / ส่วนลด / สินค้าฟรี / Coupon' }, { value: 'points', label: 'คะแนนพิเศษ' }]} />
            {edit.benefit === 'points' ? <Input label="คะแนน" type="number" value={edit.points} onValue={(v) => setEdit({ ...edit, points: v })} />
              : <Select label="Reward" value={edit.reward_id ?? ''} onValue={(v) => setEdit({ ...edit, reward_id: v })} placeholder="— เลือก Reward —" options={(rewards.data || []).map((r) => ({ value: r.id, label: r.name }))} hint="สร้าง Reward แบบ 'Reward วันเกิด' ในแท็บ Rewards" />}
            <div className="row wrap"><span className="label">เฉพาะ Tier:</span>{(tiers.data || []).map((t) => <Check key={t.id} label={t.name} checked={(edit.tier_ids || []).map(Number).includes(t.id)} onChange={(on) => setEdit({ ...edit, tier_ids: on ? [...(edit.tier_ids || []), t.id] : (edit.tier_ids || []).filter((x) => Number(x) !== t.id) })} />)}</div>
            <Toggle label="เปิดใช้งาน" checked={edit.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Points() {
  const [type, setType] = useState('');
  const list = useAsync(() => api(`/point-transactions${type ? `?type=${type}` : ''}`), [type]);
  return (
    <div className="col">
      <Seg value={type} onChange={setType} options={[{ value: '', label: 'ทั้งหมด' }, ...Object.keys(POINT_TX_TYPES).map((k) => ({ value: k, label: k }))]} />
      <DataTable rows={list.data || []} toolbar={<Button icon="download" onClick={() => download('/reports/point?format=xlsx&from=2000-01-01&to=2100-01-01')}>Export</Button>}
        columns={[{ key: 'created_at', label: 'เวลา', render: (p) => fmtDateTime(p.created_at) }, { key: 'type', label: 'ประเภท', render: (p) => <Badge tone={p.points > 0 ? 'success' : 'danger'}>{p.type}</Badge> }, { key: 'member_name', label: 'สมาชิก', render: (p) => `${p.member_name} (${p.phone})` }, { key: 'points', label: 'แต้ม', num: true, render: (p) => `${p.points > 0 ? '+' : ''}${p.points}` }, { key: 'balance', label: 'คงเหลือ', num: true }, { key: 'order_no', label: 'Order' }, { key: 'staff_name', label: 'พนักงาน', render: (p) => (p.employee_code ? `${p.employee_code} ${p.staff_name}` : '-') }, { key: 'branch_name', label: 'สาขา' }, { key: 'reason', label: 'เหตุผล' }, { key: 'txn_id', label: 'Transaction ID', render: (p) => <span className="xs muted">{p.txn_id}</span> }]} />
    </div>
  );
}

function Redemptions() {
  const list = useAsync(() => api('/redemptions'));
  const can = useApp((s) => s.can);
  return (
    <DataTable rows={list.data || []}
      columns={[{ key: 'created_at', label: 'แลกเมื่อ', render: (r) => fmtDateTime(r.created_at) }, { key: 'reward_name', label: 'Reward' }, { key: 'member_name', label: 'Member', render: (r) => `${r.member_name} (${r.phone})` }, { key: 'code', label: 'Code', render: (r) => <b className="num">{r.code}</b> }, { key: 'status', label: 'สถานะ', render: (r) => <Badge tone={r.status === 'active' ? 'success' : r.status === 'used' ? 'info' : 'danger'}>{r.status.toUpperCase()}</Badge> },
        { key: 'used_at', label: 'Used at', render: (r) => (r.used_at ? fmtDateTime(r.used_at) : '-') }, { key: 'used_by_name', label: 'Used by', render: (r) => (r.used_by_code ? `${r.used_by_code} ${r.used_by_name}` : '-') }, { key: 'device_name', label: 'POS' }, { key: 'branch_name', label: 'Branch' }, { key: 'order_no', label: 'Order' },
        { key: 'act', label: '', render: (r) => r.status === 'active' && can('member.rewards') && <Button size="sm" variant="ghost" onClick={async (e) => { e.stopPropagation(); const reason = window.prompt('เหตุผลการยกเลิก'); if (!reason) return; await api(`/redemptions/${r.id}/cancel`, { method: 'POST', body: { reason, refundPoints: window.confirm('คืนแต้มให้สมาชิกด้วยหรือไม่?') } }); list.reload(); }}>ยกเลิก</Button> }]} />
  );
}

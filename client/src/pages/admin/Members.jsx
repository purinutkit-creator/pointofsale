// Member management: search, profile, adjust points (audited), timeline, tier override, member PIN
import { useState } from 'react';
import { api, uid, download } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Modal, Input, Select, Toggle, DataTable, useAsync, Badge, Seg, Spinner, TextArea } from '../../components/ui.jsx';
import { money, int, fmtDate, fmtDateTime, fmtThaiShort } from '../../lib/util.js';
import { POINT_TX_TYPES } from '@shared/points.js';

const GENDER = { male: 'ชาย', female: 'หญิง', other: 'อื่นๆ', unspecified: 'ไม่ระบุ' };

export default function Members() {
  const can = useApp((s) => s.can);
  const [q, setQ] = useState('');
  const list = useAsync(() => api(`/members?q=${encodeURIComponent(q)}&limit=200`), [q]);
  const [open, setOpen] = useState(null);
  const [create, setCreate] = useState(null);
  const register = async () => {
    try { const m = await api('/members', { method: 'POST', body: { ...create, birthday: create.birthday || null, email: create.email || null, pin: create.pin || null, acceptTerms: true } }); setCreate(null); list.reload(); setOpen(m.id); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Page title="สมาชิก" actions={<>
      {can('report.export') && <Button icon="download" onClick={() => download('/reports/member?format=xlsx&from=2000-01-01&to=2100-01-01')}>Export</Button>}
      {can('member.create') && <Button variant="primary" icon="plus" onClick={() => setCreate({ phone: '', name: '', gender: 'unspecified', birthday: '', email: '', pin: '' })}>สมัครสมาชิก</Button>}
    </>}>
      <div className="col">
        <Input placeholder="ค้นหา เบอร์โทร / Member ID / ชื่อ เช่น 0812345678" value={q} onValue={setQ} size="lg" />
        <DataTable rows={list.data || []} search={false} onRow={(m) => setOpen(m.id)}
          columns={[
            { key: 'member_code', label: 'Member ID' }, { key: 'name', label: 'ชื่อ', render: (m) => <b>{m.name}</b> }, { key: 'phone', label: 'เบอร์โทร' },
            { key: 'tier_name', label: 'Tier', render: (m) => <Badge style={{ background: m.tier_color, color: '#fff' }}>{m.tier_name || '-'}</Badge> },
            { key: 'points', label: 'แต้ม', num: true, render: (m) => int(m.points) }, { key: 'total_spend', label: 'ยอดซื้อสะสม', num: true, render: (m) => money(m.total_spend) },
            { key: 'visit_count', label: 'ครั้ง', num: true }, { key: 'last_visit_at', label: 'มาล่าสุด', render: (m) => (m.last_visit_at ? fmtDate(m.last_visit_at) : '-') },
          ]} />
      </div>
      {open && <MemberProfile id={open} onClose={() => { setOpen(null); list.reload(); }} />}
      {create && (
        <Modal title="สมัครสมาชิก" onClose={() => setCreate(null)} footer={<Button variant="primary" onClick={register} disabled={!create.phone || !create.name}>สมัคร</Button>}>
          <div className="grid-2">
            <Input label="เบอร์โทร *" value={create.phone} onValue={(v) => setCreate({ ...create, phone: v })} />
            <Input label="ชื่อ *" value={create.name} onValue={(v) => setCreate({ ...create, name: v })} />
            <Select label="เพศ" value={create.gender} onValue={(v) => setCreate({ ...create, gender: v })} options={Object.entries(GENDER).map(([value, label]) => ({ value, label }))} />
            <Input label="วันเกิด" type="date" value={create.birthday} onValue={(v) => setCreate({ ...create, birthday: v })} />
            <Input label="อีเมล" value={create.email} onValue={(v) => setCreate({ ...create, email: v })} />
            <Input label="PIN สำหรับเข้าหน้าสมาชิก (4–6 หลัก)" value={create.pin} onValue={(v) => setCreate({ ...create, pin: v })} inputMode="numeric" />
          </div>
        </Modal>
      )}
    </Page>
  );
}

export function MemberProfile({ id, onClose }) {
  const can = useApp((s) => s.can);
  const m = useAsync(() => api(`/members/${id}`), [id]);
  const tl = useAsync(() => api(`/members/${id}/timeline`), [id]);
  const tiers = useAsync(() => api('/tiers'));
  const [tab, setTab] = useState('timeline');
  const [adj, setAdj] = useState(null);
  const [edit, setEdit] = useState(null);
  if (!m.data) return <Modal title="สมาชิก" onClose={onClose}><div className="center"><Spinner /></div></Modal>;
  const x = m.data;
  const doAdjust = async () => {
    try { await api(`/members/${id}/points`, { method: 'POST', body: { action: adj.action, points: Number(adj.points), reason: adj.reason, txnId: adj.txnId } }); toast('ปรับแต้มเรียบร้อย', 'success'); setAdj(null); m.reload(); tl.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const saveEdit = async () => {
    try { await api(`/members/${id}`, { method: 'PUT', body: { phone: edit.phone, name: edit.name, gender: edit.gender, birthday: edit.birthday || null, email: edit.email || null, lineUserId: edit.lineUserId || null, note: edit.note || null, status: edit.status, pin: edit.pin || null, notifyChannels: edit.notifyChannels } }); setEdit(null); m.reload(); toast('บันทึกแล้ว', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  const timeline = [
    ...(tl.data?.points || []).map((p) => ({ at: p.created_at, kind: 'point', p })),
    ...(tl.data?.redemptions || []).filter((r) => r.status === 'used').map((r) => ({ at: r.used_at, kind: 'used', r })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return (
    <Modal title={`${x.name} · ${x.memberCode}`} size="xwide" onClose={onClose}
      footer={<>{can('member.edit') && <Button icon="edit" onClick={() => setEdit({ phone: x.phone, name: x.name, gender: x.gender || 'unspecified', birthday: x.birthday || '', email: x.email || '', lineUserId: x.lineUserId || '', note: x.note || '', status: x.status, pin: '', notifyChannels: x.notifyChannels })}>แก้ไขข้อมูล</Button>}
        {can('member.adjust_points') && <Button variant="primary" icon="star" onClick={() => setAdj({ action: 'add', points: '', reason: '', txnId: uid() })}>ปรับแต้ม (Adjust Points)</Button>}</>}>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 340px) 1fr', alignItems: 'start' }}>
        <div className="card pad col gap-s">
          <Badge style={{ background: x.tier?.color, color: '#fff', alignSelf: 'flex-start' }}>{x.tier?.name || 'Member'}</Badge>
          {[['เบอร์โทร', x.phone], ['เพศ', GENDER[x.gender] || '-'], ['วันเกิด', x.birthday ? fmtDate(x.birthday) : '-'], ['อีเมล', x.email || '-'], ['Member Since', fmtDate(x.createdAt)],
            ['Points', int(x.points)], ['Lifetime Points', int(x.lifetimePoints)], ['Lifetime Spending', `${money(x.totalSpend)} บาท`], ['จำนวน Orders', int(x.orderCount)], ['Average Order', `${money(x.avgOrder)} บาท`],
            ['Last Visit', x.lastVisitAt ? fmtDate(x.lastVisitAt) : '-'], ['Point Debt', x.pointDebt ? int(x.pointDebt) : '-'], ['PIN หน้าสมาชิก', x.hasPin ? 'ตั้งแล้ว' : 'ยังไม่ตั้ง']].map(([k, v]) => (
            <div key={k} className="row between"><span className="muted small">{k}</span><b>{v}</b></div>
          ))}
          {x.nextTier && <div className="xs muted">อีก {int(x.nextTier.need)} คะแนนเพื่อเป็น {x.nextTier.name}</div>}
          {can('member.edit_tier') && tiers.data && (
            <div className="col mt">
              <Select label="กำหนด Tier เอง" value={x.tierLocked ? x.tier?.id : ''} placeholder="อัตโนมัติตามเงื่อนไข" options={tiers.data.map((t) => ({ value: t.id, label: t.name }))}
                onValue={async (v) => { await api(`/members/${id}/tier`, { method: 'POST', body: { tierId: v ? Number(v) : null, locked: !!v } }); m.reload(); }} />
            </div>
          )}
        </div>
        <div className="col">
          <Seg value={tab} onChange={setTab} options={[{ value: 'timeline', label: 'Timeline' }, { value: 'orders', label: 'Orders' }, { value: 'rewards', label: 'Rewards' }]} />
          {tab === 'timeline' && (
            <div className="col gap-s">
              {timeline.map((e, i) => (
                <div key={i} className="row card pad" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 60 }} className="bold">{fmtThaiShort(e.at)}</div>
                  {e.kind === 'point' ? (
                    <div className="grow">
                      <div><b>{POINT_TX_TYPES[e.p.type] || e.p.type}</b>{e.p.order_no ? ` · Order #${e.p.order_no}` : ''}{e.p.amount ? ` · ${money(e.p.amount)} บาท` : ''}</div>
                      <div className="small muted">{e.p.reason}{e.p.staff_name ? ` · โดย ${e.p.employee_code || ''} ${e.p.staff_name}` : ''}{e.p.branch_name ? ` · ${e.p.branch_name}` : ''} · {fmtDateTime(e.p.created_at)}</div>
                      <div className="xs muted">TXN {e.p.txn_id} · คงเหลือ {int(e.p.balance)}</div>
                    </div>
                  ) : (
                    <div className="grow"><b>Redeemed</b> {e.r.reward_name} · code {e.r.code}<div className="small muted">ใช้ที่ {e.r.branch_name || '-'} · {e.r.device_name || ''} · โดย {e.r.used_by_name || '-'}</div></div>
                  )}
                  {e.kind === 'point' && <b style={{ color: e.p.points > 0 ? 'var(--success)' : 'var(--danger)', fontSize: 18 }}>{e.p.points > 0 ? '+' : ''}{e.p.points} Points</b>}
                </div>
              ))}
              {!timeline.length && <div className="empty">ยังไม่มีประวัติ</div>}
            </div>
          )}
          {tab === 'orders' && <DataTable rows={tl.data?.orders || []} search={false} columns={[{ key: 'paid_at', label: 'วันที่', render: (o) => fmtDateTime(o.paid_at) }, { key: 'order_no', label: 'Order', render: (o) => `#${o.order_no}` }, { key: 'branch_name', label: 'สาขา' }, { key: 'total', label: 'ยอด', num: true, render: (o) => money(o.total) }, { key: 'points_earned', label: 'แต้ม', num: true, render: (o) => `+${o.points_earned || 0}` }, { key: 'status', label: 'สถานะ' }]} />}
          {tab === 'rewards' && <DataTable rows={tl.data?.redemptions || []} search={false} columns={[{ key: 'created_at', label: 'แลกเมื่อ', render: (r) => fmtDateTime(r.created_at) }, { key: 'reward_name', label: 'Reward' }, { key: 'code', label: 'Code' }, { key: 'points_used', label: 'แต้ม', num: true }, { key: 'status', label: 'สถานะ', render: (r) => <Badge tone={r.status === 'active' ? 'success' : r.status === 'used' ? 'info' : ''}>{r.status.toUpperCase()}</Badge> }, { key: 'used_at', label: 'ใช้เมื่อ', render: (r) => (r.used_at ? `${fmtDateTime(r.used_at)} ${r.branch_name || ''}` : '-') }]} />}
        </div>
      </div>
      {adj && (
        <Modal title="Adjust Points" size="narrow" onClose={() => setAdj(null)} footer={<Button variant="primary" onClick={doAdjust} disabled={!(Number(adj.points) > 0) || !adj.reason}>Confirm</Button>}>
          <div className="col">
            <div className="row between"><span>Member</span><b>{x.name}</b></div>
            <div className="row between"><span>Current</span><b>{int(x.points)}</b></div>
            <Seg size="lg" value={adj.action} onChange={(v) => setAdj({ ...adj, action: v })} options={[{ value: 'add', label: '+ Add Points' }, { value: 'remove', label: '− Remove Points' }]} />
            <Input label="Points" type="number" value={adj.points} onValue={(v) => setAdj({ ...adj, points: v })} size="lg" />
            <TextArea label="Reason *" value={adj.reason} onValue={(v) => setAdj({ ...adj, reason: v })} placeholder="เช่น ชดเชยคะแนนจาก Order #1234" />
            <div className="row between"><span>หลังทำรายการ</span><b>{int(x.points + (adj.action === 'add' ? 1 : -1) * (Number(adj.points) || 0))}</b></div>
          </div>
        </Modal>
      )}
      {edit && (
        <Modal title="แก้ไขข้อมูลสมาชิก" onClose={() => setEdit(null)} footer={<Button variant="primary" onClick={saveEdit}>บันทึก</Button>}>
          <div className="grid-2">
            <Input label="เบอร์โทร" value={edit.phone} onValue={(v) => setEdit({ ...edit, phone: v })} />
            <Input label="ชื่อ" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            <Select label="เพศ" value={edit.gender} onValue={(v) => setEdit({ ...edit, gender: v })} options={Object.entries(GENDER).map(([value, label]) => ({ value, label }))} />
            <Input label="วันเกิด" type="date" value={edit.birthday} onValue={(v) => setEdit({ ...edit, birthday: v })} />
            <Input label="อีเมล" value={edit.email} onValue={(v) => setEdit({ ...edit, email: v })} />
            <Input label="LINE User ID" value={edit.lineUserId} onValue={(v) => setEdit({ ...edit, lineUserId: v })} />
            <Input label="ตั้ง/Reset PIN สมาชิก" value={edit.pin} onValue={(v) => setEdit({ ...edit, pin: v })} inputMode="numeric" placeholder="เว้นว่าง = ไม่เปลี่ยน" />
            <Select label="สถานะ" value={edit.status} onValue={(v) => setEdit({ ...edit, status: v })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
          </div>
          <div className="row wrap mt">{['inapp', 'email', 'sms', 'line'].map((c) => <Toggle key={c} label={`แจ้งเตือน ${c.toUpperCase()}`} checked={edit.notifyChannels.includes(c)} onChange={(on) => setEdit({ ...edit, notifyChannels: on ? [...edit.notifyChannels, c] : edit.notifyChannels.filter((x2) => x2 !== c) })} />)}</div>
          <TextArea label="หมายเหตุ" value={edit.note} onValue={(v) => setEdit({ ...edit, note: v })} />
        </Modal>
      )}
    </Modal>
  );
}

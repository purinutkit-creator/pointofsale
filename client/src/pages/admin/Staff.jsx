// Staff management + "สิ่งที่พนักงานนี้ทำได้" (per-staff permission toggles) + Roles
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Modal, Input, Select, Toggle, TextArea, DataTable, useAsync, Badge, Seg, useDialog, Check } from '../../components/ui.jsx';
import { fmtDateTime } from '../../lib/util.js';

export default function Staff() {
  const [tab, setTab] = useState('staff');
  return (
    <Page title="พนักงาน & สิทธิ์" tabs={[{ value: 'staff', label: 'พนักงาน' }, { value: 'roles', label: 'Role' }]} tab={tab} onTab={setTab}>
      {tab === 'staff' ? <StaffList /> : <Roles />}
    </Page>
  );
}

function StaffList() {
  const can = useApp((s) => s.can);
  const list = useAsync(() => api('/staff'));
  const refs = useAsync(async () => ({ roles: await api('/roles'), branches: await api('/branches'), catalog: await api('/permissions/catalog') }));
  const [edit, setEdit] = useState(null);
  const open = async (s) => {
    if (!s) {
      const settings = useApp.getState().settings?.pos || {};
      const code = settings.employeeCodeMode === 'manual' ? '' : (await api('/staff/next-code')).code;
      return setEdit({ employeeCode: code, codeMode: settings.employeeCodeMode || 'auto', firstName: '', lastName: '', nickname: '', roleId: refs.data.roles.find((r) => r.code === 'cashier')?.id, branchId: useApp.getState().staff.branchId, status: 'active', maxDiscountPct: 0, pin: '', overrides: [], startDate: new Date().toISOString().slice(0, 10) });
    }
    const d = await api(`/staff/${s.id}`);
    setEdit({ id: d.id, employeeCode: d.employee_code, codeMode: 'manual', firstName: d.first_name, lastName: d.last_name || '', nickname: d.nickname || '', photoUrl: d.photo_url || '', roleId: d.role_id, branchId: d.branch_id, allBranches: !!d.all_branches, phone: d.phone || '', email: d.email || '', startDate: d.start_date || '', status: d.status, maxDiscountPct: d.max_discount_pct, note: d.note || '', pin: '', overrides: d.overrides.map((o) => ({ permission: o.permission, allowed: !!o.allowed })) });
  };
  return (
    <div className="col">
      <DataTable rows={list.data || []} onRow={(s) => refs.data && open(s)} toolbar={can('staff.create') && <Button variant="primary" icon="plus" onClick={() => refs.data && open(null)}>เพิ่มพนักงาน</Button>}
        columns={[
          { key: 'photo', label: '', width: 50, render: (s) => (s.photo_url ? <img src={s.photo_url} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} /> : null) },
          { key: 'employee_code', label: 'รหัส', render: (s) => <b>{s.employee_code}</b> },
          { key: 'name', label: 'ชื่อ', text: (s) => `${s.first_name} ${s.last_name || ''} ${s.nickname || ''}`, render: (s) => <>{s.first_name} {s.last_name}{s.nickname ? <span className="muted"> ({s.nickname})</span> : ''}</> },
          { key: 'role_name', label: 'Role' },
          { key: 'branch_name', label: 'สาขา', render: (s) => (s.all_branches ? 'ทุกสาขา' : s.branch_name) },
          { key: 'phone', label: 'โทร' },
          { key: 'last_login_at', label: 'เข้าใช้ล่าสุด', render: (s) => (s.last_login_at ? fmtDateTime(s.last_login_at) : '-') },
          { key: 'status', label: 'สถานะ', render: (s) => <Badge tone={s.status === 'active' ? 'success' : ''}>{s.status === 'active' ? 'ใช้งาน' : 'ปิดใช้งาน'}</Badge> },
        ]} />
      {edit && refs.data && <StaffForm value={edit} refs={refs.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

function StaffForm({ value, refs, onClose, onSaved }) {
  const can = useApp((s) => s.can);
  const me = useApp((s) => s.staff);
  const dialog = useDialog();
  const [f, setF] = useState(value);
  const [codeOk, setCodeOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const role = refs.roles.find((r) => r.id === Number(f.roleId));
  const rolePerms = new Set(role?.permissions || []);
  const ov = Object.fromEntries(f.overrides.map((o) => [o.permission, o.allowed]));
  const effective = (p) => (rolePerms.has('*') ? true : p in ov ? ov[p] : rolePerms.has(p));
  const togglePerm = (p, on) => {
    const def = rolePerms.has('*') || rolePerms.has(p);
    const rest = f.overrides.filter((o) => o.permission !== p);
    set('overrides')(on === def ? rest : [...rest, { permission: p, allowed: on }]);
  };
  useEffect(() => {
    if (!f.employeeCode) return undefined;
    const t = setTimeout(() => api(`/staff/check-code?code=${encodeURIComponent(f.employeeCode)}&excludeId=${f.id || 0}`).then((r) => setCodeOk(r.available)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [f.employeeCode, f.id]);
  const save = async () => {
    if (!f.id && !/^\d{4,6}$/.test(f.pin)) return toast('PIN ต้องเป็นตัวเลข 4–6 หลัก', 'error');
    setBusy(true);
    try {
      const body = { employeeCode: f.employeeCode, firstName: f.firstName, lastName: f.lastName || null, nickname: f.nickname || null, photoUrl: f.photoUrl || null, roleId: Number(f.roleId), branchId: f.branchId ? Number(f.branchId) : null, allBranches: !!f.allBranches, phone: f.phone || null, email: f.email || null, startDate: f.startDate || null, status: f.status, maxDiscountPct: Number(f.maxDiscountPct) || 0, note: f.note || null, overrides: f.overrides, ...(f.pin ? { pin: f.pin } : {}) };
      if (f.id) await api(`/staff/${f.id}`, { method: 'PUT', body }); else await api('/staff', { method: 'POST', body });
      toast('บันทึกพนักงานแล้ว', 'success'); onSaved();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const softDelete = async () => { if (await dialog.confirm({ message: `ลบพนักงาน ${f.firstName} (Soft Delete)?`, danger: true })) { try { await api(`/staff/${f.id}`, { method: 'DELETE' }); onSaved(); } catch (e) { toast(e.message, 'error'); } } };
  return (
    <Modal title={f.id ? `แก้ไขพนักงาน ${f.employeeCode}` : 'เพิ่มพนักงาน'} size="xwide" onClose={onClose}
      footer={<>{f.id && can('staff.disable') && f.id !== me.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={softDelete}>ลบ (Soft Delete)</Button>}<Button onClick={onClose}>ยกเลิก</Button><Button variant="primary" loading={busy} disabled={!f.firstName || !f.employeeCode || !codeOk} onClick={save}>บันทึก</Button></>}>
      <div className="col gap-l">
        <div className="grid-4">
          <Input label="ชื่อ *" value={f.firstName} onValue={set('firstName')} />
          <Input label="นามสกุล" value={f.lastName} onValue={set('lastName')} />
          <Input label="ชื่อเล่น" value={f.nickname} onValue={set('nickname')} />
          <Input label="รูป (URL)" value={f.photoUrl || ''} onValue={set('photoUrl')} />
          <div className="field">
            <label>Employee Code *</label>
            {!f.id && <Seg value={f.codeMode} onChange={async (m) => { set('codeMode')(m); if (m === 'auto') set('employeeCode')((await api('/staff/next-code')).code); }} options={[{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }]} />}
            <input className="input" value={f.employeeCode} disabled={f.codeMode === 'auto' && !f.id} onChange={(e) => set('employeeCode')(e.target.value.toUpperCase())} placeholder="EMP001 / BKK-001" />
            {!codeOk && <div className="hint" style={{ color: 'var(--danger)' }}>รหัสนี้ถูกใช้แล้ว</div>}
          </div>
          <Input label={f.id ? 'Reset PIN (เว้นว่าง = ไม่เปลี่ยน)' : 'PIN 4–6 หลัก *'} type="password" inputMode="numeric" maxLength={6} value={f.pin} onValue={set('pin')} disabled={!!f.id && !can('staff.reset_pin')} />
          <Select label="Role" value={f.roleId} onValue={set('roleId')} options={refs.roles.filter((r) => r.code !== 'owner' || me.role.code === 'owner').map((r) => ({ value: r.id, label: r.name }))} disabled={!can('staff.edit')} />
          <Select label="สาขา" value={f.branchId ?? ''} onValue={set('branchId')} options={refs.branches.map((b) => ({ value: b.id, label: b.name }))} />
          <Input label="โทร" value={f.phone || ''} onValue={set('phone')} />
          <Input label="อีเมล" value={f.email || ''} onValue={set('email')} />
          <Input label="วันเริ่มงาน" type="date" value={f.startDate || ''} onValue={set('startDate')} />
          <Select label="สถานะ" value={f.status} onValue={set('status')} options={[{ value: 'active', label: 'ใช้งาน' }, { value: 'inactive', label: 'ปิดใช้งาน' }]} disabled={!can('staff.disable')} />
        </div>
        <div className="grid-2">
          <Toggle label="เข้าใช้ได้ทุกสาขา" checked={f.allBranches} onChange={set('allBranches')} />
          <Input label="ส่วนลดสูงสุดที่ให้ได้ (Maximum Discount %)" type="number" value={f.maxDiscountPct} onValue={set('maxDiscountPct')} />
        </div>
        <TextArea label="หมายเหตุ" value={f.note || ''} onValue={set('note')} rows={2} />
        <div className="card">
          <div className="card-h"><h3>สิ่งที่พนักงานนี้ทำได้</h3><span className="small muted">ค่าเริ่มต้นตาม Role "{role?.name}" · เปิด/ปิดรายคนได้</span></div>
          <div className="card-b">
            {rolePerms.has('*') ? <div className="muted">Owner มีสิทธิ์ทุกอย่าง</div> : (
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                {refs.catalog.groups.map((g) => (
                  <div key={g.key} className="card pad col gap-s">
                    <b>{g.label}</b>
                    {g.items.map(([p, label]) => (
                      <div key={p} className="row between" style={{ minHeight: 36 }}>
                        <span className="small">{label}{p in ov && <Badge tone="warning" style={{ marginLeft: 6 }}>กำหนดเอง</Badge>}</span>
                        <Toggle checked={effective(p)} disabled={!can('staff.permission')} onChange={(on) => togglePerm(p, on)} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Roles() {
  const list = useAsync(() => api('/roles'));
  const cat = useAsync(() => api('/permissions/catalog'));
  const can = useApp((s) => s.can);
  const [edit, setEdit] = useState(null);
  const save = async () => {
    try { const b = { name: edit.name, code: edit.code, level: Number(edit.level) || 10, permissions: edit.permissions }; if (edit.id) await api(`/roles/${edit.id}`, { method: 'PUT', body: b }); else await api('/roles', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="col">
      <DataTable rows={list.data || []} search={false} onRow={(r) => r.code !== 'owner' && setEdit({ ...r })} toolbar={can('staff.role') && <Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', code: '', level: 20, permissions: [] })}>สร้าง Role</Button>}
        columns={[{ key: 'name', label: 'Role', render: (r) => <b>{r.name}</b> }, { key: 'code', label: 'รหัส' }, { key: 'level', label: 'ระดับ', num: true }, { key: 'staff_count', label: 'พนักงาน', num: true }, { key: 'p', label: 'สิทธิ์', render: (r) => (r.permissions.includes('*') ? 'ทั้งหมด' : `${r.permissions.length} สิทธิ์`) }, { key: 'sys', label: '', render: (r) => (r.is_system ? <Badge>ระบบ</Badge> : '') }]} />
      {edit && cat.data && (
        <Modal title={edit.id ? `Role: ${edit.name}` : 'สร้าง Role'} size="xwide" onClose={() => setEdit(null)} footer={<>{edit.id && !edit.is_system && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { try { await api(`/roles/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); } }}>ลบ</Button>}<Button variant="primary" onClick={save} disabled={!can('staff.role')}>บันทึก</Button></>}>
          <div className="col">
            <div className="grid-3"><Input label="ชื่อ" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} /><Input label="รหัส (a-z_)" value={edit.code} disabled={!!edit.id} onValue={(v) => setEdit({ ...edit, code: v.toLowerCase().replace(/[^a-z0-9_]/g, '') })} /><Input label="ระดับ (1–99)" type="number" value={edit.level} disabled={!!edit.is_system} onValue={(v) => setEdit({ ...edit, level: v })} /></div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {cat.data.groups.map((g) => (
                <div key={g.key} className="card pad col gap-s"><b>{g.label}</b>
                  {g.items.map(([p, label]) => <Check key={p} label={label} checked={edit.permissions.includes(p)} onChange={(on) => setEdit({ ...edit, permissions: on ? [...edit.permissions, p] : edit.permissions.filter((x) => x !== p) })} />)}
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

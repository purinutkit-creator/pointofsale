import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../lib/api.js';
import { Button, Input, Select, Field, Icon } from '../components/ui.jsx';
import { toast, useApp } from '../lib/store.js';
import { DEVICE_HOME } from './Launcher.jsx';
import { cls } from '../lib/util.js';

const TYPES = [
  { value: 'pos', label: 'POS (เครื่องขาย)', icon: 'cash', desc: 'หน้าขาย รับชำระเงิน เชื่อมเครื่องพิมพ์ Bluetooth/USB' },
  { value: 'kds', label: 'KDS (จอครัว)', icon: 'chef', desc: 'แสดงรายการอาหารแยกตามสถานี' },
  { value: 'customer_display', label: 'Customer Display', icon: 'monitor', desc: 'จอฝั่งลูกค้า แสดงรายการและยอดชำระ' },
  { value: 'queue_display', label: 'Queue Display', icon: 'list', desc: 'จอเรียกคิว สำหรับทีวี' },
];

export default function DeviceSetup() {
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [cred, setCred] = useState({ employeeCode: '', pin: '' });
  const [opts, setOpts] = useState(null);
  const [f, setF] = useState({ type: 'pos', name: 'POS-01', code: 'POS-01', branchId: '', pairedPosId: '', stationId: '' });
  const [busy, setBusy] = useState(false);
  const verify = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const o = await api('/devices/options', { method: 'POST', body: cred });
      setOpts(o); setF((x) => ({ ...x, branchId: String(o.branches[0]?.id || '') })); setStep(2);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const register = async () => {
    setBusy(true);
    try {
      const r = await api('/devices/register', { method: 'POST', body: { ...cred, type: f.type, name: f.name, code: f.code, branchId: Number(f.branchId), pairedPosId: f.pairedPosId ? Number(f.pairedPosId) : null, stationId: f.stationId ? Number(f.stationId) : null } });
      auth.deviceToken = r.token;
      await useApp.getState().loadDevice();
      toast(`ลงทะเบียน ${f.name} สำเร็จ`, 'success');
      nav(['customer_display', 'queue_display'].includes(f.type) ? DEVICE_HOME[f.type] : '/login');
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const posList = opts?.posDevices.filter((d) => String(d.branch_id) === f.branchId) || [];
  return (
    <div className="fullcenter" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ maxWidth: 720, width: '100%' }}>
        <div className="card-h"><div className="row"><Button variant="ghost" icon="back" onClick={() => nav('/')} /><h2>ลงทะเบียนอุปกรณ์</h2></div></div>
        {step === 1 && (
          <form className="card-b col" onSubmit={verify}>
            <div className="muted">เข้าสู่ระบบด้วยพนักงานที่มีสิทธิ์ "อุปกรณ์ / POS Device" (เช่น Owner/Admin)</div>
            <Input label="รหัสพนักงาน" value={cred.employeeCode} onValue={(v) => setCred({ ...cred, employeeCode: v })} autoFocus required />
            <Input label="PIN" type="password" inputMode="numeric" value={cred.pin} onValue={(v) => setCred({ ...cred, pin: v })} required />
            <Button variant="primary" size="lg" loading={busy} type="submit">ถัดไป</Button>
          </form>
        )}
        {step === 2 && opts && (
          <div className="card-b col gap-l">
            <div className="grid-2">
              {TYPES.map((t) => (
                <button key={t.value} type="button" className={cls('card pad', f.type === t.value && 'on')} style={{ textAlign: 'left', cursor: 'pointer', borderColor: f.type === t.value ? 'var(--primary)' : undefined, boxShadow: f.type === t.value ? '0 0 0 3px var(--primary-50)' : undefined }}
                  onClick={() => setF({ ...f, type: t.value, name: t.value === 'pos' ? 'POS-01' : t.value === 'kds' ? 'KDS-01' : t.value === 'customer_display' ? 'DISPLAY-01' : 'QUEUE-01', code: t.value === 'pos' ? 'POS-01' : t.value === 'kds' ? 'KDS-01' : t.value === 'customer_display' ? 'DISPLAY-01' : 'QUEUE-01' })}>
                  <div className="row"><Icon name={t.icon} /><b>{t.label}</b></div>
                  <div className="small muted mt">{t.desc}</div>
                </button>
              ))}
            </div>
            <div className="grid-3">
              <Select label="สาขา" value={f.branchId} onValue={(v) => setF({ ...f, branchId: v })} options={opts.branches.map((b) => ({ value: String(b.id), label: b.name }))} />
              <Input label="ชื่ออุปกรณ์" value={f.name} onValue={(v) => setF({ ...f, name: v })} />
              <Input label="รหัสอุปกรณ์" value={f.code} onValue={(v) => setF({ ...f, code: v.toUpperCase() })} hint="ไม่ซ้ำในสาขา เช่น POS-01" />
            </div>
            {f.type === 'customer_display' && (
              <Field label="จับคู่กับเครื่อง POS" hint="จอลูกค้าจะแสดงตะกร้าของเครื่อง POS นี้แบบ Real-time">
                <Select value={f.pairedPosId} onValue={(v) => setF({ ...f, pairedPosId: v })} placeholder="— เลือก POS —" options={posList.map((d) => ({ value: String(d.id), label: `${d.name} (${d.code})` }))} />
              </Field>
            )}
            {f.type === 'kds' && <Select label="สถานีครัว (เว้นว่าง = ทุกสถานี)" value={f.stationId} onValue={(v) => setF({ ...f, stationId: v })} placeholder="ทุกสถานี" options={opts.stations.map((s) => ({ value: String(s.id), label: s.name }))} />}
            <Button variant="primary" size="xl" loading={busy} onClick={register} disabled={!f.name || !f.code || !f.branchId || (f.type === 'customer_display' && !f.pairedPosId)}>ลงทะเบียน</Button>
          </div>
        )}
      </div>
    </div>
  );
}

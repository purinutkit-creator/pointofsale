import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.js';
import { Button, Input, PinPad, Seg, Icon } from '../components/ui.jsx';
import { DEVICE_HOME } from './Launcher.jsx';
import { cls } from '../lib/util.js';

export default function Login() {
  const nav = useNavigate();
  const { device, settings } = useApp();
  const [mode, setMode] = useState('code');
  const [code, setCode] = useState('');
  const [picked, setPicked] = useState(null);
  const [staff, setStaff] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('id');

  useEffect(() => { if (!device) useApp.getState().loadDevice(); }, [device]);
  useEffect(() => {
    if (!device) return;
    api('/auth/staff-list').then(setStaff).catch(() => {});
    const lm = settings?.pos?.loginMode;
    if (lm === 'picker') setMode('pick');
  }, [device, settings?.pos?.loginMode]);

  const submit = async (pin) => {
    setBusy(true); setError('');
    try {
      const body = mode === 'pick' ? { staffId: picked.id, pin } : { employeeCode: code.trim(), pin };
      const r = await api('/auth/login', { method: 'POST', body });
      await useApp.getState().login(r, pin);
      nav(device ? DEVICE_HOME[device.type] || '/admin' : '/admin', { replace: true });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const shop = settings?.shop;
  return (
    <div className="fullcenter" style={{ background: 'linear-gradient(135deg, var(--primary-50), var(--bg))' }}>
      <div className="card" style={{ width: '100%', maxWidth: stage === 'id' && mode === 'pick' ? 760 : 420 }}>
        <div className="card-b col" style={{ gap: 16 }}>
          <div className="center col" style={{ alignItems: 'center', gap: 6 }}>
            {shop?.logoUrl ? <img src={shop.logoUrl} alt="" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover' }} /> : <Icon name="store" size={40} />}
            <h2>{shop?.name || 'เข้าสู่ระบบ'}</h2>
            <div className="muted small">{device ? `${device.name} · ${useApp.getState().branch?.name || ''}` : 'Back Office'}</div>
          </div>
          {device && stage === 'id' && <Seg value={mode} onChange={(m) => { setMode(m); setError(''); }} options={[{ value: 'code', label: 'รหัสพนักงาน + PIN' }, { value: 'pick', label: 'เลือกชื่อพนักงาน' }]} />}
          {stage === 'id' && mode === 'code' && (
            <form className="col" onSubmit={(e) => { e.preventDefault(); if (code.trim()) setStage('pin'); }}>
              <Input size="lg" label="Employee Code" placeholder="EMP001" value={code} onValue={(v) => setCode(v.toUpperCase())} autoFocus autoCapitalize="characters" />
              <Button variant="primary" size="lg" type="submit" disabled={!code.trim()}>ถัดไป</Button>
            </form>
          )}
          {stage === 'id' && mode === 'pick' && (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', maxHeight: '55vh', overflow: 'auto' }}>
              {staff.map((s) => (
                <button key={s.id} type="button" className="card pad center" style={{ cursor: 'pointer' }} onClick={() => { setPicked(s); setStage('pin'); }}>
                  {s.photo_url ? <img src={s.photo_url} alt="" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--primary-50)', color: 'var(--primary)', display: 'grid', placeItems: 'center', margin: '0 auto', fontSize: 22, fontWeight: 700 }}>{(s.nickname || s.first_name)[0]}</div>}
                  <div className="bold mt ellipsis">{s.nickname || s.first_name}</div>
                  <div className="xs muted">{s.employee_code} · {s.role_name}</div>
                </button>
              ))}
            </div>
          )}
          {stage === 'pin' && (
            <div className="col">
              <div className="row between">
                <div><div className="small muted">พนักงาน</div><div className="bold">{mode === 'pick' ? `${picked.nickname || picked.first_name} (${picked.employee_code})` : code}</div></div>
                <Button size="sm" variant="ghost" icon="back" onClick={() => { setStage('id'); setError(''); }}>เปลี่ยน</Button>
              </div>
              <PinPad onSubmit={submit} busy={busy} error={error} />
            </div>
          )}
          <div className={cls('row between small')}>
            <Button size="sm" variant="ghost" onClick={() => nav('/')}>หน้าแรก</Button>
            {!device && <Button size="sm" variant="ghost" onClick={() => nav('/device')}>ลงทะเบียนเครื่อง</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}

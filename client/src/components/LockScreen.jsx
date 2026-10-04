import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api, NetworkError } from '../lib/api.js';
import { useApp } from '../lib/store.js';
import { kvGet } from '../lib/db.js';
import { pinDigest } from '../lib/util.js';
import { PinPad, Button, Icon } from './ui.jsx';

/** Locks after inactivity (settings.pos.lockAfterMinutes); unlock with the same staff PIN (works offline). */
export default function LockScreen() {
  const nav = useNavigate();
  const { locked, staff, settings } = useApp();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef(Date.now());
  useEffect(() => {
    const bump = () => { last.current = Date.now(); };
    ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, bump));
    const t = setInterval(() => {
      const mins = Number(settings?.pos?.lockAfterMinutes) || 0;
      if (mins > 0 && !useApp.getState().locked && Date.now() - last.current > mins * 60e3) useApp.setState({ locked: true });
    }, 5000);
    return () => { ['pointerdown', 'keydown'].forEach((e) => window.removeEventListener(e, bump)); clearInterval(t); };
  }, [settings?.pos?.lockAfterMinutes]);
  if (!locked || !staff) return null;
  const unlock = async (pin) => {
    setBusy(true); setError('');
    try {
      await api('/auth/verify-pin', { method: 'POST', body: { pin } });
      useApp.setState({ locked: false });
    } catch (e) {
      if (e instanceof NetworkError) {
        const d = await kvGet(`pin:${staff.id}`);
        if (d && d === (await pinDigest(pin, `${staff.id}:${staff.code}`))) useApp.setState({ locked: false });
        else setError('PIN ไม่ถูกต้อง');
      } else setError(e.message);
    } finally { setBusy(false); }
  };
  return createPortal(
    <div className="modal-bg" style={{ background: 'rgba(10,12,15,.85)', zIndex: 250 }}>
      <div className="modal narrow" style={{ padding: 22 }}>
        <div className="center col" style={{ alignItems: 'center' }}>
          <Icon name="lock" size={36} />
          <h2>หน้าจอถูกล็อก</h2>
          <div className="muted">{staff.displayName} ({staff.code})</div>
        </div>
        <PinPad onSubmit={unlock} busy={busy} error={error} />
        <Button block className="mt" variant="ghost" icon="users" onClick={async () => { await useApp.getState().logout(); nav('/login'); }}>สลับพนักงาน (Switch Staff)</Button>
      </div>
    </div>,
    document.body,
  );
}

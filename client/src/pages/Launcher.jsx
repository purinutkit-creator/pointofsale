import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../lib/api.js';
import { useApp } from '../lib/store.js';
import { Button, Loading, Icon } from '../components/ui.jsx';

export const DEVICE_HOME = { pos: '/pos', kds: '/kds', customer_display: '/display', queue_display: '/queue', member_kiosk: '/m', bridge: '/admin/printers' };

export default function Launcher() {
  const nav = useNavigate();
  const [state, setState] = useState('loading');
  const [shopName, setShopName] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const st = await api('/setup/status');
        if (!st.setupDone) return nav('/setup', { replace: true });
        setShopName(st.shopName);
      } catch { /* offline → continue with cached device */ }
      const d = await useApp.getState().loadDevice();
      if (d?.device) {
        const t = d.device.type;
        if (['customer_display', 'queue_display'].includes(t)) return nav(DEVICE_HOME[t], { replace: true });
        if (auth.session) return nav(DEVICE_HOME[t] || '/admin', { replace: true });
        return nav('/login', { replace: true });
      }
      if (auth.session) return nav('/admin', { replace: true });
      setState('choose');
    })();
  }, [nav]);
  if (state === 'loading') return <Loading />;
  return (
    <div className="fullcenter">
      <div className="card pad col" style={{ maxWidth: 460, width: '100%', gap: 14 }}>
        <div className="center"><Icon name="store" size={40} /><h2 className="mt">{shopName || 'ระบบ POS'}</h2><div className="muted">เครื่องนี้ยังไม่ได้ลงทะเบียน</div></div>
        <Button variant="primary" size="xl" icon="monitor" onClick={() => nav('/device')}>ลงทะเบียนเครื่องนี้ (POS / KDS / จอลูกค้า / จอคิว)</Button>
        <Button size="lg" icon="settings" onClick={() => nav('/login')}>เข้าสู่ระบบหลังร้าน (Back Office)</Button>
        <Button size="lg" variant="ghost" icon="star" onClick={() => nav('/m')}>หน้าสมาชิก (Member)</Button>
      </div>
    </div>
  );
}

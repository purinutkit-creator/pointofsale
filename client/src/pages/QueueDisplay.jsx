// Queue Display (full-screen TV): กำลังเตรียม / พร้อมรับ + chime + Thai voice call
import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../lib/api.js';
import { connectSocket, on, onConnection } from '../lib/socket.js';
import { useApp } from '../lib/store.js';
import { Loading, Button, Icon } from '../components/ui.jsx';
import { playChime, speak, unlockAudio } from '../lib/sound.js';

export default function QueueDisplay() {
  const nav = useNavigate();
  const settings = useApp((s) => s.settings);
  const [q, setQ] = useState(null);
  const [flash, setFlash] = useState(null);
  const [armed, setArmed] = useState(false);
  const [connected, setConnected] = useState(true);
  const armedRef = useRef(false);
  const load = useCallback(() => api('/queue').then(setQ).catch((e) => { if (e.status === 401) nav('/device'); }), [nav]);
  const announce = useCallback((queueNo) => {
    if (!queueNo) return;
    setFlash(queueNo);
    setTimeout(() => setFlash(null), 6000);
    if (!armedRef.current) return;
    playChime();
    const s = useApp.getState().settings?.queue;
    if (s?.voice !== false) setTimeout(() => speak((s?.voiceTemplate || 'ขอเชิญหมายเลข {queue}').replace('{queue}', queueNo.split('').join(' '))), 900);
  }, []);
  useEffect(() => {
    (async () => {
      if (!auth.deviceToken) return nav('/device');
      await useApp.getState().loadDevice();
      connectSocket();
      load();
    })();
  }, [nav, load]);
  useEffect(() => {
    const offs = [on('queue:changed', load), on('queue:ready', (e) => { load(); if (e.queueNo) announce(e.queueNo); }), on('queue:call', (e) => { load(); announce(e.queueNo); }), onConnection((c) => { setConnected(c); if (c) load(); })];
    const t = setInterval(load, 30000);
    return () => { offs.forEach((f) => f()); clearInterval(t); };
  }, [load, announce]);
  if (!q) return <Loading />;
  const shop = settings?.shop;
  return (
    <div style={{ height: '100dvh', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#0F1216', color: '#fff' }} onClick={() => { if (!armed) { unlockAudio(); armedRef.current = true; setArmed(true); } }}>
      <div className="row" style={{ padding: '14px 24px', background: 'var(--primary)' }}>
        {shop?.logoUrl && <img src={shop.logoUrl} alt="" style={{ height: 48, borderRadius: 10 }} />}
        <b style={{ fontSize: 32 }}>{q.settings?.title || 'สถานะคิว'}</b>
        <div className="grow" />
        <span style={{ fontSize: 18 }}>{shop?.name}</span>
        {!connected && <span className="badge danger">Offline</span>}
        {!armed && <span className="badge warning">แตะหน้าจอเพื่อเปิดเสียงเรียกคิว</span>}
        <Button size="sm" icon="fullscreen" onClick={(e) => { e.stopPropagation(); document.documentElement.requestFullscreen?.(); }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 0 }}>
        <div style={{ padding: 24, borderRight: '2px solid #222' }}>
          <h2 style={{ fontSize: 'clamp(26px, 3.4vw, 48px)', color: '#FBBF24', marginBottom: 16 }}>กำลังเตรียม</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            {q.preparing.map((o) => <div key={o.id} style={{ fontSize: 'clamp(34px, 4.6vw, 72px)', fontWeight: 800, background: '#1E2430', borderRadius: 16, padding: '6px 22px' }}>{o.queue_no}</div>)}
          </div>
        </div>
        <div style={{ padding: 24 }}>
          <h2 style={{ fontSize: 'clamp(26px, 3.4vw, 48px)', color: '#34D399', marginBottom: 16 }}>พร้อมรับ</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            {q.ready.map((o) => <div key={o.id} style={{ fontSize: 'clamp(40px, 6vw, 96px)', fontWeight: 800, background: '#065F46', borderRadius: 16, padding: '6px 26px', animation: flash === o.queue_no ? 'pulse 1s infinite' : undefined }}>{o.queue_no}</div>)}
          </div>
        </div>
      </div>
      {flash && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'grid', placeItems: 'center', zIndex: 10 }}>
          <div className="center"><div style={{ fontSize: 42 }}>ขอเชิญหมายเลข</div><div style={{ fontSize: 'clamp(90px, 18vw, 240px)', fontWeight: 900, color: '#34D399', lineHeight: 1 }}>{flash}</div><div style={{ fontSize: 32 }}>รับสินค้าที่เคาน์เตอร์</div></div>
        </div>
      )}
      <style>{'@keyframes pulse { 50% { transform: scale(1.08); background: #10B981; } }'}</style>
    </div>
  );
}

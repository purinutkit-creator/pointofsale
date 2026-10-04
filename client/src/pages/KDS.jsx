// Kitchen Display System: per-station tickets, sub-ticket numbers, timers, NEW → PREPARING → READY → SERVED, new-order sound
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from '../lib/api.js';
import { connectSocket, on, onConnection } from '../lib/socket.js';
import { useApp, toast } from '../lib/store.js';
import { Button, Icon, Loading, Seg, Badge } from '../components/ui.jsx';
import { elapsed, fmtTime, ORDER_TYPE_LABEL, cls } from '../lib/util.js';
import { playNewOrder, unlockAudio, playChime } from '../lib/sound.js';
import LockScreen from '../components/LockScreen.jsx';

const NEXT = { new: 'preparing', preparing: 'ready', ready: 'served' };
const NEXT_LABEL = { new: 'เริ่มทำ', preparing: 'พร้อมเสิร์ฟ', ready: 'เสิร์ฟแล้ว' };
const COLOR = { new: '#2563EB', preparing: '#D97706', ready: '#16A34A', served: '#6B7280', voided: '#DC2626' };

export default function KDS() {
  const nav = useNavigate();
  const { staff, device } = useApp();
  const [tickets, setTickets] = useState(null);
  const [stations, setStations] = useState([]);
  const [station, setStation] = useState('');
  const [done, setDone] = useState(false);
  const [sound, setSound] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    (async () => {
      if (!auth.deviceToken) return nav('/device');
      if (!auth.session) return nav('/login');
      const d = await useApp.getState().loadDevice();
      if (!(await useApp.getState().loadMe())) return nav('/login');
      setStation(d?.device?.stationId ? String(d.device.stationId) : '');
      connectSocket();
      api('/stations').then(setStations).catch(() => {});
    })();
  }, [nav]);

  const load = useCallback(async () => {
    try {
      const r = await api(`/kds/tickets?${station ? `stationId=${station}&` : ''}${done ? 'done=1' : ''}`);
      setTickets((prev) => {
        if (prev && sound && r.tickets.some((t) => !prev.some((p) => p.id === t.id))) playNewOrder();
        return r.tickets;
      });
    } catch (e) { if (e.status === 401) nav('/login'); }
  }, [station, done, sound, nav]);

  useEffect(() => {
    if (!staff) return undefined;
    load();
    const offs = [on('kds:changed', load), onConnection((c) => { setConnected(c); if (c) load(); })];
    const t = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(load, 20000);
    return () => { offs.forEach((f) => f()); clearInterval(t); clearInterval(poll); };
  }, [staff, load]);

  const bump = async (url, status) => {
    try { await api(url, { method: 'POST', body: { status } }); if (status === 'ready') playChime(); load(); } catch (e) { toast(e.message, 'error'); }
  };

  if (!staff || !tickets) return <Loading />;
  const visible = tickets.filter((t) => (done ? true : t.status !== 'served'));
  return (
    <div style={{ height: '100dvh', display: 'grid', gridTemplateRows: 'auto 1fr', background: '#111315', color: '#ECEEF0' }} data-kds>
      <div className="row" style={{ padding: '10px 14px', background: '#1A1D21', borderBottom: '1px solid #2E3339', flexWrap: 'wrap' }}>
        <Icon name="chef" /><b style={{ fontSize: 20 }}>KDS</b><span className="muted">{device?.name}</span>
        <Seg value={station} onChange={setStation} options={[{ value: '', label: 'ทุกสถานี' }, ...stations.map((s) => ({ value: String(s.id), label: s.name }))]} />
        <div className="grow" />
        <Badge tone={connected ? 'success' : 'danger'}>{connected ? 'Online' : 'Offline'}</Badge>
        <Badge tone="info">{visible.filter((t) => t.status === 'new').length} ใหม่</Badge>
        <Badge tone="warning">{visible.filter((t) => t.status === 'preparing').length} กำลังทำ</Badge>
        <Button size="sm" variant={sound ? 'success' : undefined} icon="volume" onClick={() => { unlockAudio(); setSound(!sound); if (!sound) playNewOrder(); }}>{sound ? 'เสียงเปิด' : 'เปิดเสียง'}</Button>
        <Button size="sm" onClick={() => setDone(!done)}>{done ? 'ซ่อนที่เสร็จแล้ว' : 'Recall / ดูที่เสร็จแล้ว'}</Button>
        <Button size="sm" icon="fullscreen" onClick={() => document.documentElement.requestFullscreen?.()} />
        <Button size="sm" icon="logout" onClick={async () => { await useApp.getState().logout(); nav('/login'); }} />
      </div>
      <div style={{ overflow: 'auto', padding: 12 }}>
        {!visible.length && <div className="empty" style={{ color: '#9AA3AD' }}><Icon name="check" size={40} /><div className="mt">ไม่มีรายการค้าง</div></div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 12, alignItems: 'start' }}>
          {visible.flatMap((t) => t.subs.map((s) => ({ t, s }))).map(({ t, s }) => {
            const mins = (now - new Date(t.created_at.replace(' ', 'T') + 'Z').getTime()) / 60000;
            const age = mins > 20 ? '#DC2626' : mins > 10 ? '#D97706' : '#2E3339';
            const st = s.status;
            return (
              <div key={s.id} style={{ background: '#1A1D21', borderRadius: 14, border: `3px solid ${st === 'ready' ? COLOR.ready : age}`, overflow: 'hidden', opacity: st === 'served' ? 0.55 : 1 }}>
                <div style={{ background: COLOR[st] || '#333', padding: '8px 12px', color: '#fff' }}>
                  <div className="row between">
                    <b style={{ fontSize: 26 }}>{t.queue_no || (t.table_number ? `โต๊ะ ${t.table_number}` : `#${t.order_no}`)}</b>
                    <b className="num" style={{ fontSize: 20 }}>{elapsed(t.created_at, now)}</b>
                  </div>
                  <div className="row between small">
                    <span>{ORDER_TYPE_LABEL[t.order_type]}{t.table_number && t.queue_no ? ` · โต๊ะ ${t.table_number}` : ''} · {fmtTime(t.created_at)}</span>
                    <b>ใบย่อย {s.sub_index}/{s.sub_count}</b>
                  </div>
                </div>
                <div style={{ padding: '8px 12px' }} className="col gap-s">
                  <div className="row wrap gap-s">
                    {t.is_addition ? <Badge tone="warning">รายการเพิ่ม / NEW ITEM</Badge> : null}
                    {t.station_name && <Badge>{t.station_name}</Badge>}
                    {t.customer_name && <span className="small">{t.customer_name}</span>}
                    <span className="xs" style={{ color: '#9AA3AD' }}>{t.staff_code}</span>
                  </div>
                  {s.items.map((it) => (
                    <button key={it.id} type="button" onClick={() => it.status !== 'voided' && NEXT[it.status] && bump(`/kds/items/${it.id}/status`, NEXT[it.status])}
                      style={{ textAlign: 'left', background: 'transparent', border: 0, color: 'inherit', padding: '6px 0', borderBottom: '1px solid #2E3339', cursor: 'pointer', textDecoration: it.status === 'voided' ? 'line-through' : 'none', opacity: it.status === 'voided' ? 0.5 : 1 }}>
                      <div className="row between">
                        <b style={{ fontSize: 19 }}>{it.qty} × {it.name}{it.variant_name ? ` (${it.variant_name})` : ''}{it.unit_count > 1 ? ` (${it.unit_index}/${it.unit_count})` : ''}</b>
                        <span className="dot" style={{ background: COLOR[it.status] }} />
                      </div>
                      {it.modifiers.map((m, k) => <div key={k} style={{ fontSize: 15, color: '#C9D1D9', paddingLeft: 14 }}>• {m.name}{m.qty > 1 ? ` x${m.qty}` : ''}</div>)}
                      {it.note && <div style={{ fontSize: 15, color: '#FBBF24', paddingLeft: 14, fontWeight: 700 }}>» {it.note}</div>}
                      {it.status === 'voided' && <div style={{ color: '#F87171', fontWeight: 700 }}>ยกเลิก</div>}
                    </button>
                  ))}
                  {t.order_note && <div style={{ color: '#FBBF24', fontWeight: 700 }}>หมายเหตุ: {t.order_note}</div>}
                  <div className="row">
                    {NEXT[st] && <Button size="lg" className="grow" variant={st === 'new' ? 'warning' : st === 'preparing' ? 'success' : undefined} onClick={() => bump(`/kds/subs/${s.id}/status`, NEXT[st])}>{NEXT_LABEL[st]}</Button>}
                    {st !== 'new' && <Button size="lg" icon="back" onClick={() => bump(`/kds/subs/${s.id}/status`, st === 'served' ? 'ready' : st === 'ready' ? 'preparing' : 'new')} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <LockScreen />
    </div>
  );
}

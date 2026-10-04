// Order start: ทานที่ร้าน (Zone → Table → จำนวนลูกค้า) / กลับบ้าน (ชื่อ เบอร์ Note → Queue)
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { on } from '../../lib/socket.js';
import { useApp, toast } from '../../lib/store.js';
import { usePos } from './posStore.js';
import { Button, Modal, Input, Icon, Seg, NumPad, applyKey, useDialog } from '../../components/ui.jsx';
import { cls, money, elapsed, TABLE_STATE } from '../../lib/util.js';

export function FloorView({ zones, tables, onPick, selectedIds = [], filter }) {
  const [zone, setZone] = useState('all');
  const list = tables.filter((t) => (zone === 'all' || t.zone_id === zone) && (!filter || filter(t)));
  const maxX = Math.max(600, ...list.map((t) => t.pos_x + t.width + 20));
  const maxY = Math.max(380, ...list.map((t) => t.pos_y + t.height + 20));
  return (
    <div className="col">
      <div className="row wrap between">
        <Seg value={zone} onChange={setZone} options={[{ value: 'all', label: 'ทุกโซน' }, ...zones.map((z) => ({ value: z.id, label: z.name }))]} />
        <div className="legend">{Object.entries(TABLE_STATE).map(([k, v]) => <span key={k} className={`st-${k}`}><i />{v}</span>)}</div>
      </div>
      <div className="floor">
        <div style={{ position: 'relative', width: maxX, height: maxY }}>
          {list.map((t) => (
            <div key={t.id} className={cls('ftable', `st-${t.state || 'available'}`, t.shape === 'round' && 'round', selectedIds.includes(t.id) && 'sel')}
              style={{ left: t.pos_x, top: t.pos_y, width: t.width, height: t.height }} onClick={() => onPick(t)}>
              <div className="tn">{t.number}</div>
              <div className="ts">{TABLE_STATE[t.state || 'available']}</div>
              {t.order_id ? <div className="xs num">฿{money(t.total)} · {elapsed(t.order_created_at)}</div> : <div className="xs muted">{t.seats} ที่นั่ง</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function useFloor() {
  const [floor, setFloor] = useState({ zones: [], tables: [] });
  const load = useCallback(() => api('/floor').then(setFloor).catch(() => {
    const c = usePos.getState().catalog;
    setFloor({ zones: c.zones, tables: c.tables.map((t) => ({ ...t, state: 'available' })) });
  }), []);
  useEffect(() => {
    load();
    const offs = [on('order:updated', load), on('catalog:changed', load), on('queue:changed', load)];
    return () => offs.forEach((f) => f());
  }, [load]);
  return [floor, load];
}

export default function StartOrder() {
  const settings = useApp((s) => s.settings);
  const can = useApp((s) => s.can);
  const dialog = useDialog();
  const [mode, setMode] = useState(null);
  const [floor, reload] = useFloor();
  const [table, setTable] = useState(null);
  const [guests, setGuests] = useState('2');
  const [take, setTake] = useState({ customerName: '', customerPhone: '', note: '' });
  const [busy, setBusy] = useState(false);

  const start = async (payload) => {
    setBusy(true);
    try { await usePos.getState().newOrder(payload); } catch (e) { toast(e.message, 'error'); reload(); } finally { setBusy(false); }
  };
  const pickTable = async (t) => {
    if (t.order_id) { await usePos.getState().openOrder(t.order_id); return; }
    if (t.state === 'reserved' || t.state === 'cleaning') {
      const ok = await dialog.confirm({ message: `โต๊ะ ${t.number} สถานะ "${TABLE_STATE[t.state]}" ต้องการเปิดบิลใช่หรือไม่?` });
      if (!ok) return;
      await api(`/tables/${t.id}/status`, { method: 'POST', body: { status: null } }).catch(() => {});
    }
    if (settings?.pos?.askGuests === false) return start({ type: 'dine_in', tableId: t.id, tableNumber: t.number });
    setGuests(String(Math.min(t.seats || 2, 2))); setTable(t);
  };

  if (!mode) {
    return (
      <div className="pos-start">
        <h2 className="center" style={{ margin: '20px 0' }}>เลือกประเภทบิล</h2>
        <div className="type-cards">
          <button type="button" className="type-card" onClick={() => setMode('dine_in')} disabled={!can('pos.open_order')}><Icon name="table" size={48} />ทานที่ร้าน<span className="small muted">เลือกโซน · โต๊ะ · จำนวนลูกค้า</span></button>
          <button type="button" className="type-card" onClick={() => setMode('takeaway')} disabled={!can('pos.open_order')}><Icon name="box" size={48} />กลับบ้าน<span className="small muted">ออกเลขคิวอัตโนมัติ</span></button>
        </div>
        <div className="center mt-l">
          <Button size="lg" variant="soft" icon="cash" loading={busy} onClick={() => start({ type: 'takeaway' })} disabled={!can('pos.open_order')}>ขายด่วน (กลับบ้าน ไม่ระบุชื่อ)</Button>
        </div>
      </div>
    );
  }
  if (mode === 'takeaway') {
    return (
      <div className="pos-start">
        <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
          <div className="card-h"><div className="row"><Button variant="ghost" icon="back" onClick={() => setMode(null)} /><h3>กลับบ้าน</h3></div></div>
          <div className="card-b col">
            <Input size="lg" label="ชื่อลูกค้า" value={take.customerName} onValue={(v) => setTake({ ...take, customerName: v })} autoFocus />
            <Input size="lg" label="เบอร์โทร" inputMode="tel" value={take.customerPhone} onValue={(v) => setTake({ ...take, customerPhone: v })} />
            <Input label="Note" value={take.note} onValue={(v) => setTake({ ...take, note: v })} />
            <Button variant="primary" size="xl" loading={busy} onClick={() => start({ type: 'takeaway', ...take })}>เปิดบิล + ออกเลขคิว</Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="pos-start col">
      <div className="row"><Button variant="ghost" icon="back" onClick={() => setMode(null)} /><h3>ทานที่ร้าน — เลือกโต๊ะ</h3><div className="grow" /><Button size="sm" icon="refresh" onClick={reload}>รีเฟรช</Button></div>
      <FloorView zones={floor.zones} tables={floor.tables} onPick={pickTable} />
      {!floor.tables.length && <div className="empty">ยังไม่มีโต๊ะ — เพิ่มได้ที่ หลังร้าน › โต๊ะ / Floor Plan<div className="mt"><Button onClick={() => start({ type: 'dine_in' })}>เปิดบิลทานที่ร้านโดยไม่ระบุโต๊ะ</Button></div></div>}
      {table && (
        <Modal title={`โต๊ะ ${table.number} — จำนวนลูกค้า`} size="narrow" onClose={() => setTable(null)}
          footer={<Button variant="primary" size="lg" block loading={busy} onClick={async () => { await start({ type: 'dine_in', tableId: table.id, tableNumber: table.number, guests: Number(guests) || null }); setTable(null); }}>เปิดโต๊ะ</Button>}>
          <div className="input xl" style={{ display: 'grid', placeItems: 'center' }}>{guests || '0'} ท่าน</div>
          <div className="row wrap mt">{[1, 2, 3, 4, 5, 6, 8, 10].map((n) => <button key={n} type="button" className={cls('chip', String(n) === guests && 'on')} onClick={() => setGuests(String(n))}>{n}</button>)}</div>
          <div className="mt"><NumPad extra="" onKey={(k) => setGuests((g) => applyKey(g, k, { maxLen: 3, decimals: 0 }))} /></div>
        </Modal>
      )}
    </div>
  );
}

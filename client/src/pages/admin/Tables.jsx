// Floor plan editor: zones, tables (number, seats, shape, drag position)
import { useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Modal, Input, Select, Seg, useAsync, useDialog } from '../../components/ui.jsx';
import { cls } from '../../lib/util.js';
import '../pos/pos.css';

export default function Tables() {
  const floor = useAsync(() => api('/floor'));
  const dialog = useDialog();
  const [zone, setZone] = useState('all');
  const [edit, setEdit] = useState(null);
  const [moved, setMoved] = useState({});
  const drag = useRef(null);
  if (!floor.data) return <Page title="โต๊ะ / Floor Plan" />;
  const { zones, tables } = floor.data;
  const pos = (t) => ({ ...t, ...(moved[t.id] || {}) });
  const list = tables.map(pos).filter((t) => zone === 'all' || t.zone_id === zone);
  const onDown = (e, t) => { e.preventDefault(); drag.current = { id: t.id, sx: e.clientX, sy: e.clientY, x: t.pos_x, y: t.pos_y }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const snap = (v) => Math.max(0, Math.round(v / 10) * 10);
    setMoved((m) => ({ ...m, [d.id]: { ...(m[d.id] || {}), pos_x: snap(d.x + e.clientX - d.sx), pos_y: snap(d.y + e.clientY - d.sy) } }));
  };
  const saveLayout = async () => {
    try { await api('/tables/layout', { method: 'POST', body: { tables: Object.entries(moved).map(([id, v]) => ({ id: Number(id), posX: v.pos_x, posY: v.pos_y })) } }); setMoved({}); toast('บันทึกผังโต๊ะแล้ว', 'success'); floor.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const save = async () => {
    const b = { zoneId: edit.zone_id ? Number(edit.zone_id) : null, number: edit.number, seats: Number(edit.seats) || 1, shape: edit.shape, posX: edit.pos_x ?? 20, posY: edit.pos_y ?? 20, width: Number(edit.width) || 90, height: Number(edit.height) || 90 };
    try { if (edit.id) await api(`/tables/${edit.id}`, { method: 'PUT', body: b }); else await api('/tables', { method: 'POST', body: b }); setEdit(null); floor.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const addZone = async () => { const n = await dialog.prompt({ title: 'เพิ่มโซน', placeholder: 'เช่น Outdoor, VIP, ชั้น 2', required: true }); if (n) { await api('/zones', { method: 'POST', body: { name: n } }); floor.reload(); } };
  const maxX = Math.max(800, ...list.map((t) => t.pos_x + t.width + 40));
  const maxY = Math.max(500, ...list.map((t) => t.pos_y + t.height + 40));
  return (
    <Page title="โต๊ะ / Floor Plan" actions={<>
      <Button icon="plus" onClick={addZone}>เพิ่มโซน</Button>
      <Button variant="primary" icon="plus" onClick={() => setEdit({ number: '', seats: 4, shape: 'square', zone_id: zone === 'all' ? zones[0]?.id : zone, width: 90, height: 90 })}>เพิ่มโต๊ะ</Button>
      {Object.keys(moved).length > 0 && <Button variant="success" onClick={saveLayout}>บันทึกตำแหน่ง ({Object.keys(moved).length})</Button>}
    </>}>
      <div className="col">
        <div className="row wrap">
          <Seg value={zone} onChange={setZone} options={[{ value: 'all', label: 'ทุกโซน' }, ...zones.map((z) => ({ value: z.id, label: z.name }))]} />
          {zone !== 'all' && <Button size="sm" variant="ghost" onClick={async () => { const n = await dialog.prompt({ title: 'แก้ชื่อโซน', value: zones.find((z) => z.id === zone)?.name, required: true }); if (n) { await api(`/zones/${zone}`, { method: 'PUT', body: { name: n } }); floor.reload(); } }}>แก้ชื่อโซน</Button>}
          {zone !== 'all' && <Button size="sm" variant="ghost" onClick={async () => { if (await dialog.confirm({ message: 'ลบโซนนี้? (โต๊ะจะไม่ถูกลบ)', danger: true })) { await api(`/zones/${zone}`, { method: 'DELETE' }); setZone('all'); floor.reload(); } }}>ลบโซน</Button>}
          <span className="small muted">ลากโต๊ะเพื่อจัดตำแหน่ง · แตะสองครั้งเพื่อแก้ไข</span>
        </div>
        <div className="floor">
          <div style={{ position: 'relative', width: maxX, height: maxY }} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }}>
            {list.map((t) => (
              <div key={t.id} className={cls('ftable', `st-${t.state}`, t.shape === 'round' && 'round')} style={{ left: t.pos_x, top: t.pos_y, width: t.width, height: t.height, touchAction: 'none', cursor: 'grab' }}
                onPointerDown={(e) => onDown(e, t)} onDoubleClick={() => setEdit({ ...t })}>
                <div className="tn">{t.number}</div><div className="xs muted">{t.seats} ที่นั่ง</div>
                <button type="button" className="btn sm ghost" style={{ minHeight: 24, padding: '0 6px' }} onPointerDown={(e) => e.stopPropagation()} onClick={() => setEdit({ ...t })}>แก้ไข</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {edit && (
        <Modal title={edit.id ? `โต๊ะ ${edit.number}` : 'เพิ่มโต๊ะ'} onClose={() => setEdit(null)}
          footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { try { await api(`/tables/${edit.id}`, { method: 'DELETE' }); setEdit(null); floor.reload(); } catch (e) { toast(e.message, 'error'); } }}>ลบโต๊ะ</Button>}<Button variant="primary" onClick={save} disabled={!edit.number}>บันทึก</Button></>}>
          <div className="grid-2">
            <Input label="หมายเลขโต๊ะ *" value={edit.number} onValue={(v) => setEdit({ ...edit, number: v })} />
            <Input label="จำนวนที่นั่ง" type="number" value={edit.seats} onValue={(v) => setEdit({ ...edit, seats: v })} />
            <Select label="โซน" value={edit.zone_id ?? ''} onValue={(v) => setEdit({ ...edit, zone_id: v })} placeholder="— ไม่ระบุ —" options={zones.map((z) => ({ value: z.id, label: z.name }))} />
            <Select label="รูปทรง" value={edit.shape} onValue={(v) => setEdit({ ...edit, shape: v, width: v === 'rect' ? 140 : 90 })} options={[{ value: 'square', label: 'สี่เหลี่ยม' }, { value: 'round', label: 'กลม' }, { value: 'rect', label: 'สี่เหลี่ยมผืนผ้า' }]} />
            <Input label="กว้าง (px)" type="number" value={edit.width} onValue={(v) => setEdit({ ...edit, width: v })} />
            <Input label="สูง (px)" type="number" value={edit.height} onValue={(v) => setEdit({ ...edit, height: v })} />
          </div>
        </Modal>
      )}
    </Page>
  );
}

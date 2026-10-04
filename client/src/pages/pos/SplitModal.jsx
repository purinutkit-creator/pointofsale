// Split Bill (ตามสินค้า / เลือกรายการ / ตามคน / ตามจำนวนเงิน), ย้ายโต๊ะ, รวมโต๊ะ, แยกโต๊ะ / ย้ายสินค้า
import { useState } from 'react';
import { api, uid } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { usePos, fromServer } from './posStore.js';
import { Modal, Button, Seg, Input, Badge } from '../../components/ui.jsx';
import { FloorView, useFloor } from './StartOrder.jsx';
import { money } from '../../lib/util.js';

export default function SplitModal({ onClose, onPayPart }) {
  const order = usePos((s) => s.order);
  const totals = usePos.getState().totals();
  const can = useApp((s) => s.can);
  const [mode, setMode] = useState('items');
  const [qtys, setQtys] = useState({});
  const [people, setPeople] = useState(2);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [floor, reloadFloor] = useFloor();
  const [targets, setTargets] = useState([]);
  const items = order.items.filter((i) => i.status !== 'voided');
  const selected = Object.entries(qtys).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));

  const run = async (fn) => { setBusy(true); try { await usePos.getState().flushSave(); await fn(); } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); } finally { setBusy(false); } };

  const splitToNewBill = () => run(async () => {
    const r = await api(`/orders/${order.id}/move-items`, { method: 'POST', body: { items: selected, newOrder: { id: uid(), type: order.type === 'dine_in' ? 'dine_in' : order.type, tableId: null, customerName: order.customerName } } });
    usePos.setState({ order: fromServer(r.target) });
    toast(`แยกบิลใหม่ #${r.target.order_no} — ชำระบิลนี้ได้เลย`, 'success');
    onClose();
  });
  const moveTable = (t) => run(async () => {
    if (t.order_id) {
      // target occupied → move selected items (or whole bill) into that table's order
      const list = selected.length ? selected : items.map((i) => ({ itemId: i.id, qty: i.qty }));
      const r = await api(`/orders/${order.id}/move-items`, { method: 'POST', body: { items: list, targetOrderId: t.order_id } });
      usePos.setState({ order: fromServer(r.target) });
      toast(`ย้ายรายการไปโต๊ะ ${t.number}`, 'success');
    } else if (selected.length) {
      const r = await api(`/orders/${order.id}/move-items`, { method: 'POST', body: { items: selected, newOrder: { id: uid(), type: 'dine_in', tableId: t.id } } });
      toast(`แยกโต๊ะ: ย้าย ${selected.length} รายการไปโต๊ะ ${t.number}`, 'success');
      usePos.setState({ order: fromServer(r.source.status === 'merged' ? r.target : r.source) });
    } else {
      const r = await api(`/orders/${order.id}`, { method: 'PUT', body: { id: order.id, type: 'dine_in', tableId: t.id } });
      usePos.setState({ order: fromServer(r) });
      toast(`ย้ายไปโต๊ะ ${t.number}`, 'success');
    }
    onClose();
  });
  const merge = () => run(async () => {
    const r = await api(`/orders/${order.id}/merge`, { method: 'POST', body: { sourceIds: targets } });
    usePos.setState({ order: fromServer(r) });
    toast(`รวม ${targets.length} บิลเข้าบิลนี้แล้ว`, 'success');
    onClose();
  });

  const due = totals?.remaining || 0;
  const perPerson = Math.ceil((due / Math.max(1, people)) * 100) / 100;
  return (
    <Modal title="แยกบิล / รวมบิล / ย้ายโต๊ะ" size="xwide" icon="split" onClose={onClose}>
      <div className="col gap-l">
        <Seg size="lg" value={mode} onChange={setMode} options={[
          { value: 'items', label: 'แยกตามสินค้า' }, { value: 'person', label: 'แยกตามคน' }, { value: 'amount', label: 'แยกตามจำนวนเงิน' },
          ...(order.type === 'dine_in' ? [{ value: 'move', label: 'ย้าย/แยกโต๊ะ' }, { value: 'merge', label: 'รวมโต๊ะ' }] : []),
        ]} />
        {(mode === 'items' || mode === 'move') && (
          <div className="col gap-s">
            <div className="small muted">{mode === 'items' ? 'เลือกรายการและจำนวนที่ต้องการแยกเป็นบิลใหม่ แล้วชำระแยก' : 'เลือกรายการที่จะย้าย (ไม่เลือก = ย้ายทั้งบิล) แล้วแตะโต๊ะปลายทาง'}</div>
            {items.map((i) => (
              <div key={i.id} className="pay-line">
                <div className="grow"><b>{i.name}</b>{i.variantName ? ` (${i.variantName})` : ''} <span className="muted">× {i.qty} · ฿{money(i.unitPrice)}</span>{i.status === 'sent' && <Badge tone="info">ส่งครัวแล้ว</Badge>}</div>
                <Button size="sm" icon="minus" onClick={() => setQtys({ ...qtys, [i.id]: Math.max(0, (qtys[i.id] || 0) - 1) })} />
                <b className="num" style={{ minWidth: 30, textAlign: 'center' }}>{qtys[i.id] || 0}</b>
                <Button size="sm" icon="plus" onClick={() => setQtys({ ...qtys, [i.id]: Math.min(i.qty, (qtys[i.id] || 0) + 1) })} />
                <Button size="sm" variant="ghost" onClick={() => setQtys({ ...qtys, [i.id]: i.qty })}>ทั้งหมด</Button>
              </div>
            ))}
          </div>
        )}
        {mode === 'items' && <Button variant="primary" size="lg" loading={busy} disabled={!selected.length || !can('pos.split_bill') || order.paidTotal > 0} onClick={splitToNewBill}>แยกเป็นบิลใหม่ ({selected.length} รายการ)</Button>}
        {mode === 'move' && <FloorView zones={floor.zones} tables={floor.tables.filter((t) => t.id !== order.tableId)} onPick={(t) => can('pos.move_table') ? moveTable(t) : toast('ไม่มีสิทธิ์ย้ายโต๊ะ', 'error')} />}
        {mode === 'merge' && (
          <div className="col">
            <div className="small muted">แตะโต๊ะที่มีบิลเปิดอยู่เพื่อรวมเข้ากับบิลนี้ (โต๊ะ {order.tableNumber})</div>
            <FloorView zones={floor.zones} tables={floor.tables.filter((t) => t.order_id && t.order_id !== order.id)} selectedIds={floor.tables.filter((t) => targets.includes(t.order_id)).map((t) => t.id)}
              onPick={(t) => setTargets((x) => (x.includes(t.order_id) ? x.filter((y) => y !== t.order_id) : [...x, t.order_id]))} />
            <Button variant="primary" size="lg" loading={busy} disabled={!targets.length || !can('pos.merge_table')} onClick={merge}>รวม {targets.length} บิลเข้าบิลนี้</Button>
            <Button variant="ghost" onClick={reloadFloor}>รีเฟรช</Button>
          </div>
        )}
        {mode === 'person' && (
          <div className="col center" style={{ alignItems: 'center' }}>
            <div className="row"><Button icon="minus" size="lg" onClick={() => setPeople(Math.max(2, people - 1))} /><div style={{ fontSize: 36, fontWeight: 800, minWidth: 80 }}>{people} คน</div><Button icon="plus" size="lg" onClick={() => setPeople(people + 1)} /></div>
            <div className="muted">ยอดคงเหลือ ฿{money(due)} · คนละประมาณ</div>
            <div style={{ fontSize: 40, fontWeight: 800 }}>฿{money(perPerson)}</div>
            <Button variant="primary" size="xl" disabled={!can('payment.split')} onClick={() => { onClose(); onPayPart(Math.min(perPerson, due)); }}>รับชำระส่วนของ 1 คน</Button>
            <div className="small muted">ระบบจะออกใบรับเงินบางส่วน และออกใบเสร็จเมื่อชำระครบ</div>
          </div>
        )}
        {mode === 'amount' && (
          <div className="col" style={{ maxWidth: 420, margin: '0 auto', width: '100%' }}>
            <div className="muted center">ยอดคงเหลือ ฿{money(due)}</div>
            <Input size="lg" type="number" label="จำนวนเงินที่ชำระครั้งนี้" value={amount} onValue={(v) => setAmount(String(v))} />
            <Button variant="primary" size="xl" disabled={!(Number(amount) > 0) || Number(amount) > due || !can('payment.split')} onClick={() => { onClose(); onPayPart(Number(amount)); }}>รับชำระ ฿{money(Number(amount) || 0)}</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

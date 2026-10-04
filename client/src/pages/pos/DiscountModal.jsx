// Discounts: bill discount (% / amount), coupon code, manual promotions; item editor (options, discount, override price, note)
import { useState } from 'react';
import { usePos, fromServer } from './posStore.js';
import { api } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Modal, Button, Input, Seg, NumPad, applyKey, Badge, TextArea } from '../../components/ui.jsx';
import { money, cls } from '../../lib/util.js';
import { PROMOTION_TYPES } from '@shared/promotions.js';

export function DiscountModal({ onClose }) {
  const order = usePos((s) => s.order);
  const catalog = usePos((s) => s.catalog);
  const { staff, can } = useApp();
  const manual = order.billDiscounts.filter((d) => d.source === 'manual');
  const [type, setType] = useState(manual[0]?.type || 'pct');
  const [value, setValue] = useState(manual[0] ? String(manual[0].value) : '');
  const [label, setLabel] = useState(manual[0]?.label || '');
  const [coupon, setCoupon] = useState('');
  const manualPromos = catalog.promotions.filter((p) => !p.auto_apply && p.type !== 'coupon');
  const apply = () => {
    const v = Number(value) || 0;
    if (type === 'pct' && v > 100) return toast('ส่วนลดเกิน 100%', 'error');
    usePos.getState().update({ billDiscounts: [...order.billDiscounts.filter((d) => d.source !== 'manual'), ...(v > 0 ? [{ type, value: v, label: label || (type === 'pct' ? `ส่วนลด ${v}%` : 'ส่วนลดท้ายบิล'), source: 'manual' }] : [])] });
    onClose();
  };
  const addCoupon = () => {
    const c = coupon.trim().toUpperCase();
    if (!c) return;
    if (!catalog.promotions.some((p) => p.type === 'coupon' && String(p.rule?.code || '').toUpperCase() === c)) return toast('ไม่พบคูปองนี้ หรือคูปองไม่อยู่ในช่วงใช้งาน', 'error');
    usePos.getState().update({ couponCodes: [...new Set([...order.couponCodes, c])] });
    setCoupon('');
    toast(`ใช้คูปอง ${c}`, 'success');
  };
  const togglePromo = (p) => {
    const k = `#${p.id}`;
    usePos.getState().update({ couponCodes: order.couponCodes.includes(k) ? order.couponCodes.filter((x) => x !== k) : [...order.couponCodes, k] });
  };
  return (
    <Modal title="ส่วนลด / คูปอง / โปรโมชั่น" size="wide" icon="percent" onClose={onClose}>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="col">
          <b>ส่วนลดท้ายบิล</b>
          <Seg size="lg" value={type} onChange={setType} options={[{ value: 'pct', label: 'เปอร์เซ็นต์ %' }, { value: 'amount', label: 'จำนวนเงิน ฿' }]} />
          <div className="input xl num" style={{ display: 'grid', placeItems: 'center' }}>{value || '0'}{type === 'pct' ? ' %' : ' ฿'}</div>
          <div className="row wrap">{(type === 'pct' ? [5, 10, 15, 20, 50] : [10, 20, 50, 100]).map((v) => <button key={v} type="button" className="chip" onClick={() => setValue(String(v))}>{v}{type === 'pct' ? '%' : '฿'}</button>)}</div>
          <NumPad onKey={(k) => setValue((v) => applyKey(v, k))} />
          <Input label="เหตุผล / ชื่อส่วนลด" value={label} onValue={setLabel} />
          <div className="xs muted">สิทธิ์ส่วนลดสูงสุดของคุณ: {staff?.maxDiscountPct ?? 0}% (เกินนี้ต้องให้ผู้จัดการอนุมัติ)</div>
          <div className="row"><Button onClick={() => { setValue(''); }}>ล้าง</Button><Button variant="primary" size="lg" className="grow" disabled={!can('discount.bill') && !value} onClick={apply}>ใช้ส่วนลดท้ายบิล</Button></div>
        </div>
        <div className="col">
          <b>คูปอง</b>
          <div className="row"><Input value={coupon} onValue={setCoupon} placeholder="รหัสคูปอง" onKeyDown={(e) => e.key === 'Enter' && addCoupon()} /><Button onClick={addCoupon} disabled={!can('discount.coupon')}>ใช้</Button></div>
          <div className="row wrap">{order.couponCodes.filter((c) => !c.startsWith('#')).map((c) => <span key={c} className="chip on" onClick={() => usePos.getState().update({ couponCodes: order.couponCodes.filter((x) => x !== c) })}>{c} ✕</span>)}</div>
          <b className="mt">โปรโมชั่น (เลือกใช้)</b>
          {!manualPromos.length && <div className="small muted">โปรโมชั่นอัตโนมัติจะถูกคำนวณให้ทันทีเมื่อเข้าเงื่อนไข</div>}
          {manualPromos.map((p) => (
            <button key={p.id} type="button" className={cls('pay-line')} style={{ cursor: 'pointer', background: order.couponCodes.includes(`#${p.id}`) ? 'var(--primary-50)' : 'var(--surface)' }} onClick={() => can('discount.promotion') ? togglePromo(p) : toast('ไม่มีสิทธิ์ใช้ Promotion', 'error')}>
              <div className="grow" style={{ textAlign: 'left' }}><b>{p.name}</b><div className="xs muted">{PROMOTION_TYPES[p.type]}</div></div>
              {order.couponCodes.includes(`#${p.id}`) && <Badge tone="success">ใช้อยู่</Badge>}
            </button>
          ))}
          {order.billDiscounts.filter((d) => d.source === 'reward').map((d) => (
            <div key={d.redemptionId} className="pay-line"><span className="grow">{d.label}</span><Button size="sm" variant="ghost" onClick={async () => {
              await usePos.getState().flushSave();
              usePos.setState({ order: fromServer(await api(`/orders/${order.id}/redemptions/${d.redemptionId}`, { method: 'DELETE' })) });
            }}>นำออก</Button></div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function ItemModal({ item, onClose, onEditOptions, onVoid }) {
  const { staff, can } = useApp();
  const product = usePos.getState().productById(item.productId);
  const [qty, setQty] = useState(item.qty);
  const [note, setNote] = useState(item.note || '');
  const d0 = (item.discounts || []).find((d) => !d.source || d.source === 'manual');
  const [dType, setDType] = useState(d0?.type || 'pct');
  const [dVal, setDVal] = useState(d0 ? String(d0.value) : '');
  const [override, setOverride] = useState(item.priceOverride != null ? String(item.priceOverride) : '');
  const sent = item.status === 'sent';
  const save = () => {
    const v = Number(dVal) || 0;
    usePos.getState().setItem(item.id, {
      qty, note: note.trim() || null,
      discounts: v > 0 ? [{ type: dType, value: v, label: dType === 'pct' ? `ลด ${v}%` : `ลด ${v}฿`, source: 'manual' }] : [],
      priceOverride: override === '' ? null : Number(override),
    });
    onClose();
  };
  return (
    <Modal title={`${item.name}${item.variantName ? ` (${item.variantName})` : ''}`} onClose={onClose}
      footer={sent ? <><Button variant="danger" icon="trash" onClick={onVoid}>Void รายการนี้</Button><Button onClick={onClose}>ปิด</Button></>
        : <><Button variant="danger" icon="trash" onClick={onVoid} disabled={!can('pos.remove_item')}>ลบ</Button><Button onClick={onClose}>ยกเลิก</Button><Button variant="primary" onClick={save}>บันทึก</Button></>}>
      {sent ? (
        <div className="col"><Badge tone="info">ส่งครัวแล้ว — แก้ไขไม่ได้ (Void ได้พร้อมเหตุผล)</Badge><div>จำนวน {item.qty} · ฿{money(item.unitPrice)}</div>{item.modifiers.length > 0 && <div className="muted">{item.modifiers.map((m) => m.name).join(', ')}</div>}</div>
      ) : (
        <div className="col gap-l">
          {(product?.variants.length > 0 || product?.modifierGroupIds.length > 0) && <Button icon="edit" onClick={onEditOptions} disabled={!can('pos.edit_modifier')}>แก้ตัวเลือก (Size / Topping / …)</Button>}
          <div className="row"><span className="label grow">จำนวน</span><Button icon="minus" onClick={() => setQty(Math.max(1, qty - 1))} /><b className="num" style={{ fontSize: 22, minWidth: 40, textAlign: 'center' }}>{qty}</b><Button icon="plus" onClick={() => setQty(qty + 1)} /></div>
          <TextArea label="หมายเหตุ" value={note} onValue={setNote} rows={2} disabled={!can('pos.note')} />
          <div className="col">
            <span className="label">ส่วนลดรายการ (สิทธิ์สูงสุด {staff?.maxDiscountPct}%)</span>
            <div className="row"><Seg value={dType} onChange={setDType} options={[{ value: 'pct', label: '%' }, { value: 'amount', label: '฿' }]} /><Input type="number" min={0} value={dVal} onValue={(v) => setDVal(String(v))} placeholder="0" disabled={!can('discount.item')} /></div>
          </div>
          <Input label="เปลี่ยนราคาต่อหน่วย (Override Price)" type="number" min={0} value={override} onValue={(v) => setOverride(String(v))} placeholder={`ราคาปกติ ${money(item.unitPrice)}`} hint="ต้องได้รับสิทธิ์ Override Price หรือการอนุมัติจากผู้จัดการ" />
        </div>
      )}
    </Modal>
  );
}

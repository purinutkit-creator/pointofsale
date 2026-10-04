// Promotion Engine admin: BOGO, ซื้อ X ลด %, ครบ X ลด Y, Bundle, Happy Hour, Member Price, Coupon, Double Point, Bonus Points
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Modal, Input, Select, Toggle, TextArea, DataTable, useAsync, Badge, Seg, Check } from '../../components/ui.jsx';

const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

export default function Promotions() {
  const data = useAsync(() => api('/promotions'));
  const refs = useAsync(async () => ({ products: await api('/products'), categories: await api('/categories'), tiers: await api('/tiers'), branches: await api('/branches') }));
  const [edit, setEdit] = useState(null);
  const types = data.data?.types || {};
  const save = async () => {
    const e = edit;
    const body = { name: e.name, description: e.description || null, imageUrl: e.image_url || null, type: e.type, rule: e.rule, conditions: e.conditions, startAt: e.start_at || null, endAt: e.end_at || null, priority: Number(e.priority) || 0, stackable: !!e.stackable, autoApply: e.auto_apply !== false, showMember: !!e.show_member, active: e.active !== false };
    try { if (e.id) await api(`/promotions/${e.id}`, { method: 'PUT', body }); else await api('/promotions', { method: 'POST', body }); toast('บันทึกโปรโมชั่นแล้ว', 'success'); setEdit(null); data.reload(); } catch (err) { toast(err.message, 'error'); }
  };
  const r = edit?.rule || {}; const c = edit?.conditions || {};
  const setR = (k, v) => setEdit({ ...edit, rule: { ...edit.rule, [k]: v } });
  const setC = (k, v) => setEdit({ ...edit, conditions: { ...edit.conditions, [k]: v } });
  const idList = (obj, k, id, on) => (on ? [...(obj[k] || []), id] : (obj[k] || []).filter((x) => Number(x) !== id));
  const pickProducts = (target, k) => refs.data && (
    <div className="grid-2">
      <div className="card pad" style={{ maxHeight: 180, overflow: 'auto' }}><b className="small">สินค้า</b>{refs.data.products.map((p) => <Check key={p.id} label={p.name} checked={(target[k.p] || []).map(Number).includes(p.id)} onChange={(on) => (target === r ? setR : setC)(k.p, idList(target, k.p, p.id, on))} />)}</div>
      <div className="card pad" style={{ maxHeight: 180, overflow: 'auto' }}><b className="small">หมวดสินค้า</b>{refs.data.categories.map((x) => <Check key={x.id} label={x.name} checked={(target[k.c] || []).map(Number).includes(x.id)} onChange={(on) => (target === r ? setR : setC)(k.c, idList(target, k.c, x.id, on))} />)}</div>
    </div>
  );
  const discountFields = (allowPrice) => (
    <div className="grid-3">
      <Select label="รูปแบบส่วนลด" value={r.discountType || 'pct'} onValue={(v) => setR('discountType', v)} options={[{ value: 'pct', label: 'เปอร์เซ็นต์ %' }, { value: 'amount', label: 'จำนวนเงิน (บาท)' }, ...(allowPrice ? [{ value: 'price', label: 'ราคาพิเศษ (บาท/ชิ้น)' }] : [])]} />
      <Input label="มูลค่า" type="number" value={r.value ?? ''} onValue={(v) => setR('value', v)} />
      {r.discountType !== 'price' && <Input label="ลดสูงสุด (บาท)" type="number" value={r.maxDiscount ?? ''} onValue={(v) => setR('maxDiscount', v)} />}
    </div>
  );
  return (
    <Page title="โปรโมชั่น" actions={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', type: 'spend_discount', rule: { discountType: 'amount', value: 50, minSpend: 500 }, conditions: {}, priority: 0, stackable: true, auto_apply: true, active: true })}>สร้างโปรโมชั่น</Button>}>
      <DataTable rows={data.data?.promotions || []} onRow={(p) => setEdit({ ...p })}
        columns={[{ key: 'name', label: 'โปรโมชั่น', render: (p) => <b>{p.name}</b> }, { key: 'type', label: 'ประเภท', render: (p) => types[p.type] }, { key: 'period', label: 'ช่วงเวลา', render: (p) => `${p.start_at?.slice(0, 10) || '-'} → ${p.end_at?.slice(0, 10) || '-'}${p.conditions?.timeStart ? ` · ${p.conditions.timeStart}-${p.conditions.timeEnd}` : ''}` }, { key: 'code', label: 'Coupon', render: (p) => p.rule?.code || '' }, { key: 'auto', label: 'ใช้อัตโนมัติ', render: (p) => (p.auto_apply ? 'อัตโนมัติ' : 'พนักงานเลือก') }, { key: 'active', label: 'สถานะ', render: (p) => <Badge tone={p.active ? 'success' : ''}>{p.active ? 'เปิด' : 'ปิด'}</Badge> }]} />
      {edit && (
        <Modal title={edit.id ? `โปรโมชั่น: ${edit.name}` : 'สร้างโปรโมชั่น'} size="xwide" onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/promotions/${edit.id}`, { method: 'DELETE' }); setEdit(null); data.reload(); }}>ปิดใช้งาน</Button>}<Button variant="primary" onClick={save} disabled={!edit.name}>บันทึก</Button></>}>
          <div className="col gap-l">
            <div className="grid-3">
              <Input label="ชื่อโปรโมชั่น" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
              <Select label="ประเภท" value={edit.type} onValue={(v) => setEdit({ ...edit, type: v, rule: {} })} options={Object.entries(types).map(([value, label]) => ({ value, label }))} />
              <Input label="ลำดับความสำคัญ (Priority)" type="number" value={edit.priority} onValue={(v) => setEdit({ ...edit, priority: v })} />
            </div>
            <div className="card pad col">
              <b>กติกา</b>
              {edit.type === 'bogo' && <><div className="grid-3"><Input label="ซื้อ (ชิ้น)" type="number" value={r.buyQty ?? 1} onValue={(v) => setR('buyQty', v)} /><Input label="แถม (ชิ้น)" type="number" value={r.getQty ?? 1} onValue={(v) => setR('getQty', v)} /><Input label="ส่วนลดชิ้นแถม %" type="number" value={r.getDiscountPct ?? 100} onValue={(v) => setR('getDiscountPct', v)} /></div>{pickProducts(r, { p: 'productIds', c: 'categoryIds' })}</>}
              {edit.type === 'qty_discount' && <><Input label="ซื้อขั้นต่ำ (ชิ้น)" type="number" value={r.minQty ?? 2} onValue={(v) => setR('minQty', v)} />{discountFields(false)}{pickProducts(r, { p: 'productIds', c: 'categoryIds' })}</>}
              {edit.type === 'spend_discount' && <><Input label="ยอดซื้อครบ (บาท)" type="number" value={r.minSpend ?? ''} onValue={(v) => setR('minSpend', v)} />{discountFields(false)}</>}
              {edit.type === 'coupon' && <><Input label="รหัสคูปอง" value={r.code || ''} onValue={(v) => setR('code', v.toUpperCase())} /><Input label="ยอดขั้นต่ำ" type="number" value={r.minSpend ?? ''} onValue={(v) => setR('minSpend', v)} />{discountFields(false)}<div className="xs muted">เลือกสินค้า/หมวดเพื่อจำกัดส่วนลดเฉพาะรายการ (ไม่เลือก = ลดท้ายบิล)</div>{pickProducts(r, { p: 'productIds', c: 'categoryIds' })}</>}
              {(edit.type === 'happy_hour' || edit.type === 'member_price') && <>{discountFields(true)}{pickProducts(r, { p: 'productIds', c: 'categoryIds' })}</>}
              {edit.type === 'bundle' && (
                <>
                  <Input label="ราคาชุด (บาท)" type="number" value={r.bundlePrice ?? ''} onValue={(v) => setR('bundlePrice', v)} />
                  {(r.items || []).map((it, i) => (
                    <div key={i} className="row"><Select value={it.productId || ''} onValue={(v) => setR('items', r.items.map((x, k) => (k === i ? { ...x, productId: Number(v) } : x)))} placeholder="— สินค้า —" options={(refs.data?.products || []).map((p) => ({ value: p.id, label: p.name }))} /><Input type="number" value={it.qty} onValue={(v) => setR('items', r.items.map((x, k) => (k === i ? { ...x, qty: Number(v) } : x)))} style={{ maxWidth: 100 }} /><Button size="sm" variant="ghost" icon="trash" onClick={() => setR('items', r.items.filter((_, k) => k !== i))} /></div>
                  ))}
                  <Button size="sm" icon="plus" onClick={() => setR('items', [...(r.items || []), { productId: '', qty: 1 }])}>เพิ่มสินค้าในชุด</Button>
                </>
              )}
              {edit.type === 'point_multiplier' && <><Input label="ตัวคูณแต้ม (เช่น 2 = Double Point)" type="number" value={r.multiplier ?? 2} onValue={(v) => setR('multiplier', v)} /><div className="xs muted">เช่น ทุกวันศุกร์ Points x2 → ตั้งวัน = ศ</div></>}
              {edit.type === 'bonus_points' && <div className="grid-2"><Input label="แต้มโบนัส" type="number" value={r.points ?? ''} onValue={(v) => setR('points', v)} /><div className="xs muted">ตั้ง "ยอดซื้อขั้นต่ำ" ในเงื่อนไขด้านล่าง เช่น ซื้อครบ 1,000 รับ Bonus 50 Points</div></div>}
            </div>
            <div className="card pad col">
              <b>เงื่อนไข</b>
              <div className="grid-4">
                <Input label="วันเริ่ม" type="date" value={(edit.start_at || '').slice(0, 10)} onValue={(v) => setEdit({ ...edit, start_at: v ? `${v}T00:00:00+07:00` : '' })} />
                <Input label="วันสิ้นสุด" type="date" value={(edit.end_at || '').slice(0, 10)} onValue={(v) => setEdit({ ...edit, end_at: v ? `${v}T23:59:59+07:00` : '' })} />
                <Input label="เวลาเริ่ม" type="time" value={c.timeStart || ''} onValue={(v) => setC('timeStart', v)} />
                <Input label="เวลาสิ้นสุด" type="time" value={c.timeEnd || ''} onValue={(v) => setC('timeEnd', v)} />
                <Input label="ยอดซื้อขั้นต่ำ (บาท)" type="number" value={c.minSpend ?? ''} onValue={(v) => setC('minSpend', v)} />
              </div>
              <div className="row wrap"><span className="label">วัน:</span>{DAYS.map((d, i) => <Check key={i} label={d} checked={(c.days || []).includes(i)} onChange={(on) => setC('days', on ? [...(c.days || []), i] : (c.days || []).filter((x) => x !== i))} />)}</div>
              <div className="row wrap"><span className="label">ประเภทบิล:</span>{[['dine_in', 'ทานที่ร้าน'], ['takeaway', 'กลับบ้าน']].map(([k, l]) => <Check key={k} label={l} checked={(c.orderTypes || []).includes(k)} onChange={(on) => setC('orderTypes', on ? [...(c.orderTypes || []), k] : (c.orderTypes || []).filter((x) => x !== k))} />)}</div>
              {refs.data && <div className="row wrap"><span className="label">สาขา:</span>{refs.data.branches.map((b) => <Check key={b.id} label={b.name} checked={(c.branchIds || []).map(Number).includes(b.id)} onChange={(on) => setC('branchIds', idList(c, 'branchIds', b.id, on))} />)}</div>}
              {refs.data && <div className="row wrap"><span className="label">Tier สมาชิก:</span>{refs.data.tiers.map((t) => <Check key={t.id} label={t.name} checked={(c.tierIds || []).map(Number).includes(t.id)} onChange={(on) => setC('tierIds', idList(c, 'tierIds', t.id, on))} />)}<Check label="เฉพาะสมาชิก" checked={!!c.memberOnly} onChange={(v) => setC('memberOnly', v)} /></div>}
            </div>
            <div className="grid-4">
              <Toggle label="เปิดใช้งาน" checked={edit.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} />
              <Toggle label="ใช้อัตโนมัติ" checked={edit.auto_apply !== false} onChange={(v) => setEdit({ ...edit, auto_apply: v })} />
              <Toggle label="ใช้ร่วมกับโปรอื่นได้" checked={!!edit.stackable} onChange={(v) => setEdit({ ...edit, stackable: v })} />
              <Toggle label="แสดงในหน้าสมาชิก" checked={!!edit.show_member} onChange={(v) => setEdit({ ...edit, show_member: v })} />
            </div>
            <div className="grid-2"><Input label="รูป (URL)" value={edit.image_url || ''} onValue={(v) => setEdit({ ...edit, image_url: v })} /><TextArea label="รายละเอียด" value={edit.description || ''} onValue={(v) => setEdit({ ...edit, description: v })} rows={2} /></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
export { Seg };

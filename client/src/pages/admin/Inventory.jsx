// Inventory: stock on hand, stock in/out/adjust, movements, ingredients, suppliers, purchase orders, waste
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Modal, Input, Select, TextArea, DataTable, useAsync, Badge, Seg } from '../../components/ui.jsx';
import { money, fmtDateTime } from '../../lib/util.js';

const MV = { in: 'รับเข้า', out: 'นำออก', sale: 'ขาย', waste: 'ของเสีย', adjust: 'ปรับยอด', refund: 'คืนสินค้า', po_receive: 'รับจาก PO', void_return: 'คืนจาก Void' };
const WASTE = { expired: 'หมดอายุ (Expired)', damaged: 'เสียหาย (Damaged)', wrong_preparation: 'ทำผิด (Wrong Preparation)', lost: 'สูญหาย (Lost)', other: 'อื่นๆ (Other)' };
const PO_ST = { draft: 'Draft', ordered: 'Ordered', partial: 'Partial Received', received: 'Received', cancelled: 'Cancelled' };

export default function Inventory() {
  const [tab, setTab] = useState('stock');
  return (
    <Page title="สต็อก / วัตถุดิบ" tab={tab} onTab={setTab} tabs={[{ value: 'stock', label: 'คงเหลือ (Remaining)' }, { value: 'movements', label: 'ความเคลื่อนไหว' }, { value: 'ingredients', label: 'วัตถุดิบ' }, { value: 'waste', label: 'ของเสีย (Waste)' }, { value: 'po', label: 'ใบสั่งซื้อ (PO)' }, { value: 'suppliers', label: 'Supplier' }]}>
      {tab === 'stock' && <Stock />}
      {tab === 'movements' && <Movements />}
      {tab === 'ingredients' && <Ingredients />}
      {tab === 'waste' && <Waste />}
      {tab === 'po' && <POs />}
      {tab === 'suppliers' && <Suppliers />}
    </Page>
  );
}

function Stock() {
  const can = useApp((s) => s.can);
  const inv = useAsync(() => api('/inventory'));
  const [mv, setMv] = useState(null);
  const rows = inv.data ? [...inv.data.products.map((p) => ({ ...p, key: `p${p.id}`, kind: 'สินค้า' })), ...inv.data.ingredients.map((g) => ({ ...g, key: `i${g.id}`, kind: 'วัตถุดิบ' }))] : [];
  const submit = async () => {
    try { await api('/inventory/movements', { method: 'POST', body: { type: mv.type, reason: mv.reason, items: [{ itemType: mv.item.item_type, itemId: mv.item.id, qty: Number(mv.qty), unitCost: mv.unitCost !== '' && mv.unitCost != null ? Number(mv.unitCost) : undefined }] } }); toast('บันทึกแล้ว', 'success'); setMv(null); inv.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="col">
      <div className="small muted">สินค้าที่เปิด "ติดตามสต็อก" และวัตถุดิบทั้งหมด · Low Stock แจ้งเตือนอัตโนมัติ</div>
      <DataTable rows={rows.map((r) => ({ ...r, id: r.key }))} columns={[
        { key: 'kind', label: 'ประเภท' }, { key: 'name', label: 'รายการ', render: (r) => <b>{r.name}</b> },
        { key: 'qty', label: 'คงเหลือ', num: true, render: (r) => <span style={{ color: r.low ? 'var(--danger)' : undefined, fontWeight: 700 }}>{Math.round(r.qty * 1000) / 1000} {r.unit}</span> },
        { key: 'min_stock', label: 'ขั้นต่ำ', num: true }, { key: 'sold_30d', label: 'ใช้/ขาย 30 วัน', num: true, render: (r) => Math.round(r.sold_30d * 100) / 100 },
        ...(can('stock.view_cost') ? [{ key: 'value', label: 'มูลค่า', num: true, render: (r) => money(r.value) }] : []),
        { key: 'low', label: '', render: (r) => (r.low ? <Badge tone="danger">Low Stock</Badge> : null) },
        { key: 'act', label: '', render: (r) => <span className="row gap-s" onClick={(e) => e.stopPropagation()}>
          {can('stock.in') && <Button size="sm" onClick={() => setMv({ type: 'in', item: r, qty: '', reason: '', unitCost: '' })}>Stock In</Button>}
          {can('stock.out') && <Button size="sm" onClick={() => setMv({ type: 'out', item: r, qty: '', reason: '' })}>Stock Out</Button>}
          {can('stock.adjust') && <Button size="sm" onClick={() => setMv({ type: 'adjust', item: r, qty: r.qty, reason: 'ตรวจนับสต็อก' })}>Adjust</Button>}
        </span> },
      ]} />
      {mv && (
        <Modal title={`${{ in: 'Stock In', out: 'Stock Out', adjust: 'Adjustment (ตั้งยอดคงเหลือ)' }[mv.type]}: ${mv.item.name}`} size="narrow" onClose={() => setMv(null)} footer={<Button variant="primary" onClick={submit}>บันทึก</Button>}>
          <div className="col">
            <div className="muted">คงเหลือปัจจุบัน {mv.item.qty} {mv.item.unit}</div>
            <Input label={mv.type === 'adjust' ? 'ยอดนับได้จริง' : 'จำนวน'} type="number" value={mv.qty} onValue={(v) => setMv({ ...mv, qty: v })} size="lg" />
            {mv.type === 'in' && mv.item.item_type === 'ingredient' && <Input label="ต้นทุนต่อหน่วย (คำนวณต้นทุนเฉลี่ย)" type="number" value={mv.unitCost} onValue={(v) => setMv({ ...mv, unitCost: v })} />}
            <Input label="เหตุผล / อ้างอิง" value={mv.reason} onValue={(v) => setMv({ ...mv, reason: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Movements() {
  const [type, setType] = useState('');
  const list = useAsync(() => api(`/inventory/movements${type ? `?type=${type}` : ''}`), [type]);
  return (
    <div className="col">
      <Seg value={type} onChange={setType} options={[{ value: '', label: 'ทั้งหมด' }, ...Object.entries(MV).map(([value, label]) => ({ value, label }))]} />
      <DataTable rows={list.data || []} columns={[{ key: 'created_at', label: 'เวลา', render: (m) => fmtDateTime(m.created_at) }, { key: 'item_name', label: 'รายการ' }, { key: 'type', label: 'ประเภท', render: (m) => <Badge tone={m.qty > 0 ? 'success' : 'warning'}>{MV[m.type]}</Badge> }, { key: 'qty', label: 'จำนวน', num: true, render: (m) => `${m.qty > 0 ? '+' : ''}${Math.round(m.qty * 1000) / 1000} ${m.unit}` }, { key: 'balance', label: 'คงเหลือ', num: true, render: (m) => Math.round(m.balance * 1000) / 1000 }, { key: 'ref', label: 'อ้างอิง', render: (m) => `${m.ref_type || ''} ${m.reason || ''}` }, { key: 'staff_name', label: 'โดย' }]} />
    </div>
  );
}

function Ingredients() {
  const can = useApp((s) => s.can);
  const list = useAsync(() => api('/ingredients'));
  const sups = useAsync(() => api('/suppliers').catch(() => []));
  const [edit, setEdit] = useState(null);
  const save = async () => {
    const b = { name: edit.name, unit: edit.unit, costPerUnit: Number(edit.cost_per_unit) || 0, minStock: Number(edit.min_stock) || 0, sku: edit.sku || null, supplierId: edit.supplier_id ? Number(edit.supplier_id) : null };
    try { if (edit.id) await api(`/ingredients/${edit.id}`, { method: 'PUT', body: b }); else await api('/ingredients', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="col">
      <DataTable rows={list.data || []} onRow={(g) => setEdit({ ...g })} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', unit: 'g', cost_per_unit: 0, min_stock: 0 })}>เพิ่มวัตถุดิบ</Button>}
        columns={[{ key: 'name', label: 'วัตถุดิบ', render: (g) => <b>{g.name}</b> }, { key: 'unit', label: 'หน่วย' }, ...(can('stock.view_cost') ? [{ key: 'cost_per_unit', label: 'ต้นทุน/หน่วย', num: true }] : []), { key: 'min_stock', label: 'ขั้นต่ำ', num: true }, { key: 'sku', label: 'SKU' }]} />
      {edit && (
        <Modal title={edit.id ? edit.name : 'เพิ่มวัตถุดิบ'} size="narrow" onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { try { await api(`/ingredients/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); } }}>ลบ</Button>}<Button variant="primary" onClick={save}>บันทึก</Button></>}>
          <div className="col">
            <Input label="ชื่อ เช่น Tea" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            <Select label="หน่วย" value={edit.unit} onValue={(v) => setEdit({ ...edit, unit: v })} options={['g', 'kg', 'ml', 'l', 'ชิ้น', 'ฟอง', 'ขวด', 'แพ็ค']} />
            {can('stock.view_cost') && <Input label="ต้นทุนต่อหน่วย" type="number" value={edit.cost_per_unit} onValue={(v) => setEdit({ ...edit, cost_per_unit: v })} />}
            <Input label="Minimum Stock" type="number" value={edit.min_stock} onValue={(v) => setEdit({ ...edit, min_stock: v })} />
            <Input label="SKU" value={edit.sku || ''} onValue={(v) => setEdit({ ...edit, sku: v })} />
            <Select label="Supplier" value={edit.supplier_id ?? ''} onValue={(v) => setEdit({ ...edit, supplier_id: v })} placeholder="—" options={(sups.data || []).map((s) => ({ value: s.id, label: s.name }))} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function useItems() {
  return useAsync(async () => {
    const [products, ingredients] = await Promise.all([api('/products'), api('/ingredients')]);
    return [...products.filter((p) => p.trackStock).map((p) => ({ value: `product:${p.id}`, label: `สินค้า · ${p.name}`, cost: p.cost })), ...ingredients.map((g) => ({ value: `ingredient:${g.id}`, label: `วัตถุดิบ · ${g.name} (${g.unit})`, cost: g.cost_per_unit }))];
  });
}

function Waste() {
  const can = useApp((s) => s.can);
  const list = useAsync(() => api('/waste'));
  const items = useItems();
  const [f, setF] = useState(null);
  const save = async () => {
    const [itemType, itemId] = f.item.split(':');
    try { await api('/waste', { method: 'POST', body: { itemType, itemId: Number(itemId), qty: Number(f.qty), reason: f.reason, note: f.note || undefined } }); setF(null); list.reload(); toast('บันทึกของเสียแล้ว (ตัดสต็อก + เก็บต้นทุน)', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="col">
      <DataTable rows={list.data || []} toolbar={can('stock.waste') && <Button variant="primary" icon="plus" onClick={() => setF({ item: '', qty: '', reason: 'expired', note: '' })}>บันทึกของเสีย</Button>}
        columns={[{ key: 'created_at', label: 'เวลา', render: (w) => fmtDateTime(w.created_at) }, { key: 'name', label: 'รายการ' }, { key: 'qty', label: 'จำนวน', num: true }, { key: 'reason', label: 'สาเหตุ', render: (w) => WASTE[w.reason] }, ...(can('stock.view_cost') ? [{ key: 'cost', label: 'ต้นทุน', num: true, render: (w) => money(w.cost) }] : []), { key: 'staff_name', label: 'ผู้บันทึก' }, { key: 'note', label: 'หมายเหตุ' }]} />
      {f && (
        <Modal title="บันทึกของเสีย (Waste)" size="narrow" onClose={() => setF(null)} footer={<Button variant="primary" onClick={save} disabled={!f.item || !(Number(f.qty) > 0)}>บันทึก</Button>}>
          <div className="col">
            <Select label="รายการ" value={f.item} onValue={(v) => setF({ ...f, item: v })} placeholder="— เลือก —" options={(items.data || []).concat([])} />
            <div className="xs muted">ของเสียที่เป็นสินค้าแบบมีสูตร จะตัดวัตถุดิบตามสูตรอัตโนมัติ</div>
            <Input label="จำนวน" type="number" value={f.qty} onValue={(v) => setF({ ...f, qty: v })} />
            <Select label="สาเหตุ" value={f.reason} onValue={(v) => setF({ ...f, reason: v })} options={Object.entries(WASTE).map(([value, label]) => ({ value, label }))} />
            <TextArea label="หมายเหตุ" value={f.note} onValue={(v) => setF({ ...f, note: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Suppliers() {
  const list = useAsync(() => api('/suppliers'));
  const [edit, setEdit] = useState(null);
  const save = async () => {
    const b = { name: edit.name, contact: edit.contact || null, phone: edit.phone || null, email: edit.email || null, address: edit.address || null, taxId: edit.tax_id || null, note: edit.note || null };
    try { if (edit.id) await api(`/suppliers/${edit.id}`, { method: 'PUT', body: b }); else await api('/suppliers', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="col">
      <DataTable rows={list.data || []} onRow={(s) => setEdit({ ...s })} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '' })}>เพิ่ม Supplier</Button>}
        columns={[{ key: 'name', label: 'ชื่อ', render: (s) => <b>{s.name}</b> }, { key: 'contact', label: 'ผู้ติดต่อ' }, { key: 'phone', label: 'โทร' }, { key: 'email', label: 'อีเมล' }, { key: 'tax_id', label: 'Tax ID' }]} />
      {edit && (
        <Modal title="Supplier" onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/suppliers/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); }}>ลบ</Button>}<Button variant="primary" onClick={save} disabled={!edit.name}>บันทึก</Button></>}>
          <div className="grid-2">
            <Input label="ชื่อ *" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            <Input label="ผู้ติดต่อ" value={edit.contact || ''} onValue={(v) => setEdit({ ...edit, contact: v })} />
            <Input label="โทร" value={edit.phone || ''} onValue={(v) => setEdit({ ...edit, phone: v })} />
            <Input label="อีเมล" value={edit.email || ''} onValue={(v) => setEdit({ ...edit, email: v })} />
            <Input label="Tax ID" value={edit.tax_id || ''} onValue={(v) => setEdit({ ...edit, tax_id: v })} />
            <Input label="ที่อยู่" value={edit.address || ''} onValue={(v) => setEdit({ ...edit, address: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function POs() {
  const can = useApp((s) => s.can);
  const list = useAsync(() => api('/purchase-orders'));
  const sups = useAsync(() => api('/suppliers'));
  const items = useItems();
  const [edit, setEdit] = useState(null);
  const [recv, setRecv] = useState(null);
  const open = async (po) => {
    if (!po) return setEdit({ supplierId: '', note: '', expectedAt: '', items: [{ item: '', qty: 1, unitCost: 0 }], status: 'draft' });
    const d = await api(`/purchase-orders/${po.id}`);
    setEdit({ ...d, supplierId: d.supplier_id || '', expectedAt: d.expected_at || '', items: d.items.map((i) => ({ id: i.id, item: `${i.item_type}:${i.item_id}`, qty: i.qty, unitCost: i.unit_cost, received: i.received_qty, name: i.name })) });
  };
  const save = async () => {
    const body = { supplierId: edit.supplierId ? Number(edit.supplierId) : null, note: edit.note || null, expectedAt: edit.expectedAt || null, items: edit.items.filter((i) => i.item).map((i) => ({ itemType: i.item.split(':')[0], itemId: Number(i.item.split(':')[1]), qty: Number(i.qty), unitCost: Number(i.unitCost) || 0 })) };
    try { if (edit.id) await api(`/purchase-orders/${edit.id}`, { method: 'PUT', body }); else await api('/purchase-orders', { method: 'POST', body }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const status = async (s) => { try { await api(`/purchase-orders/${edit.id}/status`, { method: 'POST', body: { status: s } }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); } };
  const receive = async () => {
    try { await api(`/purchase-orders/${recv.id}/receive`, { method: 'POST', body: { items: recv.items.map((i) => ({ id: i.id, qty: Number(i.now) || 0 })) } }); toast('รับสินค้าเข้าสต็อกแล้ว', 'success'); setRecv(null); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const editable = !edit?.id || ['draft', 'ordered'].includes(edit.status);
  return (
    <div className="col">
      <DataTable rows={list.data || []} onRow={open} toolbar={can('stock.po') && <Button variant="primary" icon="plus" onClick={() => open(null)}>สร้าง PO</Button>}
        columns={[{ key: 'po_no', label: 'เลขที่', render: (p) => <b>{p.po_no}</b> }, { key: 'supplier_name', label: 'Supplier' }, { key: 'item_count', label: 'รายการ', num: true }, { key: 'total', label: 'ยอด', num: true, render: (p) => money(p.total) }, { key: 'status', label: 'สถานะ', render: (p) => <Badge tone={p.status === 'received' ? 'success' : p.status === 'cancelled' ? 'danger' : p.status === 'partial' ? 'warning' : 'info'}>{PO_ST[p.status]}</Badge> }, { key: 'created_at', label: 'สร้างเมื่อ', render: (p) => fmtDateTime(p.created_at) }]} />
      {edit && (
        <Modal title={edit.id ? `${edit.po_no} · ${PO_ST[edit.status]}` : 'สร้างใบสั่งซื้อ'} size="wide" onClose={() => setEdit(null)}
          footer={<>
            {edit.id && edit.status === 'draft' && <Button onClick={() => status('ordered')}>ยืนยันสั่งซื้อ (Ordered)</Button>}
            {edit.id && ['ordered', 'partial', 'draft'].includes(edit.status) && can('stock.in') && <Button variant="success" onClick={() => setRecv({ id: edit.id, items: edit.items.map((i) => ({ ...i, now: Math.max(0, i.qty - (i.received || 0)) })) })}>รับสินค้า</Button>}
            {edit.id && !['received', 'cancelled'].includes(edit.status) && <Button variant="danger" onClick={() => status('cancelled')}>ยกเลิก PO</Button>}
            {editable && <Button variant="primary" onClick={save}>บันทึก</Button>}
          </>}>
          <div className="col">
            <div className="grid-3">
              <Select label="Supplier" value={edit.supplierId} onValue={(v) => setEdit({ ...edit, supplierId: v })} placeholder="—" options={(sups.data || []).map((s) => ({ value: s.id, label: s.name }))} disabled={!editable} />
              <Input label="วันที่คาดว่าจะได้รับ" type="date" value={edit.expectedAt} onValue={(v) => setEdit({ ...edit, expectedAt: v })} disabled={!editable} />
              <Input label="หมายเหตุ" value={edit.note || ''} onValue={(v) => setEdit({ ...edit, note: v })} disabled={!editable} />
            </div>
            {edit.items.map((it, i) => (
              <div key={i} className="row">
                <Select value={it.item} onValue={(v) => setEdit({ ...edit, items: edit.items.map((x, k) => (k === i ? { ...x, item: v, unitCost: (items.data || []).find((o) => o.value === v)?.cost || x.unitCost } : x)) })} placeholder="— รายการ —" options={items.data || []} disabled={!editable} />
                <Input type="number" value={it.qty} onValue={(v) => setEdit({ ...edit, items: edit.items.map((x, k) => (k === i ? { ...x, qty: v } : x)) })} style={{ maxWidth: 100 }} disabled={!editable} />
                <Input type="number" value={it.unitCost} onValue={(v) => setEdit({ ...edit, items: edit.items.map((x, k) => (k === i ? { ...x, unitCost: v } : x)) })} style={{ maxWidth: 120 }} disabled={!editable} />
                {it.received != null && <span className="small muted nowrap">รับแล้ว {it.received}</span>}
                {editable && <Button size="sm" variant="ghost" icon="trash" onClick={() => setEdit({ ...edit, items: edit.items.filter((_, k) => k !== i) })} />}
              </div>
            ))}
            {editable && <Button size="sm" icon="plus" onClick={() => setEdit({ ...edit, items: [...edit.items, { item: '', qty: 1, unitCost: 0 }] })}>เพิ่มรายการ</Button>}
            <div className="right bold">รวม ฿{money(edit.items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.unitCost) || 0), 0))}</div>
          </div>
        </Modal>
      )}
      {recv && (
        <Modal title="รับสินค้า (รับบางส่วนได้)" size="narrow" onClose={() => setRecv(null)} footer={<Button variant="success" onClick={receive}>ยืนยันรับเข้าสต็อก</Button>}>
          <div className="col">{recv.items.map((i, k) => <div key={i.id} className="row"><span className="grow">{i.name}</span><Input type="number" value={i.now} onValue={(v) => setRecv({ ...recv, items: recv.items.map((x, j) => (j === k ? { ...x, now: v } : x)) })} style={{ maxWidth: 110 }} /></div>)}</div>
        </Modal>
      )}
    </div>
  );
}

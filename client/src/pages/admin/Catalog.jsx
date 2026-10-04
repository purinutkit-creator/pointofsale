import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Modal, Input, Select, Toggle, TextArea, DataTable, useAsync, Badge, Check, useDialog, ErrorBox, Field } from '../../components/ui.jsx';
import { money } from '../../lib/util.js';
import { CUT_MODES } from '@shared/kitchen.js';

const STATUS = { available: 'พร้อมขาย', sold_out: 'Sold Out', unavailable: 'งดขายชั่วคราว' };

export default function Catalog() {
  const [tab, setTab] = useState('products');
  return (
    <Page title="สินค้า" tabs={[{ value: 'products', label: 'สินค้า' }, { value: 'categories', label: 'หมวดหมู่ (Category)' }, { value: 'modifiers', label: 'ตัวเลือก (Modifier)' }, { value: 'stations', label: 'สถานีครัว (Station)' }]} tab={tab} onTab={setTab}>
      {tab === 'products' && <Products />}
      {tab === 'categories' && <Categories />}
      {tab === 'modifiers' && <Modifiers />}
      {tab === 'stations' && <Stations />}
    </Page>
  );
}

function useRefs() {
  return useAsync(async () => {
    const [categories, stations, printers, groups, ingredients, branches] = await Promise.all([api('/categories'), api('/stations'), api('/printers'), api('/modifier-groups'), api('/ingredients').catch(() => []), api('/branches')]);
    return { categories, stations, printers, groups, ingredients, branches };
  });
}

function Products() {
  const can = useApp((s) => s.can);
  const list = useAsync(() => api('/products'));
  const refs = useRefs();
  const [edit, setEdit] = useState(null);
  const open = async (id) => {
    if (!id) return setEdit({ name: '', price: 0, cost: 0, cutMode: 'none', status: 'available', variants: [], modifierGroupIds: [], recipe: [], branchPrices: [], autoSoldOut: true });
    const p = await api(`/products/${id}`);
    setEdit({
      id: p.id, sku: p.sku || '', barcode: p.barcode || '', name: p.name, nameEn: p.name_en || '', description: p.description || '', imageUrl: p.image_url || '', categoryId: p.category_id,
      price: p.price, cost: p.cost, vatExempt: !!p.vat_exempt, scExempt: !!p.sc_exempt, trackStock: !!p.track_stock, minStock: p.min_stock, autoSoldOut: !!p.auto_sold_out,
      stationId: p.station_id, printerId: p.printer_id, cutMode: p.cut_mode, pointMultiplier: p.point_multiplier, noPromotion: !!p.no_promotion, status: p.status, sortOrder: p.sort_order,
      variants: p.variants.map((v) => ({ id: v.id, name: v.name, priceDelta: v.price_delta, sku: v.sku, barcode: v.barcode, isDefault: !!v.is_default })),
      modifierGroupIds: p.modifierGroupIds, recipe: p.recipe.filter((r) => !r.variant_id).map((r) => ({ ingredientId: r.ingredient_id, qty: r.qty })),
      branchPrices: p.branchPrices.map((b) => ({ branchId: b.branch_id, price: b.price, status: b.status, hidden: !!b.hidden })),
    });
  };
  const toggleSold = async (p) => { try { await api(`/products/${p.id}/status`, { method: 'POST', body: { status: p.status === 'available' ? 'sold_out' : 'available' } }); list.reload(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="col">
      <ErrorBox error={list.error} />
      <DataTable rows={list.data || []} onRow={(p) => can('product.edit') && open(p.id)}
        toolbar={can('product.create') && <Button variant="primary" icon="plus" onClick={() => open(null)}>เพิ่มสินค้า</Button>}
        columns={[
          { key: 'img', label: '', width: 56, render: (p) => (p.imageUrl ? <img src={p.imageUrl} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} /> : null) },
          { key: 'name', label: 'สินค้า', render: (p) => <><b>{p.name}</b><div className="xs muted">{p.sku} {p.barcode}</div></> },
          { key: 'categoryName', label: 'หมวด' },
          { key: 'price', label: 'ราคา', num: true, render: (p) => money(p.price) },
          { key: 'stock', label: 'Stock', num: true, render: (p) => (p.trackStock ? p.stock : '-') },
          { key: 'cutMode', label: 'ตัดใบครัว', render: (p) => (p.cutMode !== 'none' ? <Badge tone="warning">{CUT_MODES[p.cutMode].split(' (')[0]}</Badge> : '') },
          { key: 'status', label: 'สถานะ', render: (p) => <span onClick={(e) => { e.stopPropagation(); if (can('product.sold_out')) toggleSold(p); }}><Badge tone={p.status === 'available' ? 'success' : 'danger'}>{STATUS[p.status]}</Badge></span> },
        ]} />
      {edit && refs.data && <ProductForm value={edit} refs={refs.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

function ProductForm({ value, refs, onClose, onSaved }) {
  const dialog = useDialog();
  const can = useApp((s) => s.can);
  const [f, setF] = useState(value);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, price: Number(f.price) || 0, cost: Number(f.cost) || 0, minStock: Number(f.minStock) || 0, categoryId: num(f.categoryId), stationId: num(f.stationId), printerId: num(f.printerId), pointMultiplier: num(f.pointMultiplier), sortOrder: Number(f.sortOrder) || 0,
        variants: f.variants.map((v) => ({ ...v, priceDelta: Number(v.priceDelta) || 0 })), recipe: f.recipe.filter((r) => r.ingredientId && r.qty > 0).map((r) => ({ ingredientId: Number(r.ingredientId), qty: Number(r.qty) })),
        branchPrices: f.branchPrices.map((b) => ({ ...b, price: num(b.price), status: b.status || null })) };
      delete body.id;
      if (f.id) await api(`/products/${f.id}`, { method: 'PUT', body }); else await api('/products', { method: 'POST', body });
      toast('บันทึกสินค้าแล้ว', 'success'); onSaved();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const remove = async () => { if (!(await dialog.confirm({ message: `ลบสินค้า ${f.name}?`, danger: true }))) return; await api(`/products/${f.id}`, { method: 'DELETE' }); onSaved(); };
  return (
    <Modal title={f.id ? `แก้ไขสินค้า: ${f.name}` : 'เพิ่มสินค้า'} size="xwide" onClose={onClose}
      footer={<>{f.id && can('product.delete') && <Button variant="danger" icon="trash" onClick={remove} style={{ marginRight: 'auto' }}>ลบ</Button>}<Button onClick={onClose}>ยกเลิก</Button><Button variant="primary" loading={busy} onClick={save} disabled={!f.name}>บันทึก</Button></>}>
      <div className="col gap-l">
        <div className="grid-3">
          <Input label="ชื่อสินค้า *" value={f.name} onValue={set('name')} />
          <Input label="English Name" value={f.nameEn} onValue={set('nameEn')} />
          <Select label="หมวดหมู่" value={f.categoryId ?? ''} onValue={set('categoryId')} placeholder="— ไม่ระบุ —" options={refs.categories.map((c) => ({ value: c.id, label: c.name }))} />
          <Input label="ราคา *" type="number" value={f.price} onValue={set('price')} disabled={!!f.id && !can('product.edit_price')} />
          <Input label="ต้นทุน (Cost)" type="number" value={f.cost} onValue={set('cost')} hint="0 = คำนวณจากสูตร (Recipe)" />
          <Select label="สถานะ" value={f.status} onValue={set('status')} options={Object.entries(STATUS).map(([value, label]) => ({ value, label }))} />
          <Input label="SKU" value={f.sku} onValue={set('sku')} />
          <Input label="Barcode" value={f.barcode} onValue={set('barcode')} />
          <Input label="ลำดับการแสดง" type="number" value={f.sortOrder || 0} onValue={set('sortOrder')} />
        </div>
        <div className="grid-2">
          <Input label="รูปสินค้า (ลิงก์รูปภาพ URL)" value={f.imageUrl} onValue={set('imageUrl')} placeholder="https://…" />
          {f.imageUrl ? <img src={f.imageUrl} alt="" style={{ height: 80, borderRadius: 10, objectFit: 'cover' }} /> : <div />}
        </div>
        <TextArea label="รายละเอียด" value={f.description} onValue={set('description')} rows={2} />

        <div className="card pad col">
          <b>ครัว & การพิมพ์ใบครัว</b>
          <div className="grid-3">
            <Select label="Kitchen Station" value={f.stationId ?? ''} onValue={set('stationId')} placeholder="ตามหมวดหมู่" options={refs.stations.map((s) => ({ value: s.id, label: s.name }))} />
            <Select label="Printer (บังคับเครื่องพิมพ์)" value={f.printerId ?? ''} onValue={set('printerId')} placeholder="ตาม Station / หมวด" options={refs.printers.filter((p) => p.role === 'kitchen').map((p) => ({ value: p.id, label: p.name }))} />
            <Select label="ตัดใบพิมพ์ครัวเมื่อพบรายการนี้" value={f.cutMode} onValue={set('cutMode')} options={Object.entries(CUT_MODES).map(([value, label]) => ({ value, label }))} />
          </div>
          <div className="xs muted">
            Cut After = จบใบครัวหลังสินค้านี้และสั่งตัดกระดาษ · Cut Before = ตัดก่อนสินค้านี้ · Separate = พิมพ์แยกใบเดี่ยว · Each Quantity = สั่ง 3 ชิ้นแยก 3 ใบ (เช่น Steak 1/3, 2/3, 3/3) — ทุกใบยังอยู่ใน Order/คิวเดียวกันพร้อมเลขใบย่อย
          </div>
        </div>

        <div className="grid-2">
          <div className="card pad col">
            <b>ภาษี / Service Charge / แต้ม</b>
            <Toggle label="ยกเว้น VAT (VAT Exempt)" checked={f.vatExempt} onChange={set('vatExempt')} />
            <Toggle label="ไม่คิด Service Charge" checked={f.scExempt} onChange={set('scExempt')} />
            <Toggle label="ไม่ร่วมโปรโมชั่น" checked={f.noPromotion} onChange={set('noPromotion')} />
            <Select label="ตัวคูณแต้ม (Point Multiplier)" value={f.pointMultiplier ?? ''} onValue={set('pointMultiplier')} placeholder="ตามหมวด (x1)" options={[{ value: 0, label: 'No Point' }, { value: 1, label: 'x1' }, { value: 2, label: 'x2' }, { value: 3, label: 'x3' }, { value: 1.5, label: 'x1.5' }]} />
          </div>
          <div className="card pad col">
            <b>สต็อก</b>
            <Toggle label="ติดตามสต็อกสินค้านี้ (Track Stock)" checked={f.trackStock} onChange={set('trackStock')} />
            <Input label="Minimum Stock (แจ้งเตือน)" type="number" value={f.minStock || 0} onValue={set('minStock')} />
            <Toggle label="Sold Out อัตโนมัติเมื่อหมด" checked={f.autoSoldOut} onChange={set('autoSoldOut')} />
          </div>
        </div>

        <div className="card pad col">
          <div className="row between"><b>Variant (เช่น Size S/M/L)</b><Button size="sm" icon="plus" onClick={() => set('variants')([...f.variants, { name: '', priceDelta: 0, isDefault: !f.variants.length }])}>เพิ่ม</Button></div>
          {f.variants.map((v, i) => (
            <div key={i} className="row wrap">
              <Input placeholder="ชื่อ เช่น M" value={v.name} onValue={(x) => set('variants')(f.variants.map((y, k) => (k === i ? { ...y, name: x } : y)))} style={{ maxWidth: 160 }} />
              <Input type="number" placeholder="+ราคา" value={v.priceDelta} onValue={(x) => set('variants')(f.variants.map((y, k) => (k === i ? { ...y, priceDelta: x } : y)))} style={{ maxWidth: 110 }} />
              <Input placeholder="Barcode" value={v.barcode || ''} onValue={(x) => set('variants')(f.variants.map((y, k) => (k === i ? { ...y, barcode: x } : y)))} style={{ maxWidth: 160 }} />
              <Check label="ค่าเริ่มต้น" checked={v.isDefault} onChange={() => set('variants')(f.variants.map((y, k) => ({ ...y, isDefault: k === i })))} />
              <Button size="sm" variant="ghost" icon="trash" onClick={() => set('variants')(f.variants.filter((_, k) => k !== i))} />
            </div>
          ))}
        </div>

        <div className="card pad col">
          <b>Modifier Groups (ตัวเลือก)</b>
          <div className="row wrap">{refs.groups.map((g) => <Check key={g.id} label={`${g.name}${g.required ? ' *' : ''}`} checked={f.modifierGroupIds.includes(g.id)} onChange={(on) => set('modifierGroupIds')(on ? [...f.modifierGroupIds, g.id] : f.modifierGroupIds.filter((x) => x !== g.id))} />)}</div>
        </div>

        <div className="card pad col">
          <div className="row between"><b>สูตร (Recipe) — ตัดวัตถุดิบอัตโนมัติเมื่อขาย</b><Button size="sm" icon="plus" onClick={() => set('recipe')([...f.recipe, { ingredientId: '', qty: '' }])}>เพิ่มวัตถุดิบ</Button></div>
          {!refs.ingredients.length && <div className="xs muted">ยังไม่มีวัตถุดิบ — เพิ่มที่เมนู สต็อก › วัตถุดิบ</div>}
          {f.recipe.map((r, i) => (
            <div key={i} className="row">
              <Select value={r.ingredientId} onValue={(x) => set('recipe')(f.recipe.map((y, k) => (k === i ? { ...y, ingredientId: x } : y)))} placeholder="— วัตถุดิบ —" options={refs.ingredients.map((g) => ({ value: g.id, label: `${g.name} (${g.unit})` }))} />
              <Input type="number" placeholder="ปริมาณ" value={r.qty} onValue={(x) => set('recipe')(f.recipe.map((y, k) => (k === i ? { ...y, qty: x } : y)))} style={{ maxWidth: 140 }} />
              <Button size="sm" variant="ghost" icon="trash" onClick={() => set('recipe')(f.recipe.filter((_, k) => k !== i))} />
            </div>
          ))}
          <div className="xs muted">ตัวเลือก (Modifier) ตัดวัตถุดิบเพิ่มได้ที่หน้า Modifier</div>
        </div>

        {refs.branches.length > 1 && (
          <div className="card pad col">
            <b>ราคา / สถานะ แยกสาขา</b>
            {refs.branches.map((b) => {
              const bp = f.branchPrices.find((x) => x.branchId === b.id) || { branchId: b.id, price: '', status: '', hidden: false };
              const upd = (patch) => set('branchPrices')([...f.branchPrices.filter((x) => x.branchId !== b.id), { ...bp, ...patch }]);
              return (
                <div key={b.id} className="row wrap">
                  <b style={{ minWidth: 140 }}>{b.name}</b>
                  <Input type="number" placeholder={`ราคาหลัก ${f.price}`} value={bp.price ?? ''} onValue={(v) => upd({ price: v })} style={{ maxWidth: 140 }} />
                  <Select value={bp.status || ''} onValue={(v) => upd({ status: v })} placeholder="สถานะตามหลัก" options={Object.entries(STATUS).map(([value, label]) => ({ value, label }))} />
                  <Check label="ไม่ขายที่สาขานี้" checked={bp.hidden} onChange={(v) => upd({ hidden: v })} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Categories() {
  const list = useAsync(() => api('/categories'));
  const refs = useRefs();
  const [edit, setEdit] = useState(null);
  const dialog = useDialog();
  const save = async () => {
    const b = { name: edit.name, nameEn: edit.nameEn || null, color: edit.color || null, imageUrl: edit.imageUrl || null, sortOrder: Number(edit.sortOrder) || 0, stationId: edit.stationId ? Number(edit.stationId) : null, printerId: edit.printerId ? Number(edit.printerId) : null, scExempt: !!edit.scExempt, pointMultiplier: edit.pointMultiplier === '' || edit.pointMultiplier == null ? null : Number(edit.pointMultiplier), status: edit.status || 'active' };
    try { if (edit.id) await api(`/categories/${edit.id}`, { method: 'PUT', body: b }); else await api('/categories', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const move = async (i, d) => {
    const ids = list.data.map((c) => c.id);
    const j = i + d; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/categories/reorder', { method: 'POST', body: { ids } }); list.reload();
  };
  return (
    <div className="col">
      <DataTable rows={list.data || []} search={false} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', color: '#E4572E', status: 'active' })}>เพิ่มหมวด</Button>}
        columns={[
          { key: 'order', label: 'เรียง', render: (c) => { const i = list.data.indexOf(c); return <span className="row gap-s" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" onClick={() => move(i, -1)}>▲</Button><Button size="sm" variant="ghost" onClick={() => move(i, 1)}>▼</Button></span>; } },
          { key: 'name', label: 'หมวด', render: (c) => <span className="row"><span className="dot" style={{ background: c.color || '#999' }} /><b>{c.name}</b></span> },
          { key: 'station', label: 'Kitchen Station', render: (c) => refs.data?.stations.find((s) => s.id === c.stationId)?.name || '-' },
          { key: 'printer', label: 'Printer', render: (c) => refs.data?.printers.find((p) => p.id === c.printerId)?.name || '-' },
          { key: 'status', label: 'สถานะ', render: (c) => <Badge tone={c.status === 'active' ? 'success' : ''}>{c.status === 'active' ? 'ใช้งาน' : 'ปิด'}</Badge> },
        ]} onRow={(c) => setEdit({ ...c })} />
      {edit && (
        <Modal title={edit.id ? 'แก้ไขหมวด' : 'เพิ่มหมวด'} onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { if (await dialog.confirm({ message: 'ลบหมวดนี้?', danger: true })) { try { await api(`/categories/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); } } }}>ลบ</Button>}<Button variant="primary" onClick={save} disabled={!edit.name}>บันทึก</Button></>}>
          <div className="grid-2">
            <Input label="ชื่อหมวด *" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            <Input label="English" value={edit.nameEn || ''} onValue={(v) => setEdit({ ...edit, nameEn: v })} />
            <Input label="สี" type="color" value={edit.color || '#E4572E'} onValue={(v) => setEdit({ ...edit, color: v })} />
            <Input label="รูป (URL)" value={edit.imageUrl || ''} onValue={(v) => setEdit({ ...edit, imageUrl: v })} />
            <Select label="Kitchen Station" value={edit.stationId ?? ''} onValue={(v) => setEdit({ ...edit, stationId: v })} placeholder="— ไม่ส่งครัว —" options={(refs.data?.stations || []).map((s) => ({ value: s.id, label: s.name }))} />
            <Select label="Printer" value={edit.printerId ?? ''} onValue={(v) => setEdit({ ...edit, printerId: v })} placeholder="ตาม Station" options={(refs.data?.printers || []).filter((p) => p.role === 'kitchen').map((p) => ({ value: p.id, label: p.name }))} />
            <Select label="ตัวคูณแต้ม" value={edit.pointMultiplier ?? ''} onValue={(v) => setEdit({ ...edit, pointMultiplier: v })} placeholder="x1" options={[{ value: 0, label: 'No Point' }, { value: 1, label: 'x1' }, { value: 2, label: 'x2' }, { value: 3, label: 'x3' }]} />
            <Select label="สถานะ" value={edit.status || 'active'} onValue={(v) => setEdit({ ...edit, status: v })} options={[{ value: 'active', label: 'ใช้งาน' }, { value: 'inactive', label: 'ปิด' }]} />
          </div>
          <div className="mt"><Toggle label="ยกเว้น Service Charge ทั้งหมวด" checked={edit.scExempt} onChange={(v) => setEdit({ ...edit, scExempt: v })} /></div>
        </Modal>
      )}
    </div>
  );
}

function Modifiers() {
  const list = useAsync(() => api('/modifier-groups'));
  const ings = useAsync(() => api('/ingredients').catch(() => []));
  const [edit, setEdit] = useState(null);
  const dialog = useDialog();
  const save = async () => {
    const b = { name: edit.name, required: !!edit.required, multiple: !!edit.multiple, min: Number(edit.min) || 0, max: Number(edit.max) || (edit.multiple ? edit.modifiers.length : 1), allowQty: !!edit.allowQty, sortOrder: Number(edit.sortOrder) || 0,
      modifiers: edit.modifiers.filter((m) => m.name).map((m) => ({ id: m.id, name: m.name, price: Number(m.price) || 0, isDefault: !!m.isDefault, recipe: (m.recipe || []).filter((r) => r.ingredientId && r.qty).map((r) => ({ ingredientId: Number(r.ingredientId), qty: Number(r.qty) })) })) };
    try { if (edit.id) await api(`/modifier-groups/${edit.id}`, { method: 'PUT', body: b }); else await api('/modifier-groups', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const updM = (i, patch) => setEdit({ ...edit, modifiers: edit.modifiers.map((m, k) => (k === i ? { ...m, ...patch } : m)) });
  return (
    <div className="col">
      <DataTable rows={list.data || []} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', required: false, multiple: false, min: 0, max: 1, modifiers: [{ name: '', price: 0 }] })}>เพิ่มกลุ่มตัวเลือก</Button>}
        onRow={(g) => setEdit({ ...g, modifiers: g.modifiers.map((m) => ({ ...m })) })}
        columns={[
          { key: 'name', label: 'กลุ่ม', render: (g) => <b>{g.name}</b> },
          { key: 'rule', label: 'กฎ', render: (g) => <>{g.required ? <Badge tone="danger">Required</Badge> : <Badge>Optional</Badge>} <Badge>{g.multiple ? `Multiple ${g.min}–${g.max}` : 'Single'}</Badge></> },
          { key: 'mods', label: 'ตัวเลือก', render: (g) => g.modifiers.map((m) => `${m.name}${m.price ? ` +${m.price}` : ''}${m.isDefault ? '★' : ''}`).join(', ') },
        ]} />
      {edit && (
        <Modal title={edit.id ? 'แก้ไขกลุ่มตัวเลือก' : 'เพิ่มกลุ่มตัวเลือก'} size="wide" onClose={() => setEdit(null)}
          footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { if (await dialog.confirm({ message: 'ลบกลุ่มนี้?', danger: true })) { await api(`/modifier-groups/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); } }}>ลบ</Button>}<Button variant="primary" onClick={save} disabled={!edit.name}>บันทึก</Button></>}>
          <div className="col">
            <div className="grid-3">
              <Input label="ชื่อกลุ่ม เช่น Sweetness" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
              <Input label="Min" type="number" value={edit.min} onValue={(v) => setEdit({ ...edit, min: v })} />
              <Input label="Max" type="number" value={edit.max} onValue={(v) => setEdit({ ...edit, max: v })} />
            </div>
            <div className="grid-3">
              <Toggle label="บังคับเลือก (Required)" checked={edit.required} onChange={(v) => setEdit({ ...edit, required: v })} />
              <Toggle label="เลือกได้หลายรายการ (Multiple)" checked={edit.multiple} onChange={(v) => setEdit({ ...edit, multiple: v })} />
              <Toggle label="ระบุจำนวนต่อตัวเลือก" checked={edit.allowQty} onChange={(v) => setEdit({ ...edit, allowQty: v })} />
            </div>
            <div className="row between"><b>ตัวเลือก</b><Button size="sm" icon="plus" onClick={() => setEdit({ ...edit, modifiers: [...edit.modifiers, { name: '', price: 0 }] })}>เพิ่ม</Button></div>
            {edit.modifiers.map((m, i) => (
              <div key={i} className="card pad col gap-s">
                <div className="row wrap">
                  <Input placeholder="ชื่อ เช่น ไข่มุก" value={m.name} onValue={(v) => updM(i, { name: v })} style={{ maxWidth: 220 }} />
                  <Input type="number" placeholder="ราคาเพิ่ม" value={m.price} onValue={(v) => updM(i, { price: v })} style={{ maxWidth: 120 }} />
                  <Check label="Default" checked={m.isDefault} onChange={(v) => updM(i, { isDefault: v })} />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setEdit({ ...edit, modifiers: edit.modifiers.filter((_, k) => k !== i) })} />
                  <Button size="sm" variant="ghost" onClick={() => updM(i, { recipe: [...(m.recipe || []), { ingredientId: '', qty: '' }] })}>+ ตัดวัตถุดิบ</Button>
                </div>
                {(m.recipe || []).map((r, j) => (
                  <div key={j} className="row">
                    <Select value={r.ingredientId} onValue={(v) => updM(i, { recipe: m.recipe.map((x, k) => (k === j ? { ...x, ingredientId: v } : x)) })} placeholder="— วัตถุดิบ —" options={(ings.data || []).map((g) => ({ value: g.id, label: `${g.name} (${g.unit})` }))} />
                    <Input type="number" value={r.qty} placeholder="ปริมาณ" onValue={(v) => updM(i, { recipe: m.recipe.map((x, k) => (k === j ? { ...x, qty: v } : x)) })} style={{ maxWidth: 120 }} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stations() {
  const list = useAsync(() => api('/stations'));
  const [edit, setEdit] = useState(null);
  const save = async () => { try { const b = { name: edit.name, code: edit.code, color: edit.color, sortOrder: Number(edit.sort_order) || 0 }; if (edit.id) await api(`/stations/${edit.id}`, { method: 'PUT', body: b }); else await api('/stations', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="col">
      <DataTable rows={list.data || []} search={false} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ name: '', code: '', color: '#2E86AB' })}>เพิ่ม Station</Button>} onRow={(s) => setEdit({ ...s })}
        columns={[{ key: 'name', label: 'Station', render: (s) => <span className="row"><span className="dot" style={{ background: s.color }} /><b>{s.name}</b></span> }, { key: 'code', label: 'รหัส' }]} />
      {edit && (
        <Modal title="Kitchen Station" size="narrow" onClose={() => setEdit(null)} footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/stations/${edit.id}`, { method: 'DELETE' }); setEdit(null); list.reload(); }}>ลบ</Button>}<Button variant="primary" onClick={save}>บันทึก</Button></>}>
          <div className="col"><Input label="ชื่อ" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} /><Input label="รหัส" value={edit.code} onValue={(v) => setEdit({ ...edit, code: v.toUpperCase() })} /><Input label="สี" type="color" value={edit.color || '#2E86AB'} onValue={(v) => setEdit({ ...edit, color: v })} /></div>
        </Modal>
      )}
    </div>
  );
}
export { Field };

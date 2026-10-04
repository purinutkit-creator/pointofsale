// Product Option Modal: variants (Size), modifier groups (Required/Optional, Single/Multiple, Min/Max, Default), note, qty
import { useMemo, useState } from 'react';
import { Modal, Button, TextArea, Icon } from '../../components/ui.jsx';
import { money, cls } from '../../lib/util.js';
import { unitPriceOf } from '@shared/calc.js';

export default function ProductOptions({ product, groups, initial, onClose, onConfirm }) {
  const pgroups = useMemo(() => product.modifierGroupIds.map((id) => groups.find((g) => g.id === id)).filter(Boolean), [product, groups]);
  const [variantId, setVariantId] = useState(initial?.variantId ?? (product.variants.find((v) => v.isDefault) || product.variants[0])?.id ?? null);
  const [sel, setSel] = useState(() => {
    if (initial) return Object.fromEntries(initial.modifiers.map((m) => [m.modifierId, m.qty || 1]));
    const s = {};
    for (const g of pgroups) for (const m of g.modifiers) if (m.isDefault) s[m.id] = 1;
    return s;
  });
  const [note, setNote] = useState(initial?.note || '');
  const [qty, setQty] = useState(initial?.qty || 1);
  const [err, setErr] = useState('');

  const count = (g) => g.modifiers.reduce((a, m) => a + (sel[m.id] ? (g.allowQty ? sel[m.id] : 1) : 0), 0);
  const toggle = (g, m) => {
    setErr('');
    setSel((s) => {
      const n = { ...s };
      if (!g.multiple) { for (const x of g.modifiers) delete n[x.id]; if (!s[m.id] || g.required) n[m.id] = 1; return n; }
      if (n[m.id]) { if (g.allowQty && count(g) < (g.max || 99)) n[m.id] += 1; else delete n[m.id]; return n; }
      if (count(g) >= (g.max || 99)) { setErr(`"${g.name}" เลือกได้สูงสุด ${g.max} รายการ`); return s; }
      n[m.id] = 1; return n;
    });
  };
  const decMod = (m) => setSel((s) => { const n = { ...s }; if (n[m.id] > 1) n[m.id] -= 1; else delete n[m.id]; return n; });
  const variant = product.variants.find((v) => v.id === variantId) || null;
  const chosen = pgroups.flatMap((g) => g.modifiers.filter((m) => sel[m.id]).map((m) => ({ ...m, groupId: g.id, qty: sel[m.id] })));
  const unit = unitPriceOf({ basePrice: product.price, variantPrice: variant?.priceDelta || 0, modifiers: chosen });

  const confirm = () => {
    for (const g of pgroups) {
      const n = count(g);
      const min = g.required ? Math.max(1, g.min) : g.min;
      if (n < min) return setErr(`กรุณาเลือก "${g.name}"${min > 1 ? ` อย่างน้อย ${min} รายการ` : ''}`);
    }
    onConfirm({ variant, modifiers: chosen, note: note.trim(), qty });
  };

  return (
    <Modal title={product.name} size="wide" onClose={onClose}
      footer={<>
        <div className="row" style={{ marginRight: 'auto' }}>
          <Button icon="minus" onClick={() => setQty(Math.max(1, qty - 1))} />
          <div className="bold num" style={{ fontSize: 22, minWidth: 40, textAlign: 'center' }}>{qty}</div>
          <Button icon="plus" onClick={() => setQty(qty + 1)} />
        </div>
        <Button size="lg" onClick={onClose}>ยกเลิก</Button>
        <Button size="lg" variant="primary" onClick={confirm}>{initial ? 'บันทึก' : 'ใส่ตะกร้า'} · ฿{money(unit * qty)}</Button>
      </>}>
      <div className="col gap-l">
        {product.imageUrl && <img src={product.imageUrl} alt="" style={{ width: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 12 }} />}
        {product.variants.length > 0 && (
          <div className="col">
            <div className="row between"><b>ขนาด / ตัวเลือกหลัก</b><span className="badge danger">บังคับ</span></div>
            <div className="row wrap">
              {product.variants.map((v) => (
                <button key={v.id} type="button" className={cls('chip', variantId === v.id && 'on')} style={{ minHeight: 52, fontSize: 17 }} onClick={() => setVariantId(v.id)}>
                  {v.name}{v.priceDelta ? ` ${v.priceDelta > 0 ? '+' : ''}${money(v.priceDelta)}` : ''}
                </button>
              ))}
            </div>
          </div>
        )}
        {pgroups.map((g) => (
          <div key={g.id} className="col">
            <div className="row between">
              <b>{g.name}</b>
              <span className={cls('badge', g.required ? 'danger' : '')}>{g.required ? 'บังคับ' : 'ไม่บังคับ'} · {g.multiple ? `เลือกได้ ${g.min ? `${g.min}–` : 'สูงสุด '}${g.max || 'ไม่จำกัด'}` : 'เลือก 1'}</span>
            </div>
            <div className="row wrap">
              {g.modifiers.map((m) => (
                <div key={m.id} className="row gap-s">
                  <button type="button" className={cls('chip', sel[m.id] && 'on')} style={{ minHeight: 52, fontSize: 17 }} onClick={() => toggle(g, m)}>
                    {sel[m.id] && <Icon name="check" size={16} />}{m.name}{m.price ? ` +${money(m.price)}` : ''}{g.allowQty && sel[m.id] > 1 ? ` ×${sel[m.id]}` : ''}
                  </button>
                  {g.allowQty && sel[m.id] > 0 && <Button size="sm" icon="minus" onClick={() => decMod(m)} />}
                </div>
              ))}
            </div>
          </div>
        ))}
        <TextArea label="หมายเหตุ (Note)" value={note} onValue={setNote} placeholder="เช่น ไม่ใส่ผัก, แยกน้ำ" rows={2} />
        <div className="row wrap">{['ไม่ใส่ผัก', 'ไม่เผ็ด', 'แยกน้ำ', 'ไม่ใส่น้ำแข็ง', 'หวานน้อย', 'ใส่กล่อง'].map((t) => <button key={t} type="button" className="chip" onClick={() => setNote((n) => (n ? `${n}, ${t}` : t))}>+ {t}</button>)}</div>
        {err && <div className="card pad" style={{ background: 'var(--danger-50)', color: 'var(--danger)', borderColor: 'transparent', fontWeight: 600 }}>{err}</div>}
      </div>
    </Modal>
  );
}

// Open bills, Held bills (Hold/Retrieve), paid bills: preview, reprint, refund, tax invoice, edit closed bill
import { useEffect, useState } from 'react';
import { api, uid } from '../../lib/api.js';
import { on } from '../../lib/socket.js';
import { useApp, toast } from '../../lib/store.js';
import { usePos, fromServer } from './posStore.js';
import { localOrdersAll } from '../../lib/db.js';
import { Modal, Button, Seg, Badge, Empty, Input, Select, useDialog, Spinner } from '../../components/ui.jsx';
import { money, fmtTime, fmtDateTime, ORDER_TYPE_LABEL, ORDER_STATUS, today, PAYMENT_METHOD_LABEL } from '../../lib/util.js';
import { previewDataUrl } from '../../hw/printing.js';

export default function OrdersModal({ onClose, initialTab = 'open' }) {
  const [tab, setTab] = useState(initialTab);
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState(null);
  const load = async () => {
    setRows(null);
    try {
      if (tab === 'offline') { setRows((await localOrdersAll()).map((o) => ({ id: o.id, order_no: o.orderNo, queue_no: o.queueNo, type: o.type, status: o.status, table_number: o.tableNumber, total: 0, created_at: o.createdAt, local: o }))); return; }
      const status = tab === 'open' ? 'open' : tab === 'held' ? 'held' : 'paid,refunded,partially_refunded,voided';
      setRows(await api(`/orders?status=${status}${tab === 'paid' && !q ? `&date=${today()}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`));
    } catch (e) { toast(e.message, 'error'); setRows([]); }
  };
  useEffect(() => { load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => on('order:updated', () => { if (tab !== 'paid') load(); }), [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (r) => {
    if (r.local) { usePos.setState({ order: r.local }); onClose(); return; }
    if (r.status === 'held') {
      try { await api(`/orders/${r.id}`, { method: 'PUT', body: { id: r.id, status: 'open' } }); } catch (e) { return toast(e.message, 'error'); }
    }
    if (['open', 'held'].includes(r.status)) { await usePos.getState().openOrder(r.id); onClose(); } else setDetail(r.id);
  };

  return (
    <Modal title="บิล / ออเดอร์" size="xwide" icon="receipt" onClose={onClose}>
      <div className="col">
        <div className="row wrap">
          <Seg value={tab} onChange={setTab} options={[{ value: 'open', label: 'บิลเปิดอยู่' }, { value: 'held', label: 'พักบิล (Hold)' }, { value: 'paid', label: 'ชำระแล้ว / ใบเสร็จ' }, { value: 'offline', label: 'รอ Sync' }]} />
          <div className="grow" />
          <Input placeholder="ค้นหาเลขบิล / ใบเสร็จ / คิว / ลูกค้า" value={q} onValue={setQ} onKeyDown={(e) => e.key === 'Enter' && load()} style={{ maxWidth: 300 }} />
          <Button icon="search" onClick={load} />
        </div>
        {!rows ? <div className="center"><Spinner /></div> : !rows.length ? <Empty icon="receipt">ไม่มีรายการ</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>เวลา</th><th>บิล</th><th>โต๊ะ/คิว</th><th>ลูกค้า</th><th>พนักงาน</th><th className="num">ยอด</th><th>สถานะ</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="click" onClick={() => open(r)}>
                    <td className="nowrap">{fmtTime(r.created_at)}</td>
                    <td><b>#{r.order_no}</b>{r.receipt_no && <div className="xs muted">{r.receipt_no}</div>}</td>
                    <td>{r.table_number ? `โต๊ะ ${r.table_number}` : r.queue_no || ORDER_TYPE_LABEL[r.type]}</td>
                    <td>{r.member_name || r.customer_name || '-'}</td>
                    <td>{r.staff_name || '-'}</td>
                    <td className="num">{money(r.total)}</td>
                    <td><Badge tone={r.status === 'paid' ? 'success' : r.status === 'held' ? 'warning' : r.status === 'voided' || r.status === 'refunded' ? 'danger' : 'info'}>{ORDER_STATUS[r.status] || r.status}</Badge></td>
                    <td><Button size="sm">{['open', 'held'].includes(r.status) ? (r.status === 'held' ? 'เรียกบิลคืน' : 'เปิด') : 'ดู'}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {detail && <PaidOrder id={detail} onClose={() => { setDetail(null); load(); }} />}
    </Modal>
  );
}

function PaidOrder({ id, onClose }) {
  const can = useApp((s) => s.can);
  const dialog = useDialog();
  const [o, setO] = useState(null);
  const [preview, setPreview] = useState(null);
  const [refund, setRefund] = useState(null);
  const [tax, setTax] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const x = await api(`/orders/${id}`);
    setO(x);
    const rc = x.receipts.find((r) => r.doc_type !== 'credit_note');
    if (rc) { const full = await api(`/receipts/${rc.id}`); setPreview(await previewDataUrl(full.payload, { paper: '80' })); }
  };
  useEffect(() => { load().catch((e) => toast(e.message, 'error')); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o) return <Modal title="กำลังโหลด" onClose={onClose}><div className="center"><Spinner /></div></Modal>;
  const receipt = o.receipts.find((r) => r.doc_type !== 'credit_note');
  const reprint = async () => {
    const reason = await dialog.prompt({ title: 'Reprint ใบเสร็จ', message: 'ระบุเหตุผลการพิมพ์ซ้ำ', options: ['ลูกค้าขอสำเนา', 'กระดาษติด/พิมพ์ไม่ชัด', 'ใบเสร็จหาย'], required: true });
    if (!reason) return;
    try { await api(`/receipts/${receipt.id}/reprint`, { method: 'POST', body: { reason } }); toast('ส่งพิมพ์ซ้ำแล้ว', 'success'); } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); }
  };
  const doRefund = async () => {
    setBusy(true);
    try {
      const body = { idempotencyKey: refund.key, type: refund.type, reason: refund.reason, method: refund.method, restock: refund.restock };
      if (refund.type === 'item') body.items = Object.entries(refund.qtys).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));
      if (refund.type === 'partial') body.amount = Number(refund.amount);
      const r = await api(`/orders/${o.id}/refund`, { method: 'POST', body });
      toast(`คืนเงิน ${r.refund.refund_no} ฿${money(r.refund.amount)}`, 'success');
      setRefund(null); load();
    } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const reopen = async () => {
    const reason = await dialog.prompt({ title: 'แก้ไขบิลที่ปิดแล้ว', message: 'ระบบจะคืนเงินบิลเดิม (ใบลดหนี้) และเปิดบิลใหม่ให้แก้ไขและชำระใหม่', required: true });
    if (!reason) return;
    try { const n = await api(`/orders/${o.id}/reopen`, { method: 'POST', body: { reason } }); usePos.setState({ order: fromServer(n) }); toast(`เปิดบิลใหม่ #${n.order_no}`, 'success'); onClose(); } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); }
  };
  const issueTax = async () => {
    try { const r = await api(`/receipts/${receipt.id}/tax-invoice`, { method: 'POST', body: { customer: tax } }); toast(`ออกใบกำกับภาษี ${r.receiptNo}`, 'success'); setTax(null); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const refundable = o.total - o.refunded_total;
  return (
    <Modal title={`บิล #${o.order_no} ${receipt ? `· ${receipt.receipt_no}` : ''}`} size="xwide" onClose={onClose}>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="col">
          <div className="card pad col gap-s">
            <div className="row between"><Badge tone={o.status === 'paid' ? 'success' : 'danger'}>{ORDER_STATUS[o.status]}</Badge><span className="small muted">{fmtDateTime(o.paid_at || o.created_at)}</span></div>
            {o.items.map((i) => <div key={i.id} className="row between" style={{ textDecoration: i.status === 'voided' ? 'line-through' : undefined }}><span>{i.qty} × {i.name}{i.refunded_qty ? <Badge tone="danger">คืน {i.refunded_qty}</Badge> : null}</span><span className="num">{money(i.line_total)}</span></div>)}
            <div className="divider" />
            <div className="row between bold"><span>รวม</span><span className="num">฿{money(o.total)}</span></div>
            {o.refunded_total > 0 && <div className="row between" style={{ color: 'var(--danger)' }}><span>คืนเงินแล้ว</span><span className="num">-{money(o.refunded_total)}</span></div>}
            {o.payments.map((p) => <div key={p.id} className="row between small"><span>{p.kind === 'refund' ? 'คืนเงิน · ' : ''}{PAYMENT_METHOD_LABEL[p.method]}</span><span className="num">{money(p.amount)}</span></div>)}
          </div>
          <div className="row wrap">
            {receipt && <Button icon="print" onClick={reprint} disabled={!can('receipt.reprint') && false}>Reprint</Button>}
            {['paid', 'partially_refunded'].includes(o.status) && <Button icon="back" variant="danger" onClick={() => setRefund({ key: `refund-${uid()}`, type: 'item', reason: '', method: o.payments.find((p) => p.kind === 'sale')?.method || 'cash', restock: true, qtys: {}, amount: '' })}>คืนเงิน (Refund)</Button>}
            {o.status === 'paid' && receipt && <Button icon="receipt" onClick={() => setTax({ name: '', taxId: '', branch: 'สำนักงานใหญ่', address: '', phone: '', email: '' })}>ออกใบกำกับภาษีเต็มรูป</Button>}
            {o.status === 'paid' && <Button icon="edit" onClick={reopen}>แก้ไขบิล (Closed Bill)</Button>}
          </div>
          {o.receipts.length > 1 && <div className="small muted">เอกสาร: {o.receipts.map((r) => r.receipt_no).join(', ')}</div>}
        </div>
        <div className="center">{preview ? <img src={preview} alt="receipt preview" style={{ maxWidth: 360, width: '100%', boxShadow: 'var(--shadow-lg)', borderRadius: 6 }} /> : <Spinner />}</div>
      </div>
      {refund && (
        <Modal title="คืนเงิน (Refund)" onClose={() => setRefund(null)} footer={<><Button onClick={() => setRefund(null)}>ยกเลิก</Button><Button variant="danger" loading={busy} disabled={!refund.reason} onClick={doRefund}>ยืนยันคืนเงิน</Button></>}>
          <div className="col">
            <Seg value={refund.type} onChange={(t) => setRefund({ ...refund, type: t })} options={[{ value: 'item', label: 'คืนรายการ' }, { value: 'partial', label: 'คืนบางส่วน (ยอดเงิน)' }, { value: 'full', label: `คืนทั้งหมด ฿${money(refundable)}` }]} />
            {refund.type === 'item' && o.items.filter((i) => i.status !== 'voided' && i.qty > i.refunded_qty).map((i) => (
              <div key={i.id} className="pay-line"><span className="grow">{i.name} <span className="muted">(คืนได้ {i.qty - i.refunded_qty})</span></span>
                <Button size="sm" icon="minus" onClick={() => setRefund({ ...refund, qtys: { ...refund.qtys, [i.id]: Math.max(0, (refund.qtys[i.id] || 0) - 1) } })} />
                <b>{refund.qtys[i.id] || 0}</b>
                <Button size="sm" icon="plus" onClick={() => setRefund({ ...refund, qtys: { ...refund.qtys, [i.id]: Math.min(i.qty - i.refunded_qty, (refund.qtys[i.id] || 0) + 1) } })} />
              </div>
            ))}
            {refund.type === 'partial' && <Input type="number" label={`จำนวนเงิน (สูงสุด ${money(refundable)})`} value={refund.amount} onValue={(v) => setRefund({ ...refund, amount: v })} />}
            <Select label="คืนเงินผ่าน" value={refund.method} onValue={(v) => setRefund({ ...refund, method: v })} options={Object.entries(PAYMENT_METHOD_LABEL).filter(([k]) => k !== 'points').map(([value, label]) => ({ value, label }))} />
            <Input label="เหตุผล *" value={refund.reason} onValue={(v) => setRefund({ ...refund, reason: v })} />
            <div className="row wrap">{['สินค้าไม่ถูกต้อง', 'ลูกค้ายกเลิก', 'คุณภาพไม่ดี', 'คิดเงินผิด'].map((x) => <button key={x} type="button" className="chip" onClick={() => setRefund({ ...refund, reason: x })}>{x}</button>)}</div>
            <label className="check"><input type="checkbox" checked={refund.restock} onChange={(e) => setRefund({ ...refund, restock: e.target.checked })} /> คืนสินค้าเข้าสต็อก</label>
            <div className="xs muted">แต้มสมาชิกที่ได้จากบิลนี้จะถูกหักคืนตามสัดส่วนอัตโนมัติ</div>
          </div>
        </Modal>
      )}
      {tax && (
        <Modal title="ออกใบกำกับภาษีเต็มรูป" onClose={() => setTax(null)} footer={<Button variant="primary" onClick={issueTax} disabled={!tax.name || !tax.taxId || !tax.address}>ออกเอกสาร + พิมพ์</Button>}>
          <div className="grid-2">
            <Input label="ชื่อ / บริษัท *" value={tax.name} onValue={(v) => setTax({ ...tax, name: v })} />
            <Input label="เลขผู้เสียภาษี *" value={tax.taxId} onValue={(v) => setTax({ ...tax, taxId: v })} />
            <Input label="สาขา" value={tax.branch} onValue={(v) => setTax({ ...tax, branch: v })} />
            <Input label="โทร" value={tax.phone} onValue={(v) => setTax({ ...tax, phone: v })} />
            <Input label="ที่อยู่ *" value={tax.address} onValue={(v) => setTax({ ...tax, address: v })} />
            <Input label="อีเมล" value={tax.email} onValue={(v) => setTax({ ...tax, email: v })} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}

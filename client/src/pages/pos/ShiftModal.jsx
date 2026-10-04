// Open / Close Shift, Cash In / Cash Out, Open Drawer (No Sale)
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { usePos } from './posStore.js';
import { Modal, Button, NumPad, applyKey, Input, Seg, useDialog } from '../../components/ui.jsx';
import { money, fmtDateTime, PAYMENT_METHOD_LABEL } from '../../lib/util.js';

export function OpenShift({ onDone, forced }) {
  const [cash, setCash] = useState('');
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try { await api('/shifts/open', { method: 'POST', body: { openingCash: Number(cash) || 0 } }); await usePos.getState().loadShift(); toast('เปิดกะเรียบร้อย', 'success'); onDone?.(); } catch (e) { toast(e.message, 'error'); if (e.code === 'SHIFT_OPEN') { await usePos.getState().loadShift(); onDone?.(); } } finally { setBusy(false); }
  };
  return (
    <Modal title="เปิดกะ (Open Shift)" icon="clock" size="narrow" onClose={forced ? undefined : onDone} closeOnBg={!forced}
      footer={<Button variant="primary" size="xl" block loading={busy} onClick={open} disabled={!useApp.getState().can('shift.open_close')}>เปิดกะ</Button>}>
      <div className="col">
        <div className="muted">กรอกเงินทอนตั้งต้นในลิ้นชัก (Opening Cash)</div>
        <div className="input xl num" style={{ display: 'grid', placeItems: 'center' }}>฿{cash || '0'}</div>
        <NumPad onKey={(k) => setCash((v) => applyKey(v, k))} />
      </div>
    </Modal>
  );
}

export default function ShiftModal({ onClose }) {
  const shift = usePos((s) => s.shift);
  const can = useApp((s) => s.can);
  const dialog = useDialog();
  const [mode, setMode] = useState('summary');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [closed, setClosed] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!shift && !closed) return <OpenShift onDone={onClose} />;
  const s = closed || shift;
  const reload = () => usePos.getState().loadShift();
  const move = async (type) => {
    setBusy(true);
    try { await api('/cash-movements', { method: 'POST', body: { type, amount: Number(amount), reason } }); toast(type === 'cash_in' ? 'บันทึก Cash In แล้ว' : 'บันทึก Cash Out แล้ว', 'success'); setAmount(''); setReason(''); setMode('summary'); reload(); } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const close = async () => {
    const ok = await dialog.confirm({ message: `ยืนยันปิดกะ\nเงินสดนับได้จริง ฿${money(Number(amount) || 0)}` });
    if (!ok) return;
    setBusy(true);
    try { const r = await api(`/shifts/${shift.shift.id}/close`, { method: 'POST', body: { actualCash: Number(amount) || 0 } }); setClosed(r); await reload(); toast('ปิดกะเรียบร้อย พิมพ์รายงานกะแล้ว', 'success'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const openDrawer = async () => {
    const r = await dialog.prompt({ title: 'เปิดลิ้นชัก (No Sale)', message: 'ระบุเหตุผล (จะถูกบันทึกใน Activity Log)', options: ['แลกเงินทอน', 'ตรวจนับเงิน', 'อื่นๆ'], required: true });
    if (!r) return;
    try { await api('/drawer/open', { method: 'POST', body: { reason: r } }); toast('ส่งคำสั่งเปิดลิ้นชักแล้ว', 'success'); reload(); } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); }
  };
  const diff = closed ? closed.shift.difference : (Number(amount) || 0) - s.expectedCash;
  return (
    <Modal title={closed ? 'สรุปปิดกะ' : 'กะการขาย (Shift)'} size="wide" icon="clock" onClose={onClose}>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card pad col gap-s">
          <div className="row between"><b>{s.shift.staff_name} ({s.shift.employee_code})</b><span className="small muted">{s.shift.device_name}</span></div>
          <div className="small muted">เปิดกะ {fmtDateTime(s.shift.opened_at)}{s.shift.closed_at ? ` · ปิด ${fmtDateTime(s.shift.closed_at)}` : ''}</div>
          <div className="divider" />
          <div className="row between"><span>จำนวนบิล</span><b>{s.orders}</b></div>
          <div className="row between"><span>ยอดขายสุทธิ</span><b className="num">{money(s.netSales)}</b></div>
          {s.payments.map((p) => <div key={p.method} className="row between small"><span>{PAYMENT_METHOD_LABEL[p.method]}</span><span className="num">{money(p.amount)}</span></div>)}
          <div className="row between small" style={{ color: 'var(--danger)' }}><span>Refund</span><span className="num">-{money(s.refunds)}</span></div>
          <div className="divider" />
          <div className="row between"><span>Opening Cash</span><span className="num">{money(s.openingCash)}</span></div>
          <div className="row between"><span>+ Cash Sales</span><span className="num">{money(s.cashSales)}</span></div>
          <div className="row between"><span>+ Cash In</span><span className="num">{money(s.cashIn)}</span></div>
          <div className="row between"><span>− Cash Refund</span><span className="num">{money(s.cashRefunds)}</span></div>
          <div className="row between"><span>− Cash Out</span><span className="num">{money(s.cashOut)}</span></div>
          <div className="row between bold" style={{ fontSize: 20 }}><span>= Expected Cash</span><span className="num">฿{money(s.expectedCash)}</span></div>
          {closed && <>
            <div className="row between bold"><span>Actual Cash</span><span className="num">฿{money(closed.shift.actual_cash)}</span></div>
            <div className="row between bold" style={{ color: diff === 0 ? 'var(--success)' : 'var(--danger)', fontSize: 20 }}><span>{diff > 0 ? 'Over (เงินเกิน)' : diff < 0 ? 'Short (เงินขาด)' : 'Difference'}</span><span className="num">{money(diff)}</span></div>
          </>}
        </div>
        <div className="col">
          {closed ? (
            <>
              <Button size="lg" icon="print" onClick={() => api(`/shifts/${closed.shift.id}/print`, { method: 'POST', body: {} }).then(() => toast('ส่งพิมพ์แล้ว', 'success')).catch((e) => toast(e.message, 'error'))}>พิมพ์ Shift Report อีกครั้ง</Button>
              <Button size="lg" variant="primary" onClick={onClose}>เสร็จสิ้น</Button>
            </>
          ) : (
            <>
              <Seg size="lg" value={mode} onChange={(m) => { setMode(m); setAmount(''); setReason(''); }} options={[{ value: 'summary', label: 'สรุป' }, { value: 'cash_in', label: 'Cash In' }, { value: 'cash_out', label: 'Cash Out' }, { value: 'close', label: 'ปิดกะ' }]} />
              {mode === 'summary' && (
                <div className="col">
                  <Button size="lg" icon="drawer" onClick={openDrawer}>เปิดลิ้นชัก (No Sale)</Button>
                  <Button size="lg" icon="print" onClick={() => api(`/shifts/${shift.shift.id}/print`, { method: 'POST', body: {} }).then(() => toast('ส่งพิมพ์รายงาน X (ระหว่างกะ) แล้ว', 'success')).catch((e) => toast(e.message, 'error'))}>พิมพ์รายงานระหว่างกะ</Button>
                  {s.movements.length > 0 && <div className="card pad col gap-s">{s.movements.map((m) => <div key={m.id} className="row between small"><span>{m.type === 'cash_in' ? 'Cash In' : m.type === 'cash_out' ? 'Cash Out' : 'No Sale'} · {m.reason}</span><span className="num">{m.type === 'no_sale' ? '' : money(m.amount)}</span></div>)}</div>}
                </div>
              )}
              {(mode === 'cash_in' || mode === 'cash_out' || mode === 'close') && (
                <div className="col">
                  <div className="muted">{mode === 'close' ? 'นับเงินสดในลิ้นชัก (Actual Cash)' : 'จำนวนเงิน'}</div>
                  <div className="input xl num" style={{ display: 'grid', placeItems: 'center' }}>฿{amount || '0'}</div>
                  {mode === 'close' && amount && <div className="center bold" style={{ color: diff === 0 ? 'var(--success)' : 'var(--danger)' }}>{diff > 0 ? `เกิน ${money(diff)}` : diff < 0 ? `ขาด ${money(-diff)}` : 'ตรงพอดี'}</div>}
                  <NumPad onKey={(k) => setAmount((v) => applyKey(v, k))} />
                  {mode !== 'close' && <Input label="เหตุผล *" value={reason} onValue={setReason} />}
                  {mode === 'close'
                    ? <Button variant="danger" size="xl" loading={busy} onClick={close} disabled={!can('shift.open_close')}>ปิดกะ + พิมพ์รายงาน</Button>
                    : <Button variant="primary" size="xl" loading={busy} disabled={!(Number(amount) > 0) || !reason} onClick={() => move(mode)}>บันทึก {mode === 'cash_in' ? 'Cash In' : 'Cash Out'}</Button>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

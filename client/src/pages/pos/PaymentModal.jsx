import { useEffect, useMemo, useRef, useState } from 'react';
import { usePos } from './posStore.js';
import { payOrder, newKey } from './actions.js';
import { useApp, toast } from '../../lib/store.js';
import { api } from '../../lib/api.js';
import { Modal, Button, Input, NumPad, applyKey, Seg, Icon, Toggle, Select } from '../../components/ui.jsx';
import { money, cls, PAYMENT_METHOD_LABEL } from '../../lib/util.js';
import { qrSvg } from '@shared/codes.js';
import { pushDisplay } from './display.js';
import { playBeep } from '../../lib/sound.js';

const r2 = (n) => Math.round(n * 100) / 100;

export default function PaymentModal({ onClose, onDone, partialAmount = null }) {
  const order = usePos((s) => s.order);
  const totals = usePos.getState().totals();
  const { settings, can } = useApp();
  const methodsOn = settings?.payment?.methods || {};
  const quick = settings?.pos?.quickCash || [100, 500, 1000];
  const rc = settings?.receipt || {};
  const keyRef = useRef(newKey());
  const due = r2(partialAmount ?? totals?.remaining ?? 0);
  const [tab, setTab] = useState(methodsOn.cash !== false && can('payment.cash') ? 'cash' : 'qr');
  const [lines, setLines] = useState([]);
  const [cashIn, setCashIn] = useState('');
  const [amountIn, setAmountIn] = useState('');
  const [cardType, setCardType] = useState('credit_card');
  const [otherType, setOtherType] = useState('transfer');
  const [ref, setRef] = useState('');
  const [pp, setPp] = useState(null);
  const [docType, setDocType] = useState(rc.docType || 'receipt');
  const [customer, setCustomer] = useState({ name: '', taxId: '', branch: 'สำนักงานใหญ่', address: '', phone: '', email: '' });
  const [copies, setCopies] = useState(rc.copies ?? 1);
  const [print, setPrint] = useState(rc.printMode !== 'none');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const paid = r2(lines.reduce((a, l) => a + l.amount, 0));
  const remaining = r2(Math.max(0, due - paid));
  const change = r2(lines.reduce((a, l) => a + (l.tendered ? l.tendered - l.amount : 0), 0));

  useEffect(() => { setAmountIn(remaining ? String(remaining) : ''); }, [remaining, tab]);
  useEffect(() => {
    if (tab !== 'qr' || !order) return;
    api(`/orders/${order.id}/promptpay?amount=${remaining || due}`).then(setPp).catch(() => setPp({ enabled: !!settings?.payment?.promptpay?.qrImageUrl, qrImageUrl: settings?.payment?.promptpay?.qrImageUrl, accountName: settings?.payment?.promptpay?.accountName }));
  }, [tab, remaining, due, order, settings]);
  useEffect(() => {
    if (result) return;
    pushDisplay({ stage: 'payment', due, paid, remaining, received: lines.filter((l) => l.method === 'cash').reduce((a, l) => a + (l.tendered || l.amount), 0), change, qr: tab === 'qr' && pp?.payload ? pp.payload : null, qrImage: tab === 'qr' && !pp?.payload ? pp?.qrImageUrl : null, accountName: pp?.accountName });
  }, [due, paid, remaining, change, tab, pp, lines, result]);

  const addLine = (l) => { setLines((x) => [...x, l]); setRef(''); setCashIn(''); playBeep(); };
  const tender = (method, amt, extra = {}) => {
    const a = r2(Number(amt) || 0);
    if (a <= 0) return toast('กรุณาระบุจำนวนเงิน', 'error');
    if (method === 'cash') {
      const applied = r2(Math.min(a, remaining));
      if (applied <= 0) return;
      addLine({ method, amount: applied, tendered: a, ...extra });
      return { applied, done: r2(remaining - applied) <= 0 };
    }
    if (a > remaining + 0.001) return toast('ยอดเกินยอดค้างชำระ (เงินทอนได้เฉพาะเงินสด)', 'error');
    addLine({ method, amount: a, reference: ref || null, ...extra });
    return { applied: a, done: r2(remaining - a) <= 0 };
  };

  const confirm = async (finalLines = lines) => {
    const total = r2(finalLines.reduce((a, l) => a + l.amount, 0));
    if (total + 0.001 < due) return toast(`ยอดยังไม่ครบ ขาดอีก ${money(due - total)}`, 'error');
    if (docType === 'full_tax_invoice' && (!customer.name || !customer.taxId)) return toast('กรุณากรอกชื่อและเลขผู้เสียภาษีของลูกค้า', 'error');
    setBusy(true);
    try {
      const r = await payOrder({
        idempotencyKey: keyRef.current, partial: partialAmount != null && due < (totals?.remaining ?? due) - 0.001,
        payments: finalLines.map((l) => ({ method: l.method, amount: l.amount, tendered: l.tendered ?? null, reference: l.reference ?? null })),
        docType, customer: docType === 'full_tax_invoice' ? customer : null, copies: rc.staffCanChangeCopies ? copies : undefined, print: rc.printMode === 'ask' ? print : undefined,
      });
      setResult(r);
      pushDisplay({ stage: 'done', change: r.change, total: r.total ?? due, received: r.received, receiptNo: r.receiptNo, member: r.member });
    } catch (e) {
      if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error');
      if (e.code === 'ALREADY_PAID') onDone?.({ alreadyPaid: true });
    } finally { setBusy(false); }
  };

  // fast path: cash tendered ≥ remaining → close the bill in one tap
  const cashQuick = (amt) => {
    const a = r2(Number(amt));
    if (a + 0.001 >= remaining && remaining > 0) {
      const applied = remaining;
      const next = [...lines, { method: 'cash', amount: applied, tendered: a }];
      setLines(next); playBeep();
      confirm(next);
    } else tender('cash', a);
  };

  if (result) {
    return (
      <Modal title={result.partial ? 'รับชำระบางส่วนแล้ว' : 'ชำระเงินสำเร็จ'} size="narrow" closeOnBg={false} onClose={() => onDone(result)}
        footer={<Button variant="primary" size="xl" block onClick={() => onDone(result)}>{result.partial ? 'ตกลง' : 'ออเดอร์ใหม่'}</Button>}>
        <div className="col center" style={{ alignItems: 'center' }}>
          <Icon name="check" size={56} style={{ color: 'var(--success)' }} />
          {result.change > 0 && <><div className="muted">เงินทอน</div><div className="change-big">฿{money(result.change)}</div></>}
          {result.partial ? <div>ชำระแล้ว ฿{money(result.paid)} · คงค้าง ฿{money(result.remaining)}</div> : <div className="bold">ใบเสร็จ {result.receiptNo}</div>}
          {result.offline && <div className="badge warning">Offline — จะ Sync อัตโนมัติเมื่อเชื่อมต่อ</div>}
          {result.member && <div className="card pad" style={{ width: '100%' }}>สมาชิก {result.member.name}: +{result.member.earned} แต้ม · คงเหลือ {result.member.balance}</div>}
          {result.claimUrl && <div className="small muted">ใบเสร็จมี QR สะสมแต้ม (ใช้ได้ 1 ครั้ง)</div>}
        </div>
      </Modal>
    );
  }

  const methodBtn = (key, icon, label, perm, enabled = true) => (
    <button type="button" className={cls(tab === key && 'on')} onClick={() => setTab(key)} disabled={!enabled || !can(perm)}>
      <Icon name={icon} />{label}
    </button>
  );

  return (
    <Modal title={partialAmount != null ? 'ชำระบางส่วน (แยกจ่าย)' : 'ชำระเงิน'} size="xwide" onClose={busy ? undefined : onClose} closeOnBg={false}>
      <div className="pay-grid">
        <div className="col">
          <div className="card pad center">
            <div className="muted">ยอดที่ต้องชำระ</div>
            <div className="pay-due">฿{money(due)}</div>
            {paid > 0 && <div className="row between"><span>รับแล้ว</span><b className="num">฿{money(paid)}</b></div>}
            {paid > 0 && <div className="row between" style={{ color: remaining ? 'var(--danger)' : 'var(--success)' }}><span>คงเหลือ</span><b className="num">฿{money(remaining)}</b></div>}
            {change > 0 && <div className="row between" style={{ color: 'var(--success)' }}><span>เงินทอน</span><b className="num">฿{money(change)}</b></div>}
          </div>
          {lines.length > 0 && (
            <div className="col gap-s">
              {lines.map((l, i) => (
                <div key={i} className="pay-line">
                  <b className="grow">{PAYMENT_METHOD_LABEL[l.method]}{l.reference ? ` · ${l.reference}` : ''}</b>
                  <span className="num">{money(l.amount)}{l.tendered && l.tendered !== l.amount ? ` (รับ ${money(l.tendered)})` : ''}</span>
                  <Button size="sm" variant="ghost" icon="x" onClick={() => setLines(lines.filter((_, k) => k !== i))} disabled={busy} />
                </div>
              ))}
            </div>
          )}
          <div className="card pad col">
            <Seg value={docType} onChange={setDocType} options={[{ value: 'receipt', label: 'ใบเสร็จ' }, { value: 'abb_tax_invoice', label: 'ใบกำกับภาษีอย่างย่อ' }, { value: 'full_tax_invoice', label: 'ใบกำกับภาษีเต็มรูป' }]} />
            {docType === 'full_tax_invoice' && (
              <div className="grid-2">
                <Input label="ชื่อ / บริษัท *" value={customer.name} onValue={(v) => setCustomer({ ...customer, name: v })} />
                <Input label="เลขผู้เสียภาษี *" value={customer.taxId} onValue={(v) => setCustomer({ ...customer, taxId: v })} />
                <Input label="สาขา" value={customer.branch} onValue={(v) => setCustomer({ ...customer, branch: v })} />
                <Input label="โทร" value={customer.phone} onValue={(v) => setCustomer({ ...customer, phone: v })} />
                <Input label="ที่อยู่" value={customer.address} onValue={(v) => setCustomer({ ...customer, address: v })} />
                <Input label="อีเมล" value={customer.email} onValue={(v) => setCustomer({ ...customer, email: v })} />
              </div>
            )}
            <div className="row wrap">
              {rc.printMode === 'ask' && <Toggle label="พิมพ์ใบเสร็จ" checked={print} onChange={setPrint} />}
              {rc.staffCanChangeCopies && (
                <div className="row"><span className="label">จำนวนใบเสร็จ</span>
                  <Button size="sm" icon="minus" onClick={() => setCopies(Math.max(0, copies - 1))} /><b className="num">{copies}</b><Button size="sm" icon="plus" onClick={() => setCopies(Math.min(10, copies + 1))} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="col">
          <div className="method-tabs">
            {methodBtn('cash', 'cash', 'เงินสด', 'payment.cash', methodsOn.cash !== false)}
            {methodBtn('qr', 'qr', 'QR / PromptPay', 'payment.qr', methodsOn.qr !== false)}
            {methodBtn('card', 'card', 'บัตร', 'payment.card', methodsOn.credit_card !== false || methodsOn.debit_card !== false)}
            {methodBtn('other', 'swap', 'อื่นๆ', 'payment.other', methodsOn.transfer !== false || methodsOn.ewallet !== false || methodsOn.other !== false)}
          </div>
          {remaining <= 0 ? (
            <div className="card pad center col" style={{ alignItems: 'center' }}>
              <Icon name="check" size={40} style={{ color: 'var(--success)' }} />
              <b>รับชำระครบแล้ว</b>
            </div>
          ) : tab === 'cash' ? (
            <div className="col">
              <div className="input xl num" style={{ display: 'grid', placeItems: 'center' }}>฿{cashIn || '0'}</div>
              <div className="quick-cash">
                <button type="button" onClick={() => cashQuick(remaining)}>พอดี</button>
                {quick.map((q) => <button type="button" key={q} onClick={() => cashQuick(q)} disabled={busy}>{Number(q).toLocaleString()}</button>)}
              </div>
              <NumPad onKey={(k) => setCashIn((v) => applyKey(v, k))} />
              <Button size="xl" variant="success" disabled={!cashIn || busy} loading={busy} onClick={() => cashQuick(Number(cashIn))}>
                รับเงิน {cashIn ? `฿${money(Number(cashIn))}` : ''}{Number(cashIn) >= remaining && cashIn ? ` · ทอน ฿${money(Number(cashIn) - remaining)}` : ''}
              </Button>
            </div>
          ) : tab === 'qr' ? (
            <div className="col center" style={{ alignItems: 'center' }}>
              {pp?.payload ? <div style={{ width: 240 }} dangerouslySetInnerHTML={{ __html: qrSvg(pp.payload) }} /> : pp?.qrImageUrl ? <img src={pp.qrImageUrl} alt="QR" style={{ width: 240, borderRadius: 12 }} /> : <div className="empty">ยังไม่ได้ตั้งค่า PromptPay (หลังร้าน › ตั้งค่า › Payment)</div>}
              {pp?.accountName && <div className="bold">{pp.accountName}</div>}
              <Input label="จำนวนเงิน" type="number" value={amountIn} onValue={setAmountIn} style={{ textAlign: 'center' }} />
              <Input label="เลขอ้างอิง (ถ้ามี)" value={ref} onValue={setRef} />
              <Button size="xl" variant="success" block loading={busy} onClick={() => { const r = tender('qr', amountIn); if (r?.done) confirm([...lines, { method: 'qr', amount: r.applied, reference: ref || null }]); }}>ได้รับเงินแล้ว (ยืนยัน)</Button>
            </div>
          ) : tab === 'card' ? (
            <div className="col">
              <Seg size="lg" value={cardType} onChange={setCardType} options={[{ value: 'credit_card', label: 'Credit' }, { value: 'debit_card', label: 'Debit' }]} />
              <Input size="lg" label="จำนวนเงิน" type="number" value={amountIn} onValue={setAmountIn} />
              <Input label="เลขอ้างอิง / 4 หลักท้ายบัตร / Approval Code" value={ref} onValue={setRef} />
              <div className="small muted">ทำรายการที่เครื่อง EDC แล้วยืนยันเมื่อรายการสำเร็จ</div>
              <Button size="xl" variant="success" loading={busy} onClick={() => { const r = tender(cardType, amountIn); if (r?.done) confirm([...lines, { method: cardType, amount: r.applied, reference: ref || null }]); }}>ยืนยันรับชำระด้วยบัตร</Button>
            </div>
          ) : (
            <div className="col">
              <Seg size="lg" value={otherType} onChange={setOtherType} options={[{ value: 'transfer', label: 'โอนเงิน' }, { value: 'ewallet', label: 'E-Wallet' }, { value: 'other', label: 'อื่นๆ' }].filter((o) => methodsOn[o.value] !== false)} />
              <Input size="lg" label="จำนวนเงิน" type="number" value={amountIn} onValue={setAmountIn} />
              <Input label="เลขอ้างอิง" value={ref} onValue={setRef} />
              <Button size="xl" variant="success" loading={busy} onClick={() => { const r = tender(otherType, amountIn); if (r?.done) confirm([...lines, { method: otherType, amount: r.applied, reference: ref || null }]); }}>ยืนยันรับชำระ</Button>
            </div>
          )}
          {lines.length > 0 && remaining <= 0 && <Button size="xl" variant="primary" loading={busy} onClick={() => confirm()}>ปิดบิล · ยืนยันการชำระเงิน</Button>}
          {lines.length > 0 && remaining > 0 && <div className="small muted center">Split Payment: เลือกช่องทางถัดไปเพื่อชำระส่วนที่เหลือ ฿{money(remaining)}</div>}
        </div>
      </div>
    </Modal>
  );
}

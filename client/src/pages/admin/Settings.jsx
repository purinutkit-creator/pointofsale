// Store settings: shop/theme/logo, VAT, Service Charge, Receipt designer & copies, Kitchen, POS, Payment/PromptPay,
// Point & Member, Manager Approval, Customer/Queue display, Notifications, Branches, Devices, Backup/Restore
import { useEffect, useState } from 'react';
import { api, download } from '../../lib/api.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Input, Select, Toggle, TextArea, DataTable, useAsync, Badge, Seg, Spinner, Modal, Check, useDialog, Field } from '../../components/ui.jsx';
import { previewDataUrl } from '../../hw/printing.js';
import { fmtDateTime } from '../../lib/util.js';
import { qrSvg, promptPayPayload } from '@shared/codes.js';

const TABS = [
  ['shop', 'ร้าน / ธีม / โลโก้', 'settings.shop'], ['tax', 'VAT & Service Charge', 'settings.vat'], ['receipt', 'ใบเสร็จ & จำนวนใบพิมพ์', 'settings.receipt'],
  ['kitchen', 'ครัว / ใบครัว', 'settings.printer'], ['pos', 'POS / Login / กะ', 'settings.shop'], ['payment', 'Payment / PromptPay', 'settings.payment'],
  ['points', 'สะสมแต้ม / สมาชิก', 'settings.point'], ['approval', 'Manager Approval', 'settings.approval'], ['display', 'จอลูกค้า / จอคิว', 'settings.shop'],
  ['notify', 'การแจ้งเตือน', 'settings.member'], ['branches', 'สาขา', 'settings.branch'], ['devices', 'อุปกรณ์', 'settings.device'], ['backup', 'Backup / Restore', 'settings.backup'],
];

export default function Settings() {
  const can = useApp((s) => s.can);
  const tabs = TABS.filter((t) => can(t[2]));
  const [tab, setTab] = useState(tabs[0]?.[0]);
  const [scope, setScope] = useState('global');
  const branchId = useApp((s) => s.staff.branchId);
  const data = useAsync(() => api(`/settings?branchId=${branchId}`), [branchId]);
  if (!data.data) return <Page title="ตั้งค่า"><Spinner /></Page>;
  const { settings, overrides, branchScoped } = data.data;
  const save = async (key, value) => {
    try {
      const r = await api(`/settings/${key}`, { method: 'PUT', body: { value, branchId: scope === 'branch' && branchScoped.includes(key) ? branchId : null } });
      toast('บันทึกการตั้งค่าแล้ว', 'success');
      data.reload(); useApp.getState().loadMe();
      return r;
    } catch (e) { toast(e.message, 'error'); }
  };
  const props = { s: settings, save, overrides, scope };
  const scoped = { tax: ['vat', 'serviceCharge'], receipt: ['receipt'], kitchen: ['kitchen'], pos: ['pos'], payment: ['payment'], display: ['display', 'queue'] }[tab];
  return (
    <Page title="ตั้งค่า" tabs={tabs.map(([value, label]) => ({ value, label }))} tab={tab} onTab={setTab}>
      {scoped && (
        <div className="card pad row wrap mb">
          <span className="small">บันทึกการตั้งค่าเป็น:</span>
          <Seg value={scope} onChange={setScope} options={[{ value: 'global', label: 'ค่าเริ่มต้นทุกสาขา' }, { value: 'branch', label: 'เฉพาะสาขานี้' }]} />
          {scoped.some((k) => overrides[k]) && <><Badge tone="warning">สาขานี้มีค่ากำหนดเฉพาะ</Badge><Button size="sm" variant="ghost" onClick={async () => { for (const k of scoped) if (overrides[k]) await api(`/settings/${k}/branch/${branchId}`, { method: 'DELETE' }); data.reload(); }}>ล้างค่าเฉพาะสาขา</Button></>}
        </div>
      )}
      {tab === 'shop' && <ShopTab {...props} />}
      {tab === 'tax' && <TaxTab {...props} />}
      {tab === 'receipt' && <ReceiptTab {...props} />}
      {tab === 'kitchen' && <Form keyName="kitchen" {...props} fields={[['printOnSend', 'พิมพ์ใบครัวอัตโนมัติเมื่อกดส่งครัว', 'toggle'], ['voidTicket', 'พิมพ์ใบยกเลิก (VOID) ไปที่ครัวเมื่อ Void รายการที่ส่งแล้ว', 'toggle'], ['kdsSound', 'เสียงแจ้งเตือน Order ใหม่บน KDS', 'toggle']]} note="จำนวนใบครัวแยกตาม Station/Printer ตั้งได้ที่ เครื่องพิมพ์ › Printer Routing · การตัดใบครัวตามสินค้า ตั้งที่หน้าแก้ไขสินค้า" />}
      {tab === 'pos' && <Form keyName="pos" {...props} fields={[
        ['requireShift', 'บังคับเปิดกะ (Open Shift) ก่อนขาย', 'toggle'], ['autoLogoutMinutes', 'Auto Logout เมื่อไม่ใช้งาน (นาที, 0 = ปิด)', 'number'], ['lockAfterMinutes', 'Lock Screen เมื่อไม่ใช้งาน (นาที, 0 = ปิด)', 'number'],
        ['loginMode', 'วิธี Login', 'select', [['both', 'รหัส + PIN และเลือกชื่อ'], ['code', 'Employee Code + PIN'], ['picker', 'เลือกชื่อพนักงาน + PIN']]],
        ['defaultOrderType', 'ประเภทบิลเริ่มต้น', 'select', [['dine_in', 'ทานที่ร้าน'], ['takeaway', 'กลับบ้าน']]], ['askGuests', 'ถามจำนวนลูกค้าเมื่อเปิดโต๊ะ', 'toggle'], ['cleanTableAfterPay', 'ตั้งโต๊ะเป็น "ทำความสะอาด" หลังชำระเงิน', 'toggle'],
        ['showStock', 'แสดง Stock บนหน้าขาย', 'toggle'], ['quickCash', 'ปุ่ม Quick Cash (คั่นด้วย ,)', 'list'],
        ['employeeCodeMode', 'Employee Code', 'select', [['auto', 'Auto Generate'], ['manual', 'Manual']]], ['employeeCodePrefix', 'Prefix รหัสพนักงาน', 'text'], ['employeeCodeDigits', 'จำนวนหลัก', 'number']]} />}
      {tab === 'payment' && <PaymentTab {...props} />}
      {tab === 'points' && <PointsTab {...props} />}
      {tab === 'approval' && <ApprovalTab {...props} />}
      {tab === 'display' && <DisplayTab {...props} />}
      {tab === 'notify' && <NotifyTab {...props} />}
      {tab === 'branches' && <Branches />}
      {tab === 'devices' && <Devices />}
      {tab === 'backup' && <Backup />}
    </Page>
  );
}

function useDraft(v) { const [d, setD] = useState(v); useEffect(() => setD(v), [v]); return [d, setD]; }

function Form({ keyName, s, save, fields, note }) {
  const [d, setD] = useDraft(s[keyName]);
  return (
    <div className="card pad col" style={{ maxWidth: 760 }}>
      {fields.map(([k, label, type, opts]) => (
        type === 'toggle' ? <Toggle key={k} label={label} checked={!!d[k]} onChange={(v) => setD({ ...d, [k]: v })} />
          : type === 'select' ? <Select key={k} label={label} value={d[k] ?? ''} onValue={(v) => setD({ ...d, [k]: v })} options={opts.map(([value, l]) => ({ value, label: l }))} />
            : type === 'list' ? <Input key={k} label={label} value={(d[k] || []).join(',')} onValue={(v) => setD({ ...d, [k]: v.split(',').map((x) => Number(x.trim())).filter(Boolean) })} />
              : <Input key={k} label={label} type={type === 'number' ? 'number' : 'text'} value={d[k] ?? ''} onValue={(v) => setD({ ...d, [k]: v })} />
      ))}
      {note && <div className="xs muted">{note}</div>}
      <Button variant="primary" onClick={() => save(keyName, d)}>บันทึก</Button>
    </div>
  );
}

function ShopTab({ s, save }) {
  const [d, setD] = useDraft(s.shop);
  const t = d.theme || {};
  const setT = (k, v) => setD({ ...d, theme: { ...t, [k]: v } });
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card pad col">
        <Input label="ชื่อร้าน (Shop Name)" value={d.name} onValue={(v) => setD({ ...d, name: v })} />
        <Input label="English Name" value={d.nameEn || ''} onValue={(v) => setD({ ...d, nameEn: v })} />
        <Input label="โลโก้ (ลิงก์รูปภาพ URL)" value={d.logoUrl} onValue={(v) => setD({ ...d, logoUrl: v })} placeholder="https://…/logo.png" />
        <Input label="รูปปก / Cover (URL) — หน้าสมาชิก" value={d.coverImageUrl} onValue={(v) => setD({ ...d, coverImageUrl: v })} />
        <Input label="Favicon (URL)" value={d.faviconUrl} onValue={(v) => setD({ ...d, faviconUrl: v })} />
        <Input label="โทร" value={d.phone} onValue={(v) => setD({ ...d, phone: v })} />
        <TextArea label="ที่อยู่" value={d.address} onValue={(v) => setD({ ...d, address: v })} rows={2} />
        <Input label="เลขประจำตัวผู้เสียภาษี (Tax ID)" value={d.taxId} onValue={(v) => setD({ ...d, taxId: v })} />
        <div className="grid-2">
          <Select label="สกุลเงิน" value={d.currency} onValue={(v) => setD({ ...d, currency: v, currencySymbol: v === 'THB' ? '฿' : v })} options={['THB', 'USD', 'LAK', 'MMK', 'KHR']} />
          <Select label="Timezone" value={d.timezone} onValue={(v) => setD({ ...d, timezone: v })} options={['Asia/Bangkok', 'Asia/Vientiane', 'Asia/Yangon', 'Asia/Phnom_Penh', 'Asia/Singapore', 'UTC']} />
        </div>
        <Input label="Public URL (ใช้ใน QR สะสมแต้มท้ายใบเสร็จ)" value={d.publicUrl} onValue={(v) => setD({ ...d, publicUrl: v })} placeholder="https://pos.myshop.com" />
        <Input label="ฟอนต์ Sukhumvit สำหรับหน้าสมาชิก (URL .woff2/.ttf ที่มีสิทธิ์ใช้งาน)" value={d.memberFontUrl} onValue={(v) => setD({ ...d, memberFontUrl: v })} hint="อุปกรณ์ Apple มีฟอนต์ Sukhumvit Set ในเครื่องอยู่แล้ว" />
      </div>
      <div className="card pad col">
        <b>ธีมสี</b>
        <div className="grid-2">
          <Input label="สีหลัก (Primary)" type="color" value={t.primary} onValue={(v) => setT('primary', v)} />
          <Input label="สีรอง (Accent)" type="color" value={t.accent} onValue={(v) => setT('accent', v)} />
          <Input label="สีหลักหน้าสมาชิก" type="color" value={t.memberPrimary} onValue={(v) => setT('memberPrimary', v)} />
          <Input label="สีเน้นหน้าสมาชิก" type="color" value={t.memberAccent} onValue={(v) => setT('memberAccent', v)} />
          <Input label="ความโค้งมุม (px)" type="number" value={t.radius} onValue={(v) => setT('radius', v)} />
          <Select label="โหมด" value={t.mode} onValue={(v) => setT('mode', v)} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </div>
        <div className="row card pad" style={{ background: t.primary, color: '#fff' }}>{d.logoUrl && <img src={d.logoUrl} alt="" style={{ width: 48, height: 48, borderRadius: 12, objectFit: 'cover' }} />}<b style={{ fontSize: 20 }}>{d.name}</b></div>
        <Button variant="primary" onClick={() => save('shop', d)}>บันทึก</Button>
      </div>
    </div>
  );
}

function TaxTab({ s, save }) {
  const [v, setV] = useDraft(s.vat);
  const [sc, setSc] = useDraft(s.serviceCharge);
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card pad col">
        <h3>ตั้งค่า VAT</h3>
        <Toggle label="เปิดใช้ VAT" checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} />
        <Field label="อัตรา VAT"><div className="row wrap">{[0, 7].map((r) => <button key={r} type="button" className={`chip ${Number(v.rate) === r ? 'on' : ''}`} onClick={() => setV({ ...v, rate: r })}>{r}%</button>)}<Input type="number" value={v.rate} onValue={(x) => setV({ ...v, rate: x })} style={{ maxWidth: 120 }} /> <span className="small muted">Custom %</span></div></Field>
        <Seg value={v.mode} onChange={(x) => setV({ ...v, mode: x })} options={[{ value: 'inclusive', label: 'VAT Inclusive (ราคารวม VAT)' }, { value: 'exclusive', label: 'VAT Exclusive (บวก VAT เพิ่ม)' }]} />
        <div className="xs muted">สินค้าที่ยกเว้น VAT ตั้งได้ในหน้าสินค้า (VAT Exempt)</div>
        <Button variant="primary" onClick={() => save('vat', { ...v, rate: Number(v.rate) })}>บันทึก VAT</Button>
      </div>
      <div className="card pad col">
        <h3>Service Charge</h3>
        <Toggle label="เปิดใช้ Service Charge" checked={sc.enabled} onChange={(x) => setSc({ ...sc, enabled: x })} />
        <Field label="อัตรา"><div className="row wrap">{[0, 5, 10].map((r) => <button key={r} type="button" className={`chip ${Number(sc.rate) === r ? 'on' : ''}`} onClick={() => setSc({ ...sc, rate: r })}>{r}%</button>)}<Input type="number" value={sc.rate} onValue={(x) => setSc({ ...sc, rate: x })} style={{ maxWidth: 120 }} /></div></Field>
        <Seg value={sc.applyTo} onChange={(x) => setSc({ ...sc, applyTo: x })} options={[{ value: 'dine_in', label: 'ทานที่ร้าน' }, { value: 'takeaway', label: 'กลับบ้าน' }, { value: 'all', label: 'ทั้งหมด' }]} />
        <div className="xs muted">สินค้า/หมวดยกเว้นได้ในหน้าสินค้า · สิทธิ์ยกเว้น SC ในบิล: Permission "ยกเว้น Service Charge"</div>
        <div className="card pad xs muted">ลำดับการคำนวณ (Calculation Engine กลาง): Subtotal → Discount → Service Charge → VAT → Grand Total</div>
        <Button variant="primary" onClick={() => save('serviceCharge', { ...sc, rate: Number(sc.rate) })}>บันทึก Service Charge</Button>
      </div>
    </div>
  );
}

const SECTIONS = { logo: 'Logo', shopName: 'ชื่อร้าน', branch: 'สาขา', address: 'ที่อยู่', phone: 'โทร', taxId: 'Tax ID', header: 'Header', member: 'ข้อมูลสมาชิก/แต้ม', claimQr: 'QR สะสมแต้ม', qr: 'QR Code', social: 'Social', promotion: 'Promotion', footer: 'Footer' };

function ReceiptTab({ s, save }) {
  const [d, setD] = useDraft(s.receipt);
  const [paper, setPaper] = useState('80');
  const [img, setImg] = useState(null);
  const shop = s.shop;
  useEffect(() => {
    const doc = {
      type: 'receipt', title: d.docType === 'abb_tax_invoice' ? 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ' : 'ใบเสร็จรับเงิน', receiptNo: 'R000125', orderNo: '0045', queueNo: 'Q011', time: new Date().toISOString(), tz: shop.timezone, staff: 'EMP003', orderType: 'takeaway', vatMode: s.vat.mode,
      shop: { name: shop.name, logoUrl: shop.logoUrl, address: shop.address, phone: shop.phone, taxId: shop.taxId, branchName: useApp.getState().branch?.name, header: d.header, footer: d.footer, social: d.social, promotion: d.promotion, qrText: d.qrText, qrLabel: d.qrLabel },
      sections: { ...d.sections, claimQr: d.claimQr && d.sections.claimQr },
      items: [{ qty: 2, name: 'ชาไทย', variant: 'L', lineTotal: 130, modifiers: [{ name: 'หวาน 25%' }, { name: 'ไข่มุก', price: 10, qty: 1 }] }],
      totals: { subtotal: 130, discount: 0, serviceCharge: 0, vat: s.vat.enabled ? 8.5 : 0, vatRate: s.vat.enabled ? s.vat.rate : 0, vatMode: s.vat.mode, beforeVat: 121.5, total: 130 },
      payments: [{ method: 'cash', amount: 130 }], received: 200, change: 70,
      member: { name: 'Punpun', tier: 'Gold', before: 325, used: 100, earned: 12, balance: 237 }, claimUrl: `${shop.publicUrl || location.origin}/m/claim/preview`, claimPoints: 5, copy: d.copies > 1 ? { n: 1, of: d.copies } : null,
    };
    const t = setTimeout(() => previewDataUrl(doc, { paper }).then(setImg).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [d, paper, s, shop]);
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="col">
        <div className="card pad col">
          <h3>การตั้งค่าจำนวนใบพิมพ์ — ใบเสร็จ</h3>
          <Field label="จำนวนใบเสร็จที่พิมพ์อัตโนมัติ"><div className="row wrap">{[0, 1, 2, 3].map((n) => <button key={n} type="button" className={`chip ${Number(d.copies) === n ? 'on' : ''}`} onClick={() => setD({ ...d, copies: n })}>{n} ใบ</button>)}<Input type="number" min={0} max={10} value={d.copies} onValue={(v) => setD({ ...d, copies: v })} style={{ maxWidth: 90 }} /><span className="small muted">Custom</span></div></Field>
          <Seg value={d.printMode} onChange={(v) => setD({ ...d, printMode: v })} options={[{ value: 'auto', label: 'Auto Print' }, { value: 'ask', label: 'Ask Before Print' }, { value: 'none', label: 'No Auto Print' }]} />
          <Toggle label="พนักงานเปลี่ยนจำนวนใบได้" checked={d.staffCanChangeCopies} onChange={(v) => setD({ ...d, staffCanChangeCopies: v })} />
          <div className="xs muted">ทุกสำเนาใช้เลขที่ใบเสร็จ/Payment เดียวกัน ไม่สร้างเลขใหม่</div>
          <Select label="ประเภทเอกสารเริ่มต้น" value={d.docType} onValue={(v) => setD({ ...d, docType: v })} options={[{ value: 'receipt', label: 'Receipt / ใบเสร็จรับเงิน' }, { value: 'abb_tax_invoice', label: 'Simplified Tax Invoice / ใบกำกับภาษีอย่างย่อ' }]} />
          <Toggle label="พิมพ์ QR สะสมแต้มท้ายใบเสร็จ (ลูกค้าไม่ได้ระบุสมาชิก)" checked={d.claimQr} onChange={(v) => setD({ ...d, claimQr: v })} />
        </div>
        <div className="card pad col">
          <h3>Receipt Designer</h3>
          <TextArea label="Header" value={d.header} onValue={(v) => setD({ ...d, header: v })} rows={2} />
          <TextArea label="Footer" value={d.footer} onValue={(v) => setD({ ...d, footer: v })} rows={2} />
          <Input label="Social (เช่น LINE: @myshop · IG: myshop)" value={d.social} onValue={(v) => setD({ ...d, social: v })} />
          <TextArea label="Promotion" value={d.promotion} onValue={(v) => setD({ ...d, promotion: v })} rows={2} />
          <div className="grid-2"><Input label="QR Code (ข้อความ/ลิงก์)" value={d.qrText} onValue={(v) => setD({ ...d, qrText: v })} /><Input label="ข้อความเหนือ QR" value={d.qrLabel} onValue={(v) => setD({ ...d, qrLabel: v })} /></div>
          <b>เปิด/ปิดแต่ละ Section</b>
          <div className="row wrap">{Object.entries(SECTIONS).map(([k, l]) => <Check key={k} label={l} checked={d.sections[k] !== false} onChange={(v) => setD({ ...d, sections: { ...d.sections, [k]: v } })} />)}</div>
          <Button variant="primary" onClick={() => save('receipt', { ...d, copies: Number(d.copies) })}>บันทึก</Button>
        </div>
      </div>
      <div className="card pad col" style={{ position: 'sticky', top: 10, alignItems: 'center' }}>
        <div className="row"><b>Print Preview (Sarabun)</b><Seg value={paper} onChange={setPaper} options={[{ value: '58', label: '58mm' }, { value: '80', label: '80mm' }]} /></div>
        {img ? <img src={img} alt="preview" style={{ width: paper === '58' ? 270 : 360, boxShadow: 'var(--shadow-lg)', background: '#fff' }} /> : <Spinner />}
      </div>
    </div>
  );
}

function PaymentTab({ s, save }) {
  const [d, setD] = useDraft(s.payment);
  const pp = d.promptpay;
  let sample = null;
  try { sample = pp.id ? qrSvg(promptPayPayload(pp.id, 1)) : null; } catch { sample = null; }
  const M = { cash: 'เงินสด', qr: 'QR / PromptPay', credit_card: 'Credit Card', debit_card: 'Debit Card', transfer: 'โอนเงิน', ewallet: 'E-Wallet', other: 'อื่นๆ' };
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card pad col"><h3>ช่องทางชำระเงิน</h3>{Object.entries(M).map(([k, l]) => <Toggle key={k} label={l} checked={d.methods[k] !== false} onChange={(v) => setD({ ...d, methods: { ...d.methods, [k]: v } })} />)}</div>
      <div className="card pad col">
        <h3>PromptPay</h3>
        <Toggle label="เปิดใช้ PromptPay" checked={pp.enabled} onChange={(v) => setD({ ...d, promptpay: { ...pp, enabled: v } })} />
        <Input label="PromptPay ID (เบอร์โทร / เลขบัตรประชาชน / เลขผู้เสียภาษี)" value={pp.id} onValue={(v) => setD({ ...d, promptpay: { ...pp, id: v } })} />
        <Input label="ชื่อบัญชี (Account Name)" value={pp.accountName} onValue={(v) => setD({ ...d, promptpay: { ...pp, accountName: v } })} />
        <Toggle label="Dynamic QR (ใส่ยอดเงินใน QR อัตโนมัติ)" checked={pp.dynamic} onChange={(v) => setD({ ...d, promptpay: { ...pp, dynamic: v } })} />
        <Input label="หรือใช้รูป QR (URL) แทน" value={pp.qrImageUrl} onValue={(v) => setD({ ...d, promptpay: { ...pp, qrImageUrl: v } })} />
        {sample && <div style={{ width: 160 }} dangerouslySetInnerHTML={{ __html: sample }} title="ตัวอย่าง QR ยอด 1 บาท" />}
        <Button variant="primary" onClick={() => save('payment', d)}>บันทึก</Button>
      </div>
    </div>
  );
}

function PointsTab({ s, save }) {
  const [p, setP] = useDraft(s.points);
  const [m, setM] = useDraft(s.member);
  const ex = p.expiry || {};
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card pad col">
        <h3>สูตรสะสมแต้ม</h3>
        <Toggle label="เปิดระบบสะสมแต้ม" checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} />
        <div className="row"><Input label="ทุกยอดซื้อ (บาท)" type="number" value={p.earnAmount} onValue={(v) => setP({ ...p, earnAmount: v })} /><Input label="ได้รับ (แต้ม)" type="number" value={p.earnPoints} onValue={(v) => setP({ ...p, earnPoints: v })} /></div>
        <div className="xs muted">ตัวอย่าง: {p.earnAmount} บาท = {p.earnPoints} คะแนน → ซื้อ 500 บาท ได้ {Math.floor((500 / (Number(p.earnAmount) || 1)) * Number(p.earnPoints))} คะแนน</div>
        <Select label="ฐานคำนวณ" value={p.base} onValue={(v) => setP({ ...p, base: v })} options={[{ value: 'before_discount', label: 'ก่อน Discount' }, { value: 'after_discount', label: 'หลัง Discount (ยอดสุทธิ)' }, { value: 'before_vat', label: 'ก่อน VAT' }, { value: 'after_vat', label: 'หลัง VAT' }, { value: 'grand_total', label: 'Grand Total' }]} />
        <Select label="การปัดเศษแต้ม" value={p.rounding} onValue={(v) => setP({ ...p, rounding: v })} options={[{ value: 'floor', label: 'ปัดลง' }, { value: 'ceil', label: 'ปัดขึ้น' }, { value: 'round', label: 'ปัดตามหลักคณิต' }]} />
        <Input label="ยอดขั้นต่ำที่จะได้แต้ม (บาท)" type="number" value={p.minSpend} onValue={(v) => setP({ ...p, minSpend: v })} />
        <Select label="วันหมดอายุแต้ม" value={ex.mode === 'months' ? `m${ex.months}` : ex.mode} onValue={(v) => setP({ ...p, expiry: v === 'none' ? { mode: 'none' } : v === 'fixed' ? { ...ex, mode: 'fixed' } : { mode: 'months', months: Number(v.slice(1)) } })} options={[{ value: 'none', label: 'ไม่มีวันหมดอายุ' }, { value: 'm6', label: 'หมดอายุภายใน 6 เดือน' }, { value: 'm12', label: 'หมดอายุภายใน 12 เดือน' }, { value: 'm24', label: 'หมดอายุภายใน 24 เดือน' }, { value: 'fixed', label: 'กำหนดวันหมดอายุเอง' }]} />
        {ex.mode === 'fixed' && <Input label="วันหมดอายุ" type="date" value={ex.date || ''} onValue={(v) => setP({ ...p, expiry: { ...ex, date: v } })} />}
        <Select label="Refund เมื่อแต้มไม่พอหัก" value={p.negativePolicy} onValue={(v) => setP({ ...p, negativePolicy: v })} options={[{ value: 'allow_negative', label: 'อนุญาตให้แต้มติดลบ' }, { value: 'debt', label: 'สร้าง Point Debt (หักจากแต้มในอนาคต)' }]} />
        <Select label="Tier ตัดสินจาก" value={p.tierBasis} onValue={(v) => setP({ ...p, tierBasis: v })} options={[{ value: 'lifetime', label: 'คะแนนสะสมตลอดชีพ' }, { value: 'current', label: 'คะแนนคงเหลือปัจจุบัน' }]} />
        <Input label="มูลค่าแต้มเมื่อใช้เป็นส่วนลด (บาท/แต้ม, 0 = ปิด)" type="number" value={p.pointValue} onValue={(v) => setP({ ...p, pointValue: v })} />
        <Input label="QR สะสมแต้มท้ายใบเสร็จใช้ได้ภายใน (วัน)" type="number" value={p.claimDays} onValue={(v) => setP({ ...p, claimDays: v })} />
        <Button variant="primary" onClick={() => save('points', { ...p, earnAmount: Number(p.earnAmount), earnPoints: Number(p.earnPoints), minSpend: Number(p.minSpend) || 0, pointValue: Number(p.pointValue) || 0, claimDays: Number(p.claimDays) || 7 })}>บันทึก</Button>
      </div>
      <div className="card pad col">
        <h3>สมาชิก</h3>
        <TextArea label="ข้อความเงื่อนไขการสมัคร" value={m.termsText} onValue={(v) => setM({ ...m, termsText: v })} />
        <Input label="แต้มต้อนรับสมาชิกใหม่" type="number" value={m.welcomePoints} onValue={(v) => setM({ ...m, welcomePoints: Number(v) || 0 })} />
        <Input label="ความยาว Redemption Code (หลัก)" type="number" value={m.redemptionCodeLength} onValue={(v) => setM({ ...m, redemptionCodeLength: Number(v) || 6 })} />
        <div className="xs muted">หน้าสมาชิก: {location.origin}/m — Tier / Rewards / Birthday ตั้งค่าที่เมนู Loyalty Program</div>
        <Button variant="primary" onClick={() => save('member', m)}>บันทึก</Button>
      </div>
    </div>
  );
}

function ApprovalTab({ s, save }) {
  const cat = useAsync(() => api('/permissions/catalog'));
  const [d, setD] = useDraft(s.approval);
  if (!cat.data) return <Spinner />;
  return (
    <div className="card pad col" style={{ maxWidth: 640 }}>
      <h3>Function ที่ต้องใช้ Manager PIN</h3>
      <div className="xs muted">พนักงานระดับ Manager ขึ้นไปไม่ต้องขออนุมัติ · บันทึก ผู้ทำ / ผู้อนุมัติ / เวลา / เหตุผล / Order ทุกครั้ง</div>
      {cat.data.approvalActions.map(([k, l]) => <Toggle key={k} label={l} checked={d.actions.includes(k)} onChange={(on) => setD({ ...d, actions: on ? [...d.actions, k] : d.actions.filter((x) => x !== k) })} />)}
      <Button variant="primary" onClick={() => save('approval', d)}>บันทึก</Button>
    </div>
  );
}

function DisplayTab({ s, save }) {
  const [d, setD] = useDraft(s.display);
  const [q, setQ] = useDraft(s.queue);
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card pad col">
        <h3>Customer Display</h3>
        <TextArea label="รูปโปรโมชั่นขณะ Idle (URL บรรทัดละ 1 รูป)" value={(d.images || []).join('\n')} onValue={(v) => setD({ ...d, images: v.split('\n').map((x) => x.trim()).filter(Boolean) })} rows={5} />
        <div className="row wrap">{(d.images || []).map((u) => <img key={u} src={u} alt="" style={{ height: 60, borderRadius: 8 }} />)}</div>
        <Input label="เปลี่ยนรูปทุก (วินาที)" type="number" value={d.intervalSec} onValue={(v) => setD({ ...d, intervalSec: Number(v) || 8 })} />
        <Input label="ข้อความต้อนรับ" value={d.welcomeText} onValue={(v) => setD({ ...d, welcomeText: v })} />
        <Toggle label="ให้ลูกค้ากรอกเบอร์สะสมแต้ม / ใช้ Reward บนจอลูกค้า" checked={d.allowMemberInput !== false} onChange={(v) => setD({ ...d, allowMemberInput: v })} />
        <Button variant="primary" onClick={() => save('display', d)}>บันทึก</Button>
      </div>
      <div className="card pad col">
        <h3>Queue Display</h3>
        <Input label="หัวข้อจอ" value={q.title} onValue={(v) => setQ({ ...q, title: v })} />
        <Toggle label="เสียงเรียกคิว (พูดภาษาไทย)" checked={q.voice} onChange={(v) => setQ({ ...q, voice: v })} />
        <Input label="ข้อความเรียกคิว ({queue} = เลขคิว)" value={q.voiceTemplate} onValue={(v) => setQ({ ...q, voiceTemplate: v })} />
        <Input label="ซ่อนคิวที่พร้อมรับหลัง (นาที)" type="number" value={q.readyHideMinutes} onValue={(v) => setQ({ ...q, readyHideMinutes: Number(v) || 20 })} />
        <Button variant="primary" onClick={() => save('queue', q)}>บันทึก</Button>
      </div>
    </div>
  );
}

function NotifyTab({ s, save }) {
  const [d, setD] = useDraft(s.notifications);
  const [to, setTo] = useState('');
  const set2 = (g, k, v) => setD({ ...d, [g]: { ...d[g], [k]: v } });
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card pad col">
        <h3>ช่องทางแจ้งเตือนสมาชิก</h3>
        <div className="xs muted">In-app (หน้าสมาชิก, Real-time) เปิดเสมอ</div>
        {['email', 'sms', 'line'].map((c) => <Toggle key={c} label={c.toUpperCase()} checked={d.channels[c]} onChange={(v) => set2('channels', c, v)} />)}
        <h3 className="mt">LINE Messaging API</h3>
        <Input label="Channel Access Token" type="password" value={d.line.channelAccessToken} onValue={(v) => set2('line', 'channelAccessToken', v)} />
        <h3 className="mt">SMS Gateway (HTTP)</h3>
        <Input label="URL" value={d.sms.url} onValue={(v) => set2('sms', 'url', v)} />
        <Select label="Method" value={d.sms.method} onValue={(v) => set2('sms', 'method', v)} options={['POST', 'GET']} />
        <TextArea label="Headers (JSON)" value={d.sms.headers} onValue={(v) => set2('sms', 'headers', v)} rows={2} />
        <TextArea label="Body template ({phone}, {message})" value={d.sms.body} onValue={(v) => set2('sms', 'body', v)} rows={2} />
      </div>
      <div className="card pad col">
        <h3>Email (SMTP)</h3>
        <Input label="Host" value={d.smtp.host} onValue={(v) => set2('smtp', 'host', v)} />
        <div className="row"><Input label="Port" type="number" value={d.smtp.port} onValue={(v) => set2('smtp', 'port', v)} /><Toggle label="SSL/TLS" checked={d.smtp.secure} onChange={(v) => set2('smtp', 'secure', v)} /></div>
        <Input label="User" value={d.smtp.user} onValue={(v) => set2('smtp', 'user', v)} />
        <Input label="Password" type="password" value={d.smtp.pass} onValue={(v) => set2('smtp', 'pass', v)} />
        <Input label="From" value={d.smtp.from} onValue={(v) => set2('smtp', 'from', v)} />
        <div className="row"><Input placeholder="ส่งทดสอบไปที่อีเมล" value={to} onValue={setTo} /><Button onClick={() => api('/settings/test-email', { method: 'POST', body: { to } }).then(() => toast('ส่งแล้ว', 'success')).catch((e) => toast(e.message, 'error'))}>ทดสอบ</Button></div>
        <Toggle label="แจ้งเตือนพนักงานเมื่อ Stock ต่ำ" checked={d.lowStock} onChange={(v) => setD({ ...d, lowStock: v })} />
        <Button variant="primary" onClick={() => save('notifications', d)}>บันทึก</Button>
      </div>
    </div>
  );
}

function Branches() {
  const list = useAsync(() => api('/branches'));
  const [edit, setEdit] = useState(null);
  const save = async () => {
    const b = { code: edit.code, name: edit.name, address: edit.address || null, phone: edit.phone || null, taxId: edit.tax_id || null, taxBranch: edit.tax_branch || null, timezone: edit.timezone || 'Asia/Bangkok', receiptPrefix: edit.receipt_prefix, queuePrefix: edit.queue_prefix ?? 'Q', active: edit.active !== 0 && edit.active !== false };
    try { if (edit.id) await api(`/branches/${edit.id}`, { method: 'PUT', body: b }); else await api('/branches', { method: 'POST', body: b }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="col">
      <DataTable rows={list.data || []} search={false} onRow={(b) => setEdit({ ...b })} toolbar={<Button variant="primary" icon="plus" onClick={() => setEdit({ code: '', name: '', receipt_prefix: '', queue_prefix: 'Q', timezone: 'Asia/Bangkok' })}>เพิ่มสาขา</Button>}
        columns={[{ key: 'code', label: 'รหัส' }, { key: 'name', label: 'สาขา', render: (b) => <b>{b.name}</b> }, { key: 'receipt_prefix', label: 'Prefix ใบเสร็จ' }, { key: 'queue_prefix', label: 'Prefix คิว' }, { key: 'staff_count', label: 'พนักงาน', num: true }, { key: 'device_count', label: 'อุปกรณ์', num: true }, { key: 'active', label: 'สถานะ', render: (b) => <Badge tone={b.active ? 'success' : ''}>{b.active ? 'เปิด' : 'ปิด'}</Badge> }]} />
      <div className="xs muted">แต่ละสาขามี สินค้า/ราคา (ตั้งในหน้าสินค้า), Stock, พนักงาน, โต๊ะ, เครื่องพิมพ์, KDS, VAT/Service Charge (ตั้ง "เฉพาะสาขานี้"), Promotion แยกได้ · Owner ดู Dashboard รวมทุกสาขาได้</div>
      {edit && (
        <Modal title={edit.id ? edit.name : 'เพิ่มสาขา'} onClose={() => setEdit(null)} footer={<Button variant="primary" onClick={save}>บันทึก</Button>}>
          <div className="grid-2">
            <Input label="รหัสสาขา" value={edit.code} onValue={(v) => setEdit({ ...edit, code: v.toUpperCase() })} />
            <Input label="ชื่อสาขา" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            <Input label="Prefix ใบเสร็จ (ไม่ซ้ำ)" value={edit.receipt_prefix} onValue={(v) => setEdit({ ...edit, receipt_prefix: v.toUpperCase() })} />
            <Input label="Prefix คิว" value={edit.queue_prefix} onValue={(v) => setEdit({ ...edit, queue_prefix: v.toUpperCase() })} />
            <Input label="โทร" value={edit.phone || ''} onValue={(v) => setEdit({ ...edit, phone: v })} />
            <Input label="Tax ID" value={edit.tax_id || ''} onValue={(v) => setEdit({ ...edit, tax_id: v })} />
            <Input label="สาขาตามทะเบียนภาษี (เช่น 00001)" value={edit.tax_branch || ''} onValue={(v) => setEdit({ ...edit, tax_branch: v })} />
            <Select label="Timezone" value={edit.timezone} onValue={(v) => setEdit({ ...edit, timezone: v })} options={['Asia/Bangkok', 'Asia/Vientiane', 'Asia/Yangon', 'Asia/Singapore', 'UTC']} />
          </div>
          <TextArea label="ที่อยู่" value={edit.address || ''} onValue={(v) => setEdit({ ...edit, address: v })} />
          {edit.id && <Toggle label="เปิดใช้งาน" checked={!!edit.active} onChange={(v) => setEdit({ ...edit, active: v ? 1 : 0 })} />}
        </Modal>
      )}
    </div>
  );
}

function Devices() {
  const list = useAsync(() => api('/devices'));
  const stations = useAsync(() => api('/stations'));
  const [edit, setEdit] = useState(null);
  const T = { pos: 'POS', kds: 'KDS', customer_display: 'Customer Display', queue_display: 'Queue Display', bridge: 'Print Bridge', member_kiosk: 'Member Kiosk' };
  const save = async () => { try { await api(`/devices/${edit.id}`, { method: 'PUT', body: { name: edit.name, pairedPosId: edit.paired_pos_id ? Number(edit.paired_pos_id) : null, stationId: edit.station_id ? Number(edit.station_id) : null, active: !!edit.active } }); setEdit(null); list.reload(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="col">
      <div className="small muted">ลงทะเบียนอุปกรณ์ใหม่: เปิดเว็บนี้บนอุปกรณ์ แล้วเลือก "ลงทะเบียนเครื่องนี้"</div>
      <DataTable rows={list.data || []} onRow={(d) => setEdit({ ...d })} columns={[{ key: 'code', label: 'รหัส' }, { key: 'name', label: 'ชื่อ', render: (d) => <b>{d.name}</b> }, { key: 'type', label: 'ประเภท', render: (d) => T[d.type] }, { key: 'paired', label: 'จับคู่/สถานี', render: (d) => d.paired_pos_name || d.station_name || '-' }, { key: 'online', label: 'สถานะ', render: (d) => <Badge tone={d.online ? 'success' : ''}>{d.online ? 'Online' : 'Offline'}</Badge> }, { key: 'last_seen_at', label: 'ล่าสุด', render: (d) => (d.last_seen_at ? fmtDateTime(d.last_seen_at) : '-') }, { key: 'active', label: '', render: (d) => (!d.active ? <Badge tone="danger">ปิดใช้งาน</Badge> : '') }]} />
      {edit && (
        <Modal title={edit.name} size="narrow" onClose={() => setEdit(null)} footer={<Button variant="primary" onClick={save}>บันทึก</Button>}>
          <div className="col">
            <Input label="ชื่อ" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
            {edit.type === 'customer_display' && <Select label="จับคู่กับ POS" value={edit.paired_pos_id ?? ''} onValue={(v) => setEdit({ ...edit, paired_pos_id: v })} options={(list.data || []).filter((d) => d.type === 'pos').map((d) => ({ value: d.id, label: d.name }))} />}
            {edit.type === 'kds' && <Select label="สถานีครัว" value={edit.station_id ?? ''} onValue={(v) => setEdit({ ...edit, station_id: v })} placeholder="ทุกสถานี" options={(stations.data || []).map((s) => ({ value: s.id, label: s.name }))} />}
            <Toggle label="เปิดใช้งาน (ปิด = เพิกถอน token ของเครื่อง)" checked={!!edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Backup() {
  const list = useAsync(() => api('/backups'));
  const settings = useApp((s) => s.settings);
  const dialog = useDialog();
  const [cfg, setCfg] = useDraft(settings.backup);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState({ from: '', to: '' });
  const restore = async (file, filename) => {
    if (!(await dialog.confirm({ message: 'ยืนยันการ Restore? ข้อมูลปัจจุบันจะถูกแทนที่ (ระบบจะสำรองข้อมูลก่อน Restore อัตโนมัติ)', danger: true }))) return;
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file); else fd.append('filename', filename);
      await api('/backups/restore', { method: 'POST', body: fd });
      toast('Restore สำเร็จ กรุณาเข้าสู่ระบบใหม่', 'success');
      setTimeout(() => window.location.assign('/login'), 1500);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card pad col">
        <h3>Automatic Backup</h3>
        <Toggle label="สำรองข้อมูลอัตโนมัติทุกวัน" checked={cfg.auto} onChange={(v) => setCfg({ ...cfg, auto: v })} />
        <Input label="เวลา (ชั่วโมง 0–23)" type="number" value={cfg.hour} onValue={(v) => setCfg({ ...cfg, hour: Number(v) })} />
        <Input label="เก็บย้อนหลัง (ไฟล์)" type="number" value={cfg.keep} onValue={(v) => setCfg({ ...cfg, keep: Number(v) })} />
        <Button onClick={() => api('/settings/backup', { method: 'PUT', body: { value: cfg } }).then(() => toast('บันทึกแล้ว', 'success')).catch((e) => toast(e.message, 'error'))}>บันทึก</Button>
        <h3 className="mt">Manual Backup / Export</h3>
        <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api('/backups', { method: 'POST', body: {} }); list.reload(); toast('สำรองข้อมูลแล้ว', 'success'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } }}>Backup ตอนนี้</Button>
        <div className="row"><Input type="date" value={range.from} onValue={(v) => setRange({ ...range, from: v })} /><Input type="date" value={range.to} onValue={(v) => setRange({ ...range, to: v })} /></div>
        <Button icon="download" onClick={() => download(`/export${range.from ? `?from=${range.from}&to=${range.to || range.from}` : ''}`)}>Export Data (JSON)</Button>
        <h3 className="mt">Restore จากไฟล์</h3>
        <input type="file" accept=".db,.sqlite" onChange={(e) => e.target.files[0] && restore(e.target.files[0])} />
      </div>
      <div className="card pad col">
        <h3>ไฟล์สำรองข้อมูล</h3>
        <DataTable rows={list.data || []} search={false} columns={[{ key: 'created_at', label: 'เวลา', render: (b) => fmtDateTime(b.created_at) }, { key: 'kind', label: 'ประเภท' }, { key: 'size', label: 'ขนาด', num: true, render: (b) => `${(b.size / 1024 / 1024).toFixed(2)} MB` },
          { key: 'act', label: '', render: (b) => <span className="row gap-s"><Button size="sm" icon="download" onClick={() => download(`/backups/${b.filename}/download`, b.filename)} /><Button size="sm" variant="ghost" onClick={() => restore(null, b.filename)}>Restore</Button></span> }]} />
      </div>
    </div>
  );
}

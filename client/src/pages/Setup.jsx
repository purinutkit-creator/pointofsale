import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Button, Input, Toggle, Field, Icon } from '../components/ui.jsx';
import { toast } from '../lib/store.js';

export default function Setup() {
  const nav = useNavigate();
  const [f, setF] = useState({ shopName: '', branchName: 'สาขาหลัก', branchCode: 'HQ', ownerFirstName: '', ownerLastName: '', employeeCode: 'EMP001', pin: '', pin2: '', phone: '', address: '', taxId: '', vatEnabled: true, sampleMenu: false });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(f.pin)) return toast('PIN ต้องเป็นตัวเลข 4–6 หลัก', 'error');
    if (f.pin !== f.pin2) return toast('PIN ไม่ตรงกัน', 'error');
    setBusy(true);
    try {
      const { pin2, ...body } = f;
      await api('/setup', { method: 'POST', body: { ...body, phone: f.phone || undefined, address: f.address || undefined, taxId: f.taxId || undefined, ownerLastName: f.ownerLastName || undefined } });
      toast('ตั้งค่าร้านเรียบร้อย ลงทะเบียนเครื่อง POS เครื่องแรกได้เลย', 'success');
      nav('/device');
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="fullcenter" style={{ alignItems: 'flex-start' }}>
      <form onSubmit={submit} className="card" style={{ maxWidth: 720, width: '100%' }}>
        <div className="card-h"><div className="row"><Icon name="store" /><h2>ตั้งค่าร้านครั้งแรก</h2></div></div>
        <div className="card-b col gap-l">
          <div className="grid-2">
            <Input label="ชื่อร้าน *" required value={f.shopName} onValue={set('shopName')} />
            <Input label="เบอร์โทรร้าน" value={f.phone} onValue={set('phone')} />
            <Input label="ชื่อสาขา *" required value={f.branchName} onValue={set('branchName')} />
            <Input label="รหัสสาขา *" required value={f.branchCode} onValue={set('branchCode')} hint="A-Z, 0-9" />
            <Input label="เลขประจำตัวผู้เสียภาษี" value={f.taxId} onValue={set('taxId')} />
            <Input label="ที่อยู่" value={f.address} onValue={set('address')} />
          </div>
          <div className="divider" />
          <h3>บัญชีเจ้าของร้าน (Owner)</h3>
          <div className="grid-2">
            <Input label="ชื่อ *" required value={f.ownerFirstName} onValue={set('ownerFirstName')} />
            <Input label="นามสกุล" value={f.ownerLastName} onValue={set('ownerLastName')} />
            <Input label="รหัสพนักงาน (Employee Code) *" required value={f.employeeCode} onValue={set('employeeCode')} />
            <div />
            <Input label="PIN 4–6 หลัก *" required type="password" inputMode="numeric" maxLength={6} value={f.pin} onValue={set('pin')} />
            <Input label="ยืนยัน PIN *" required type="password" inputMode="numeric" maxLength={6} value={f.pin2} onValue={set('pin2')} />
          </div>
          <Toggle label="เปิดใช้ VAT 7% (ราคารวม VAT)" checked={f.vatEnabled} onChange={set('vatEnabled')} />
          <Field hint="สร้างเมนูตัวอย่าง หมวดหมู่ ตัวเลือก และโต๊ะ เพื่อทดลองใช้งาน (แก้ไข/ลบได้ภายหลัง)">
            <Toggle label="สร้างเมนูเริ่มต้นสำหรับทดลองใช้" checked={f.sampleMenu} onChange={set('sampleMenu')} />
          </Field>
          <Button variant="primary" size="xl" loading={busy} type="submit">เริ่มใช้งาน</Button>
        </div>
      </form>
    </div>
  );
}

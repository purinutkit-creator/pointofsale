// Printer Management + Printer Routing + Print copy settings + Print Queue + Hardware Status
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { on } from '../../lib/socket.js';
import { useApp, toast } from '../../lib/store.js';
import { Page } from './Admin.jsx';
import { Button, Modal, Input, Select, Toggle, DataTable, useAsync, Badge, Seg, Icon, Spinner } from '../../components/ui.jsx';
import { DevicePrinters, CONN_LABEL, ST_TONE, ST_LABEL } from '../pos/PrinterPanel.jsx';
import { printAgent, capabilities } from '../../hw/printing.js';
import { fmtDateTime, PRINT_STATUS, DOC_LABEL } from '../../lib/util.js';

export default function Printers() {
  const [tab, setTab] = useState('printers');
  return (
    <Page title="เครื่องพิมพ์ / Hardware" tab={tab} onTab={setTab} tabs={[{ value: 'printers', label: 'Printer Management' }, { value: 'device', label: 'เชื่อมต่อกับเครื่องนี้' }, { value: 'queue', label: 'Print Queue' }, { value: 'hardware', label: 'Hardware Status' }]}>
      {tab === 'printers' && <PrinterList />}
      {tab === 'device' && <ThisDevice />}
      {tab === 'queue' && <PrintQueue />}
      {tab === 'hardware' && <Hardware />}
    </Page>
  );
}

function PrinterList() {
  const can = useApp((s) => s.can);
  const list = useAsync(() => api('/printers'));
  const refs = useAsync(async () => ({ stations: await api('/stations'), devices: await api('/devices').catch(() => []) }));
  const [edit, setEdit] = useState(null);
  const device = useApp((s) => s.device);
  const open = (p) => setEdit(p ? { ...p, routes: p.routes.filter((r) => r.doc_type === 'kitchen').map((r) => ({ stationId: r.station_id, copies: r.copies })) }
    : { name: '', role: 'kitchen', connection: 'lan', address: '', paper: '80', render_mode: 'raster', has_cutter: 1, cut_type: 'partial', feed_lines: 4, has_drawer: 0, kitchen_copies: 1, host_device_id: device?.id || null, routes: [] });
  const save = async () => {
    const e = edit;
    const body = { name: e.name, role: e.role, connection: e.connection, hostDeviceId: ['ble', 'bt_classic', 'usb', 'serial'].includes(e.connection) ? Number(e.host_device_id) || null : null, address: e.address || null, paper: String(e.paper), dotsWidth: e.dots_width ? Number(e.dots_width) : null, renderMode: e.render_mode, codepage: Number(e.codepage) || 255, hasCutter: !!e.has_cutter, cutType: e.cut_type, feedLines: Number(e.feed_lines) || 0, hasDrawer: !!e.has_drawer, drawerPin: Number(e.drawer_pin) || 0, beep: !!e.beep, kitchenCopies: Number(e.kitchen_copies) || 0, routes: e.routes.map((r) => ({ stationId: Number(r.stationId), copies: Number(r.copies) || 0 })) };
    if (['ble', 'bt_classic', 'usb', 'serial'].includes(e.connection) && !body.hostDeviceId) return toast('กรุณาเลือกเครื่อง POS ที่เชื่อมต่อเครื่องพิมพ์นี้', 'error');
    try { if (e.id) await api(`/printers/${e.id}`, { method: 'PUT', body }); else await api('/printers', { method: 'POST', body }); setEdit(null); list.reload(); toast('บันทึกเครื่องพิมพ์แล้ว', 'success'); } catch (err) { toast(err.message, 'error'); }
  };
  const route = (sid) => edit.routes.find((r) => Number(r.stationId) === sid);
  return (
    <div className="col">
      <DataTable rows={list.data || []} onRow={(p) => can('settings.printer') && open(p)} search={false} toolbar={can('settings.printer') && <Button variant="primary" icon="plus" onClick={() => open(null)}>เพิ่มเครื่องพิมพ์</Button>}
        columns={[
          { key: 'name', label: 'เครื่องพิมพ์', render: (p) => <b>{p.name}</b> }, { key: 'role', label: 'หน้าที่', render: (p) => (p.role === 'receipt' ? 'ใบเสร็จ' : 'ครัว') },
          { key: 'connection', label: 'การเชื่อมต่อ', render: (p) => `${CONN_LABEL[p.connection]}${p.address ? ` · ${p.address}` : ''}${p.host_device_name ? ` · ${p.host_device_name}` : ''}` },
          { key: 'paper', label: 'กระดาษ', render: (p) => `${p.paper}mm` }, { key: 'cut', label: 'Cutter', render: (p) => (p.has_cutter ? `${p.cut_type} · feed ${p.feed_lines}` : 'ไม่มี (feed)') },
          { key: 'routes', label: 'Routing / จำนวนใบครัว', render: (p) => p.routes.map((r) => `${r.station_name} ×${r.copies}`).join(', ') || '-' },
          { key: 'status', label: 'สถานะ', render: (p) => <Badge tone={ST_TONE[p.status]}>{ST_LABEL[p.status]}</Badge> },
        ]} />
      {edit && refs.data && (
        <Modal title={edit.id ? `เครื่องพิมพ์: ${edit.name}` : 'เพิ่มเครื่องพิมพ์'} size="wide" onClose={() => setEdit(null)}
          footer={<>{edit.id && <Button variant="danger" style={{ marginRight: 'auto' }} onClick={async () => { await api(`/printers/${edit.id}`, { method: 'DELETE' }); printAgent.forget(edit.id); setEdit(null); list.reload(); }}>Remove</Button>}<Button variant="primary" onClick={save} disabled={!edit.name}>Save</Button></>}>
          <div className="col gap-l">
            <div className="grid-3">
              <Input label="ชื่อ เช่น Kitchen Printer" value={edit.name} onValue={(v) => setEdit({ ...edit, name: v })} />
              <Select label="หน้าที่" value={edit.role} onValue={(v) => setEdit({ ...edit, role: v })} options={[{ value: 'receipt', label: 'Receipt Printer → ใบเสร็จ' }, { value: 'kitchen', label: 'Kitchen/Beverage/Dessert Printer → ใบครัว' }]} />
              <Select label="การเชื่อมต่อ" value={edit.connection} onValue={(v) => setEdit({ ...edit, connection: v })} options={Object.entries(CONN_LABEL).map(([value, label]) => ({ value, label }))} />
            </div>
            {['ble', 'bt_classic', 'usb', 'serial'].includes(edit.connection) && (
              <Select label="ต่อกับอุปกรณ์ (POS ที่จับคู่ Bluetooth/USB)" value={edit.host_device_id ?? ''} onValue={(v) => setEdit({ ...edit, host_device_id: v })} placeholder="— เลือก —" options={refs.data.devices.filter((d) => d.type === 'pos' || d.type === 'kds').map((d) => ({ value: d.id, label: `${d.name} (${d.code})` }))} hint="หลังบันทึก ให้ไปที่แท็บ 'เชื่อมต่อกับเครื่องนี้' บนอุปกรณ์นั้นเพื่อ Search / Pair" />
            )}
            {edit.connection === 'lan' && <Input label="IP:Port (RAW 9100)" value={edit.address || ''} onValue={(v) => setEdit({ ...edit, address: v })} placeholder="192.168.1.50:9100" hint="เซิร์ฟเวอร์ต้องอยู่ในเครือข่ายเดียวกับเครื่องพิมพ์ หรือใช้ Local Print Bridge" />}
            {edit.connection === 'bridge' && <Input label="ชื่อ/ที่อยู่เครื่องพิมพ์บน Bridge" value={edit.address || ''} onValue={(v) => setEdit({ ...edit, address: v })} placeholder="tcp://192.168.1.50:9100 หรือ /dev/usb/lp0" hint="ติดตั้ง Local Print Bridge (npm run bridge) บนคอมพิวเตอร์ในร้าน" />}
            <div className="grid-4">
              <Select label="กระดาษ" value={String(edit.paper)} onValue={(v) => setEdit({ ...edit, paper: v })} options={[{ value: '58', label: '58mm (384 dots)' }, { value: '80', label: '80mm (576 dots)' }]} />
              <Input label="ความกว้าง dots (กำหนดเอง)" type="number" value={edit.dots_width || ''} onValue={(v) => setEdit({ ...edit, dots_width: v })} />
              <Select label="โหมดพิมพ์" value={edit.render_mode} onValue={(v) => setEdit({ ...edit, render_mode: v })} options={[{ value: 'raster', label: 'Bitmap Sarabun (แนะนำ)' }, { value: 'text', label: 'Text (Code page ไทย)' }]} />
              <Input label="Code page (text mode)" type="number" value={edit.codepage ?? 255} onValue={(v) => setEdit({ ...edit, codepage: v })} />
            </div>
            <div className="card pad col">
              <b>Paper Cut</b>
              <div className="grid-3">
                <Toggle label="มี Cutter" checked={!!edit.has_cutter} onChange={(v) => setEdit({ ...edit, has_cutter: v })} />
                <Select label="แบบตัด" value={edit.cut_type} onValue={(v) => setEdit({ ...edit, cut_type: v })} options={[{ value: 'full', label: 'Full Cut' }, { value: 'partial', label: 'Partial Cut' }]} disabled={!edit.has_cutter} />
                <Input label="Feed ก่อน Cut (บรรทัด)" type="number" value={edit.feed_lines} onValue={(v) => setEdit({ ...edit, feed_lines: v })} />
              </div>
              <div className="xs muted">ไม่มี Cutter: ระบบจะ Feed กระดาษแทนและไม่ส่งคำสั่งตัด</div>
            </div>
            <div className="grid-3">
              <Toggle label="ต่อ Cash Drawer" checked={!!edit.has_drawer} onChange={(v) => setEdit({ ...edit, has_drawer: v })} />
              <Select label="Drawer pin" value={String(edit.drawer_pin || 0)} onValue={(v) => setEdit({ ...edit, drawer_pin: v })} options={[{ value: '0', label: 'Pin 2' }, { value: '1', label: 'Pin 5' }]} />
              <Toggle label="เสียงบี๊บเมื่อพิมพ์ใบครัว" checked={!!edit.beep} onChange={(v) => setEdit({ ...edit, beep: v })} />
            </div>
            {edit.role === 'kitchen' && (
              <div className="card pad col">
                <b>Printer Routing & จำนวนใบครัว (แยกต่อ Station)</b>
                <div className="xs muted">เลือก Station ที่ส่งมาที่เครื่องพิมพ์นี้ และจำนวนสำเนา (0 = ใช้ KDS อย่างเดียว ไม่พิมพ์)</div>
                {refs.data.stations.map((s) => {
                  const r = route(s.id);
                  return (
                    <div key={s.id} className="row">
                      <Toggle checked={!!r} onChange={(on) => setEdit({ ...edit, routes: on ? [...edit.routes, { stationId: s.id, copies: 1 }] : edit.routes.filter((x) => Number(x.stationId) !== s.id) })} />
                      <span className="grow">{s.name}</span>
                      {r && <><span className="small muted">จำนวนใบ</span><Input type="number" min={0} max={10} value={r.copies} onValue={(v) => setEdit({ ...edit, routes: edit.routes.map((x) => (Number(x.stationId) === s.id ? { ...x, copies: v } : x)) })} style={{ maxWidth: 90 }} /></>}
                    </div>
                  );
                })}
                <Input label="จำนวนใบเมื่อสินค้า/หมวดกำหนดเครื่องพิมพ์นี้โดยตรง" type="number" value={edit.kitchen_copies} onValue={(v) => setEdit({ ...edit, kitchen_copies: v })} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ThisDevice() {
  const device = useApp((s) => s.device);
  const list = useAsync(() => api('/printers'));
  useEffect(() => {
    if (list.data && device) { printAgent.configure(device.id, list.data); printAgent.start(); }
  }, [list.data, device]);
  if (!device) return <div className="empty">เบราว์เซอร์นี้ยังไม่ได้ลงทะเบียนเป็นอุปกรณ์ — ลงทะเบียนที่หน้าแรกก่อนจับคู่เครื่องพิมพ์ Bluetooth/USB</div>;
  return list.data ? <DevicePrinters printers={list.data} /> : <Spinner />;
}

function PrintQueue() {
  const [status, setStatus] = useState('');
  const list = useAsync(() => api(`/print-jobs${status ? `?status=${status}` : ''}`), [status]);
  const [preview, setPreview] = useState(null);
  useEffect(() => on('print:job', () => list.reload()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (id, a) => { try { await api(`/print-jobs/${id}/${a}`, { method: 'POST', body: a === 'reprint' ? { reason: 'Reprint จาก Print Queue' } : {} }); list.reload(); } catch (e) { if (e.code !== 'APPROVAL_CANCELLED') toast(e.message, 'error'); } };
  const showPreview = async (id) => {
    const res = await api(`/print-jobs/${id}/preview.png`, { raw: true });
    setPreview(URL.createObjectURL(await res.blob()));
  };
  return (
    <div className="col">
      <Seg value={status} onChange={setStatus} options={[{ value: '', label: 'ทั้งหมด' }, ...Object.entries(PRINT_STATUS).map(([value, label]) => ({ value, label }))]} />
      <DataTable rows={list.data || []} columns={[
        { key: 'id', label: 'Job', render: (j) => <span className="xs">#{j.id}</span> }, { key: 'created_at', label: 'เวลา', render: (j) => fmtDateTime(j.created_at) },
        { key: 'order', label: 'Order', render: (j) => j.queue_no || (j.order_no ? `#${j.order_no}` : '-') }, { key: 'doc_type', label: 'เอกสาร', render: (j) => DOC_LABEL[j.doc_type] },
        { key: 'printer_name', label: 'Printer' }, { key: 'station_name', label: 'Station' },
        { key: 'sub', label: 'ใบย่อย/สำเนา', render: (j) => `${j.sub_index ? `${j.sub_index}/${j.sub_count}` : '-'} · ${j.copy_index}/${j.copy_count}` },
        { key: 'status', label: 'สถานะ', render: (j) => <Badge tone={{ printed: 'success', failed: 'danger', waiting: 'warning', printing: 'info' }[j.status]}>{PRINT_STATUS[j.status]}</Badge> },
        { key: 'error', label: 'Error', render: (j) => <span className="xs" style={{ color: 'var(--danger)' }}>{j.error}</span> },
        { key: 'act', label: '', render: (j) => <span className="row gap-s">
          {j.doc_type !== 'drawer' && <Button size="sm" icon="eye" onClick={() => showPreview(j.id)} />}
          {['failed', 'cancelled'].includes(j.status) && <Button size="sm" onClick={() => act(j.id, 'retry')}>Retry</Button>}
          {['waiting', 'failed', 'printing'].includes(j.status) && <Button size="sm" variant="ghost" onClick={() => act(j.id, 'cancel')}>Cancel</Button>}
          {j.status === 'printed' && j.doc_type !== 'drawer' && <Button size="sm" onClick={() => act(j.id, 'reprint')}>Reprint</Button>}
        </span> },
      ]} />
      {preview && <Modal title="Print Preview (Sarabun bitmap)" size="narrow" onClose={() => setPreview(null)}><img src={preview} alt="preview" style={{ width: '100%', boxShadow: 'var(--shadow)' }} /></Modal>}
    </div>
  );
}

function Hardware() {
  const hw = useAsync(() => api('/hardware'));
  const caps = capabilities();
  useEffect(() => { const offs = [on('printer:status', () => hw.reload()), on('device:presence', () => hw.reload())]; return () => offs.forEach((f) => f()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hw.data) return <Spinner />;
  const dot = (ok) => <span className={`dot ${ok ? 'green' : 'red'}`} />;
  const row = (label, ok, text, extra) => <div className="row card pad"><Icon name="monitor" /><span className="grow"><b>{label}</b><div className="xs muted">{extra}</div></span>{dot(ok)}<b>{text}</b></div>;
  const kds = hw.data.devices.filter((d) => d.type === 'kds');
  const displays = hw.data.devices.filter((d) => d.type === 'customer_display');
  const queues = hw.data.devices.filter((d) => d.type === 'queue_display');
  return (
    <div className="col">
      {hw.data.printers.map((p) => row(`${p.role === 'receipt' ? 'Receipt' : 'Kitchen'} Printer · ${p.name}`, p.status === 'connected' || p.status === 'printing', ST_LABEL[p.status], `${CONN_LABEL[p.connection]} ${p.address || p.host_name || ''} ${p.status_message || ''}`))}
      {row('Bluetooth', caps.bluetooth, caps.bluetooth ? 'Available' : 'Not supported', 'Web Bluetooth บนเบราว์เซอร์นี้')}
      {row('USB / Serial', caps.usb || caps.serial, caps.usb || caps.serial ? 'Available' : 'Not supported', 'WebUSB / Web Serial')}
      {hw.data.printers.filter((p) => p.has_drawer).map((p) => row(`Cash Drawer (${p.name})`, p.status === 'connected', p.status === 'connected' ? 'Ready' : 'Not ready', 'ESC/POS drawer kick ผ่านเครื่องพิมพ์ใบเสร็จ'))}
      {displays.map((d) => row(`Customer Display · ${d.name}`, d.online, d.online ? 'Connected' : 'Offline', `ล่าสุด ${d.last_seen_at ? fmtDateTime(d.last_seen_at) : '-'}`))}
      {kds.map((d) => row(`KDS · ${d.name}`, d.online, d.online ? 'Online' : 'Offline', `ล่าสุด ${d.last_seen_at ? fmtDateTime(d.last_seen_at) : '-'}`))}
      {queues.map((d) => row(`Queue Display · ${d.name}`, d.online, d.online ? 'Online' : 'Offline', ''))}
      <div className="row card pad"><span className="grow">Print jobs ล้มเหลวใน 24 ชม.: <b>{hw.data.failedJobs}</b> · รอพิมพ์: <b>{hw.data.waitingJobs}</b></span>
        <Button icon="print" onClick={async () => { for (const p of hw.data.printers) await api(`/printers/${p.id}/test`, { method: 'POST', body: {} }).catch(() => {}); toast('ส่ง Test Print ไปทุกเครื่องแล้ว', 'success'); }}>Test Hardware (พิมพ์ทดสอบทุกเครื่อง)</Button>
      </div>
    </div>
  );
}

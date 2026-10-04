// Printer connection panel for this device + Print failure watcher ("ไม่สามารถพิมพ์ใบครัวได้ … [เชื่อมต่อใหม่] [ลองพิมพ์อีกครั้ง]")
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { on } from '../../lib/socket.js';
import { toast, useApp } from '../../lib/store.js';
import { printAgent, capabilities } from '../../hw/printing.js';
import { Modal, Button, Badge, Icon, Empty, Input } from '../../components/ui.jsx';
import { DOC_LABEL } from '../../lib/util.js';
import { playError } from '../../lib/sound.js';

const CONN_LABEL = { ble: 'Bluetooth (BLE)', bt_classic: 'Bluetooth Classic (SPP)', usb: 'USB', serial: 'Serial', lan: 'LAN / Network', bridge: 'Local Print Bridge' };
const ST_TONE = { connected: 'success', printing: 'info', disconnected: 'warning', error: 'danger' };
const ST_LABEL = { connected: 'Connected', printing: 'Printing', disconnected: 'Disconnected', error: 'Error' };
export { CONN_LABEL, ST_TONE, ST_LABEL };

export function usePrinters() {
  const [list, setList] = useState(printAgent.snapshot());
  useEffect(() => printAgent.on(setList), []);
  return list;
}

export function DevicePrinters({ printers }) {
  const local = usePrinters();
  const caps = capabilities();
  const device = useApp((s) => s.device);
  const [busy, setBusy] = useState(null);
  const run = async (id, fn, ok) => { setBusy(id); try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success'); } catch (e) { toast(e.message || String(e), 'error'); } finally { setBusy(null); } };
  const all = printers || [];
  return (
    <div className="col">
      <div className="row wrap small">
        <Badge tone={caps.bluetooth ? 'success' : 'danger'}>Web Bluetooth {caps.bluetooth ? 'พร้อม' : 'ไม่รองรับ'}</Badge>
        <Badge tone={caps.serial ? 'success' : 'danger'}>Web Serial (BT Classic) {caps.serial ? 'พร้อม' : 'ไม่รองรับ'}</Badge>
        <Badge tone={caps.usb ? 'success' : 'danger'}>WebUSB {caps.usb ? 'พร้อม' : 'ไม่รองรับ'}</Badge>
        {!caps.secure && <Badge tone="danger">ต้องใช้ HTTPS หรือ localhost เพื่อเชื่อมต่อฮาร์ดแวร์</Badge>}
      </div>
      {!all.length && <Empty icon="print">ยังไม่มีเครื่องพิมพ์ในสาขานี้ — เพิ่มได้ที่ หลังร้าน › เครื่องพิมพ์</Empty>}
      {all.map((p) => {
        const mine = local.find((x) => x.id === p.id);
        const st = mine ? mine.local.status : p.status;
        const msg = mine ? mine.local.message : p.status_message;
        return (
          <div key={p.id} className="card pad col gap-s">
            <div className="row between">
              <div className="row"><Icon name={p.connection === 'lan' ? 'lan' : p.connection === 'usb' ? 'usb' : p.connection === 'bridge' ? 'monitor' : 'bluetooth'} /><div><b>{p.name}</b><div className="xs muted">{p.role === 'receipt' ? 'ใบเสร็จ' : 'ครัว'} · {CONN_LABEL[p.connection]} · {p.paper}mm{p.host_device_id ? ` · ต่อกับ ${p.host_device_id === device?.id ? 'เครื่องนี้' : p.host_device_name || `อุปกรณ์ #${p.host_device_id}`}` : ''}</div></div></div>
              <Badge tone={ST_TONE[st]}>{ST_LABEL[st] || st}</Badge>
            </div>
            {msg && <div className="xs muted">{msg}</div>}
            <div className="row wrap">
              {mine && <>
                <Button size="sm" icon="search" loading={busy === p.id} onClick={() => run(p.id, () => printAgent.pair(p.id), (n) => `จับคู่ ${n || ''} สำเร็จ`)}>{printAgent.isPaired(p.id) ? 'Search / Pair ใหม่' : 'Search & Pair'}</Button>
                <Button size="sm" icon="refresh" onClick={() => run(p.id, () => printAgent.reconnect(p.id), 'เชื่อมต่อแล้ว')}>Connect / Reconnect</Button>
                <Button size="sm" icon="x" onClick={() => run(p.id, () => printAgent.disconnect(p.id))}>Disconnect</Button>
                <Button size="sm" variant="ghost" icon="trash" onClick={() => run(p.id, async () => printAgent.forget(p.id), 'ลบการจับคู่แล้ว')}>Remove pairing</Button>
              </>}
              {p.connection === 'lan' && <Button size="sm" icon="refresh" onClick={() => run(p.id, () => api(`/printers/${p.id}/probe`, { method: 'POST', body: {} }), (r) => (r.ok ? 'เครื่องพิมพ์ตอบสนอง' : `เชื่อมต่อไม่ได้: ${r.message}`))}>ตรวจสอบการเชื่อมต่อ</Button>}
              <Button size="sm" variant="soft" icon="print" onClick={() => run(p.id, () => api(`/printers/${p.id}/test`, { method: 'POST', body: {} }), 'ส่งงาน Test Print เข้าคิวแล้ว')}>Test Print</Button>
            </div>
            {mine && p.connection === 'ble' && (
              <div className="row small"><span className="muted">ขนาด chunk BLE</span><Input type="number" style={{ maxWidth: 100 }} defaultValue={printAgent.option(p.id).chunk || 180} onBlur={(e) => printAgent.setOption(p.id, { chunk: Number(e.target.value) || 180 })} /><span className="xs muted">ลดเหลือ 20–100 หากเครื่องพิมพ์ไม่ตอบสนอง</span></div>
            )}
            {mine && ['bt_classic', 'serial'].includes(p.connection) && (
              <div className="row small"><span className="muted">Baud rate</span><Input type="number" style={{ maxWidth: 120 }} defaultValue={printAgent.option(p.id).baud || 9600} onBlur={(e) => printAgent.setOption(p.id, { baud: Number(e.target.value) || 9600 })} /></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function PrinterPanel({ onClose }) {
  const [printers, setPrinters] = useState(null);
  useEffect(() => { api('/printers').then(setPrinters).catch((e) => toast(e.message, 'error')); }, []);
  return (
    <Modal title="เครื่องพิมพ์ (Printer)" size="wide" icon="print" onClose={onClose}>
      {printers ? <DevicePrinters printers={printers} /> : <div className="center"><span className="spinner" /></div>}
    </Modal>
  );
}

/** Shows print failures for this branch with Reconnect / Retry (never re-creates orders or payments). */
export function PrintErrorWatcher() {
  const [fail, setFail] = useState(null);
  useEffect(() => on('print:job', async (j) => {
    if (j.status !== 'failed') return;
    try {
      const job = await api(`/print-jobs/${j.id}`);
      const printers = await api('/printers');
      setFail({ job, printer: printers.find((p) => p.id === job.printer_id) });
      playError();
    } catch { /* ignore */ }
  }), []);
  if (!fail) return null;
  const { job, printer } = fail;
  const label = DOC_LABEL[job.doc_type] || job.doc_type;
  const reconnect = async () => {
    try {
      if (printAgent.printers.has(printer.id)) await printAgent.reconnect(printer.id);
      else if (printer.connection === 'lan') { const r = await api(`/printers/${printer.id}/probe`, { method: 'POST', body: {} }); if (!r.ok) throw new Error(r.message); }
      toast('เชื่อมต่อเครื่องพิมพ์แล้ว', 'success');
    } catch (e) { toast(`เชื่อมต่อไม่ได้: ${e.message}`, 'error'); }
  };
  const retry = async () => { try { await api(`/print-jobs/${job.id}/retry`, { method: 'POST', body: {} }); toast('ส่งพิมพ์อีกครั้งแล้ว', 'success'); setFail(null); } catch (e) { toast(e.message, 'error'); } };
  return (
    <Modal title={`ไม่สามารถพิมพ์${label}ได้`} icon="alert" size="narrow" onClose={() => setFail(null)}
      footer={<><Button onClick={() => setFail(null)}>ปิด</Button><Button icon="refresh" onClick={reconnect}>เชื่อมต่อใหม่</Button><Button variant="primary" icon="print" onClick={retry}>ลองพิมพ์อีกครั้ง</Button></>}>
      <div className="col">
        <div className="bold">เครื่องพิมพ์ {printer?.name || '-'} ขาดการเชื่อมต่อ</div>
        <div className="small muted">{job.error}</div>
        <div className="small">Order {job.payload?.queueNo || job.payload?.orderNo || '-'}{job.sub_index ? ` · ใบย่อย ${job.sub_index}/${job.sub_count}` : ''}{job.copy_count > 1 ? ` · สำเนา ${job.copy_index}/${job.copy_count}` : ''}</div>
        <div className="xs muted">ข้อมูลบิลและการชำระเงินถูกบันทึกแล้ว การพิมพ์ซ้ำจะไม่สร้าง Order หรือ Payment ใหม่</div>
      </div>
    </Modal>
  );
}

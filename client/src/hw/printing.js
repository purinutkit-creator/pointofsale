// ─────────────────────────────────────────────────────────────────────────────
// Browser print agent + real hardware transports (no simulation):
//   • BLE  — Web Bluetooth GATT (ESC/POS over common printer services)
//   • Bluetooth Classic — Web Serial with RFCOMM SPP (Chrome desktop) / paired COM port
//   • USB  — WebUSB bulk OUT endpoint (printer class 7)
//   • Serial — Web Serial (USB-serial / COM)
//   • LAN / Bridge — printed by the server or the Local Print Bridge (not here)
// Documents are rendered with Sarabun to a bitmap (shared/render.js) and sent as ESC/POS raster.
// ─────────────────────────────────────────────────────────────────────────────
import { renderDocument } from '@shared/render.js';
import { canvasToEscPos, paperDots, EscPos } from '@shared/escpos.js';
import { api } from '../lib/api.js';
import { getSocket } from '../lib/socket.js';
import { proxiedImage, sleep } from '../lib/util.js';
import { idb } from '../lib/db.js';

const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb', '0000ae00-0000-1000-8000-00805f9b34fb',
];
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
const DEVICE_KINDS = ['ble', 'bt_classic', 'usb', 'serial'];

export const capabilities = () => ({
  bluetooth: typeof navigator !== 'undefined' && !!navigator.bluetooth,
  serial: typeof navigator !== 'undefined' && !!navigator.serial,
  usb: typeof navigator !== 'undefined' && !!navigator.usb,
  secure: typeof window !== 'undefined' && window.isSecureContext,
});

const memKey = (id) => `pos.hw.${id}`;
const remember = (id, v) => localStorage.setItem(memKey(id), JSON.stringify(v));
const recall = (id) => { try { return JSON.parse(localStorage.getItem(memKey(id)) || 'null'); } catch { return null; } };

// ── Transports ────────────────────────────────────────────────────────────
class BleTransport {
  constructor(printer) { this.printer = printer; this.device = null; this.char = null; this.chunk = 180; }
  async pair() {
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    remember(this.printer.id, { kind: 'ble', id: this.device.id, name: this.device.name });
    await this.connect();
    return this.device.name;
  }
  async restore() {
    const m = recall(this.printer.id);
    if (!m || !navigator.bluetooth.getDevices) return false;
    const list = await navigator.bluetooth.getDevices();
    this.device = list.find((d) => d.id === m.id) || null;
    if (!this.device) return false;
    await this.connect();
    return true;
  }
  async connect() {
    if (!this.device) throw new Error('ยังไม่ได้จับคู่เครื่องพิมพ์ Bluetooth');
    this.device.ongattserverdisconnected = () => this.onDisconnect?.();
    const server = await this.device.gatt.connect();
    const services = await server.getPrimaryServices();
    for (const s of services) {
      for (const c of await s.getCharacteristics()) {
        if (c.properties.writeWithoutResponse || c.properties.write) { this.char = c; return; }
      }
    }
    throw new Error('ไม่พบช่องทางส่งข้อมูลของเครื่องพิมพ์ (BLE characteristic)');
  }
  get connected() { return !!this.device?.gatt?.connected && !!this.char; }
  async write(bytes) {
    if (!this.connected) await this.connect();
    const size = Number(recall(this.printer.id)?.chunk) || this.chunk;
    for (let i = 0; i < bytes.length; i += size) {
      const part = bytes.subarray(i, i + size);
      if (this.char.properties.writeWithoutResponse) { await this.char.writeValueWithoutResponse(part); await sleep(8); } else await this.char.writeValueWithResponse(part);
    }
  }
  async disconnect() { try { this.device?.gatt?.disconnect(); } catch { /* ignore */ } }
  forget() { localStorage.removeItem(memKey(this.printer.id)); this.disconnect(); this.device?.forget?.(); }
}

class SerialTransport {
  constructor(printer, bluetooth) { this.printer = printer; this.bt = bluetooth; this.port = null; }
  async pair() {
    const opts = this.bt ? { allowedBluetoothServiceClassIds: [SPP_UUID], filters: [{ bluetoothServiceClassId: SPP_UUID }] } : {};
    try { this.port = await navigator.serial.requestPort(opts); } catch (e) {
      if (this.bt && e.name === 'TypeError') this.port = await navigator.serial.requestPort(); else throw e;
    }
    const info = this.port.getInfo();
    remember(this.printer.id, { kind: this.bt ? 'bt_classic' : 'serial', info, baud: recall(this.printer.id)?.baud || 9600 });
    await this.connect();
    return info.bluetoothServiceClassId ? 'Bluetooth SPP' : `Serial ${info.usbVendorId ?? ''}`;
  }
  async restore() {
    const m = recall(this.printer.id);
    if (!m) return false;
    const ports = await navigator.serial.getPorts();
    this.port = ports.find((p) => JSON.stringify(p.getInfo()) === JSON.stringify(m.info)) || (ports.length === 1 ? ports[0] : null);
    if (!this.port) return false;
    await this.connect();
    return true;
  }
  async connect() {
    if (!this.port) throw new Error('ยังไม่ได้จับคู่เครื่องพิมพ์');
    if (!this.port.writable) await this.port.open({ baudRate: Number(recall(this.printer.id)?.baud) || 9600 });
    this.port.ondisconnect = () => this.onDisconnect?.();
  }
  get connected() { return !!this.port?.writable; }
  async write(bytes) {
    if (!this.connected) await this.connect();
    const w = this.port.writable.getWriter();
    try { for (let i = 0; i < bytes.length; i += 1024) await w.write(bytes.subarray(i, i + 1024)); } finally { w.releaseLock(); }
  }
  async disconnect() { try { await this.port?.close(); } catch { /* ignore */ } }
  forget() { localStorage.removeItem(memKey(this.printer.id)); this.disconnect(); this.port?.forget?.(); }
}

class UsbTransport {
  constructor(printer) { this.printer = printer; this.dev = null; this.ep = null; this.iface = null; }
  async pair() {
    // show every USB device; most thermal printers expose a printer-class (7) interface
    this.dev = await navigator.usb.requestDevice({ filters: [] });
    remember(this.printer.id, { kind: 'usb', vendorId: this.dev.vendorId, productId: this.dev.productId, serial: this.dev.serialNumber });
    await this.connect();
    return this.dev.productName || 'USB Printer';
  }
  async restore() {
    const m = recall(this.printer.id);
    if (!m) return false;
    const list = await navigator.usb.getDevices();
    this.dev = list.find((d) => d.vendorId === m.vendorId && d.productId === m.productId && (!m.serial || d.serialNumber === m.serial)) || null;
    if (!this.dev) return false;
    await this.connect();
    return true;
  }
  async connect() {
    if (!this.dev) throw new Error('ยังไม่ได้จับคู่เครื่องพิมพ์ USB');
    if (!this.dev.opened) await this.dev.open();
    if (!this.dev.configuration) await this.dev.selectConfiguration(1);
    for (const itf of this.dev.configuration.interfaces) {
      for (const alt of itf.alternates) {
        const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (out && (alt.interfaceClass === 7 || !this.ep)) { this.iface = itf.interfaceNumber; this.ep = out.endpointNumber; }
      }
    }
    if (this.ep == null) throw new Error('ไม่พบ USB endpoint สำหรับพิมพ์');
    try { await this.dev.claimInterface(this.iface); } catch (e) { if (!String(e.message).includes('already')) throw e; }
  }
  get connected() { return !!this.dev?.opened && this.ep != null; }
  async write(bytes) {
    if (!this.connected) await this.connect();
    for (let i = 0; i < bytes.length; i += 16384) {
      const r = await this.dev.transferOut(this.ep, bytes.subarray(i, i + 16384));
      if (r.status !== 'ok') throw new Error(`USB transfer ${r.status}`);
    }
  }
  async disconnect() { try { await this.dev?.close(); } catch { /* ignore */ } }
  forget() { localStorage.removeItem(memKey(this.printer.id)); this.disconnect(); this.dev?.forget?.(); }
}

function transportFor(p) {
  if (p.connection === 'ble') return new BleTransport(p);
  if (p.connection === 'bt_classic') return new SerialTransport(p, true);
  if (p.connection === 'serial') return new SerialTransport(p, false);
  if (p.connection === 'usb') return new UsbTransport(p);
  return null;
}

// ── Rendering in the browser ──────────────────────────────────────────────
let fontsReady = null;
function ensureFonts() {
  fontsReady ||= Promise.all(['400 24px Sarabun', '700 24px Sarabun'].map((f) => document.fonts.load(f))).catch(() => null);
  return fontsReady;
}
const createCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};

/** Render a print document to a canvas (Sarabun). Used for printing and on-screen Print Preview. */
export async function renderCanvas(doc, printer = {}) {
  await ensureFonts();
  return renderDocument(doc, { width: paperDots(printer.paper || '80', printer.dots_width), createCanvas, loadImage: (u) => proxiedImage(u), fontFamily: 'Sarabun' });
}

export async function previewDataUrl(doc, printer) {
  const c = await renderCanvas(doc, printer);
  if (c.convertToBlob) { const b = await c.convertToBlob(); return URL.createObjectURL(b); }
  return c.toDataURL('image/png');
}

export async function jobBytes(job, printer) {
  if (job.doc_type === 'drawer' || job.payload?.type === 'drawer') return new EscPos().init().drawer(printer.drawer_pin || 0).bytes();
  const c = await renderCanvas(job.payload, printer);
  const ctx = c.getContext('2d');
  return canvasToEscPos(ctx.getImageData(0, 0, c.width, c.height), printer, { cut: true, beep: !!printer.beep && job.doc_type === 'kitchen' });
}

// ── Agent ─────────────────────────────────────────────────────────────────
class PrintAgent {
  constructor() {
    this.deviceId = null; this.printers = new Map(); this.transports = new Map(); this.status = new Map();
    this.listeners = new Set(); this.busy = new Map(); this.timer = null; this.started = false;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this.snapshot())); }
  snapshot() { return [...this.printers.values()].map((p) => ({ ...p, local: this.status.get(p.id) || { status: 'disconnected' } })); }

  /** Configure printers hosted by this device (called with catalog.printers). */
  configure(deviceId, printers) {
    this.deviceId = deviceId;
    const mine = (printers || []).filter((p) => p.host_device_id === deviceId && DEVICE_KINDS.includes(p.connection));
    const ids = new Set(mine.map((p) => p.id));
    for (const id of [...this.printers.keys()]) if (!ids.has(id)) { this.transports.get(id)?.disconnect(); this.transports.delete(id); this.printers.delete(id); }
    for (const p of mine) {
      const prev = this.printers.get(p.id);
      this.printers.set(p.id, p);
      if (!prev || prev.connection !== p.connection) {
        const t = transportFor(p);
        t.onDisconnect = () => { this.setStatus(p.id, 'disconnected', 'การเชื่อมต่อหลุด'); this.autoReconnect(p.id); };
        this.transports.set(p.id, t);
        this.restore(p.id);
      }
    }
    this.emit();
  }
  setStatus(id, status, message = null) {
    this.status.set(id, { status, message, at: Date.now() });
    getSocket()?.emit('printer:status', { printerId: id, status, message });
    this.emit();
  }
  async restore(id) {
    const t = this.transports.get(id);
    try { if (await t.restore()) this.setStatus(id, 'connected'); else this.setStatus(id, 'disconnected', recall(id) ? 'กดเชื่อมต่อใหม่' : 'ยังไม่ได้จับคู่'); } catch (e) { this.setStatus(id, 'disconnected', e.message); }
  }
  async autoReconnect(id, attempt = 0) {
    if (attempt > 6 || !this.transports.has(id)) return;
    await sleep(Math.min(30000, 1500 * 2 ** attempt));
    const t = this.transports.get(id);
    if (!t || t.connected) return;
    try { await t.connect(); this.setStatus(id, 'connected'); this.pump(); } catch { this.autoReconnect(id, attempt + 1); }
  }
  /** User gesture required (browser device picker). */
  async pair(id) {
    const t = this.transports.get(id);
    if (!t) throw new Error('เครื่องพิมพ์นี้ไม่ได้ผูกกับเครื่องนี้');
    const name = await t.pair();
    this.setStatus(id, 'connected');
    this.pump();
    return name;
  }
  async reconnect(id) {
    const t = this.transports.get(id);
    if (!t) throw new Error('เครื่องพิมพ์นี้ไม่ได้ผูกกับเครื่องนี้');
    try { if (!(await t.restore())) await t.connect(); this.setStatus(id, 'connected'); this.pump(); } catch (e) { this.setStatus(id, 'error', e.message); throw e; }
  }
  async disconnect(id) { await this.transports.get(id)?.disconnect(); this.setStatus(id, 'disconnected', 'ตัดการเชื่อมต่อ'); }
  forget(id) { this.transports.get(id)?.forget(); this.setStatus(id, 'disconnected', 'ยังไม่ได้จับคู่'); }
  isPaired(id) { return !!recall(id); }
  setOption(id, opt) { remember(id, { ...(recall(id) || {}), ...opt }); }
  option(id) { return recall(id) || {}; }

  async sendBytes(id, bytes) {
    const t = this.transports.get(id);
    const p = this.printers.get(id);
    if (!t || !p) throw new Error('ไม่พบเครื่องพิมพ์บนอุปกรณ์นี้');
    this.setStatus(id, 'printing');
    try { await t.write(bytes); this.setStatus(id, 'connected'); } catch (e) { this.setStatus(id, 'error', e.message); throw e; }
  }

  /** Print directly (offline mode) without a server job. */
  async printLocal(printerId, doc, docType = doc.type) {
    const p = this.printers.get(printerId);
    if (!p) throw new Error('เครื่องพิมพ์ไม่ได้เชื่อมกับอุปกรณ์นี้');
    const bytes = await jobBytes({ doc_type: docType, payload: doc }, p);
    await this.sendBytes(printerId, bytes);
    try { (await idb()).add('printlog', { at: Date.now(), printerId, docType, ref: doc.receiptNo || doc.queueNo || doc.orderNo }); } catch { /* ignore */ }
  }
  localPrinters(role) { return [...this.printers.values()].filter((p) => !role || p.role === role); }

  start() {
    if (this.started) return;
    this.started = true;
    const s = getSocket();
    s?.on('print:job', (j) => { if (j.status === 'waiting' && this.printers.has(j.printerId)) this.pump(); });
    s?.on('connect', () => { for (const [id, st] of this.status) getSocket()?.emit('printer:status', { printerId: id, status: st.status, message: st.message }); this.pump(); });
    this.timer = setInterval(() => this.pump(), 4000);
    this.pump();
  }
  stop() { clearInterval(this.timer); this.started = false; }

  async pump() {
    if (!this.printers.size || this.pumping) return;
    this.pumping = true;
    try {
      const jobs = await api('/print-agent/jobs');
      for (const j of jobs) {
        const t = this.transports.get(j.printer_id);
        if (!t) continue;
        if (!t.connected) {
          try { await t.connect(); this.setStatus(j.printer_id, 'connected'); } catch { this.setStatus(j.printer_id, 'disconnected', 'รอเชื่อมต่อเครื่องพิมพ์'); continue; }
        }
        let claimed;
        try { claimed = await api(`/print-agent/jobs/${j.id}/claim`, { method: 'POST', body: {} }); } catch { continue; }
        try {
          const bytes = await jobBytes(claimed.job, claimed.printer);
          await this.sendBytes(j.printer_id, bytes);
          await api(`/print-agent/jobs/${j.id}/result`, { method: 'POST', body: { ok: true } });
        } catch (e) {
          await api(`/print-agent/jobs/${j.id}/result`, { method: 'POST', body: { ok: false, error: e.message || String(e) } }).catch(() => {});
        }
      }
    } catch { /* offline: try later */ } finally { this.pumping = false; }
  }
}

export const printAgent = new PrintAgent();

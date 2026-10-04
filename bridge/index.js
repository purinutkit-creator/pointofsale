#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Local Print Bridge
// Runs on a computer inside the shop network when the POS server is hosted in the
// cloud (or a browser cannot reach a printer). It registers as a "bridge" device,
// claims print jobs for printers configured with connection = "bridge", renders them
// with Sarabun (same renderer as the server) and sends ESC/POS bytes to:
//   tcp://192.168.1.50:9100  |  192.168.1.50:9100   → LAN printer (RAW 9100)
//   /dev/usb/lp0  |  /dev/ttyUSB0  |  \\.\COM3       → USB / serial device file
//
// Usage:
//   node bridge/index.js register --server https://pos.example.com --code EMP001 --pin 1234 --branch 1 --name BRIDGE-01
//   node bridge/index.js            (runs the agent with bridge/config.json)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { buildJobBytes, sendTcp } from '../server/print/render.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = process.env.BRIDGE_CONFIG || path.join(dir, 'config.json');
const args = Object.fromEntries(process.argv.slice(3).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));

async function register() {
  const server = (args.server || 'http://localhost:3000').replace(/\/$/, '');
  const res = await fetch(`${server}/api/devices/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeCode: args.code, pin: String(args.pin), branchId: Number(args.branch || 1), name: args.name || 'Print Bridge', code: (args.name || 'BRIDGE-01').toUpperCase().replace(/[^A-Z0-9-]/g, ''), type: 'bridge' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  fs.writeFileSync(CONFIG, JSON.stringify({ server, token: data.token, device: data.device }, null, 2));
  console.log(`[bridge] registered as ${data.device.name} (id ${data.device.id}); config saved to ${CONFIG}`);
}

async function send(printer, bytes) {
  const addr = String(printer.address || '').trim();
  if (!addr) throw new Error('ยังไม่ได้ระบุที่อยู่เครื่องพิมพ์บน Bridge');
  if (addr.startsWith('tcp://') || /^[\d.]+(:\d+)?$/.test(addr) || /^[a-z0-9.-]+:\d+$/i.test(addr)) return sendTcp(addr.replace('tcp://', ''), bytes);
  await fs.promises.writeFile(addr, Buffer.from(bytes)); // device file (USB / serial)
}

async function run() {
  if (!fs.existsSync(CONFIG)) { console.error(`[bridge] missing ${CONFIG}. Run: node bridge/index.js register --server URL --code EMP001 --pin 1234`); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const api = async (p, opts = {}) => {
    const r = await fetch(`${cfg.server}/api${p}`, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Device-Token': cfg.token } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || r.statusText); e.status = r.status; throw e; }
    return d;
  };
  const socket = io(cfg.server, { auth: { deviceToken: cfg.token }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => { console.log('[bridge] connected'); pump(); });
  socket.on('connect_error', (e) => console.error('[bridge] connect error', e.message));
  socket.on('print:job', (j) => { if (j.status === 'waiting') pump(); });
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      const jobs = await api('/print-agent/jobs');
      for (const j of jobs) {
        let c;
        try { c = await api(`/print-agent/jobs/${j.id}/claim`, { method: 'POST', body: '{}' }); } catch { continue; }
        try {
          socket.emit('printer:status', { printerId: c.printer.id, status: 'printing' });
          await send(c.printer, await buildJobBytes(c.job, c.printer));
          await api(`/print-agent/jobs/${j.id}/result`, { method: 'POST', body: JSON.stringify({ ok: true }) });
          socket.emit('printer:status', { printerId: c.printer.id, status: 'connected' });
          console.log(`[bridge] printed job #${j.id} (${c.job.doc_type}) → ${c.printer.name}`);
        } catch (e) {
          await api(`/print-agent/jobs/${j.id}/result`, { method: 'POST', body: JSON.stringify({ ok: false, error: e.message }) }).catch(() => {});
          socket.emit('printer:status', { printerId: c.printer.id, status: 'error', message: e.message });
          console.error(`[bridge] job #${j.id} failed: ${e.message}`);
        }
      }
    } catch (e) {
      if (e.status === 401) { console.error('[bridge] device token rejected — re-register'); process.exit(1); }
    } finally { busy = false; }
  }
  setInterval(pump, 3000);
}

(process.argv[2] === 'register' ? register() : run()).catch((e) => { console.error('[bridge]', e.message); process.exit(1); });

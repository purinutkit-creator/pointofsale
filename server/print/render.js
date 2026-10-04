// Server-side rendering (Node) with @napi-rs/canvas + bundled Sarabun TTF.
// Used for LAN printers, the Local Print Bridge and PNG print previews.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import dns from 'node:dns/promises';
import { createCanvas, GlobalFonts, Image } from '@napi-rs/canvas';
import { renderDocument } from '../../shared/render.js';
import { canvasToEscPos, paperDots, EscPos, encodeTIS620 } from '../../shared/escpos.js';

const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
let fontsLoaded = false;
export function loadFonts() {
  if (fontsLoaded) return;
  for (const w of ['Regular', 'Medium', 'SemiBold', 'Bold']) GlobalFonts.registerFromPath(path.join(fontsDir, `Sarabun-${w}.ttf`), 'Sarabun');
  fontsLoaded = true;
}

function isPrivateIp(ip) {
  return /^(10\.|127\.|169\.254\.|192\.168\.|0\.|::1$|fc|fd|fe80)/i.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** Fetch a remote image safely (http/https only, public hosts, size-limited). */
export async function fetchImageBuffer(url, { allowPrivate = false, maxBytes = 3_000_000 } = {}) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('unsupported protocol');
  if (!allowPrivate) {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('private address not allowed');
  }
  const res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('image too large');
  return { buf, type };
}

const imageCache = new Map();
async function loadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const { buf } = await fetchImageBuffer(url);
  const img = new Image();
  img.src = buf;
  imageCache.set(url, img);
  if (imageCache.size > 50) imageCache.delete(imageCache.keys().next().value);
  return img;
}

export async function renderToCanvas(doc, printer = {}) {
  loadFonts();
  const width = paperDots(printer.paper || '80', printer.dots_width);
  return renderDocument(doc, { width, createCanvas, loadImage, fontFamily: 'Sarabun' });
}

export async function renderPng(doc, printer) {
  const c = await renderToCanvas(doc, printer);
  return c.toBuffer('image/png');
}

/** Build ESC/POS bytes for a print job. */
export async function buildJobBytes(job, printer) {
  if (job.doc_type === 'drawer') return new EscPos().init().drawer(printer.drawer_pin || 0).bytes();
  const doc = job.payload;
  if (printer.render_mode === 'text') return textModeBytes(doc, printer);
  const canvas = await renderToCanvas(doc, printer);
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return canvasToEscPos(img, printer, { cut: true, beep: !!printer.beep && job.doc_type === 'kitchen' });
}

/** Fallback for printers with a Thai code page: plain text (not Sarabun). Raster is the default. */
function textModeBytes(doc, printer) {
  const p = new EscPos().init().codepage(printer.codepage || 255);
  const cols = String(printer.paper) === '58' ? 32 : 48;
  const line = (l = '', r = '') => p.line(l + ' '.repeat(Math.max(1, cols - [...l].length - [...r].length)) + r);
  if (doc.type === 'kitchen') {
    p.align('center').size(2, 2).bold(true).line(doc.queueNo || `#${doc.orderNo}`).size(1, 1);
    if (doc.sub) p.size(1, 2).line(`ใบย่อยที่ ${doc.sub.n}/${doc.sub.of}`).size(1, 1);
    if (doc.copy?.of > 1) p.line(`สำเนา ${doc.copy.n}/${doc.copy.of}`);
    if (doc.isAddition) p.line('** รายการเพิ่ม / NEW ITEM **');
    if (doc.kind === 'void') p.line('** ยกเลิก / VOID **');
    p.bold(false).align('left');
    for (const it of doc.items || []) {
      p.bold(true).line(`${it.qty} x ${it.name}${it.variant ? ` ${it.variant}` : ''}`).bold(false);
      for (const m of it.modifiers || []) p.line(`   - ${m.name}`);
      if (it.note) p.line(`   * ${it.note}`);
    }
    if (doc.orderNote) p.line(`หมายเหตุ: ${doc.orderNote}`);
  } else {
    p.align('center').bold(true).line(doc.shop?.name || doc.title || '').bold(false).align('left');
    if (doc.receiptNo) line(`ใบเสร็จ ${doc.receiptNo}`);
    for (const it of doc.items || []) line(`${it.qty}x ${it.name}`, Number(it.lineTotal).toFixed(2));
    if (doc.totals) line('TOTAL', Number(doc.totals.total).toFixed(2));
    for (const r of doc.rows || []) line(String(r[0]), String(r[1] ?? ''));
  }
  p.cut({ hasCutter: !!printer.has_cutter, cutType: printer.cut_type, feedLines: printer.feed_lines });
  return p.bytes();
}

/** Send raw bytes to a LAN printer (RAW / JetDirect port 9100). */
export function sendTcp(address, bytes, timeout = 8000) {
  const [host, portStr] = String(address || '').split(':');
  const port = Number(portStr) || 9100;
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('ไม่ได้ระบุ IP เครื่องพิมพ์'));
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`เชื่อมต่อ ${host}:${port} ไม่ได้ (timeout)`)); }, timeout);
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`เชื่อมต่อ ${host}:${port} ไม่ได้: ${e.code || e.message}`)); });
    sock.on('connect', () => {
      sock.write(Buffer.from(bytes), () => {
        sock.end();
      });
    });
    sock.on('close', (hadErr) => { clearTimeout(timer); if (!hadErr) resolve(); });
  });
}

/** Probe a LAN printer (TCP connect). */
export function probeTcp(address, timeout = 3000) {
  const [host, portStr] = String(address || '').split(':');
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port: Number(portStr) || 9100 });
    const done = (ok, msg) => { clearTimeout(t); sock.destroy(); resolve({ ok, message: msg }); };
    const t = setTimeout(() => done(false, 'timeout'), timeout);
    sock.on('connect', () => done(true, 'connected'));
    sock.on('error', (e) => done(false, e.code || e.message));
  });
}

export { encodeTIS620 };

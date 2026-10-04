// ─────────────────────────────────────────────────────────────────────────────
// ESC/POS encoder.
// Thai + Sarabun printing is done by rendering the document to a bitmap
// (shared/render.js) and sending it with GS v 0 raster commands, because
// thermal printers do not ship the Sarabun font.
// ─────────────────────────────────────────────────────────────────────────────

const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  constructor() { this.chunks = []; }

  raw(bytes) { this.chunks.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)); return this; }
  init() { return this.raw([ESC, 0x40]); }
  align(a = 'left') { return this.raw([ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0]); }
  bold(on = true) { return this.raw([ESC, 0x45, on ? 1 : 0]); }
  size(w = 1, h = 1) { return this.raw([GS, 0x21, ((w - 1) << 4) | (h - 1)]); }
  feed(lines = 1) { return this.raw([ESC, 0x64, Math.max(0, Math.min(255, lines))]); }
  lineSpacing(dots = 30) { return this.raw([ESC, 0x33, dots]); }

  /** Thai text through code page (TIS-620 / CP874 = page 255 on most Thai printers, configurable). */
  codepage(n = 255) { return this.raw([ESC, 0x74, n]); }
  text(str) { return this.raw(encodeTIS620(str)); }
  line(str = '') { return this.text(str + '\n'); }

  /**
   * Paper cut. `hasCutter=false` → feed only (never send a cut command the hardware does not support).
   * @param {{hasCutter:boolean, cutType:'full'|'partial', feedLines:number}} opt
   */
  cut({ hasCutter = true, cutType = 'partial', feedLines = 4 } = {}) {
    if (!hasCutter) return this.feed(Math.max(feedLines, 4));
    // GS V 66 n → feed n dots then cut (65 = full, 66 = partial)
    this.feed(Math.max(0, feedLines));
    return this.raw([GS, 0x56, cutType === 'full' ? 0x41 : 0x42, 0]);
  }

  /** Cash drawer kick: ESC p m t1 t2 (pin 2 by default). */
  drawer(pin = 0) { return this.raw([ESC, 0x70, pin ? 1 : 0, 25, 250]); }

  /** Beep (supported by many Thai/Chinese printers: ESC B n t). */
  beep(times = 2, dur = 3) { return this.raw([ESC, 0x42, times, dur]); }

  /**
   * Raster bit image (GS v 0). `bits` is a packed 1-bpp bitmap, `widthBytes` per row.
   * Sent in bands to stay within small printer buffers (BLE printers).
   */
  raster(bits, widthBytes, height, band = 96) {
    for (let y = 0; y < height; y += band) {
      const h = Math.min(band, height - y);
      this.raw([GS, 0x76, 0x30, 0, widthBytes & 0xff, (widthBytes >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
      this.raw(bits.subarray(y * widthBytes, (y + h) * widthBytes));
    }
    return this;
  }

  bytes() {
    const len = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/**
 * Convert RGBA pixels into a packed 1-bit bitmap with Floyd–Steinberg dithering.
 * Transparent pixels are treated as white.
 */
export function toMonochrome(rgba, width, height, { threshold = 160, dither = true } = {}) {
  const widthBytes = Math.ceil(width / 8);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const lum = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    gray[i] = lum * a + 255 * (1 - a);
  }
  const bits = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = gray[i];
      const black = old < threshold;
      if (black) bits[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      if (dither) {
        const err = old - (black ? 0 : 255);
        // only diffuse error for mid-tones (photos/logos); keeps text crisp
        if (old > 40 && old < 215) {
          if (x + 1 < width) gray[i + 1] += (err * 7) / 16;
          if (y + 1 < height) {
            if (x > 0) gray[i + width - 1] += (err * 3) / 16;
            gray[i + width] += (err * 5) / 16;
            if (x + 1 < width) gray[i + width + 1] += err / 16;
          }
        }
      }
    }
  }
  return { bits, widthBytes, height };
}

/** Build the full ESC/POS byte stream for a rendered canvas. */
export function canvasToEscPos(imageData, printer = {}, { cut = true, drawer = false, beep = false } = {}) {
  const { bits, widthBytes, height } = toMonochrome(imageData.data, imageData.width, imageData.height);
  const p = new EscPos().init();
  if (beep) p.beep();
  p.align('left').raster(bits, widthBytes, height);
  if (drawer) p.drawer(printer.drawer_pin || 0);
  if (cut) p.cut({ hasCutter: printer.has_cutter !== 0 && printer.has_cutter !== false, cutType: printer.cut_type || 'partial', feedLines: printer.feed_lines ?? 4 });
  return p.bytes();
}

/** UTF-16 → TIS-620 (Thai code page). Non-mappable characters become '?'. */
export function encodeTIS620(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c >= 0x0e01 && c <= 0x0e5b) out.push(c - 0x0e00 + 0xa0);
    else out.push(0x3f);
  }
  return Uint8Array.from(out);
}

/** Paper width in printable dots (203 dpi). */
export function paperDots(paper, override) {
  if (override) return Number(override);
  return String(paper) === '58' ? 384 : 576;
}

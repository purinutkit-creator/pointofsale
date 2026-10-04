// Server print agent for LAN printers: claims waiting jobs and sends ESC/POS over TCP 9100.
import { all, one, run } from '../db/index.js';
import { claimJob, finishJob, failStaleJobs } from '../services/printing.js';
import { buildJobBytes, sendTcp, probeTcp } from './render.js';
import { emitBranch } from '../realtime.js';

let busy = false;
const AGENT = `server:${process.pid}`;

export async function processLanJobs() {
  if (busy) return;
  busy = true;
  try {
    failStaleJobs();
    const jobs = all(`SELECT j.id, j.printer_id FROM print_jobs j JOIN printers p ON p.id = j.printer_id
                      WHERE j.status = 'waiting' AND p.connection = 'lan' AND p.active = 1 ORDER BY j.id LIMIT 20`);
    // print sequentially per printer so sub-tickets/copies come out in order
    for (const { id } of jobs) {
      const job = claimJob(id, AGENT);
      if (!job) continue;
      const printer = one('SELECT * FROM printers WHERE id = ?', job.printer_id);
      try {
        setPrinterStatus(printer, 'printing');
        const bytes = await buildJobBytes(job, printer);
        await sendTcp(printer.address, bytes);
        finishJob(job.id, { ok: true });
        setPrinterStatus(printer, 'connected');
      } catch (e) {
        finishJob(job.id, { ok: false, error: e.message });
        setPrinterStatus(printer, 'error', e.message);
      }
    }
  } finally {
    busy = false;
  }
}

function setPrinterStatus(p, status, message = null) {
  run("UPDATE printers SET status = ?, status_message = ?, status_at = datetime('now') WHERE id = ?", status, message, p.id);
  emitBranch(p.branch_id, 'printer:status', { printerId: p.id, status, message });
}

/** Periodic health check of LAN printers (updates Hardware Status). */
export async function probeLanPrinters() {
  for (const p of all("SELECT * FROM printers WHERE connection = 'lan' AND active = 1")) {
    const r = await probeTcp(p.address);
    const status = r.ok ? 'connected' : 'disconnected';
    if (status !== p.status && p.status !== 'printing') setPrinterStatus(p, status, r.ok ? null : r.message);
  }
}

export function startPrintWorker() {
  setInterval(() => processLanJobs().catch((e) => console.error('[print]', e)), 1500);
  setInterval(() => probeLanPrinters().catch(() => {}), 30000);
  probeLanPrinters().catch(() => {});
}

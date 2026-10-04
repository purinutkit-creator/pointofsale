// Background jobs: LAN print worker, loyalty maintenance, automatic backup, shift reminders.
import { all } from '../db/index.js';
import { config } from '../config.js';
import { startPrintWorker } from '../print/worker.js';
import { loyaltyDailyJob } from '../services/loyalty.js';
import { scheduleAutoBackup } from '../services/backup.js';
import { notifyStaff } from '../services/notify.js';
import { failStaleJobs } from '../services/printing.js';

export function startJobs() {
  if (config.serverPrinting) startPrintWorker();
  else setInterval(() => failStaleJobs(), 15000);
  scheduleAutoBackup();
  const loyalty = () => { try { loyaltyDailyJob(); } catch (e) { console.error('[loyalty job]', e); } };
  setTimeout(loyalty, 10_000);
  setInterval(loyalty, 60 * 60 * 1000);
  // Shift not closed (> 14h open)
  setInterval(() => {
    for (const s of all("SELECT sh.id, sh.branch_id, st.employee_code FROM shifts sh JOIN staff st ON st.id = sh.staff_id WHERE sh.status = 'open' AND sh.opened_at < datetime('now','-14 hours')")) {
      notifyStaff(s.branch_id, 'shift_not_closed', 'warning', `กะของ ${s.employee_code} ยังไม่ปิด`, 'เปิดกะมานานกว่า 14 ชั่วโมง กรุณาปิดกะ', { shiftId: s.id }, `shift_open:${s.id}:${new Date().toISOString().slice(0, 10)}`);
    }
  }, 30 * 60 * 1000);
}

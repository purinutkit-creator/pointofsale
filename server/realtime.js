// Real-time sync hub (Socket.IO): POS ↔ KDS ↔ Customer Display ↔ Queue Display ↔ Dashboard ↔ Member app
import { Server } from 'socket.io';
import { one, run } from './db/index.js';
import { sha256 } from './lib/security.js';
import { notifyStaff } from './services/notify.js';

let io;
const presence = new Map(); // deviceId -> socket count
const offlineTimers = new Map();

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: false }, pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 2e6 });

  io.use((socket, next) => {
    const { deviceToken, memberToken } = socket.handshake.auth || {};
    if (deviceToken) {
      const d = one('SELECT * FROM pos_devices WHERE token_hash = ? AND active = 1', sha256(deviceToken));
      if (!d) return next(new Error('DEVICE_UNAUTHORIZED'));
      socket.data.device = d;
      return next();
    }
    if (memberToken) {
      const s = one("SELECT member_id FROM member_sessions WHERE token_hash = ? AND expires_at > datetime('now')", sha256(memberToken));
      if (!s) return next(new Error('MEMBER_UNAUTHORIZED'));
      socket.data.memberId = s.member_id;
      return next();
    }
    return next(new Error('UNAUTHORIZED'));
  });

  io.on('connection', (socket) => {
    const d = socket.data.device;
    if (socket.data.memberId) {
      socket.join(`member:${socket.data.memberId}`);
      return;
    }
    socket.join(`branch:${d.branch_id}`);
    socket.join(`device:${d.id}`);
    if (d.type === 'customer_display' && d.paired_pos_id) socket.join(`display:${d.paired_pos_id}`);
    if (d.type === 'pos') socket.join(`pos:${d.branch_id}`);
    markOnline(d);

    // a POS can additionally view any branch it is allowed to (owner dashboards)
    socket.on('branch:watch', (branchId) => {
      if (Number.isInteger(branchId)) socket.join(`branch:${branchId}`);
    });

    // POS → paired customer displays (cart, payment, change …)
    socket.on('display:update', (state) => {
      if (d.type !== 'pos') return;
      io.to(`display:${d.id}`).emit('display:state', state);
    });

    // Customer display → paired POS (member lookup / attach / reward request)
    socket.on('display:event', (evt) => {
      if (d.type !== 'customer_display' || !d.paired_pos_id) return;
      io.to(`device:${d.paired_pos_id}`).emit('display:event', { ...evt, fromDevice: d.id });
    });

    // Print agents report printer connection state
    socket.on('printer:status', ({ printerId, status, message } = {}) => {
      const p = one('SELECT id, branch_id, name, status FROM printers WHERE id = ?', printerId);
      if (!p || p.branch_id !== d.branch_id) return;
      if (!['connected', 'disconnected', 'printing', 'error'].includes(status)) return;
      run("UPDATE printers SET status = ?, status_message = ?, status_at = datetime('now') WHERE id = ?", status, message || null, p.id);
      emitBranch(d.branch_id, 'printer:status', { printerId: p.id, status, message });
      if ((status === 'disconnected' || status === 'error') && p.status === 'connected') {
        notifyStaff(d.branch_id, 'printer_offline', 'warning', `เครื่องพิมพ์ ${p.name} ขาดการเชื่อมต่อ`, message || '', { printerId: p.id }, `printer_offline:${p.id}:${new Date().toISOString().slice(0, 13)}`);
      }
    });

    socket.on('disconnect', () => markOffline(d));
  });
  return io;
}

function markOnline(d) {
  presence.set(d.id, (presence.get(d.id) || 0) + 1);
  clearTimeout(offlineTimers.get(d.id));
  run("UPDATE pos_devices SET last_seen_at = datetime('now') WHERE id = ?", d.id);
  emitBranch(d.branch_id, 'device:presence', { deviceId: d.id, online: true, type: d.type });
}

function markOffline(d) {
  const n = (presence.get(d.id) || 1) - 1;
  if (n > 0) { presence.set(d.id, n); return; }
  presence.delete(d.id);
  run("UPDATE pos_devices SET last_seen_at = datetime('now') WHERE id = ?", d.id);
  emitBranch(d.branch_id, 'device:presence', { deviceId: d.id, online: false, type: d.type });
  // grace period before raising "offline" notifications
  offlineTimers.set(d.id, setTimeout(() => {
    if (presence.has(d.id)) return;
    const labels = { kds: 'KDS Offline', customer_display: 'Customer Display Offline', queue_display: 'Queue Display Offline', bridge: 'Print Bridge Offline' };
    if (labels[d.type]) notifyStaff(d.branch_id, `${d.type}_offline`, 'warning', `${labels[d.type]}: ${d.name}`, 'อุปกรณ์ขาดการเชื่อมต่อจากเซิร์ฟเวอร์', { deviceId: d.id });
  }, 30000));
}

export const isOnline = (deviceId) => presence.has(deviceId);
export const onlineDevices = () => [...presence.keys()];

export function emitBranch(branchId, event, data) { io?.to(`branch:${branchId}`).emit(event, data); }
export function emitDevice(deviceId, event, data) { io?.to(`device:${deviceId}`).emit(event, data); }
export function emitMember(memberId, event, data) { io?.to(`member:${memberId}`).emit(event, data); }
export function emitAll(event, data) { io?.emit(event, data); }
export const getIo = () => io;

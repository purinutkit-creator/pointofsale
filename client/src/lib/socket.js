import { io } from 'socket.io-client';
import { auth } from './api.js';

let socket = null;
const listeners = new Set();

export function connectSocket({ member = false } = {}) {
  if (socket) return socket;
  const a = member ? { memberToken: auth.memberToken } : { deviceToken: auth.deviceToken };
  if (!a.memberToken && !a.deviceToken) return null;
  socket = io({ auth: a, transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });
  socket.on('connect', () => listeners.forEach((fn) => fn(true)));
  socket.on('disconnect', () => listeners.forEach((fn) => fn(false)));
  return socket;
}
export const getSocket = () => socket;
export function disconnectSocket() { socket?.disconnect(); socket = null; }
export function onConnection(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Subscribe to a socket event inside React effects. */
export function on(event, fn) {
  const s = socket || connectSocket();
  s?.on(event, fn);
  return () => s?.off(event, fn);
}

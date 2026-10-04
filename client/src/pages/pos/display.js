// POS → Customer Display sync: Socket.IO (paired display device) + BroadcastChannel (second window on the same machine)
import { getSocket } from '../../lib/socket.js';

let state = { stage: 'idle' };
let bc = null;
try { bc = new BroadcastChannel('pos-display'); } catch { bc = null; }
const handlers = new Set();
bc && (bc.onmessage = (e) => { if (e.data?.kind === 'event') handlers.forEach((fn) => fn(e.data.event)); });

export function pushDisplay(patch, replace = false) {
  state = replace ? { ...patch, at: Date.now() } : { ...state, ...patch, at: Date.now() };
  getSocket()?.emit('display:update', state);
  bc?.postMessage({ kind: 'state', state });
}
export const displayState = () => state;

/** Events from the customer display (member attach, reward request) via BroadcastChannel. */
export function onLocalDisplayEvent(fn) { handlers.add(fn); return () => handlers.delete(fn); }

export function cartForDisplay(order, totals, settings) {
  if (!order) return { stage: 'idle' };
  return {
    stage: 'cart', orderNo: order.orderNo, queueNo: order.queueNo, table: order.tableNumber, type: order.type,
    items: order.items.filter((i) => i.status !== 'voided').map((i) => ({ id: i.id, name: i.name, variant: i.variantName, qty: i.qty, price: i.unitPrice, total: totals?.lines.find((l) => l.key === i.id)?.gross ?? i.unitPrice * i.qty, modifiers: i.modifiers.map((m) => m.name), note: i.note })),
    totals: totals && { subtotal: totals.subtotal, discount: totals.discount, serviceCharge: totals.serviceCharge, serviceChargeRate: totals.serviceChargeRate, vat: totals.vat, vatRate: totals.vatRate, vatMode: totals.vatMode, total: totals.total, remaining: totals.remaining },
    member: order.member ? { id: order.member.id, name: order.member.name, tier: order.member.tierName, tierColor: order.member.tierColor, points: order.member.points } : null,
    earnPoints: totals?.earnPoints || 0, pointsEnabled: settings?.points?.enabled !== false,
  };
}

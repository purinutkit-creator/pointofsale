// Client-side document builders used when the POS is offline: the same shared kitchen splitter
// and renderer as the server, printed directly on printers attached to this device.
import { planKitchenTickets, expandCopies } from '@shared/kitchen.js';
import { useApp } from '../../lib/store.js';
import { printAgent } from '../../hw/printing.js';

const DOC_TITLES = { receipt: 'ใบเสร็จรับเงิน', abb_tax_invoice: 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ', full_tax_invoice: 'ใบเสร็จรับเงิน/ใบกำกับภาษีเต็มรูป' };

export async function printKitchenOffline(order, items, catalog) {
  const { staff, settings } = useApp.getState();
  if (settings?.kitchen?.printOnSend === false) return 0;
  const prod = (id) => catalog.products.find((p) => p.id === id) || {};
  const kItems = items.map((i) => {
    const p = prod(i.productId);
    return { orderItemId: i.id, name: i.name, variant: i.variantName, qty: i.qty, note: i.note, modifiers: i.modifiers.map((m) => ({ name: m.name, qty: m.qty })), cutMode: p.cutMode || 'none', stationId: p.stationId ?? null, printerId: p.printerId ?? null };
  }).filter((k) => k.stationId || k.printerId);
  const hadSent = order.items.some((i) => i.status === 'sent');
  let printed = 0;
  for (const g of planKitchenTickets(kItems)) {
    const station = catalog.stations.find((s) => s.id === g.stationId);
    const targets = g.printerId
      ? [{ printerId: g.printerId, copies: catalog.printers.find((p) => p.id === g.printerId)?.kitchen_copies ?? 1 }]
      : catalog.routes.filter((r) => r.station_id === g.stationId && r.doc_type === 'kitchen').map((r) => ({ printerId: r.printer_id, copies: r.copies }));
    for (const t of targets) {
      if (!printAgent.printers.has(t.printerId)) continue; // only printers reachable from this device
      for (const c of expandCopies(g.subTickets, t.copies)) {
        const doc = {
          type: 'kitchen', kind: 'order', orderNo: order.orderNo, queueNo: order.queueNo, table: order.tableNumber, guests: order.guests, orderType: order.type,
          customerName: order.customerName, staff: staff?.code, orderNote: order.note, tz: settings?.shop?.timezone, isAddition: hadSent,
          station: station?.name, time: new Date().toISOString(), sub: { n: c.subIndex, of: c.subCount }, copy: { n: c.copyIndex, of: c.copyCount },
          items: c.items.map((s) => ({ name: s.name, variant: s.variant, qty: s.qty, note: s.note, modifiers: s.modifiers, unitIndex: s.unitIndex, unitCount: s.unitCount })),
        };
        try { await printAgent.printLocal(t.printerId, doc, 'kitchen'); printed++; } catch (e) { useApp.getState().toast(`พิมพ์ใบครัวไม่สำเร็จ: ${e.message}`, 'error'); }
      }
    }
  }
  return printed;
}

export function buildReceiptDocOffline(order, totals, { receiptNo, payments, received, change, docType = 'receipt', customer = null, copy = null }) {
  const { settings, staff, branch, device } = useApp.getState();
  const rc = settings.receipt || {};
  const shop = settings.shop || {};
  const lineBy = Object.fromEntries((totals.lines || []).map((l) => [l.key, l]));
  return {
    type: 'receipt', title: DOC_TITLES[docType], receiptNo, orderNo: order.orderNo, queueNo: order.queueNo, time: new Date().toISOString(), tz: shop.timezone,
    staff: `${staff?.code || ''} ${staff?.displayName || ''}`.trim(), posName: device?.name, table: order.tableNumber, orderType: order.type, customer, vatMode: settings.vat?.mode,
    shop: { name: shop.name, logoUrl: shop.logoUrl, address: shop.address, phone: shop.phone, taxId: shop.taxId, branchName: branch?.name, header: rc.header, footer: rc.footer, social: rc.social, promotion: rc.promotion, qrText: rc.qrText, qrLabel: rc.qrLabel },
    sections: { ...rc.sections, claimQr: false },
    items: order.items.filter((i) => i.status !== 'voided').map((i) => ({ qty: i.qty, name: i.name, variant: i.variantName, note: i.note, lineTotal: lineBy[i.id]?.gross ?? i.unitPrice * i.qty, modifiers: i.modifiers.map((m) => ({ name: m.name, price: m.price, qty: m.qty })), discount: lineBy[i.id]?.itemDiscount || 0 })),
    totals, payments, received, change, copy,
    member: order.member ? { name: order.member.name, tier: order.member.tierName, before: order.member.points, used: totals.pointsUsed || 0, earned: totals.earnPoints, balance: (order.member.points || 0) - (totals.pointsUsed || 0) + totals.earnPoints } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kitchen ticket splitting ("ระบบตัดใบครัวตามรายการสินค้า")
//
// Cut modes per product:
//   none           – normal
//   cut_after      – ตัดหลังสินค้านี้ (close current ticket after this item)
//   cut_before     – ตัดก่อนสินค้านี้ (close current ticket before this item)
//   separate       – สินค้านี้พิมพ์แยกใบเดี่ยว
//   each_qty       – แยกใบตามจำนวน (3 × Steak → 3 tickets "Steak 1/3..3/3")
// Every ticket ends with a paper cut. The order reference never changes:
// all sub-tickets belong to the same order / queue number.
// ─────────────────────────────────────────────────────────────────────────────

export const CUT_MODES = {
  none: 'ไม่ตัด',
  cut_after: 'ตัดหลังสินค้านี้ (Cut After Item)',
  cut_before: 'ตัดก่อนสินค้านี้ (Cut Before Item)',
  separate: 'พิมพ์แยกใบเดี่ยว (Separate Ticket)',
  each_qty: 'แยกใบตามจำนวน (Each Quantity Separate)',
};

/**
 * Split an ordered list of items into sub-tickets.
 * @param {Array<{cutMode?:string, qty:number}>} items in order sequence
 * @returns {Array<Array<object>>} sub-tickets, each an array of items (each_qty items get `unitIndex`/`unitCount`)
 */
export function splitTickets(items) {
  const tickets = [];
  let current = [];
  const close = () => { if (current.length) { tickets.push(current); current = []; } };

  for (const item of items) {
    const mode = item.cutMode || 'none';
    switch (mode) {
      case 'cut_before':
        close();
        current.push(item);
        break;
      case 'cut_after':
        current.push(item);
        close();
        break;
      case 'separate':
        close();
        tickets.push([item]);
        break;
      case 'each_qty': {
        close();
        const n = Math.max(1, Math.floor(Number(item.qty) || 1));
        for (let k = 1; k <= n; k++) tickets.push([{ ...item, qty: 1, unitIndex: k, unitCount: n }]);
        break;
      }
      default:
        current.push(item);
    }
  }
  close();
  return tickets;
}

/**
 * Group items by kitchen route (station + optional printer override) preserving order,
 * then split each group into sub-tickets.
 * @param {Array} items each with stationId and optional printerId (product/category override)
 * @returns {Array<{stationId, printerId, subTickets: Array<Array<object>>}>}
 */
export function planKitchenTickets(items) {
  const groups = new Map();
  for (const it of items) {
    const k = `${it.stationId ?? 'none'}|${it.printerId ?? ''}`;
    if (!groups.has(k)) groups.set(k, { stationId: it.stationId ?? null, printerId: it.printerId ?? null, items: [] });
    groups.get(k).items.push(it);
  }
  return [...groups.values()].map((g) => ({ stationId: g.stationId, printerId: g.printerId, subTickets: splitTickets(g.items) }));
}

/**
 * Expand into print copies:  for each sub-ticket n/N, copies c/C.
 * Returns flat list [{subIndex, subCount, copyIndex, copyCount, items}] in print order:
 * 1/3 copy 1/2, 1/3 copy 2/2, 2/3 copy 1/2 ...
 */
export function expandCopies(subTickets, copies) {
  const C = Math.max(0, Math.floor(Number(copies) || 0));
  const out = [];
  subTickets.forEach((items, i) => {
    for (let c = 1; c <= C; c++) {
      out.push({ subIndex: i + 1, subCount: subTickets.length, copyIndex: c, copyCount: C, items });
    }
  });
  return out;
}

export const KDS_STATUS = ['new', 'preparing', 'ready', 'served'];
export const KDS_STATUS_LABEL = { new: 'NEW', preparing: 'PREPARING', ready: 'READY', served: 'SERVED', voided: 'VOID' };

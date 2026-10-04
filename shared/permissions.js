// Permission catalog — the single source of truth for RBAC keys.
// Shown on the staff page under "สิ่งที่พนักงานนี้ทำได้".

export const PERMISSION_GROUPS = [
  {
    key: 'pos', label: 'POS', items: [
      ['pos.access', 'เข้า POS'], ['pos.open_order', 'เปิด Order'], ['pos.add_item', 'เพิ่มสินค้า'],
      ['pos.edit_qty', 'แก้จำนวน'], ['pos.remove_item', 'ลบสินค้า (ยังไม่ส่งครัว)'], ['pos.edit_modifier', 'Edit Modifier'],
      ['pos.note', 'Note'], ['pos.hold_bill', 'Hold Bill'], ['pos.retrieve_bill', 'Retrieve Bill'],
      ['pos.send_kitchen', 'Send Kitchen'], ['pos.change_type', 'เปลี่ยนทานที่ร้าน/กลับบ้าน'], ['pos.move_table', 'ย้ายโต๊ะ'],
      ['pos.merge_table', 'รวมโต๊ะ'], ['pos.split_bill', 'Split Bill'], ['pos.sc_exempt', 'ยกเว้น Service Charge'],
    ],
  },
  {
    key: 'payment', label: 'PAYMENT', items: [
      ['payment.cash', 'รับเงินสด'], ['payment.qr', 'QR'], ['payment.card', 'Card'], ['payment.other', 'ช่องทางอื่น'],
      ['payment.split', 'Split Payment'], ['payment.cash_in', 'Cash In'], ['payment.cash_out', 'Cash Out'],
      ['payment.open_drawer', 'Open Drawer'], ['shift.open_close', 'เปิด/ปิดกะ'], ['shift.view_all', 'ดูกะของพนักงานอื่น'],
    ],
  },
  {
    key: 'discount', label: 'DISCOUNT', items: [
      ['discount.item', 'Discount Item'], ['discount.bill', 'Discount Bill'], ['discount.coupon', 'Coupon'],
      ['discount.promotion', 'Promotion'], ['discount.override_price', 'Override Price'],
    ],
  },
  {
    key: 'void', label: 'VOID/REFUND', items: [
      ['void.item', 'Void Item'], ['void.order', 'Void Order'], ['refund.partial', 'Partial Refund'],
      ['refund.full', 'Full Refund'], ['receipt.reprint', 'Reprint ใบเสร็จ'], ['order.edit_closed', 'แก้ Closed Bill'],
    ],
  },
  {
    key: 'member', label: 'MEMBER', items: [
      ['member.search', 'ค้นหาสมาชิก'], ['member.create', 'สมัครสมาชิก'], ['member.edit', 'แก้ข้อมูล'],
      ['member.use_points', 'ใช้ Point'], ['member.adjust_points', 'เพิ่ม/ลด Point'], ['member.edit_tier', 'แก้ Tier'],
      ['member.history', 'ดูประวัติ'], ['member.rewards', 'จัดการ Reward / Tier / Campaign'],
    ],
  },
  {
    key: 'product', label: 'PRODUCT', items: [
      ['product.create', 'เพิ่มสินค้า'], ['product.edit', 'แก้สินค้า'], ['product.delete', 'ลบ'],
      ['product.edit_price', 'แก้ราคา'], ['product.sold_out', 'Sold Out'], ['product.category', 'Category'],
      ['product.modifier', 'Modifier'], ['table.manage', 'จัดการโต๊ะ / Floor Plan'],
    ],
  },
  {
    key: 'stock', label: 'STOCK', items: [
      ['stock.view', 'ดู Stock'], ['stock.in', 'Stock In'], ['stock.out', 'Stock Out'], ['stock.adjust', 'Adjustment'],
      ['stock.waste', 'Waste'], ['stock.supplier', 'Supplier'], ['stock.po', 'PO'], ['stock.view_cost', 'ดูต้นทุน'],
    ],
  },
  {
    key: 'report', label: 'REPORT', items: [
      ['report.dashboard', 'Dashboard'], ['report.sales', 'Sales Report'], ['report.profit', 'Profit'],
      ['report.cost', 'Cost'], ['report.export', 'Export'], ['report.other_staff', 'ดูยอดพนักงานอื่น'],
      ['report.all_branches', 'ดูทุกสาขา'], ['audit.view', 'ดู Activity Log'],
    ],
  },
  {
    key: 'staff', label: 'STAFF', items: [
      ['staff.create', 'เพิ่มพนักงาน'], ['staff.edit', 'แก้ไข'], ['staff.reset_pin', 'Reset PIN'],
      ['staff.permission', 'Permission'], ['staff.disable', 'ปิดใช้งาน'], ['staff.role', 'จัดการ Role'],
    ],
  },
  {
    key: 'settings', label: 'SETTINGS', items: [
      ['settings.shop', 'ร้าน / ธีม'], ['settings.vat', 'VAT'], ['settings.service_charge', 'Service Charge'],
      ['settings.printer', 'Printer'], ['settings.receipt', 'Receipt'], ['settings.member', 'Member'],
      ['settings.point', 'Point'], ['settings.promotion', 'Promotion'], ['settings.branch', 'Branch'],
      ['settings.device', 'อุปกรณ์ / POS Device'], ['settings.payment', 'Payment'], ['settings.backup', 'Backup / Restore'],
      ['settings.approval', 'Manager Approval'],
    ],
  },
  {
    key: 'kitchen', label: 'KITCHEN', items: [
      ['kds.access', 'ใช้งาน KDS'], ['kds.bump', 'เปลี่ยนสถานะรายการครัว'], ['queue.call', 'เรียกคิว'],
    ],
  },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map(([k]) => k));
export const PERMISSION_LABEL = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.items));

const pick = (prefixes) => ALL_PERMISSIONS.filter((p) => prefixes.some((x) => p === x || p.startsWith(x)));

export const DEFAULT_ROLES = [
  { code: 'owner', name: 'Owner', level: 100, permissions: ['*'] },
  { code: 'admin', name: 'Admin', level: 90, permissions: ALL_PERMISSIONS },
  {
    code: 'manager', name: 'Manager', level: 70,
    permissions: ALL_PERMISSIONS.filter((p) => !['settings.backup', 'staff.role', 'report.all_branches'].includes(p)),
  },
  {
    code: 'supervisor', name: 'Supervisor', level: 50,
    permissions: [...pick(['pos.', 'payment.', 'discount.', 'void.', 'member.', 'kds.', 'queue.', 'shift.']),
      'refund.partial', 'receipt.reprint', 'product.sold_out', 'stock.view', 'report.dashboard', 'report.sales']
      .filter((p) => !['member.adjust_points', 'member.rewards'].includes(p)),
  },
  {
    code: 'cashier', name: 'Cashier', level: 30,
    permissions: [...pick(['pos.']).filter((p) => !['pos.sc_exempt', 'pos.merge_table'].includes(p)),
      'payment.cash', 'payment.qr', 'payment.card', 'payment.other', 'payment.split', 'payment.cash_in', 'shift.open_close',
      'discount.item', 'discount.bill', 'discount.coupon', 'discount.promotion',
      'member.search', 'member.create', 'member.use_points', 'member.history', 'product.sold_out', 'queue.call'],
  },
  {
    code: 'waiter', name: 'Waiter', level: 20,
    permissions: ['pos.access', 'pos.open_order', 'pos.add_item', 'pos.edit_qty', 'pos.remove_item', 'pos.edit_modifier',
      'pos.note', 'pos.hold_bill', 'pos.retrieve_bill', 'pos.send_kitchen', 'pos.move_table', 'member.search'],
  },
  { code: 'kitchen', name: 'Kitchen', level: 10, permissions: ['kds.access', 'kds.bump', 'queue.call', 'product.sold_out'] },
  { code: 'stock', name: 'Stock Staff', level: 10, permissions: pick(['stock.']).filter((p) => p !== 'stock.view_cost') },
];

// Actions that can be configured to require a manager PIN (Manager Approval)
export const APPROVAL_ACTIONS = [
  ['void_item', 'Void รายการ (ส่งครัวแล้ว)', 'void.item'],
  ['void_order', 'Void Order', 'void.order'],
  ['refund', 'Refund', 'refund.full'],
  ['discount_over_limit', 'Discount เกินสิทธิ์', 'discount.bill'],
  ['override_price', 'Override Price', 'discount.override_price'],
  ['reprint', 'Reprint ใบเสร็จ', 'receipt.reprint'],
  ['open_drawer', 'เปิด Cash Drawer (No Sale)', 'payment.open_drawer'],
  ['cash_out', 'Cash Out', 'payment.cash_out'],
  ['edit_closed_bill', 'แก้ Closed Bill', 'order.edit_closed'],
  ['sc_exempt', 'ยกเว้น Service Charge', 'pos.sc_exempt'],
];

/** Effective permission set: role permissions + staff overrides. */
export function effectivePermissions(rolePerms = [], overrides = []) {
  if (rolePerms.includes('*')) return new Set(['*', ...ALL_PERMISSIONS]);
  const set = new Set(rolePerms);
  for (const o of overrides) {
    if (o.allowed) set.add(o.permission);
    else set.delete(o.permission);
  }
  return set;
}

export const can = (perms, key) => !!perms && (perms.has?.('*') || perms.has?.(key) || (Array.isArray(perms) && (perms.includes('*') || perms.includes(key))));

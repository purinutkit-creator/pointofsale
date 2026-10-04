// First-run setup: roles, permissions, owner account, default branch, stations, tiers.
import { one, all, run, insert, tx } from '../db/index.js';
import { PERMISSION_GROUPS, DEFAULT_ROLES } from '../../shared/permissions.js';
import { hashSecret } from '../lib/security.js';
import { setSetting, getSetting } from './settings.js';

/** Make sure permission catalog & system roles exist (idempotent, runs on every boot). */
export function syncPermissionCatalog() {
  tx(() => {
    for (const g of PERMISSION_GROUPS) {
      for (const [key, label] of g.items) {
        run('INSERT INTO permissions (key, group_key, label) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET group_key = excluded.group_key, label = excluded.label', key, g.key, label);
      }
    }
    for (const r of DEFAULT_ROLES) {
      let role = one('SELECT * FROM roles WHERE code = ?', r.code);
      if (!role) {
        const id = insert('roles', { code: r.code, name: r.name, level: r.level, is_system: 1 });
        for (const p of r.permissions) run('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)', id, p);
        role = one('SELECT * FROM roles WHERE id = ?', id);
      }
      if (r.code === 'owner') run("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, '*')", role.id);
    }
  });
}

export const isSetupDone = () => !!one('SELECT id FROM staff LIMIT 1');

export function runSetup({ shopName, branchName, branchCode, ownerFirstName, ownerLastName, employeeCode, pin, phone, address, taxId, vatEnabled, sampleMenu }) {
  return tx(() => {
    if (isSetupDone()) throw new Error('already set up');
    syncPermissionCatalog();
    const branchId = insert('branches', { code: branchCode || 'HQ', name: branchName || 'สาขาหลัก', address, phone, tax_id: taxId, receipt_prefix: 'R', queue_prefix: 'Q' });
    const shop = getSetting('shop');
    setSetting('shop', { ...shop, name: shopName, phone: phone || '', address: address || '', taxId: taxId || '' });
    setSetting('vat', { ...getSetting('vat'), enabled: !!vatEnabled });
    const ownerRole = one("SELECT id FROM roles WHERE code = 'owner'");
    const staffId = insert('staff', {
      employee_code: employeeCode || 'EMP001', first_name: ownerFirstName, last_name: ownerLastName || null, role_id: ownerRole.id,
      branch_id: branchId, all_branches: 1, max_discount_pct: 100, start_date: new Date().toISOString().slice(0, 10), phone: phone || null,
    });
    insert('users', { staff_id: staffId, pin_hash: hashSecret(pin), pin_changed_at: new Date().toISOString() });
    const stations = [['Main Kitchen', 'MAIN', '#E4572E'], ['Hot', 'HOT', '#D7263D'], ['Cold', 'COLD', '#1B998B'], ['Beverage', 'BEV', '#2E86AB'], ['Dessert', 'DES', '#C5458A'], ['Bar', 'BAR', '#6C4AB6']];
    stations.forEach(([name, code, color], i) => insert('kitchen_stations', { branch_id: null, name, code, color, sort_order: i }));
    const tiers = [['Member', 0, 100, '#9CA3AF', 0, 1], ['Silver', 101, 300, '#94A3B8', 0, 1.2], ['Gold', 301, 700, '#D4A017', 5, 1], ['Platinum', 701, null, '#4B5563', 10, 1.5]];
    tiers.forEach(([name, min, max, color, disc, mult], i) => insert('member_tiers', { name, min_points: min, max_points: max, color, discount_pct: disc, point_multiplier: mult, sort_order: i, benefits: disc ? `ส่วนลด ${disc}%${mult > 1 ? ` และคะแนน x${mult}` : ''}` : mult > 1 ? `ได้รับคะแนน x${mult}` : 'สะสมแต้มทุกการซื้อ' }));
    insert('zones', { branch_id: branchId, name: 'Indoor', sort_order: 0 });
    if (sampleMenu) seedSampleMenu(branchId);
    return { branchId, staffId };
  });
}

/** Optional starter menu so a new shop can try the POS immediately (editable/deletable). */
function seedSampleMenu(branchId) {
  const st = Object.fromEntries(all('SELECT id, code FROM kitchen_stations').map((s) => [s.code, s.id]));
  const cat = (name, station, color, i) => insert('categories', { name, station_id: st[station], color, sort_order: i });
  const food = cat('อาหารจานเดียว', 'MAIN', '#E4572E', 0);
  const drink = cat('เครื่องดื่ม', 'BEV', '#2E86AB', 1);
  const dessert = cat('ของหวาน', 'DES', '#C5458A', 2);
  const g = (name, required, multiple, min, max, mods) => {
    const id = insert('modifier_groups', { name, required: required ? 1 : 0, multiple: multiple ? 1 : 0, min_select: min, max_select: max });
    mods.forEach(([n, price, def], i) => insert('modifiers', { group_id: id, name: n, price, is_default: def ? 1 : 0, sort_order: i }));
    return id;
  };
  const size = g('Size', true, false, 1, 1, [['S', 0, true], ['M', 10], ['L', 20]]);
  const sweet = g('ความหวาน', true, false, 1, 1, [['0%', 0], ['25%', 0], ['50%', 0], ['75%', 0], ['100%', 0, true]]);
  const spicy = g('ความเผ็ด', true, false, 1, 1, [['ไม่เผ็ด', 0], ['น้อย', 0], ['กลาง', 0, true], ['มาก', 0]]);
  const topping = g('Topping', false, true, 0, 3, [['ไข่มุก', 10], ['ชีส', 20], ['ไข่ดาว', 15]]);
  const p = (name, category, price, cost, groups, extra = {}) => {
    const id = insert('products', { name, category_id: category, price, cost, sku: extra.sku, ...extra });
    groups.forEach((gid, i) => insert('product_modifier_groups', { product_id: id, group_id: gid, sort_order: i }));
    return id;
  };
  p('ข้าวกะเพราหมูสับ', food, 60, 25, [spicy, topping], { sku: 'F001' });
  p('ผัดไทยกุ้งสด', food, 80, 35, [spicy], { sku: 'F002' });
  p('ข้าวผัดปู', food, 90, 40, [topping], { sku: 'F003' });
  p('สเต็กหมู', food, 159, 70, [], { sku: 'F004', cut_mode: 'each_qty' });
  p('ชาไทย', drink, 45, 12, [size, sweet, topping], { sku: 'D001' });
  p('กาแฟเย็น', drink, 50, 15, [size, sweet], { sku: 'D002' });
  p('น้ำดื่ม', drink, 15, 5, [], { sku: 'D003', track_stock: 1, min_stock: 12 });
  p('บิงซูสตรอว์เบอร์รี', dessert, 129, 45, [], { sku: 'S001', cut_mode: 'separate' });
  p('เค้กช็อกโกแลต', dessert, 85, 30, [], { sku: 'S002' });
  const water = one("SELECT id FROM products WHERE sku = 'D003'");
  run("INSERT INTO inventory (branch_id, item_type, item_id, qty) VALUES (?, 'product', ?, 48)", branchId, water.id);
  const zone = one('SELECT id FROM zones WHERE branch_id = ?', branchId);
  for (let i = 1; i <= 8; i++) insert('tables', { branch_id: branchId, zone_id: zone.id, number: `A${i}`, seats: i % 3 === 0 ? 6 : 4, shape: i % 3 === 0 ? 'rect' : i % 2 ? 'square' : 'round', pos_x: 30 + ((i - 1) % 4) * 140, pos_y: 30 + Math.floor((i - 1) / 4) * 140, width: i % 3 === 0 ? 120 : 90, height: 90 });
}

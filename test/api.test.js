// End-to-end API test: setup → device → login → catalog → order → kitchen split → payment → refund → loyalty.
// A local TCP server stands in for a LAN thermal printer and captures the real ESC/POS bytes.
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'pos-test-'));

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { initDb, all, one } from '../server/db/index.js';
import { createApp } from '../server/index.js';
import { initRealtime, emitBranch } from '../server/realtime.js';
import { setNotifyEmitter } from '../server/services/notify.js';
import { syncPermissionCatalog } from '../server/services/bootstrap.js';
import { processLanJobs } from '../server/print/worker.js';

let server; let base; let printer; const received = [];
let deviceToken; let token;

async function api(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(deviceToken ? { 'X-Device-Token': deviceToken } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

before(async () => {
  initDb(':memory:');
  syncPermissionCatalog();
  server = http.createServer(createApp());
  initRealtime(server);
  setNotifyEmitter(emitBranch);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  printer = net.createServer((sock) => { const chunks = []; sock.on('data', (c) => chunks.push(c)); sock.on('end', () => received.push(Buffer.concat(chunks))); });
  await new Promise((r) => printer.listen(0, '127.0.0.1', r));
});
after(() => { server.close(); printer.close(); setTimeout(() => process.exit(0), 50); });

test('full POS flow', async () => {
  // setup
  let r = await api('POST', '/setup', { shopName: 'ร้านทดสอบ', branchName: 'สาขาหลัก', branchCode: 'HQ', ownerFirstName: 'Owner', employeeCode: 'EMP001', pin: '1234', vatEnabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('POST', '/devices/register', { employeeCode: 'EMP001', pin: '1234', branchId: 1, name: 'POS-01', code: 'POS-01', type: 'pos' });
  assert.equal(r.status, 200);
  deviceToken = r.data.token;
  // bad pin
  r = await api('POST', '/auth/login', { employeeCode: 'EMP001', pin: '9999' });
  assert.equal(r.status, 401);
  r = await api('POST', '/auth/login', { employeeCode: 'EMP001', pin: '1234' });
  assert.equal(r.status, 200);
  token = r.data.token;
  assert.ok(r.data.staff.permissions.includes('*'));

  // receipt copies = 2, kitchen printer LAN with 2 copies on Main Kitchen
  r = await api('PUT', '/settings/receipt', { value: { copies: 2, printMode: 'auto' } });
  assert.equal(r.status, 200);
  const stations = (await api('GET', '/stations')).data;
  const main = stations.find((s) => s.code === 'MAIN');
  const addr = `127.0.0.1:${printer.address().port}`;
  r = await api('POST', '/printers', { name: 'Kitchen', role: 'kitchen', connection: 'lan', address: addr, paper: '80', hasCutter: true, routes: [{ stationId: main.id, copies: 2 }] });
  assert.equal(r.status, 200);
  r = await api('POST', '/printers', { name: 'Receipt', role: 'receipt', connection: 'lan', address: addr, paper: '58', hasCutter: false, hasDrawer: true });
  const receiptPrinterId = r.data.id;

  // catalog
  r = await api('POST', '/categories', { name: 'อาหาร', stationId: main.id });
  const cat = r.data.id;
  const mk = async (name, price, cutMode = 'none') => (await api('POST', '/products', { name, price, categoryId: cat, cutMode, cost: 10 })).data.id;
  const kaprao = await mk('ข้าวกะเพรา', 60);
  const egg = await mk('ไข่ดาว', 10);
  const a = await mk('สินค้า A', 50, 'cut_after');
  const tea = await mk('ชาไทย', 45);
  const cake = await mk('เค้ก', 80);
  const steak = await mk('Steak', 200, 'each_qty');

  // shift required
  const items = [kaprao, egg, a, tea, cake].map((p, i) => ({ id: `item-${i}-xxxxxxxx`, productId: p, qty: 1 }));
  r = await api('POST', '/orders', { id: 'order-0001-xxxx', type: 'takeaway', items, customerName: 'คุณเอ' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.queue_no, 'Q001');
  assert.equal(r.data.total, 245);

  // send kitchen → cut after "สินค้า A": 2 sub-tickets × 2 copies = 4 jobs
  r = await api('POST', '/orders/order-0001-xxxx/send-kitchen');
  assert.equal(r.status, 200);
  let jobs = all("SELECT * FROM print_jobs WHERE doc_type = 'kitchen' ORDER BY id");
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map((j) => `${j.sub_index}/${j.sub_count}-${j.copy_index}/${j.copy_count}`), ['1/2-1/2', '1/2-2/2', '2/2-1/2', '2/2-2/2']);
  const p1 = JSON.parse(jobs[0].payload);
  assert.deepEqual(p1.items.map((x) => x.name), ['ข้าวกะเพรา', 'ไข่ดาว', 'สินค้า A']);
  assert.equal(p1.queueNo, 'Q001');
  assert.equal(JSON.parse(jobs[2].payload).items.length, 2);

  // add new item → only the new item prints, flagged as addition; each_qty Steak x3 → 3 tickets
  r = await api('PUT', '/orders/order-0001-xxxx', { items: [...items, { id: 'item-steak-xxxxxx', productId: steak, qty: 3 }], version: r.data.order.version });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('POST', '/orders/order-0001-xxxx/send-kitchen');
  jobs = all("SELECT * FROM print_jobs WHERE doc_type = 'kitchen' AND id > ? ORDER BY id", jobs.at(-1).id);
  assert.equal(jobs.length, 6); // 3 sub tickets × 2 copies
  const pj = JSON.parse(jobs[0].payload);
  assert.equal(pj.isAddition, true);
  assert.equal(pj.items.length, 1);
  assert.equal(pj.items[0].unitIndex, 1);
  assert.equal(pj.items[0].unitCount, 3);
  assert.equal(pj.queueNo, 'Q001');

  // the worker prints LAN jobs → real ESC/POS bytes with raster + cut
  await processLanJobs();
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(all("SELECT * FROM print_jobs WHERE status = 'printed'").length, 10);
  assert.ok(received.length >= 10);
  const bytes = received[0];
  assert.equal(bytes[0], 0x1b); assert.equal(bytes[1], 0x40); // ESC @
  assert.ok(bytes.includes(0x76)); // GS v 0 raster
  const cutIdx = bytes.lastIndexOf(0x56);
  assert.equal(bytes[cutIdx - 1], 0x1d); // GS V (cut)

  // payment without shift → blocked
  r = await api('POST', '/orders/order-0001-xxxx/pay', { idempotencyKey: 'pay-key-0001', payments: [{ method: 'cash', amount: 845, tendered: 1000 }] });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'SHIFT_REQUIRED');
  r = await api('POST', '/shifts/open', { openingCash: 1000 });
  assert.equal(r.status, 200);
  const shiftId = r.data.shift.id;

  // member
  r = await api('POST', '/members', { phone: '0812345678', name: 'Punpun', gender: 'female', birthday: '2000-01-01' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const memberId = r.data.id;
  r = await api('POST', '/members', { phone: '081-234-5678', name: 'Dup' });
  assert.equal(r.status, 409);
  r = await api('POST', '/orders/order-0001-xxxx/member', { memberId });
  assert.equal(r.status, 200);
  const total = r.data.total;
  assert.equal(total, 845);
  assert.equal(r.data.calc.earnPoints, Math.floor(845 / 25));

  // underpay rejected
  r = await api('POST', '/orders/order-0001-xxxx/pay', { idempotencyKey: 'pay-key-0001', payments: [{ method: 'cash', amount: 500, tendered: 500 }] });
  assert.equal(r.status, 400);
  // split payment: cash + qr
  const payBody = { idempotencyKey: 'pay-key-0002', payments: [{ method: 'cash', amount: 500, tendered: 1000 }, { method: 'qr', amount: 345 }] };
  const [p1r, p2r] = await Promise.all([api('POST', '/orders/order-0001-xxxx/pay', payBody), api('POST', '/orders/order-0001-xxxx/pay', payBody)]);
  assert.equal(p1r.status, 200, JSON.stringify(p1r.data));
  assert.equal(p2r.status, 200);
  assert.equal(p1r.data.receiptNo, p2r.data.receiptNo); // idempotent
  assert.equal(p1r.data.change, 500);
  assert.equal(all('SELECT * FROM payments').length, 1);
  assert.equal(all("SELECT * FROM receipts WHERE doc_type <> 'credit_note'").length, 1);
  const receiptJobs = all("SELECT * FROM print_jobs WHERE doc_type = 'receipt' ORDER BY id");
  assert.equal(receiptJobs.length, 2);
  assert.equal(JSON.parse(receiptJobs[0].payload).receiptNo, JSON.parse(receiptJobs[1].payload).receiptNo);
  assert.ok(all("SELECT * FROM print_jobs WHERE doc_type = 'drawer'").length === 1);
  let m = one('SELECT * FROM members WHERE id = ?', memberId);
  assert.equal(m.points, 33);
  assert.equal(m.visit_count, 1);
  // double payment on another key → ALREADY_PAID
  r = await api('POST', '/orders/order-0001-xxxx/pay', { idempotencyKey: 'pay-key-0003', payments: [{ method: 'cash', amount: 845 }] });
  assert.equal(r.status, 409);

  // retry a print job must not create new payment/order
  const failedJob = receiptJobs[0].id;
  await api('POST', `/print-jobs/${failedJob}/cancel`);
  r = await api('POST', `/print-jobs/${failedJob}/retry`);
  assert.equal(r.data.status, 'waiting');
  assert.equal(all('SELECT * FROM payments').length, 1);
  assert.equal(all('SELECT * FROM orders').length, 1);

  // partial refund of Steak x1 → stock / points reversed proportionally
  const steakItem = one("SELECT * FROM order_items WHERE id = 'item-steak-xxxxxx'");
  r = await api('POST', '/orders/order-0001-xxxx/refund', { idempotencyKey: 'refund-0001', type: 'item', items: [{ itemId: steakItem.id, qty: 1 }], reason: 'ลูกค้าเปลี่ยนใจ', method: 'cash' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund.amount, 200);
  assert.equal(r.data.order.status, 'partially_refunded');
  m = one('SELECT * FROM members WHERE id = ?', memberId);
  assert.equal(m.points, 33 - Math.round((33 * 200) / 845));

  // shift expected cash = 1000 + 500 - 200
  r = await api('GET', `/shifts/${shiftId}`);
  assert.equal(r.data.expectedCash, 1300);

  // reward → redemption code → apply on new order → used
  r = await api('POST', '/rewards', { name: 'ส่วนลด 20 บาท', type: 'discount_amount', pointsRequired: 10, discountValue: 20 });
  const rewardId = r.data.id;
  r = await api('POST', `/members/${memberId}/redeem`, { rewardId, txnId: 'redeem-txn-0001' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const code = r.data.code;
  assert.match(code, /^\d{6}$/);
  r = await api('POST', '/orders', { id: 'order-0002-xxxx', type: 'dine_in', items: [{ id: 'item-o2-1-xxxxx', productId: kaprao, qty: 2 }] });
  assert.equal(r.status, 200);
  r = await api('POST', '/orders/order-0002-xxxx/redemptions', { code });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.order.total, 100);
  r = await api('POST', '/orders/order-0002-xxxx/redemptions', { code });
  assert.equal(r.status, 409); // single use
  assert.equal(one('SELECT status FROM reward_redemptions WHERE code = ?', code).status, 'used');

  // void order releases the code and requires reason
  r = await api('POST', '/orders/order-0002-xxxx/void', { reason: 'ทดสอบ' });
  assert.equal(r.status, 200);
  assert.equal(one('SELECT status FROM reward_redemptions WHERE code = ?', code).status, 'active');

  // close shift
  r = await api('POST', `/shifts/${shiftId}/close`, { actualCash: 1290 });
  assert.equal(r.status, 200);
  assert.equal(r.data.shift.difference, -10);

  // reports
  r = await api('GET', '/dashboard');
  assert.equal(r.status, 200);
  assert.equal(r.data.kpi.orders, 1);
  r = await api('GET', '/reports/product?format=csv');
  assert.equal(r.status, 200);
  assert.ok(String(r.data).includes('Steak'));
  const pdf = await fetch(`${base}/reports/sales?format=pdf`, { headers: { Authorization: `Bearer ${token}`, 'X-Device-Token': deviceToken } });
  assert.equal(pdf.status, 200);
  assert.equal((await pdf.arrayBuffer()).byteLength > 1000, true);

  // audit log recorded critical actions
  const actions = new Set(all('SELECT action FROM audit_logs').map((x) => x.action));
  for (const a_ of ['auth.login', 'order.send_kitchen', 'payment.create', 'refund.partial', 'void.order', 'shift.open', 'shift.close', 'reward.use']) assert.ok(actions.has(a_), a_);
});

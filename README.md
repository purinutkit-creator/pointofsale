# ระบบ POS ร้านอาหาร (Full-Stack)

ระบบขายหน้าร้านสำหรับร้านอาหาร คาเฟ่ ร้านเครื่องดื่ม และร้านค้าทั่วไป ใช้งานแบบ Touch Screen ประกอบด้วย POS, KDS, Customer Display, Queue Display, Back Office, Member & Loyalty และพิมพ์ผ่านเครื่องพิมพ์ ESC/POS จริง ทุกหน้าจอใช้ฟอนต์ **Sarabun** (หน้าสมาชิกใช้ **Sukhumvit**) ใบเสร็จและใบครัวพิมพ์ด้วย Sarabun แบบ Bitmap

## เริ่มใช้งาน

```bash
npm install
npm run build        # build หน้าเว็บ (React + Vite) → client/dist
npm start            # http://localhost:3000
```

เปิด `http://<เครื่องเซิร์ฟเวอร์>:3000` แล้วทำตามขั้นตอน

1. **ตั้งค่าร้านครั้งแรก**: ชื่อร้าน สาขา บัญชี Owner (Employee Code + PIN) เลือกสร้างเมนูตัวอย่างได้
2. **ลงทะเบียนอุปกรณ์**: เปิดเว็บบนแต่ละเครื่อง แล้วเลือกประเภท POS / KDS / Customer Display / Queue Display
3. **เข้าสู่ระบบ**: Employee Code + PIN หรือเลือกชื่อพนักงาน + PIN
4. **ตั้งค่าเครื่องพิมพ์**: หลังร้าน › เครื่องพิมพ์ แล้วจับคู่ Bluetooth/USB ที่แท็บ "เชื่อมต่อกับเครื่องนี้"

| Environment | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|
| `PORT` | 3000 | พอร์ตเซิร์ฟเวอร์ |
| `DATA_DIR` | `./data` | ฐานข้อมูล SQLite และไฟล์ Backup |
| `PUBLIC_URL` | – | URL สาธารณะสำหรับ QR สะสมแต้มท้ายใบเสร็จ (ตั้งในหน้าตั้งค่าได้) |
| `SESSION_HOURS` | 12 | อายุ Session พนักงาน |
| `SERVER_PRINTING` | 1 | ให้เซิร์ฟเวอร์พิมพ์ไปยังเครื่องพิมพ์ LAN โดยตรง |
| `TRUST_PROXY` | loopback | ตั้งเมื่ออยู่หลัง Reverse proxy |

> Web Bluetooth / WebUSB / Web Serial ต้องเปิดผ่าน **HTTPS** หรือ `localhost` และใช้ได้บน Chrome / Edge (Desktop, Android)
> ถ้าใช้บน LAN ให้ตั้ง HTTPS ด้วย reverse proxy (เช่น Caddy) หรือใช้ Local Print Bridge แทน

```bash
npm test             # integration test (API flow) + unit test ของ engine ที่ใช้ร่วมกัน
```

## สถาปัตยกรรม

```
client/   React SPA: POS · KDS · Customer/Queue Display · Back Office · Member App · Service Worker
server/   Express + Socket.IO + SQLite (better-sqlite3, WAL)
shared/   โค้ดที่ใช้ร่วมกันทั้ง client และ server
  calc.js        Calculation Engine กลาง  Subtotal → Discount → Service Charge → VAT → Grand Total
  promotions.js  Promotion Engine (BOGO, ซื้อ X ลด %, ครบ X ลด Y, Bundle, Happy Hour, Member Price, Coupon, Double/Bonus Point)
  points.js      สูตรสะสมแต้ม / Tier
  kitchen.js     ระบบตัดใบครัว (Cut After / Cut Before / Separate / Each Qty) + เลขใบย่อย + เลขสำเนา
  render.js      วาดใบเสร็จ/ใบครัว/รายงานกะ ด้วย Sarabun ลง Canvas
  escpos.js      ESC/POS raster (GS v 0), Paper Cut, Cash Drawer, TIS-620
  codes.js       QR, Code128, PromptPay (EMVCo Dynamic QR)
bridge/   Local Print Bridge สำหรับเครื่องพิมพ์ในร้านเมื่อเซิร์ฟเวอร์อยู่บน Cloud
```

* **ราคาและยอดรวม** ฝั่งเซิร์ฟเวอร์คำนวณใหม่จากฐานข้อมูลเสมอ ไม่เชื่อราคาจาก Client และทุกหน้าจอ (POS, จอลูกค้า, ใบเสร็จ, Dashboard, Report) ใช้ `shared/calc.js` ตัวเดียวกัน
* **การชำระเงิน** ทำใน Transaction เดียว ตามลำดับ Validate → Permission → Payment → Transaction → Paid → Receipt → Inventory → Points → Print Jobs → Commit ใช้ Idempotency-Key กันกดซ้ำหรือจ่ายซ้ำ และถ้าพิมพ์ไม่สำเร็จ การชำระเงินจะไม่ถูกทำซ้ำ
* **Real-time**: Socket.IO แยก room ตามสาขา อุปกรณ์ และสมาชิก ครอบคลุม POS ↔ KDS ↔ Customer Display ↔ Queue Display ↔ Dashboard ↔ Member App
* **Offline Mode**: Service Worker เก็บหน้าเว็บ, IndexedDB เก็บ Catalog, บิล และ Outbox ระหว่างออฟไลน์ระบบพิมพ์ใบครัว/ใบเสร็จผ่านเครื่องพิมพ์ที่ต่อกับเครื่อง POS นั้นโดยตรง เมื่อกลับมาออนไลน์จะ Sync อัตโนมัติ ใช้ UUID ของ Order/Item และ Idempotency-Key จึงไม่เกิด Order ซ้ำ สถานะแสดงเป็น 🟢 Online / 🟠 Syncing / 🔴 Offline
* **Security**: PIN และรหัสผ่านเก็บแบบ scrypt hash, Session token เก็บแบบ hash, RBAC + Permission รายคน, Manager Approval (token ใช้ครั้งเดียว), Rate limiting, ตรวจสอบ Input ด้วย zod, Helmet CSP และ Audit Log ทุกการกระทำสำคัญ

## การพิมพ์

| ช่องทาง | วิธีทำงาน |
|---|---|
| Bluetooth BLE | Web Bluetooth (Chrome Desktop/Android) จับคู่และพิมพ์จากเครื่อง POS ที่ผูกไว้ |
| Bluetooth Classic (SPP) | Web Serial แบบ RFCOMM (Chrome Desktop) หรือเลือก COM port ที่ Pair แล้ว |
| USB | WebUSB (bulk endpoint, printer class) |
| Serial | Web Serial |
| LAN / Network | เซิร์ฟเวอร์ส่ง RAW TCP 9100 โดยตรง |
| Local Print Bridge | `node bridge/index.js` บนคอมพิวเตอร์ในร้าน รองรับ LAN และ USB/Serial device file |

* ทุกงานพิมพ์ต้องเข้า **Print Queue** (สถานะ Waiting / Printing / Printed / Failed / Cancelled) ทำ Retry / Cancel / Reprint ได้ โดยใช้เอกสารเดิม ไม่สร้าง Order หรือ Payment ใหม่
* เอกสารทุกใบ render ด้วย **Sarabun เป็น Bitmap** แล้วส่งผ่าน ESC/POS raster จึงพิมพ์ภาษาไทยได้กับเครื่องพิมพ์ทุกรุ่น (มีโหมด Text code page สำรองไว้ด้วย)
* **ตัดใบครัวตามสินค้า**: เมื่อพบสินค้าที่ตั้งค่าไว้ ระบบจะจบใบปัจจุบันแล้วสั่ง Paper Cut จริง ทุกใบย่อยมีหัว `Q011 / ใบย่อยที่ 1/3` และ `สำเนา 1/2` ทั้งหมดอ้างอิง Order เดียวกัน
* เมื่อสั่งเพิ่มหลังส่งครัวแล้ว ระบบพิมพ์เฉพาะรายการใหม่ พร้อมแถบ **รายการเพิ่ม / NEW ITEM**
* ตั้งจำนวนใบเสร็จได้ 0 / 1 / 2 / 3 / Custom ทุกสำเนาใช้เลขใบเสร็จเดียวกัน ตั้งจำนวนใบครัวแยกตาม Station/Printer ได้ (0 = ใช้ KDS อย่างเดียว)
* Paper Cut ตั้งเป็น Full / Partial และกำหนดจำนวนบรรทัด Feed ได้ ถ้าเครื่องไม่มี Cutter ระบบจะ Feed กระดาษแทนการตัด และเปิด Cash Drawer ด้วยคำสั่ง ESC/POS ได้

### Local Print Bridge

```bash
node bridge/index.js register --server https://pos.example.com --code EMP001 --pin 1234 --branch 1 --name BRIDGE-01
node bridge/index.js
```
แล้วเพิ่มเครื่องพิมพ์ชนิด "Local Print Bridge" ที่อยู่ `tcp://192.168.1.50:9100` หรือ `/dev/usb/lp0`

## Member & Loyalty

* หน้าสมาชิก `/m` (มือถือเป็นหลัก) ใช้สมัครและเข้าสู่ระบบด้วยเบอร์โทร + PIN ดูแต้มและ Tier, แลก Reward แล้วได้ Redemption Code พร้อม Barcode/QR, ดูประวัติ, Member Card และรับสิทธิ์วันเกิด
* สะสมแต้มได้ 3 วิธี: QR ท้ายใบเสร็จ (`/m/claim/<token>` ใช้ได้ครั้งเดียว), พนักงานกรอกเบอร์ที่ POS และลูกค้ากรอกเบอร์เองที่ Customer Display
* Point Ledger แยกประเภท EARN / REDEEM / BONUS / BIRTHDAY / ADJUSTMENT / REFUND / EXPIRED ทุกรายการมี Transaction ID ไม่ซ้ำ แต้มหมดอายุแบบ FIFO และเมื่อ Refund ระบบหักแต้มคืนตามสัดส่วน (เลือกได้ว่าให้ติดลบหรือเป็น Point Debt)
* แจ้งเตือนสมาชิกผ่าน In-app (Real-time), Email (SMTP), SMS (HTTP gateway) และ LINE Messaging API

## Backup

มี Backup อัตโนมัติรายวัน (SQLite online backup), Backup ด้วยตนเอง, Restore (ระบบสำรองข้อมูลก่อน Restore ให้อัตโนมัติ) และ Export Data เป็น JSON ใช้ได้เฉพาะ Owner/Admin

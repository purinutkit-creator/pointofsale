-- ─────────────────────────────────────────────────────────────────────────
-- POS + Loyalty schema (SQLite, WAL). Money = REAL baht rounded to 2 decimals
-- (all arithmetic is done in satang by shared/calc.js). Timestamps = UTC.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE branches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  address       TEXT, phone TEXT, tax_id TEXT, tax_branch TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  receipt_prefix TEXT NOT NULL DEFAULT 'R',
  queue_prefix  TEXT NOT NULL DEFAULT 'Q',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- key/value settings, branch_id NULL = global default, otherwise branch override
CREATE TABLE settings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER REFERENCES branches(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_settings_scope ON settings(IFNULL(branch_id, 0), key);

CREATE TABLE roles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  level      INTEGER NOT NULL DEFAULT 10,
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE permissions (
  key        TEXT PRIMARY KEY,
  group_key  TEXT NOT NULL,
  label      TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE staff (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_code  TEXT NOT NULL COLLATE NOCASE,
  first_name     TEXT NOT NULL,
  last_name      TEXT,
  nickname       TEXT,
  photo_url      TEXT,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  branch_id      INTEGER REFERENCES branches(id),
  all_branches   INTEGER NOT NULL DEFAULT 0,
  phone          TEXT, email TEXT,
  start_date     TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  max_discount_pct REAL NOT NULL DEFAULT 0,
  note           TEXT,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_staff_code ON staff(employee_code) WHERE deleted_at IS NULL;
CREATE INDEX ix_staff_branch ON staff(branch_id, status);

-- credentials (never plain text: scrypt hashes)
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id        INTEGER NOT NULL UNIQUE REFERENCES staff(id) ON DELETE CASCADE,
  pin_hash        TEXT NOT NULL,
  password_hash   TEXT,
  pin_changed_at  TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE staff_permissions (
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  allowed    INTEGER NOT NULL,
  PRIMARY KEY (staff_id, permission)
);

CREATE TABLE pos_devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id    INTEGER NOT NULL REFERENCES branches(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'pos' CHECK (type IN ('pos','kds','customer_display','queue_display','bridge','member_kiosk')),
  token_hash   TEXT NOT NULL UNIQUE,
  config       TEXT NOT NULL DEFAULT '{}',
  paired_pos_id INTEGER REFERENCES pos_devices(id),
  station_id   INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  last_ip      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_device_code ON pos_devices(branch_id, code);

CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  device_id   INTEGER REFERENCES pos_devices(id),
  branch_id   INTEGER REFERENCES branches(id),
  ip          TEXT, user_agent TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX ix_sessions_staff ON sessions(staff_id);

CREATE TABLE shifts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id      INTEGER NOT NULL REFERENCES branches(id),
  device_id      INTEGER REFERENCES pos_devices(id),
  staff_id       INTEGER NOT NULL REFERENCES staff(id),
  closed_by      INTEGER REFERENCES staff(id),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opening_cash   REAL NOT NULL DEFAULT 0,
  expected_cash  REAL, actual_cash REAL, difference REAL,
  summary        TEXT,
  note           TEXT,
  opened_at      TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at      TEXT
);
CREATE INDEX ix_shifts_open ON shifts(branch_id, status);

CREATE TABLE cash_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  shift_id    INTEGER REFERENCES shifts(id),
  device_id   INTEGER REFERENCES pos_devices(id),
  staff_id    INTEGER NOT NULL REFERENCES staff(id),
  type        TEXT NOT NULL CHECK (type IN ('cash_in','cash_out','no_sale')),
  amount      REAL NOT NULL DEFAULT 0,
  reason      TEXT,
  approval_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_cash_shift ON cash_movements(shift_id);

-- ── Catalog ──────────────────────────────────────────────────────────────
CREATE TABLE kitchen_stations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER REFERENCES branches(id),
  name       TEXT NOT NULL,
  code       TEXT NOT NULL,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE printers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id     INTEGER NOT NULL REFERENCES branches(id),
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'kitchen' CHECK (role IN ('receipt','kitchen','label','report')),
  connection    TEXT NOT NULL CHECK (connection IN ('ble','bt_classic','usb','serial','lan','bridge')),
  host_device_id INTEGER REFERENCES pos_devices(id),
  address       TEXT,                    -- LAN ip:port / bridge printer name / BT device id
  paper         TEXT NOT NULL DEFAULT '80' CHECK (paper IN ('58','80')),
  dots_width    INTEGER,
  render_mode   TEXT NOT NULL DEFAULT 'raster' CHECK (render_mode IN ('raster','text')),
  codepage      INTEGER NOT NULL DEFAULT 255,
  has_cutter    INTEGER NOT NULL DEFAULT 1,
  cut_type      TEXT NOT NULL DEFAULT 'partial' CHECK (cut_type IN ('full','partial')),
  feed_lines    INTEGER NOT NULL DEFAULT 4,
  has_drawer    INTEGER NOT NULL DEFAULT 0,
  drawer_pin    INTEGER NOT NULL DEFAULT 0,
  beep          INTEGER NOT NULL DEFAULT 0,
  kitchen_copies INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected','printing','error')),
  status_message TEXT,
  status_at     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  name_en     TEXT,
  color       TEXT,
  image_url   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  station_id  INTEGER REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  printer_id  INTEGER REFERENCES printers(id) ON DELETE SET NULL,
  sc_exempt   INTEGER NOT NULL DEFAULT 0,
  point_multiplier REAL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT COLLATE NOCASE,
  barcode       TEXT,
  name          TEXT NOT NULL,
  name_en       TEXT,
  description   TEXT,
  image_url     TEXT,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  price         REAL NOT NULL DEFAULT 0,
  cost          REAL NOT NULL DEFAULT 0,
  vat_exempt    INTEGER NOT NULL DEFAULT 0,
  sc_exempt     INTEGER NOT NULL DEFAULT 0,
  track_stock   INTEGER NOT NULL DEFAULT 0,
  min_stock     REAL NOT NULL DEFAULT 0,
  auto_sold_out INTEGER NOT NULL DEFAULT 1,
  station_id    INTEGER REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  printer_id    INTEGER REFERENCES printers(id) ON DELETE SET NULL,
  cut_mode      TEXT NOT NULL DEFAULT 'none' CHECK (cut_mode IN ('none','cut_after','cut_before','separate','each_qty')),
  point_multiplier REAL,
  no_promotion  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','sold_out','unavailable')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_products_sku ON products(sku) WHERE sku IS NOT NULL AND sku <> '' AND deleted_at IS NULL;
CREATE INDEX ix_products_barcode ON products(barcode);
CREATE INDEX ix_products_category ON products(category_id);

-- per-branch price / availability override
CREATE TABLE product_branches (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  price      REAL,
  status     TEXT CHECK (status IN ('available','sold_out','unavailable')),
  hidden     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, branch_id)
);

CREATE TABLE product_variants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price_delta REAL NOT NULL DEFAULT 0,
  sku        TEXT, barcode TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_variants_product ON product_variants(product_id);

CREATE TABLE modifier_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  required    INTEGER NOT NULL DEFAULT 0,
  multiple    INTEGER NOT NULL DEFAULT 0,
  min_select  INTEGER NOT NULL DEFAULT 0,
  max_select  INTEGER NOT NULL DEFAULT 1,
  allow_qty   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);

CREATE TABLE modifiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price       REAL NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_modifiers_group ON modifiers(group_id);

CREATE TABLE product_modifier_groups (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_id   INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id)
);

-- ── Tables ───────────────────────────────────────────────────────────────
CREATE TABLE zones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER NOT NULL REFERENCES branches(id),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tables (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER NOT NULL REFERENCES branches(id),
  zone_id    INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  number     TEXT NOT NULL,
  seats      INTEGER NOT NULL DEFAULT 4,
  shape      TEXT NOT NULL DEFAULT 'square' CHECK (shape IN ('square','round','rect')),
  pos_x      REAL NOT NULL DEFAULT 0, pos_y REAL NOT NULL DEFAULT 0,
  width      REAL NOT NULL DEFAULT 90, height REAL NOT NULL DEFAULT 90,
  manual_status TEXT CHECK (manual_status IN ('reserved','cleaning')),
  reserved_note TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_tables_number ON tables(branch_id, number) WHERE active = 1;

-- ── Members & Loyalty ───────────────────────────────────────────────────
CREATE TABLE member_tiers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  min_points    INTEGER NOT NULL DEFAULT 0,
  max_points    INTEGER,
  color         TEXT NOT NULL DEFAULT '#9CA3AF',
  icon          TEXT,
  badge_url     TEXT,
  benefits      TEXT,
  discount_pct  REAL NOT NULL DEFAULT 0,
  point_multiplier REAL NOT NULL DEFAULT 1,
  birthday_reward_id INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tier_rules (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tier_id  INTEGER NOT NULL REFERENCES member_tiers(id) ON DELETE CASCADE,
  type     TEXT NOT NULL CHECK (type IN ('total_spend','visits','points','period_spend')),
  value    REAL NOT NULL,
  days     INTEGER
);

CREATE TABLE members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code   TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  gender        TEXT CHECK (gender IN ('male','female','other','unspecified')),
  birthday      TEXT,
  email         TEXT,
  line_user_id  TEXT,
  pin_hash      TEXT,
  tier_id       INTEGER REFERENCES member_tiers(id),
  tier_locked   INTEGER NOT NULL DEFAULT 0,
  points        INTEGER NOT NULL DEFAULT 0,
  point_debt    INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  total_spend   REAL NOT NULL DEFAULT 0,
  visit_count   INTEGER NOT NULL DEFAULT 0,
  last_visit_at TEXT,
  join_branch_id INTEGER REFERENCES branches(id),
  accepted_terms_at TEXT,
  notify_channels TEXT NOT NULL DEFAULT '["inapp"]',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_members_name ON members(name);

-- point lots (for FIFO expiry). member_points.remaining is consumed by REDEEM/REFUND/EXPIRED
CREATE TABLE member_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  source_tx_id INTEGER,
  points     INTEGER NOT NULL,
  remaining  INTEGER NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_member_points_fifo ON member_points(member_id, remaining, expires_at);

CREATE TABLE point_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id      TEXT NOT NULL UNIQUE,          -- idempotency / unique transaction id
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('EARN','REDEEM','BONUS','BIRTHDAY','ADJUSTMENT','REFUND','EXPIRED')),
  points      INTEGER NOT NULL,              -- signed
  balance     INTEGER NOT NULL,
  order_id    TEXT,
  redemption_id INTEGER,
  branch_id   INTEGER REFERENCES branches(id),
  staff_id    INTEGER REFERENCES staff(id),
  device_id   INTEGER REFERENCES pos_devices(id),
  amount      REAL,                           -- spend amount related
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_point_tx_member ON point_transactions(member_id, created_at);
CREATE INDEX ix_point_tx_order ON point_transactions(order_id);

CREATE TABLE rewards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  description    TEXT,
  image_url      TEXT,
  type           TEXT NOT NULL CHECK (type IN ('discount_amount','discount_pct','free_product')),
  points_required INTEGER NOT NULL DEFAULT 0,
  discount_value REAL NOT NULL DEFAULT 0,
  max_discount   REAL,
  product_id     INTEGER REFERENCES products(id) ON DELETE SET NULL,
  total_quota    INTEGER,
  used_count     INTEGER NOT NULL DEFAULT 0,
  per_member_limit INTEGER,
  start_at       TEXT, end_at TEXT,
  code_valid_days INTEGER NOT NULL DEFAULT 30,
  branch_ids     TEXT NOT NULL DEFAULT '[]',
  tier_ids       TEXT NOT NULL DEFAULT '[]',
  product_ids    TEXT NOT NULL DEFAULT '[]',
  min_spend      REAL NOT NULL DEFAULT 0,
  combinable     INTEGER NOT NULL DEFAULT 1,
  is_birthday    INTEGER NOT NULL DEFAULT 0,
  hidden         INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reward_redemptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id       TEXT NOT NULL UNIQUE,
  code         TEXT NOT NULL,
  reward_id    INTEGER NOT NULL REFERENCES rewards(id),
  member_id    INTEGER NOT NULL REFERENCES members(id),
  campaign_id  INTEGER,
  points_used  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','cancelled')),
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  order_id     TEXT,
  used_by_staff_id INTEGER REFERENCES staff(id),
  used_device_id INTEGER REFERENCES pos_devices(id),
  used_branch_id INTEGER REFERENCES branches(id),
  created_via  TEXT NOT NULL DEFAULT 'member' CHECK (created_via IN ('member','pos','admin','birthday')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_redemption_code ON reward_redemptions(code);
CREATE INDEX ix_redemption_member ON reward_redemptions(member_id, status);

CREATE TABLE promotions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  image_url   TEXT,
  type        TEXT NOT NULL,
  rule        TEXT NOT NULL DEFAULT '{}',
  conditions  TEXT NOT NULL DEFAULT '{}',
  start_at    TEXT, end_at TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  stackable   INTEGER NOT NULL DEFAULT 1,
  auto_apply  INTEGER NOT NULL DEFAULT 1,
  show_member INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE birthday_campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  message     TEXT,
  image_url   TEXT,
  window_type TEXT NOT NULL DEFAULT 'month' CHECK (window_type IN ('day','3days','7days','month')),
  benefit     TEXT NOT NULL CHECK (benefit IN ('points','reward')),
  points      INTEGER NOT NULL DEFAULT 0,
  reward_id   INTEGER REFERENCES rewards(id),
  tier_ids    TEXT NOT NULL DEFAULT '[]',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE birthday_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES birthday_campaigns(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  redemption_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, member_id, year)
);

CREATE TABLE member_notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  channels    TEXT NOT NULL DEFAULT '[]',
  delivery    TEXT NOT NULL DEFAULT '{}',
  dedupe_key  TEXT UNIQUE,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_member_notif ON member_notifications(member_id, created_at);

CREATE TABLE member_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- ── Orders ───────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id             TEXT PRIMARY KEY,               -- client generated UUID (idempotent offline sync)
  order_no       TEXT NOT NULL,
  queue_no       TEXT,
  business_date  TEXT NOT NULL,
  branch_id      INTEGER NOT NULL REFERENCES branches(id),
  device_id      INTEGER REFERENCES pos_devices(id),
  shift_id       INTEGER REFERENCES shifts(id),
  staff_id       INTEGER REFERENCES staff(id),
  type           TEXT NOT NULL CHECK (type IN ('dine_in','takeaway','delivery')),
  table_id       INTEGER REFERENCES tables(id),
  guests         INTEGER,
  customer_name  TEXT, customer_phone TEXT,
  member_id      INTEGER REFERENCES members(id),
  parent_order_id TEXT REFERENCES orders(id),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','held','paid','voided','refunded','partially_refunded','merged')),
  kitchen_status TEXT NOT NULL DEFAULT 'none' CHECK (kitchen_status IN ('none','new','preparing','ready','served')),
  note           TEXT,
  bill_discounts TEXT NOT NULL DEFAULT '[]',
  coupon_codes   TEXT NOT NULL DEFAULT '[]',
  sc_exempt      INTEGER NOT NULL DEFAULT 0,
  points_to_use  INTEGER NOT NULL DEFAULT 0,
  promotions     TEXT NOT NULL DEFAULT '[]',
  subtotal       REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  service_charge REAL NOT NULL DEFAULT 0,
  vat            REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  cost_total     REAL NOT NULL DEFAULT 0,
  calc           TEXT,
  paid_total     REAL NOT NULL DEFAULT 0,
  refunded_total REAL NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  offline        INTEGER NOT NULL DEFAULT 0,
  held_at        TEXT,
  sent_at        TEXT,
  paid_at        TEXT,
  voided_at      TEXT,
  ready_at       TEXT,
  called_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_orders_no ON orders(branch_id, business_date, order_no);
CREATE INDEX ix_orders_status ON orders(branch_id, status);
CREATE INDEX ix_orders_table ON orders(table_id, status);
CREATE INDEX ix_orders_paid ON orders(branch_id, paid_at);
CREATE INDEX ix_orders_member ON orders(member_id);
CREATE INDEX ix_orders_queue ON orders(branch_id, business_date, queue_no);

CREATE TABLE order_items (
  id             TEXT PRIMARY KEY,               -- client UUID
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL DEFAULT 0,
  product_id     INTEGER REFERENCES products(id),
  variant_id     INTEGER REFERENCES product_variants(id),
  name           TEXT NOT NULL,
  variant_name   TEXT,
  category_id    INTEGER,
  station_id     INTEGER,
  qty            REAL NOT NULL,
  base_price     REAL NOT NULL,
  variant_price  REAL NOT NULL DEFAULT 0,
  unit_price     REAL NOT NULL,
  price_override REAL,
  discounts      TEXT NOT NULL DEFAULT '[]',
  discount       REAL NOT NULL DEFAULT 0,
  line_total     REAL NOT NULL DEFAULT 0,
  unit_cost      REAL NOT NULL DEFAULT 0,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','voided')),
  kitchen_status TEXT NOT NULL DEFAULT 'new',
  reward_redemption_id INTEGER,
  refunded_qty   REAL NOT NULL DEFAULT 0,
  added_by       INTEGER REFERENCES staff(id),
  sent_at        TEXT,
  voided_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_order_items_order ON order_items(order_id, seq);
CREATE INDEX ix_order_items_product ON order_items(product_id);

CREATE TABLE order_item_modifiers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id   INTEGER REFERENCES modifiers(id),
  group_id      INTEGER,
  group_name    TEXT,
  name          TEXT NOT NULL,
  price         REAL NOT NULL DEFAULT 0,
  qty           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_oim_item ON order_item_modifiers(order_item_id);

CREATE TABLE order_members (
  order_id      TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  member_id     INTEGER NOT NULL REFERENCES members(id),
  points_before INTEGER NOT NULL DEFAULT 0,
  points_used   INTEGER NOT NULL DEFAULT 0,
  points_earned INTEGER NOT NULL DEFAULT 0,
  points_reversed INTEGER NOT NULL DEFAULT 0,
  tier_name     TEXT,
  attached_via  TEXT NOT NULL DEFAULT 'pos' CHECK (attached_via IN ('pos','display','claim','scan')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Kitchen ──────────────────────────────────────────────────────────────
CREATE TABLE kitchen_tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  station_id  INTEGER REFERENCES kitchen_stations(id),
  batch_no    INTEGER NOT NULL DEFAULT 1,          -- 1 = first send, >1 = additions
  is_addition INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'order' CHECK (kind IN ('order','void')),
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','served','voided')),
  sub_count   INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES staff(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT, ready_at TEXT, served_at TEXT
);
CREATE INDEX ix_kt_station ON kitchen_tickets(branch_id, station_id, status);
CREATE INDEX ix_kt_order ON kitchen_tickets(order_id);

CREATE TABLE kitchen_sub_tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES kitchen_tickets(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sub_index   INTEGER NOT NULL,
  sub_count   INTEGER NOT NULL,
  items       TEXT NOT NULL,                       -- snapshot for printing
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','served','voided')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ticket_id, sub_index)
);

CREATE TABLE kitchen_ticket_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_ticket_id INTEGER NOT NULL REFERENCES kitchen_sub_tickets(id) ON DELETE CASCADE,
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  qty           REAL NOT NULL,
  unit_index    INTEGER, unit_count INTEGER,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','served','voided')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_kti_sub ON kitchen_ticket_items(sub_ticket_id);
CREATE INDEX ix_kti_item ON kitchen_ticket_items(order_item_id);

-- station → printer routing (with copies per route); doc_type kitchen|receipt
CREATE TABLE printer_routes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  printer_id  INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  station_id  INTEGER REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL DEFAULT 'kitchen' CHECK (doc_type IN ('kitchen','receipt')),
  copies      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (printer_id, station_id, doc_type)
);

CREATE TABLE print_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_uid       TEXT NOT NULL UNIQUE,
  branch_id     INTEGER NOT NULL REFERENCES branches(id),
  printer_id    INTEGER REFERENCES printers(id) ON DELETE SET NULL,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('receipt','kitchen','kitchen_void','shift_report','test','drawer','slip')),
  station_id    INTEGER,
  sub_ticket_id INTEGER REFERENCES kitchen_sub_tickets(id) ON DELETE SET NULL,
  sub_index     INTEGER, sub_count INTEGER,
  copy_index    INTEGER NOT NULL DEFAULT 1, copy_count INTEGER NOT NULL DEFAULT 1,
  receipt_id    INTEGER,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','printing','printed','failed','cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  claimed_by    TEXT,
  claimed_at    TEXT,
  reprint_of    INTEGER REFERENCES print_jobs(id),
  created_by    INTEGER REFERENCES staff(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  printed_at    TEXT
);
CREATE INDEX ix_print_jobs_queue ON print_jobs(printer_id, status, id);
CREATE INDEX ix_print_jobs_branch ON print_jobs(branch_id, created_at);
CREATE INDEX ix_print_jobs_order ON print_jobs(order_id);

-- ── Payment ──────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  branch_id       INTEGER NOT NULL REFERENCES branches(id),
  shift_id        INTEGER REFERENCES shifts(id),
  device_id       INTEGER REFERENCES pos_devices(id),
  staff_id        INTEGER REFERENCES staff(id),
  total           REAL NOT NULL,
  received        REAL NOT NULL DEFAULT 0,
  change          REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded','partially_refunded')),
  result          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_payments_order ON payments(order_id);

CREATE TABLE payment_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  INTEGER REFERENCES payments(id),
  order_id    TEXT NOT NULL REFERENCES orders(id),
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  shift_id    INTEGER REFERENCES shifts(id),
  method      TEXT NOT NULL CHECK (method IN ('cash','qr','credit_card','debit_card','transfer','ewallet','other','points')),
  amount      REAL NOT NULL,                  -- negative for refunds
  tendered    REAL,
  reference   TEXT,
  kind        TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','refund')),
  refund_id   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_ptx_shift ON payment_transactions(shift_id, method);
CREATE INDEX ix_ptx_branch ON payment_transactions(branch_id, created_at);

CREATE TABLE receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no    TEXT NOT NULL UNIQUE,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  payment_id    INTEGER REFERENCES payments(id),
  branch_id     INTEGER NOT NULL REFERENCES branches(id),
  doc_type      TEXT NOT NULL DEFAULT 'receipt' CHECK (doc_type IN ('receipt','abb_tax_invoice','full_tax_invoice','credit_note')),
  customer      TEXT,
  payload       TEXT NOT NULL,
  total         REAL NOT NULL,
  claim_token   TEXT UNIQUE,
  claim_points  INTEGER NOT NULL DEFAULT 0,
  claim_status  TEXT CHECK (claim_status IN ('available','used','void')),
  claimed_member_id INTEGER REFERENCES members(id),
  claimed_at    TEXT,
  claim_expires_at TEXT,
  ref_receipt_id INTEGER REFERENCES receipts(id),
  print_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_receipts_order ON receipts(order_id);
CREATE INDEX ix_receipts_branch ON receipts(branch_id, created_at);

CREATE TABLE reprints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id  INTEGER NOT NULL REFERENCES receipts(id),
  staff_id    INTEGER NOT NULL REFERENCES staff(id),
  approval_id INTEGER,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Inventory ────────────────────────────────────────────────────────────
CREATE TABLE ingredients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT 'g',
  cost_per_unit REAL NOT NULL DEFAULT 0,
  min_stock   REAL NOT NULL DEFAULT 0,
  sku         TEXT,
  supplier_id INTEGER,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recipes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER REFERENCES products(id) ON DELETE CASCADE,
  variant_id   INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  modifier_id  INTEGER REFERENCES modifiers(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty          REAL NOT NULL
);
CREATE INDEX ix_recipes_product ON recipes(product_id);
CREATE INDEX ix_recipes_modifier ON recipes(modifier_id);

-- stock on hand per branch for products (track_stock) and ingredients
CREATE TABLE inventory (
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  item_type   TEXT NOT NULL CHECK (item_type IN ('product','ingredient')),
  item_id     INTEGER NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (branch_id, item_type, item_id)
);

CREATE TABLE stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  item_type   TEXT NOT NULL CHECK (item_type IN ('product','ingredient')),
  item_id     INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('in','out','sale','waste','adjust','refund','po_receive','void_return')),
  qty         REAL NOT NULL,                     -- signed
  balance     REAL NOT NULL,
  unit_cost   REAL NOT NULL DEFAULT 0,
  ref_type    TEXT, ref_id TEXT,
  reason      TEXT,
  staff_id    INTEGER REFERENCES staff(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_stock_mov_item ON stock_movements(branch_id, item_type, item_id, created_at);
CREATE INDEX ix_stock_mov_ref ON stock_movements(ref_type, ref_id);

CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  contact    TEXT, phone TEXT, email TEXT, address TEXT, tax_id TEXT, note TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE purchase_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no       TEXT NOT NULL UNIQUE,
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partial','received','cancelled')),
  note        TEXT,
  total       REAL NOT NULL DEFAULT 0,
  expected_at TEXT,
  created_by  INTEGER REFERENCES staff(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE purchase_order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id       INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_type   TEXT NOT NULL CHECK (item_type IN ('product','ingredient')),
  item_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  qty         REAL NOT NULL,
  received_qty REAL NOT NULL DEFAULT 0,
  unit_cost   REAL NOT NULL DEFAULT 0
);

CREATE TABLE waste (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  item_type   TEXT NOT NULL CHECK (item_type IN ('product','ingredient')),
  item_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  qty         REAL NOT NULL,
  unit_cost   REAL NOT NULL DEFAULT 0,
  cost        REAL NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL CHECK (reason IN ('expired','damaged','wrong_preparation','lost','other')),
  note        TEXT,
  staff_id    INTEGER REFERENCES staff(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Void / Refund / Approval / Audit ────────────────────────────────────
CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT NOT NULL UNIQUE,
  action        TEXT NOT NULL,
  requested_by  INTEGER NOT NULL REFERENCES staff(id),
  approved_by   INTEGER NOT NULL REFERENCES staff(id),
  order_id      TEXT,
  reason        TEXT,
  branch_id     INTEGER,
  device_id     INTEGER,
  used_at       TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE voids (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT REFERENCES order_items(id),
  scope         TEXT NOT NULL CHECK (scope IN ('item','order')),
  qty           REAL,
  amount        REAL NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL,
  staff_id      INTEGER NOT NULL REFERENCES staff(id),
  approval_id   INTEGER REFERENCES approvals(id),
  branch_id     INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_voids_branch ON voids(branch_id, created_at);

CREATE TABLE refunds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_no     TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  receipt_id    INTEGER REFERENCES receipts(id),
  branch_id     INTEGER NOT NULL REFERENCES branches(id),
  shift_id      INTEGER REFERENCES shifts(id),
  type          TEXT NOT NULL CHECK (type IN ('full','partial','item')),
  amount        REAL NOT NULL,
  method        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  restock       INTEGER NOT NULL DEFAULT 1,
  points_reversed INTEGER NOT NULL DEFAULT 0,
  staff_id      INTEGER NOT NULL REFERENCES staff(id),
  approval_id   INTEGER REFERENCES approvals(id),
  approved_by   INTEGER REFERENCES staff(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_refunds_branch ON refunds(branch_id, created_at);

CREATE TABLE refund_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id     INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  qty           REAL NOT NULL,
  amount        REAL NOT NULL
);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id   INTEGER,
  staff_id    INTEGER,
  device_id   INTEGER,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  details     TEXT,
  approved_by INTEGER,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_audit_time ON audit_logs(created_at);
CREATE INDEX ix_audit_action ON audit_logs(action, created_at);
CREATE INDEX ix_audit_entity ON audit_logs(entity, entity_id);

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id   INTEGER,
  kind        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','success','warning','error')),
  title       TEXT NOT NULL,
  body        TEXT,
  data        TEXT,
  dedupe_key  TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_notifications_branch ON notifications(branch_id, created_at);

-- daily counters (order no, queue no, receipt no …) per branch
CREATE TABLE sequences (
  branch_id INTEGER NOT NULL,
  name      TEXT NOT NULL,
  period    TEXT NOT NULL,
  value     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, name, period)
);

CREATE TABLE idempotency_keys (
  key         TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  response    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('auto','manual','pre_restore')),
  staff_id    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  ip         TEXT,
  success    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_login_attempts ON login_attempts(identifier, created_at);

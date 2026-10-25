-- DealerDoor schema (Cloudflare D1 / SQLite).
-- Extends the spec's section 7 model with auth, routes, consent records,
-- payments, audit and offline-sync tables. Deviations are listed in docs/05-BACKEND-SCHEMA.md.

CREATE TABLE crews (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lead_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  role TEXT CHECK (role IN ('customer','coworker','lead','office','admin')) NOT NULL,
  display_name TEXT,
  phone TEXT,
  locale TEXT DEFAULT 'en' CHECK (locale IN ('en','es')),
  crew_id TEXT REFERENCES crews(id),
  password_hash TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  refresh_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE devices (
  apns_token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  env TEXT DEFAULT 'production' CHECK (env IN ('sandbox','production')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE service_area (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  geojson TEXT NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  address_norm TEXT UNIQUE NOT NULL,
  zip TEXT,
  lat REAL,
  lng REAL,
  seatac_valid INTEGER DEFAULT 0,
  needs_review INTEGER DEFAULT 0,
  review_note TEXT,
  do_not_knock INTEGER DEFAULT 0,
  dnk_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_properties_review ON properties(needs_review);

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  coworker_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT REFERENCES users(id),
  route_date TEXT NOT NULL,
  permit_ref TEXT NOT NULL,
  status TEXT DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','completed')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_routes_coworker ON routes(coworker_id, route_date);

CREATE TABLE route_stops (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  property_id TEXT NOT NULL REFERENCES properties(id),
  sort_order INTEGER,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','knocked','skipped')),
  UNIQUE (route_id, property_id)
);

CREATE TABLE check_ins (
  id TEXT PRIMARY KEY,
  route_stop_id TEXT REFERENCES route_stops(id),
  property_id TEXT NOT NULL REFERENCES properties(id),
  coworker_id TEXT NOT NULL REFERENCES users(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  distance_m REAL,
  outcome TEXT CHECK (outcome IN ('no_answer','not_interested','interested','come_back')),
  photo_key TEXT,
  client_created_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_checkins_coworker ON check_ins(coworker_id, created_at);

CREATE TABLE consent_texts (
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tcpa','d2d_disclosure')),
  locale TEXT NOT NULL CHECK (locale IN ('en','es')),
  body TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  PRIMARY KEY (version, kind, locale)
);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  property_id TEXT REFERENCES properties(id),
  coworker_id TEXT REFERENCES users(id),
  customer_name TEXT,
  phone TEXT,
  email TEXT,
  product_interest TEXT,          -- JSON array of catalog kinds/skus
  status TEXT CHECK (status IN ('new','interested','appointment','order','not_serviceable','closed')),
  not_serviceable_reason TEXT,
  closed_reason TEXT,
  tcpa_consent_at TEXT,
  consent_text_version TEXT,
  disclosure_ack_at TEXT,
  signature_key TEXT,
  photo_key TEXT,
  client_created_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_leads_coworker ON leads(coworker_id, status);

-- Immutable consent evidence: timestamp, text version, rep, address.
CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL CHECK (kind IN ('tcpa','d2d_disclosure')),
  text_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  rep_id TEXT NOT NULL REFERENCES users(id),
  property_id TEXT REFERENCES properties(id),
  address_snapshot TEXT NOT NULL,
  signature_key TEXT,
  lat REAL,
  lng REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_consents_lead ON consents(lead_id);

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT DEFAULT 'install' CHECK (kind IN ('install','consult')),
  scheduled_at TEXT NOT NULL,
  window_end TEXT,
  status TEXT DEFAULT 'set' CHECK (status IN ('set','completed','no_show','cancelled')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_appointments_lead ON appointments(lead_id);

CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('internet','tv','bundle','addon')),
  name TEXT NOT NULL,
  name_es TEXT,
  speed_mbps INTEGER,
  monthly_price_cents INTEGER NOT NULL,
  promo_price_cents INTEGER,
  promo_months INTEGER,
  contract_months INTEGER DEFAULT 0,
  eligibility_notes TEXT,
  required_tech TEXT,              -- NULL = any covered address
  commission_cents INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

-- Serviceability by ZIP (and optionally street). Maintained by office from dealer portal data.
CREATE TABLE coverage (
  id TEXT PRIMARY KEY,
  zip TEXT NOT NULL,
  street_norm TEXT,
  tech TEXT NOT NULL,
  max_speed_mbps INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_coverage_zip ON coverage(zip);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  customer_id TEXT REFERENCES users(id),
  coworker_id TEXT REFERENCES users(id),
  bundle_json TEXT NOT NULL,        -- pricing snapshot at order time
  install_window_start TEXT,
  install_window_end TEXT,
  install_scheduled_at TEXT,
  install_completed_at TEXT,
  activated_at TEXT,
  att_order_ref TEXT,
  status TEXT CHECK (status IN ('submitted','scheduled','installed','activated','closed','cancelled')),
  cancelled_reason TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_coworker ON orders(coworker_id);

CREATE TABLE order_timeline (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  stage TEXT NOT NULL,
  status TEXT CHECK (status IN ('pending','in_progress','complete','delayed')),
  note_internal TEXT,
  note_customer TEXT,
  completed_at TEXT,
  sort_order INTEGER,
  updated_by TEXT REFERENCES users(id),
  UNIQUE (order_id, stage)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  payment_term_days INTEGER NOT NULL CHECK (payment_term_days IN (0,15,30,45,60)),
  due_date TEXT NOT NULL,
  status TEXT CHECK (status IN ('draft','sent','viewed','partial','paid','overdue')),
  processor_invoice_id TEXT,
  sent_at TEXT,
  viewed_at TEXT,
  paid_at TEXT,
  created_by TEXT REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status, due_date);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL,
  method TEXT CHECK (method IN ('card','ach')),
  processor_payment_id TEXT UNIQUE,
  status TEXT CHECK (status IN ('pending','succeeded','failed')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE invoice_reminders (
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  kind TEXT NOT NULL CHECK (kind IN ('T-3','T0','T+7','T+30')),
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (invoice_id, kind)
);

CREATE TABLE customer_feedback (
  id TEXT PRIMARY KEY,
  order_id TEXT UNIQUE REFERENCES orders(id),
  customer_id TEXT REFERENCES users(id),
  sales_rating INTEGER CHECK (sales_rating BETWEEN 1 AND 5),
  install_rating INTEGER CHECK (install_rating BETWEEN 1 AND 5),
  clarity_rating INTEGER CHECK (clarity_rating BETWEEN 1 AND 5),
  support_rating INTEGER CHECK (support_rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
  photo_key TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,                  -- internal only, never returned to customers
  moderated_by TEXT REFERENCES users(id),
  moderated_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Anonymous by default: user_hash = HMAC(secret, user_id) lets a coworker see their own
-- trend and blocks double-voting without storing who answered. user_id is set only on opt-in.
CREATE TABLE pulse_responses (
  id TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  crew_id TEXT REFERENCES crews(id),
  iso_week TEXT NOT NULL,
  workload_score INTEGER CHECK (workload_score BETWEEN 1 AND 5),
  safety_score INTEGER CHECK (safety_score BETWEEN 1 AND 5),
  support_score INTEGER CHECK (support_score BETWEEN 1 AND 5),
  anonymous INTEGER DEFAULT 1,
  followup_requested INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_hash, iso_week)
);

CREATE TABLE kudos (
  id TEXT PRIMARY KEY,
  from_user_id TEXT REFERENCES users(id),
  to_user_id TEXT REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  route_id TEXT REFERENCES routes(id),
  message TEXT CHECK (length(message) <= 280),
  created_at TEXT DEFAULT (datetime('now')),
  CHECK (order_id IS NOT NULL OR route_id IS NOT NULL),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX idx_kudos_to ON kudos(to_user_id);

CREATE TABLE commissions (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  coworker_id TEXT REFERENCES users(id),
  estimate_cents INTEGER NOT NULL,
  actual_cents INTEGER,
  status TEXT DEFAULT 'estimated' CHECK (status IN ('estimated','reconciled')),
  reconciled_by TEXT REFERENCES users(id),
  reconciled_at TEXT
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- Offline captures the server refused (e.g. do-not-knock hit) wait here for admin review.
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  entity TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

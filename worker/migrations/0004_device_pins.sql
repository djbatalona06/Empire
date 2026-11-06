-- Per-device PIN for quick sign-in. Each row belongs to one person and one device that has already signed in.
-- The PIN is stored as a salted PBKDF2 hash, never as typed. failed_attempts locks the device after five wrong tries.
CREATE TABLE device_pins (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  pin_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_device_pins_user ON device_pins(user_id);

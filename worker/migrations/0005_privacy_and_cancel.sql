-- Customer account deletion and cancellation requests. Additions only, so older code keeps working.

-- Set when a customer deletes their own account. The row stays (invoices and consent records point to it)
-- but the name, email, phone and password are blanked.
ALTER TABLE users ADD COLUMN deleted_at TEXT;

-- A customer asks to cancel inside the cooling-off window; office or admin approves with the existing cancel action.
ALTER TABLE orders ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE orders ADD COLUMN cancel_request_reason TEXT;

-- Business days (Mon-Fri) after the order is placed during which the customer can ask to cancel in the app.
-- Counsel confirms the right number for Washington / FTC rules (see docs/07-LAUNCH-CHECKLIST.md).
INSERT OR IGNORE INTO settings (key, value) VALUES ('cancel_window_business_days', '3');

-- Indexes for the lists and joins the back office uses all day (found in the scale audit).
-- Plain CREATE INDEX IF NOT EXISTS: safe to run on a database that already has data.

CREATE INDEX IF NOT EXISTS idx_leads_status_created ON leads(status, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated_at);
CREATE INDEX IF NOT EXISTS idx_leads_property ON leads(property_id);

CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_lead ON orders(lead_id);

CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE INDEX IF NOT EXISTS idx_feedback_status_created ON customer_feedback(status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_customer ON customer_feedback(customer_id);

CREATE INDEX IF NOT EXISTS idx_conflicts_status_created ON sync_conflicts(status, created_at);

CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
CREATE INDEX IF NOT EXISTS idx_users_crew ON users(crew_id);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at);

CREATE INDEX IF NOT EXISTS idx_checkins_property ON check_ins(property_id);

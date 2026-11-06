import { Hono } from 'hono';
import { BACKOFFICE, type AppEnv, type Role } from '../env';
import { requireAuth } from '../lib/auth';
import { audit, fail, toCsv } from '../lib/util';

// CSV downloads for office and admin. Leads and orders are not offered to team leads, because their normal
// list is limited to their own crew and this file is not.
const app = new Hono<AppEnv>();

const MAX_ROWS = 5000;

interface Export {
  roles: Role[];
  columns: string[];
  sql: string;
}

const EXPORTS: Record<string, Export> = {
  leads: {
    roles: ['office', 'admin'],
    columns: ['id', 'created_at', 'status', 'customer_name', 'phone', 'email', 'address', 'out_of_area', 'coworker', 'consent_text_version', 'tcpa_consent_at', 'disclosure_ack_at', 'closed_reason'],
    sql: `SELECT l.id, l.created_at, l.status, l.customer_name, l.phone, l.email, p.address, CASE WHEN p.seatac_valid = 1 THEN 'no' ELSE 'yes' END AS out_of_area,
            u.display_name AS coworker, l.consent_text_version, l.tcpa_consent_at, l.disclosure_ack_at, l.closed_reason
          FROM leads l JOIN properties p ON p.id = l.property_id LEFT JOIN users u ON u.id = l.coworker_id ORDER BY l.created_at DESC LIMIT ${MAX_ROWS}`,
  },
  orders: {
    roles: ['office', 'admin'],
    columns: ['id', 'created_at', 'status', 'customer', 'coworker', 'address', 'install_scheduled_at', 'activated_at', 'att_order_ref', 'cancelled_reason'],
    sql: `SELECT o.id, o.created_at, o.status, cu.display_name AS customer, cw.display_name AS coworker, p.address, o.install_scheduled_at, o.activated_at, o.att_order_ref, o.cancelled_reason
          FROM orders o LEFT JOIN leads l ON l.id = o.lead_id LEFT JOIN properties p ON p.id = l.property_id
          LEFT JOIN users cu ON cu.id = o.customer_id LEFT JOIN users cw ON cw.id = o.coworker_id ORDER BY o.created_at DESC LIMIT ${MAX_ROWS}`,
  },
  invoices: {
    roles: ['office', 'admin'],
    columns: ['id', 'order_id', 'customer', 'description', 'amount_dollars', 'paid_dollars', 'terms_days', 'due_date', 'status', 'sent_at', 'paid_at'],
    sql: `SELECT i.id, i.order_id, cu.display_name AS customer, i.description, i.amount_cents / 100.0 AS amount_dollars, i.amount_paid_cents / 100.0 AS paid_dollars,
            i.payment_term_days AS terms_days, i.due_date, i.status, i.sent_at, i.paid_at
          FROM invoices i LEFT JOIN users cu ON cu.id = i.customer_id ORDER BY i.due_date DESC LIMIT ${MAX_ROWS}`,
  },
  commissions: {
    roles: ['admin'],
    columns: ['order_id', 'coworker', 'estimate_dollars', 'actual_dollars', 'status', 'reconciled_at'],
    sql: `SELECT cm.order_id, u.display_name AS coworker, cm.estimate_cents / 100.0 AS estimate_dollars, cm.actual_cents / 100.0 AS actual_dollars, cm.status, cm.reconciled_at
          FROM commissions cm LEFT JOIN users u ON u.id = cm.coworker_id ORDER BY cm.status, cm.order_id LIMIT ${MAX_ROWS}`,
  },
};

app.get('/admin/export/:kind', requireAuth(...BACKOFFICE), async (c) => {
  const kind = c.req.param('kind');
  const spec = Object.hasOwn(EXPORTS, kind) ? EXPORTS[kind] : undefined;
  if (!spec) fail(404, 'unknown_export');
  const user = c.get('user');
  if (!spec!.roles.includes(user.role)) fail(403, 'forbidden');

  const { results } = await c.env.empire_accounts.prepare(spec!.sql).all<Record<string, unknown>>();
  await audit(c.env.empire_accounts, user.id, 'export.csv', kind, null, { rows: results.length }).run();

  const stamp = new Date().toISOString().slice(0, 10);
  return c.body(toCsv(spec!.columns, results), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="dealerdoor-${kind}-${stamp}.csv"`,
    'cache-control': 'no-store',
  });
});

export default app;

import { Hono } from 'hono';
import { BACKOFFICE, STAFF, type AppEnv, type AuthUser } from '../env';
import { requireAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import { pushToUser, sendEmail } from '../lib/notify';
import { audit, clientId, fail, isoDateTime, newId, oneOf, readJson, reqStr, str } from '../lib/util';

const app = new Hono<AppEnv>();

// Full internal lifecycle (spec 4.1). The first six are done by the time an order exists.
export const STAGES = [
  'route_assigned', 'door_knock', 'interest_captured', 'qualification', 'appointment_set',
  'order_submitted', 'install_scheduled', 'install_complete', 'activated', 'invoice_paid', 'closed',
] as const;
const DONE_AT_ORDER = 6;

// Customer view: Order received → Install scheduled → Installed → Activated → Feedback available.
const CUSTOMER_VIEW = [
  ['order_received', 'order_submitted'],
  ['install_scheduled', 'install_scheduled'],
  ['installed', 'install_complete'],
  ['activated', 'activated'],
  ['feedback_available', 'activated'],
] as const;

function orderScope(u: AuthUser): [string, unknown[]] {
  switch (u.role) {
    case 'customer': return ['o.customer_id = ?', [u.id]];
    case 'coworker': return ['o.coworker_id = ?', [u.id]];
    case 'lead': return ['(o.coworker_id = ? OR o.coworker_id IN (SELECT id FROM users WHERE crew_id = ?))', [u.id, u.crew_id]];
    default: return ['1 = 1', []];
  }
}

async function loadOrder(db: D1Database, u: AuthUser, id: string) {
  const [scope, args] = orderScope(u);
  return (
    (await db
      .prepare(`SELECT o.*, p.address FROM orders o LEFT JOIN leads l ON l.id = o.lead_id LEFT JOIN properties p ON p.id = l.property_id WHERE o.id = ? AND ${scope}`)
      .bind(id, ...args)
      .first<Record<string, unknown> & { id: string; customer_id: string; status: string; bundle_json: string }>()) ?? fail(404, 'order_not_found')
  );
}

type TimelineRow = { id: string; stage: string; status: string; note_internal: string | null; note_customer: string | null; completed_at: string | null; sort_order: number };

async function timeline(db: D1Database, orderId: string) {
  return (await db.prepare('SELECT * FROM order_timeline WHERE order_id = ? ORDER BY sort_order').bind(orderId).all<TimelineRow>()).results;
}

function customerTimeline(rows: TimelineRow[], order: Record<string, unknown>, locale: string) {
  const s = t(locale) as unknown as Record<string, string>;
  return CUSTOMER_VIEW.map(([key, stage]) => {
    const r = rows.find((x) => x.stage === stage)!;
    return {
      key,
      label: s[`stage_${key}`],
      status: r.status,
      completed_at: r.completed_at,
      note: r.note_customer,
      ...(key === 'install_scheduled' && { scheduled_for: order.install_scheduled_at }),
    };
  });
}

// ---- Orders --------------------------------------------------------------

app.post('/orders', requireAuth(...STAFF), async (c) => {
  const body = await readJson(c);
  const u = c.get('user');
  const id = clientId(body.id);
  const replay = await c.env.DB.prepare('SELECT id, status FROM orders WHERE id = ?').bind(id).first();
  if (replay) return c.json(replay);

  const leadScope = u.role === 'coworker' ? ' AND coworker_id = ?' : '';
  const lead = await c.env.DB.prepare(`SELECT * FROM leads WHERE id = ?${leadScope}`)
    .bind(reqStr(body, 'lead_id', { max: 64 }), ...(leadScope ? [u.id] : []))
    .first<{ id: string; coworker_id: string; customer_name: string; email: string | null; status: string; created_at: string }>();
  if (!lead) fail(404, 'lead_not_found');
  if (['order', 'closed', 'not_serviceable'].includes(lead!.status)) fail(409, 'lead_not_orderable', `Lead is ${lead!.status}`);
  if (!lead!.email) fail(422, 'customer_email_required', 'Add the customer email so they can sign in to track the order');

  const skus = Array.isArray(body.skus) ? [...new Set(body.skus.filter((s): s is string => typeof s === 'string'))] : [];
  if (!skus.length || skus.length > 10) fail(400, 'invalid_skus');
  const { results: items } = await c.env.DB.prepare(`SELECT * FROM catalog_items WHERE active = 1 AND sku IN (${skus.map(() => '?').join(',')})`)
    .bind(...skus)
    .all<{ sku: string; kind: string; name: string; monthly_price_cents: number; promo_price_cents: number | null; promo_months: number | null; contract_months: number; speed_mbps: number | null; commission_cents: number }>();
  if (items.length !== skus.length) fail(422, 'unknown_sku');
  if (!items.some((i) => i.kind === 'internet' || i.kind === 'bundle')) fail(422, 'internet_required', 'Orders need an internet plan or bundle');

  const windowStart = str(body, 'install_window_start', { optional: true, pattern: isoDateTime }) ?? null;
  const windowEnd = str(body, 'install_window_end', { optional: true, pattern: isoDateTime }) ?? null;
  const locale = oneOf(body, 'customer_locale', ['en', 'es'] as const, true) ?? 'en';
  const bundle = {
    items: items.map(({ commission_cents, ...i }) => i),
    monthly_total_cents: items.reduce((s, i) => s + (i.promo_price_cents ?? i.monthly_price_cents), 0),
    priced_at: new Date().toISOString(),
    notice: t(locale).att_billing_notice,
  };

  // Customer account keyed by email; staff accounts can't double as customers.
  let customer = await c.env.DB.prepare('SELECT id, role FROM users WHERE email = ?').bind(lead!.email).first<{ id: string; role: string }>();
  const stmts: D1PreparedStatement[] = [];
  if (!customer) {
    customer = { id: newId(), role: 'customer' };
    stmts.push(c.env.DB.prepare(`INSERT INTO users (id, email, role, display_name, locale) VALUES (?, ?, 'customer', ?, ?)`).bind(customer.id, lead!.email, lead!.customer_name, locale));
  } else if (customer.role !== 'customer') fail(409, 'email_belongs_to_staff');

  stmts.push(
    c.env.DB.prepare(`INSERT INTO orders (id, lead_id, customer_id, coworker_id, bundle_json, install_window_start, install_window_end, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`)
      .bind(id, lead!.id, customer.id, lead!.coworker_id, JSON.stringify(bundle), windowStart, windowEnd),
    ...STAGES.map((stage, i) =>
      c.env.DB.prepare(`INSERT INTO order_timeline (id, order_id, stage, status, completed_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)`).bind(
        newId(), id, stage, i < DONE_AT_ORDER ? 'complete' : 'pending',
        i < DONE_AT_ORDER ? (stage === 'interest_captured' ? lead!.created_at : new Date().toISOString()) : null, i,
      ),
    ),
    c.env.DB.prepare(`INSERT INTO commissions (order_id, coworker_id, estimate_cents) VALUES (?, ?, ?)`).bind(id, lead!.coworker_id, items.reduce((s, i) => s + i.commission_cents, 0)),
    c.env.DB.prepare(`UPDATE leads SET status = 'order', updated_at = datetime('now') WHERE id = ?`).bind(lead!.id),
  );
  await c.env.DB.batch(stmts);

  if (c.env.APP_STORE_URL) {
    c.executionCtx.waitUntil(
      sendEmail(c.env, lead!.email!, locale === 'es' ? 'Recibimos su pedido' : 'We received your order',
        locale === 'es'
          ? `Siga su instalación en la app DealerDoor: ${c.env.APP_STORE_URL}\nInicie sesión con este correo.\n\n${bundle.notice}`
          : `Track your install in the DealerDoor app: ${c.env.APP_STORE_URL}\nSign in with this email address.\n\n${bundle.notice}`),
    );
  }
  return c.json({ id, status: 'submitted', customer_id: customer.id, bundle }, 201);
});

app.get('/orders', requireAuth(), async (c) => {
  const [scope, args] = orderScope(c.get('user'));
  const status = c.req.query('status');
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.status, o.install_scheduled_at, o.activated_at, o.created_at, o.bundle_json, p.address, cu.display_name AS customer_name, cw.display_name AS coworker_name,
       (SELECT COUNT(*) FROM invoices WHERE order_id = o.id AND status NOT IN ('paid','draft')) AS open_invoices
     FROM orders o LEFT JOIN leads l ON l.id = o.lead_id LEFT JOIN properties p ON p.id = l.property_id
     LEFT JOIN users cu ON cu.id = o.customer_id LEFT JOIN users cw ON cw.id = o.coworker_id
     WHERE ${scope} ${status ? 'AND o.status = ?' : ''} ORDER BY o.created_at DESC LIMIT 200`,
  )
    .bind(...args, ...(status ? [status] : []))
    .all<{ bundle_json: string }>();
  return c.json(results.map(({ bundle_json, ...o }) => ({ ...o, bundle: JSON.parse(bundle_json) })));
});

app.get('/orders/:id', requireAuth(), async (c) => {
  const u = c.get('user');
  const order = await loadOrder(c.env.DB, u, c.req.param('id'));
  const rows = await timeline(c.env.DB, order.id);
  const { bundle_json, ...rest } = order;
  const base = { ...rest, bundle: JSON.parse(bundle_json), billing_notice: t(u.locale).att_billing_notice };
  if (u.role === 'customer') {
    const { coworker_id, lead_id, att_order_ref, ...pub } = base as Record<string, unknown>;
    return c.json({ ...pub, timeline: customerTimeline(rows, order, u.locale), feedback_unlocked: !!order.activated_at });
  }
  const commission = await c.env.DB.prepare('SELECT estimate_cents, actual_cents, status FROM commissions WHERE order_id = ?').bind(order.id).first();
  return c.json({ ...base, timeline: rows, commission });
});

app.get('/orders/:id/timeline', requireAuth(), async (c) => {
  const u = c.get('user');
  const order = await loadOrder(c.env.DB, u, c.req.param('id'));
  const rows = await timeline(c.env.DB, order.id);
  return c.json(u.role === 'customer' ? customerTimeline(rows, order, u.locale) : rows);
});

app.patch('/orders/:id', requireAuth(...BACKOFFICE), async (c) => {
  const u = c.get('user');
  const order = await loadOrder(c.env.DB, u, c.req.param('id'));
  const body = await readJson(c);
  const cancel = body.status === 'cancelled';
  const reason = str(body, 'cancelled_reason', { optional: true, max: 300 });
  if (cancel && !reason) fail(400, 'reason_required');
  if (cancel && ['activated', 'closed'].includes(order.status)) fail(409, 'cannot_cancel_active_order');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE orders SET att_order_ref = COALESCE(?, att_order_ref), install_window_start = COALESCE(?, install_window_start), install_window_end = COALESCE(?, install_window_end),
         status = CASE WHEN ? THEN 'cancelled' ELSE status END, cancelled_reason = COALESCE(?, cancelled_reason), updated_at = datetime('now') WHERE id = ?`,
    ).bind(str(body, 'att_order_ref', { optional: true, max: 64 }) ?? null, str(body, 'install_window_start', { optional: true, pattern: isoDateTime }) ?? null,
      str(body, 'install_window_end', { optional: true, pattern: isoDateTime }) ?? null, cancel ? 1 : 0, reason ?? null, order.id),
    audit(c.env.DB, u.id, cancel ? 'order.cancel' : 'order.update', 'order', order.id, body),
  ]);
  return c.json({ ok: true });
});

// ---- Timeline stage updates (office/admin) -------------------------------

const CUSTOMER_PUSH_STAGES = new Set(['install_scheduled', 'install_complete', 'activated']);

app.patch('/timeline/:id', requireAuth(...BACKOFFICE), async (c) => {
  const u = c.get('user');
  const row = await c.env.DB.prepare('SELECT t.*, o.customer_id, o.status AS order_status FROM order_timeline t JOIN orders o ON o.id = t.order_id WHERE t.id = ?')
    .bind(c.req.param('id'))
    .first<TimelineRow & { order_id: string; customer_id: string; order_status: string }>();
  if (!row) fail(404, 'stage_not_found');
  if (row!.order_status === 'cancelled') fail(409, 'order_cancelled');
  const body = await readJson(c);
  const status = oneOf(body, 'status', ['pending', 'in_progress', 'complete', 'delayed'] as const, true);
  const at = str(body, 'at', { optional: true, pattern: isoDateTime });
  const stage = row!.stage;

  if (status === 'complete' && stage !== 'invoice_paid') {
    // Stages complete in order; invoice payment may land any time but must precede closing.
    const open = await c.env.DB.prepare(`SELECT stage FROM order_timeline WHERE order_id = ? AND sort_order < ? AND status <> 'complete' AND (stage <> 'invoice_paid' OR ? = 'closed') LIMIT 1`)
      .bind(row!.order_id, row!.sort_order, stage)
      .first<{ stage: string }>();
    if (open) fail(409, 'previous_stage_open', `Complete "${open.stage}" first`);
  }
  if (stage === 'closed' && status === 'complete') {
    if (u.role !== 'admin') fail(403, 'admin_only');
    const comm = await c.env.DB.prepare('SELECT status FROM commissions WHERE order_id = ?').bind(row!.order_id).first<{ status: string }>();
    if (comm?.status !== 'reconciled') fail(409, 'commission_not_reconciled');
  }
  if (stage === 'install_scheduled' && status === 'complete' && !at) fail(400, 'at_required', 'Install date/time is required');

  // Completing these stages moves the order itself forward. ?1 = install time, ?2 = order id.
  const orderEffect: Record<string, string> = {
    install_scheduled: `status = 'scheduled', install_scheduled_at = ?1`,
    install_complete: `status = 'installed', install_completed_at = datetime('now')`,
    activated: `status = 'activated', activated_at = datetime('now')`,
    closed: `status = 'closed'`,
  };
  const stmts = [
    c.env.DB.prepare(
      `UPDATE order_timeline SET status = COALESCE(?, status), note_internal = COALESCE(?, note_internal), note_customer = COALESCE(?, note_customer),
         completed_at = CASE WHEN ? = 'complete' THEN datetime('now') WHEN ? IS NOT NULL THEN NULL ELSE completed_at END, updated_by = ? WHERE id = ?`,
    ).bind(status ?? null, str(body, 'note_internal', { optional: true, max: 1000 }) ?? null, str(body, 'note_customer', { optional: true, max: 500 }) ?? null,
      status ?? null, status ?? null, u.id, row!.id),
    audit(c.env.DB, u.id, 'timeline.update', 'order', row!.order_id, { stage, ...body }),
  ];
  const effect = status === 'complete' ? orderEffect[stage] : undefined;
  if (effect) stmts.push(c.env.DB.prepare(`UPDATE orders SET ${effect}, updated_at = datetime('now') WHERE id = ?2`).bind(at ?? null, row!.order_id));
  await c.env.DB.batch(stmts);

  if (status && CUSTOMER_PUSH_STAGES.has(stage) && (status === 'complete' || status === 'delayed')) {
    c.executionCtx.waitUntil(
      pushToUser(c.env, row!.customer_id, (loc) => {
        const s = t(loc);
        if (stage === 'activated' && status === 'complete') return { title: s.push_feedback_title, body: s.push_feedback_body, data: { order_id: row!.order_id, screen: 'feedback' } };
        const label = { install_scheduled: s.stage_install_scheduled, install_complete: s.stage_installed, activated: s.stage_activated }[stage]!;
        return { title: s.push_stage_title, body: s.push_stage_body(label), data: { order_id: row!.order_id, screen: 'timeline' } };
      }),
    );
  }
  return c.json(await c.env.DB.prepare('SELECT * FROM order_timeline WHERE id = ?').bind(row!.id).first());
});

export default app;

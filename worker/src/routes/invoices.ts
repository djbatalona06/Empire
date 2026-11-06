import { Hono } from 'hono';
import { BACKOFFICE, type AppEnv, type AuthUser } from '../env';
import { requireAuth } from '../lib/auth';
import { money, t } from '../lib/i18n';
import { pushToUser } from '../lib/notify';
import { applyPayment, createPaymentIntent, recomputeInvoice, verifyStripeSignature } from '../lib/payments';
import { addDays, audit, fail, newId, num, oneOf, readJson, reqNum, reqStr, str, todayPacific } from '../lib/util';

const app = new Hono<AppEnv>();

export const TERMS = [0, 15, 30, 45, 60] as const;

type Invoice = { id: string; order_id: string | null; customer_id: string; description: string; amount_cents: number; amount_paid_cents: number; payment_term_days: number; due_date: string; status: string; sent_at: string | null };

async function loadInvoice(db: D1Database, u: AuthUser, id: string) {
  const inv = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<Invoice>();
  // Customers only ever see their own sent invoices; drafts stay internal.
  if (!inv || (u.role === 'customer' && (inv.customer_id !== u.id || inv.status === 'draft'))) fail(404, 'invoice_not_found');
  return inv!;
}

function notifyInvoice(env: AppEnv['Bindings'], inv: Invoice) {
  return pushToUser(env, inv.customer_id, (loc) => ({
    title: t(loc).push_invoice_title,
    body: t(loc).push_invoice_body(money(inv.amount_cents - inv.amount_paid_cents), inv.due_date),
    data: { invoice_id: inv.id, screen: 'invoice' },
  }));
}

/** Terms clock starts when the invoice is sent (net terms from send date). */
const sendStmt = (db: D1Database, id: string, term: number) =>
  db.prepare(`UPDATE invoices SET status = 'sent', sent_at = datetime('now'), due_date = ?, updated_at = datetime('now') WHERE id = ?`).bind(addDays(todayPacific(), term), id);

app.post('/invoices', requireAuth(...BACKOFFICE), async (c) => {
  const u = c.get('user');
  const body = await readJson(c);
  const orderId = reqStr(body, 'order_id', { max: 64 });
  const order = await c.env.empire_accounts.prepare('SELECT id, customer_id, status FROM orders WHERE id = ?').bind(orderId).first<{ id: string; customer_id: string; status: string }>();
  if (!order) fail(404, 'order_not_found');
  if (order!.status === 'cancelled') fail(409, 'order_cancelled');
  const amount = reqNum(body, 'amount_cents', { min: 100, max: 10_000_000, int: true });
  const term = (num(body, 'payment_term_days', { int: true, optional: true }) ?? 30) as (typeof TERMS)[number];
  if (!TERMS.includes(term)) fail(400, 'invalid_term', 'Terms are 0, 15, 30, 45 or 60 days');
  const description = reqStr(body, 'description', { max: 300 });
  const id = newId();
  const stmts = [
    c.env.empire_accounts.prepare(`INSERT INTO invoices (id, order_id, customer_id, description, amount_cents, payment_term_days, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
      .bind(id, order!.id, order!.customer_id, description, amount, term, addDays(todayPacific(), term), u.id),
    audit(c.env.empire_accounts, u.id, 'invoice.create', 'invoice', id, { amount, term, description }),
  ];
  if (body.send === true) stmts.push(sendStmt(c.env.empire_accounts, id, term));
  await c.env.empire_accounts.batch(stmts);
  const inv = (await c.env.empire_accounts.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<Invoice>())!;
  if (inv.status === 'sent') c.executionCtx.waitUntil(notifyInvoice(c.env, inv));
  return c.json(inv, 201);
});

app.post('/invoices/:id/send', requireAuth(...BACKOFFICE), async (c) => {
  const u = c.get('user');
  const inv = await loadInvoice(c.env.empire_accounts, u, c.req.param('id'));
  if (inv.status !== 'draft') fail(409, 'already_sent');
  await c.env.empire_accounts.batch([sendStmt(c.env.empire_accounts, inv.id, inv.payment_term_days), audit(c.env.empire_accounts, u.id, 'invoice.send', 'invoice', inv.id)]);
  const sent = (await c.env.empire_accounts.prepare('SELECT * FROM invoices WHERE id = ?').bind(inv.id).first<Invoice>())!;
  c.executionCtx.waitUntil(notifyInvoice(c.env, sent));
  return c.json(sent);
});

// Edits are audited; amount can't drop below what's already paid.
app.patch('/invoices/:id', requireAuth(...BACKOFFICE), async (c) => {
  const u = c.get('user');
  const inv = await loadInvoice(c.env.empire_accounts, u, c.req.param('id'));
  if (inv.status === 'paid') fail(409, 'invoice_paid');
  const body = await readJson(c);
  const amount = num(body, 'amount_cents', { min: 100, max: 10_000_000, int: true, optional: true });
  const term = num(body, 'payment_term_days', { int: true, optional: true });
  if (term !== undefined && !TERMS.includes(term as 0)) fail(400, 'invalid_term');
  if (amount !== undefined && amount < inv.amount_paid_cents) fail(409, 'below_paid_amount');
  const base = inv.sent_at ? inv.sent_at.slice(0, 10) : todayPacific();
  const due = term !== undefined ? addDays(base, term) : inv.due_date;
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(`UPDATE invoices SET amount_cents = COALESCE(?, amount_cents), payment_term_days = COALESCE(?, payment_term_days), due_date = ?, description = COALESCE(?, description), updated_at = datetime('now') WHERE id = ?`)
      .bind(amount ?? null, term ?? null, due, str(body, 'description', { optional: true, max: 300 }) ?? null, inv.id),
    audit(c.env.empire_accounts, u.id, 'invoice.edit', 'invoice', inv.id, { before: { amount: inv.amount_cents, term: inv.payment_term_days }, after: body }),
  ]);
  // Status may change (e.g. new amount equals paid amount, or new due date un-overdues it).
  if (inv.status === 'overdue' && due >= todayPacific()) await c.env.empire_accounts.prepare(`UPDATE invoices SET status = CASE WHEN amount_paid_cents > 0 THEN 'partial' ELSE 'sent' END WHERE id = ?`).bind(inv.id).run();
  return c.json(await recomputeInvoice(c.env.empire_accounts, inv.id));
});

app.get('/invoices', requireAuth(), async (c) => {
  const u = c.get('user');
  const status = c.req.query('status');
  const where = u.role === 'customer' ? `i.customer_id = ? AND i.status <> 'draft'` : BACKOFFICE.includes(u.role) ? '1 = 1' : fail(403, 'forbidden');
  const { results } = await c.env.empire_accounts.prepare(
    `SELECT i.*, cu.display_name AS customer_name FROM invoices i LEFT JOIN users cu ON cu.id = i.customer_id
     WHERE ${where} ${status ? 'AND i.status = ?' : ''} ORDER BY i.due_date LIMIT 200`,
  )
    .bind(...(u.role === 'customer' ? [u.id] : []), ...(status ? [status] : []))
    .all();
  return c.json({ invoices: results, billing_notice: t(u.locale).att_billing_notice });
});

app.get('/invoices/:id', requireAuth(), async (c) => {
  const u = c.get('user');
  const inv = await loadInvoice(c.env.empire_accounts, u, c.req.param('id'));
  if (u.role === 'customer' && inv.status === 'sent') {
    await c.env.empire_accounts.prepare(`UPDATE invoices SET status = 'viewed', viewed_at = datetime('now') WHERE id = ? AND status = 'sent'`).bind(inv.id).run();
    inv.status = 'viewed';
  }
  const { results: payments } = await c.env.empire_accounts.prepare('SELECT id, amount_cents, method, status, created_at FROM payments WHERE invoice_id = ? ORDER BY created_at').bind(inv.id).all();
  return c.json({ ...inv, balance_cents: inv.amount_cents - inv.amount_paid_cents, payments, billing_notice: t(u.locale).att_billing_notice });
});

/**
 * Starts a payment. Returns the processor client secret for the iOS PaymentSheet, which tokenizes the
 * card/bank on device. The webhook (not this call) marks money as received.
 */
app.post('/invoices/:id/pay', requireAuth('customer'), async (c) => {
  const u = c.get('user');
  const inv = await loadInvoice(c.env.empire_accounts, u, c.req.param('id'));
  if (inv.status === 'paid') fail(409, 'invoice_paid');
  const body = await readJson(c);
  const method = oneOf(body, 'method', ['card', 'ach'] as const)!;
  const balance = inv.amount_cents - inv.amount_paid_cents;
  const amount = num(body, 'amount_cents', { int: true, min: Math.min(100, balance), max: balance, optional: true }) ?? balance;

  if (!c.env.STRIPE_SECRET_KEY) {
    // Sandbox without a processor: settle instantly so flows can be tested end to end.
    if (c.env.ENVIRONMENT === 'production') fail(500, 'processor_not_configured');
    const result = await applyPayment(c.env.empire_accounts, { invoiceId: inv.id, processorId: `mock_${newId()}`, amountCents: amount, method, status: 'succeeded' });
    return c.json({ mode: 'mock', invoice: result });
  }
  const intent = await createPaymentIntent(c.env, { amountCents: amount, method, invoiceId: inv.id, idempotencyKey: `${inv.id}:${amount}:${method}:${inv.amount_paid_cents}` });
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(`INSERT INTO payments (id, invoice_id, amount_cents, method, processor_payment_id, status) VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT(processor_payment_id) DO NOTHING`)
      .bind(newId(), inv.id, amount, method, intent.id),
    c.env.empire_accounts.prepare('UPDATE invoices SET processor_invoice_id = COALESCE(processor_invoice_id, ?) WHERE id = ?').bind(intent.id, inv.id),
  ]);
  return c.json({ mode: 'stripe', client_secret: intent.clientSecret, publishable_key: c.env.STRIPE_PUBLISHABLE_KEY, amount_cents: amount });
});

// Processor webhook: the only path that marks real payments as succeeded.
app.post('/webhooks/stripe', async (c) => {
  const payload = await c.req.text();
  if (!c.env.STRIPE_WEBHOOK_SECRET || !(await verifyStripeSignature(c.env.STRIPE_WEBHOOK_SECRET, c.req.header('stripe-signature'), payload))) fail(400, 'bad_signature');
  let event: { type: string; data: { object: { id: string; amount: number; currency?: string; metadata?: { invoice_id?: string; method?: string } } } };
  try {
    event = JSON.parse(payload);
  } catch {
    fail(400, 'bad_payload');
  }
  const pi = event!.data?.object;
  const status = ({ 'payment_intent.succeeded': 'succeeded', 'payment_intent.processing': 'pending', 'payment_intent.payment_failed': 'failed' } as const)[event!.type as 'payment_intent.succeeded'];
  const invoiceId = pi?.metadata?.invoice_id;
  if (status && invoiceId) {
    // A signed event is still checked against our own records, so a wrong id or amount in the metadata can't credit an invoice.
    const known = await c.env.empire_accounts.prepare('SELECT invoice_id, amount_cents FROM payments WHERE processor_payment_id = ?').bind(pi.id).first<{ invoice_id: string; amount_cents: number }>();
    const inv = await c.env.empire_accounts.prepare('SELECT amount_cents, amount_paid_cents FROM invoices WHERE id = ?').bind(invoiceId).first<{ amount_cents: number; amount_paid_cents: number }>();
    const balance = inv ? inv.amount_cents - inv.amount_paid_cents : 0;
    const matches = known ? known.invoice_id === invoiceId && known.amount_cents === pi.amount : pi.amount > 0 && pi.amount <= balance;
    if (!inv || (pi.currency && pi.currency.toLowerCase() !== 'usd') || !matches) {
      console.error(JSON.stringify({ level: 'error', msg: 'stripe_webhook_mismatch', payment: pi.id, invoiceId, amount: pi.amount, requestId: c.get('requestId') }));
      return c.json({ received: true, ignored: true });
    }
    await applyPayment(c.env.empire_accounts, { invoiceId, processorId: pi.id, amountCents: pi.amount, method: pi.metadata?.method === 'ach' ? 'ach' : 'card', status });
  }
  return c.json({ received: true });
});

export default app;

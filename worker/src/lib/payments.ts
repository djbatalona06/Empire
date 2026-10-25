import type { Env } from '../env';
import { hmac, safeEqual } from './crypto';
import { fail, newId, todayPacific } from './util';

// Card data never touches the Worker: the iOS PaymentSheet tokenizes it with the processor (PCI SAQ-A).
// We only create the PaymentIntent and store the processor's ids.

export async function createPaymentIntent(env: Env, p: { amountCents: number; method: 'card' | 'ach'; invoiceId: string; idempotencyKey: string }) {
  const form = new URLSearchParams({
    amount: String(p.amountCents),
    currency: 'usd',
    'payment_method_types[]': p.method === 'ach' ? 'us_bank_account' : 'card',
    'metadata[invoice_id]': p.invoiceId,
    'metadata[method]': p.method,
  });
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': p.idempotencyKey,
    },
    body: form,
  });
  const data = (await res.json()) as { id?: string; client_secret?: string; error?: { message: string } };
  if (!res.ok || !data.id) fail(502, 'processor_error', data.error?.message ?? 'Payment processor unavailable');
  return { id: data.id!, clientSecret: data.client_secret! };
}

/** Stripe-Signature: t=<ts>,v1=<hmac(secret, `${t}.${payload}`)>; rejects events older than 5 minutes. */
export async function verifyStripeSignature(secret: string, header: string | undefined, payload: string) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300 || !parts.v1) return false;
  return safeEqual(await hmac(secret, `${parts.t}.${payload}`), parts.v1);
}

/** Records a processor result once (idempotent on processor id) and recomputes the invoice. */
export async function applyPayment(
  db: D1Database,
  p: { invoiceId: string; processorId: string; amountCents: number; method: 'card' | 'ach'; status: 'pending' | 'succeeded' | 'failed' },
) {
  await db
    .prepare(
      `INSERT INTO payments (id, invoice_id, amount_cents, method, processor_payment_id, status) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(processor_payment_id) DO UPDATE SET status = excluded.status`,
    )
    .bind(newId(), p.invoiceId, p.amountCents, p.method, p.processorId, p.status)
    .run();
  return recomputeInvoice(db, p.invoiceId);
}

export async function recomputeInvoice(db: D1Database, invoiceId: string) {
  const inv = await db
    .prepare(
      `SELECT i.id, i.order_id, i.amount_cents, i.due_date, i.status,
        COALESCE((SELECT SUM(amount_cents) FROM payments WHERE invoice_id = i.id AND status = 'succeeded'), 0) AS paid
       FROM invoices i WHERE i.id = ?`,
    )
    .bind(invoiceId)
    .first<{ id: string; order_id: string | null; amount_cents: number; due_date: string; status: string; paid: number }>();
  if (!inv) return null;

  let status = inv.status;
  if (inv.paid >= inv.amount_cents) status = 'paid';
  else if (inv.paid > 0) status = inv.due_date < todayPacific() ? 'overdue' : 'partial';

  const stmts = [
    db
      .prepare(`UPDATE invoices SET amount_paid_cents = ?, status = ?, paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, datetime('now')) ELSE paid_at END, updated_at = datetime('now') WHERE id = ?`)
      .bind(inv.paid, status, status, inv.id),
  ];
  // Order's "dealer invoice paid" stage completes once every invoice on it is paid.
  if (status === 'paid' && inv.order_id) {
    stmts.push(
      db
        .prepare(
          `UPDATE order_timeline SET status = 'complete', completed_at = datetime('now')
           WHERE order_id = ? AND stage = 'invoice_paid' AND status <> 'complete'
             AND NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = ? AND id <> ? AND status <> 'paid')`,
        )
        .bind(inv.order_id, inv.order_id, inv.id),
    );
  }
  await db.batch(stmts);
  return { ...inv, status, amount_paid_cents: inv.paid };
}

import type { Env } from './env';
import { money, t } from './lib/i18n';
import { pushToUser } from './lib/notify';
import { daysBetween, todayPacific } from './lib/util';

// Reminder offsets relative to due date: T-3, T0, T+7, T+30.
const REMINDERS = [[-3, 'T-3'], [0, 'T0'], [7, 'T+7'], [30, 'T+30']] as const;

/** Picks the latest reminder whose day has arrived; earlier missed ones are skipped, never stacked. */
export function reminderFor(dueDate: string, today: string) {
  const days = daysBetween(dueDate, today);
  let pick: (typeof REMINDERS)[number][1] | null = null;
  for (const [offset, kind] of REMINDERS) if (days >= offset) pick = kind;
  return pick;
}

export async function runDaily(env: Env, now = new Date()) {
  const today = todayPacific(now);

  // 1. Unpaid invoices past their due date become overdue.
  await env.DB.prepare(`UPDATE invoices SET status = 'overdue', updated_at = datetime('now') WHERE status IN ('sent','viewed','partial') AND due_date < ?`).bind(today).run();

  // 2. Payment reminders, each kind at most once per invoice.
  const { results } = await env.DB.prepare(
    `SELECT id, customer_id, amount_cents, amount_paid_cents, due_date FROM invoices WHERE status IN ('sent','viewed','partial','overdue') AND due_date <= date(?, '+3 days')`,
  )
    .bind(today)
    .all<{ id: string; customer_id: string; amount_cents: number; amount_paid_cents: number; due_date: string }>();
  let sent = 0;
  for (const inv of results) {
    const kind = reminderFor(inv.due_date, today);
    if (!kind) continue;
    const res = await env.DB.prepare('INSERT INTO invoice_reminders (invoice_id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(inv.id, kind).run();
    if (!res.meta.changes) continue;
    sent++;
    const amount = money(inv.amount_cents - inv.amount_paid_cents);
    await pushToUser(env, inv.customer_id, (loc) => ({ title: t(loc).remind_title, body: t(loc).remind_body[kind](amount, inv.due_date), data: { invoice_id: inv.id, screen: 'invoice' } }));
  }

  // 3. Stale leads: no progress in N days → closed (keeps rep pipelines honest).
  const staleDays = Number((await env.DB.prepare(`SELECT value FROM settings WHERE key = 'stale_lead_days'`).first<{ value: string }>())?.value ?? 30);
  const stale = await env.DB.prepare(
    `UPDATE leads SET status = 'closed', closed_reason = 'stale: no activity', updated_at = datetime('now')
     WHERE status IN ('new','interested') AND updated_at < datetime('now', ?)`,
  )
    .bind(`-${staleDays} days`)
    .run();

  // 4. Expired auth artifacts.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM magic_links WHERE expires_at < datetime('now', '-1 day')`),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now') OR revoked_at < datetime('now', '-7 days')`),
  ]);

  // Pulse reminders are not pushed: the app shows a banner from GET /v1/pulse/status (spec 4.6).
  return { today, reminders_sent: sent, stale_leads_closed: stale.meta.changes };
}

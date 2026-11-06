import { Hono } from 'hono';
import { MANAGERS, STAFF, type AppEnv } from '../env';
import { requireAuth } from '../lib/auth';
import { pulseSecret } from '../lib/config';
import { hmac } from '../lib/crypto';
import { audit, fail, isoWeek, newId, oneOf, readJson, reqNum, reqStr, str } from '../lib/util';

const app = new Hono<AppEnv>();

// ---- Customer feedback (unlocked after activation) -----------------------

const rating = (b: Record<string, unknown>, k: string) => reqNum(b, k, { min: 1, max: 5, int: true });

app.post('/feedback/customer', requireAuth('customer'), async (c) => {
  const u = c.get('user');
  const body = await readJson(c);
  const order = await c.env.empire_accounts.prepare('SELECT id, activated_at FROM orders WHERE id = ? AND customer_id = ?').bind(reqStr(body, 'order_id', { max: 64 }), u.id).first<{ id: string; activated_at: string | null }>();
  if (!order) fail(404, 'order_not_found');
  if (!order!.activated_at) fail(409, 'feedback_locked', 'Feedback opens once your service is activated');
  const photo = str(body, 'photo_key', { optional: true, max: 200 });
  if (photo && !photo.startsWith(`feedback_photo/${u.id}/`)) fail(403, 'foreign_photo');
  const id = newId();
  const res = await c.env.empire_accounts.prepare(
    `INSERT INTO customer_feedback (id, order_id, customer_id, sales_rating, install_rating, clarity_rating, support_rating, comment, photo_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING`,
  )
    .bind(id, order!.id, u.id, rating(body, 'sales_rating'), rating(body, 'install_rating'), rating(body, 'clarity_rating'), rating(body, 'support_rating'),
      str(body, 'comment', { optional: true, max: 1000 }) ?? null, photo ?? null)
    .run();
  if (!res.meta.changes) fail(409, 'feedback_exists');
  return c.json({ id, status: 'pending' }, 201);
});

// Customers see their own feedback; admin_note is never selected here.
app.get('/feedback/customer/mine', requireAuth('customer'), async (c) => {
  const { results } = await c.env.empire_accounts.prepare(
    'SELECT id, order_id, sales_rating, install_rating, clarity_rating, support_rating, comment, status, created_at FROM customer_feedback WHERE customer_id = ? ORDER BY created_at DESC',
  )
    .bind(c.get('user').id)
    .all();
  return c.json(results);
});

/** Public aggregate: approved feedback only. */
app.get('/feedback/summary', requireAuth(), async (c) => {
  const row = await c.env.empire_accounts.prepare(
    `SELECT COUNT(*) AS count, ROUND(AVG(sales_rating), 2) AS sales, ROUND(AVG(install_rating), 2) AS install, ROUND(AVG(clarity_rating), 2) AS clarity,
       ROUND(AVG(support_rating), 2) AS support, ROUND(AVG((sales_rating + install_rating + clarity_rating + support_rating) / 4.0), 2) AS overall
     FROM customer_feedback WHERE status = 'approved'`,
  ).first();
  return c.json(row);
});

app.get('/feedback/customer', requireAuth(...MANAGERS), async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const { results } = await c.env.empire_accounts.prepare(
    `SELECT f.*, u.display_name AS customer_name, cw.display_name AS coworker_name FROM customer_feedback f
     LEFT JOIN users u ON u.id = f.customer_id LEFT JOIN orders o ON o.id = f.order_id LEFT JOIN users cw ON cw.id = o.coworker_id
     WHERE f.status = ? ORDER BY f.created_at DESC LIMIT 200`,
  )
    .bind(status)
    .all();
  return c.json(results);
});

app.patch('/feedback/customer/:id/status', requireAuth(...MANAGERS), async (c) => {
  const u = c.get('user');
  const body = await readJson(c);
  const status = oneOf(body, 'status', ['approved', 'rejected'] as const)!;
  const note = str(body, 'admin_note', { optional: true, max: 1000 });
  const [res] = await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(`UPDATE customer_feedback SET status = ?, admin_note = COALESCE(?, admin_note), moderated_by = ?, moderated_at = datetime('now') WHERE id = ?`).bind(status, note ?? null, u.id, c.req.param('id')),
    audit(c.env.empire_accounts, u.id, `feedback.${status}`, 'customer_feedback', c.req.param('id'), { note }),
  ]);
  if (!res.meta.changes) fail(404, 'feedback_not_found');
  return c.json({ ok: true });
});

// ---- Coworker pulse (anonymous by default) -------------------------------

const pulseHash = (secret: string, userId: string) => hmac(`pulse:${secret}`, userId);
const COWORKERS = STAFF.filter((r) => r !== 'office' && r !== 'admin');

/** Drives the in-app banner (pulse is never pushed after hours). */
app.get('/pulse/status', requireAuth(...STAFF), async (c) => {
  const week = isoWeek();
  const done = await c.env.empire_accounts.prepare('SELECT 1 FROM pulse_responses WHERE user_hash = ? AND iso_week = ?').bind(await pulseHash(pulseSecret(c.env), c.get('user').id), week).first();
  return c.json({ iso_week: week, due: !done, questions: ['workload_score', 'safety_score', 'support_score'] });
});

app.post('/pulse', requireAuth(...COWORKERS), async (c) => {
  const u = c.get('user');
  const body = await readJson(c);
  const anonymous = body.anonymous !== false;
  const followup = body.followup_requested === true;
  if (followup && anonymous) fail(400, 'followup_requires_name', 'Turn off anonymous to request a named follow-up');
  const res = await c.env.empire_accounts.prepare(
    `INSERT INTO pulse_responses (id, user_hash, user_id, crew_id, iso_week, workload_score, safety_score, support_score, anonymous, followup_requested)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_hash, iso_week) DO NOTHING`,
  )
    .bind(newId(), await pulseHash(pulseSecret(c.env), u.id), anonymous ? null : u.id, u.crew_id, isoWeek(),
      rating(body, 'workload_score'), rating(body, 'safety_score'), rating(body, 'support_score'), anonymous ? 1 : 0, followup ? 1 : 0)
    .run();
  if (!res.meta.changes) fail(409, 'already_submitted_this_week');
  return c.json({ ok: true }, 201);
});

// ---- Kudos -----------------------------------------------------------------

app.post('/kudos', requireAuth(...STAFF), async (c) => {
  const u = c.get('user');
  const body = await readJson(c);
  const to = reqStr(body, 'to_user_id', { max: 64 });
  if (to === u.id) fail(400, 'no_self_kudos');
  const orderId = str(body, 'order_id', { optional: true, max: 64 }) ?? null;
  const routeId = str(body, 'route_id', { optional: true, max: 64 }) ?? null;
  if (!orderId && !routeId) fail(400, 'order_or_route_required');
  const target = await c.env.empire_accounts.prepare(`SELECT 1 FROM users WHERE id = ? AND role IN ('coworker','lead','office','admin') AND active = 1`).bind(to).first();
  if (!target) fail(404, 'coworker_not_found');
  const id = newId();
  await c.env.empire_accounts.prepare('INSERT INTO kudos (id, from_user_id, to_user_id, order_id, route_id, message) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, u.id, to, orderId, routeId, reqStr(body, 'message', { max: 280 }))
    .run()
    .catch(() => fail(400, 'invalid_reference', 'Order or route not found'));
  return c.json({ id }, 201);
});

app.get('/coworkers', requireAuth(...STAFF), async (c) => {
  const { results } = await c.env.empire_accounts.prepare(`SELECT id, display_name, crew_id FROM users WHERE role IN ('coworker','lead') AND active = 1 ORDER BY display_name`).all();
  return c.json(results);
});

// ---- Scorecards ------------------------------------------------------------

const MIN_CREW_N = 3; // aggregates hide below this many responses so nobody can be singled out

const trendSql = (where: string) =>
  `SELECT iso_week, COUNT(*) AS n, ROUND(AVG(workload_score), 2) AS workload, ROUND(AVG(safety_score), 2) AS safety, ROUND(AVG(support_score), 2) AS support
   FROM pulse_responses WHERE ${where} AND created_at >= datetime('now', '-90 days') GROUP BY iso_week ORDER BY iso_week`;

app.get('/scorecards/me', requireAuth(...STAFF), async (c) => {
  const u = c.get('user');
  const [trend, kudos, sales] = await Promise.all([
    c.env.empire_accounts.prepare(trendSql('user_hash = ?')).bind(await pulseHash(pulseSecret(c.env), u.id)).all(),
    c.env.empire_accounts.prepare(`SELECT k.id, k.message, k.order_id, k.route_id, k.created_at, f.display_name AS from_name FROM kudos k LEFT JOIN users f ON f.id = k.from_user_id WHERE k.to_user_id = ? AND k.created_at >= datetime('now', '-90 days') ORDER BY k.created_at DESC`).bind(u.id).all(),
    salesStats(c.env.empire_accounts, 'coworker_id = ?', [u.id]),
  ]);
  return c.json({ trend: trend.results, kudos: kudos.results, sales });
});

app.get('/scorecards/crew', requireAuth(...STAFF), async (c) => {
  const u = c.get('user');
  if (!u.crew_id) return c.json({ crew_id: null, trend: [] });
  const { results } = await c.env.empire_accounts.prepare(trendSql('crew_id = ?')).bind(u.crew_id).all<{ n: number }>();
  return c.json({ crew_id: u.crew_id, trend: results.filter((r) => r.n >= MIN_CREW_N), min_responses: MIN_CREW_N });
});

/** Admin view: crew aggregates + named (opted-in) responses + per-person sales and kudos. */
app.get('/admin/scorecards', requireAuth('admin'), async (c) => {
  const [crews, named, people] = await Promise.all([
    c.env.empire_accounts.prepare(
      `SELECT cr.id, cr.name, COUNT(p.id) AS n, ROUND(AVG(p.workload_score), 2) AS workload, ROUND(AVG(p.safety_score), 2) AS safety, ROUND(AVG(p.support_score), 2) AS support
       FROM crews cr LEFT JOIN pulse_responses p ON p.crew_id = cr.id AND p.created_at >= datetime('now', '-90 days') GROUP BY cr.id ORDER BY cr.name`,
    ).all<{ n: number }>(),
    c.env.empire_accounts.prepare(
      `SELECT p.iso_week, p.workload_score, p.safety_score, p.support_score, p.followup_requested, u.id AS user_id, u.display_name
       FROM pulse_responses p JOIN users u ON u.id = p.user_id WHERE p.anonymous = 0 AND p.created_at >= datetime('now', '-90 days') ORDER BY p.created_at DESC`,
    ).all(),
    c.env.empire_accounts.prepare(
      `SELECT u.id, u.display_name, u.crew_id,
         (SELECT COUNT(*) FROM leads WHERE coworker_id = u.id AND created_at >= datetime('now', '-90 days')) AS leads,
         (SELECT COUNT(*) FROM orders WHERE coworker_id = u.id AND created_at >= datetime('now', '-90 days')) AS orders,
         (SELECT COUNT(*) FROM orders WHERE coworker_id = u.id AND activated_at >= datetime('now', '-90 days')) AS activations,
         (SELECT COUNT(*) FROM kudos WHERE to_user_id = u.id AND created_at >= datetime('now', '-90 days')) AS kudos
       FROM users u WHERE u.role IN ('coworker','lead') AND u.active = 1 ORDER BY u.display_name`,
    ).all(),
  ]);
  return c.json({
    crews: crews.results.map((r) => (r.n >= MIN_CREW_N ? r : { ...r, workload: null, safety: null, support: null, hidden: true })),
    named_responses: named.results,
    people: people.results,
  });
});

async function salesStats(db: D1Database, where: string, args: unknown[]) {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM leads WHERE ${where} AND created_at >= datetime('now', '-90 days')) AS leads,
         (SELECT COUNT(*) FROM leads WHERE ${where} AND status IN ('appointment','order') AND created_at >= datetime('now', '-90 days')) AS appointments,
         (SELECT COUNT(*) FROM orders WHERE ${where} AND created_at >= datetime('now', '-90 days')) AS orders,
         (SELECT COUNT(*) FROM orders WHERE ${where} AND activated_at IS NOT NULL AND created_at >= datetime('now', '-90 days')) AS activations`,
    )
    .bind(...args, ...args, ...args, ...args)
    .first();
}

export default app;

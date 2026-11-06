import { Hono } from 'hono';
import { BACKOFFICE, MANAGERS, type AppEnv, type Role } from '../env';
import { requireAuth } from '../lib/auth';
import { clearAreaCache, pointInArea } from '../lib/geo';
import { upsertProperty } from '../lib/properties';
import { audit, email, fail, isoDate, newId, normalizeAddress, num, oneOf, readJson, reqNum, reqStr, str } from '../lib/util';

const app = new Hono<AppEnv>();
const admin = requireAuth('admin');
const managers = requireAuth(...MANAGERS);
const dnkEditors = requireAuth('lead', 'office', 'admin');
const ROLES: Role[] = ['customer', 'coworker', 'lead', 'office', 'admin'];

// ---- Users & crews -------------------------------------------------------

app.get('/admin/users', requireAuth(...MANAGERS, ...BACKOFFICE), async (c) => {
  const role = c.req.query('role');
  const { results } = await c.env.empire_accounts.prepare(`SELECT id, email, role, display_name, phone, locale, crew_id, active, created_at FROM users ${role ? 'WHERE role = ?' : ''} ORDER BY role, display_name LIMIT 500`)
    .bind(...(role ? [role] : []))
    .all();
  return c.json(results);
});

app.post('/admin/users', admin, async (c) => {
  const body = await readJson(c);
  const id = newId();
  const role = oneOf(body, 'role', ROLES)!;
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare('INSERT INTO users (id, email, role, display_name, phone, locale, crew_id) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      id, reqStr(body, 'email', { max: 254, pattern: email }).toLowerCase(), role, reqStr(body, 'display_name', { max: 100 }),
      str(body, 'phone', { optional: true, max: 20 }) ?? null, oneOf(body, 'locale', ['en', 'es'] as const, true) ?? 'en', str(body, 'crew_id', { optional: true, max: 64 }) ?? null,
    ),
    audit(c.env.empire_accounts, c.get('user').id, 'user.create', 'user', id, { role }),
  ]).catch((e: Error) => {
    console.error(JSON.stringify({ level: 'error', msg: 'user_create_failed', detail: e.message }));
    fail(409, 'user_exists', 'A user with that email already exists, or the crew does not exist.');
  });
  return c.json({ id }, 201);
});

app.patch('/admin/users/:id', admin, async (c) => {
  const body = await readJson(c);
  const active = typeof body.active === 'boolean' ? (body.active ? 1 : 0) : null;
  const id = c.req.param('id');
  const role = oneOf(body, 'role', ROLES, true) ?? null;
  // `crew_id: null` removes the user from their crew; leaving the key out changes nothing.
  const setCrew = 'crew_id' in body;
  const crewId = setCrew ? (body.crew_id === null ? null : str(body, 'crew_id', { max: 64 }) ?? null) : null;

  const target = await c.env.empire_accounts.prepare('SELECT role, active FROM users WHERE id = ?').bind(id).first<{ role: Role; active: number }>();
  if (!target) fail(404, 'not_found');

  // Nobody can lock the admins out: not by editing themselves, and not by removing the last active admin.
  const losesAdmin = target!.role === 'admin' && target!.active === 1 && ((role !== null && role !== 'admin') || active === 0);
  if (losesAdmin) {
    if (id === c.get('user').id) fail(409, 'cannot_demote_self', 'Ask another admin to change your own role or deactivate your account.');
    const others = await c.env.empire_accounts.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`).bind(id).first<{ n: number }>();
    if (!others || others.n < 1) fail(409, 'last_admin', 'There must always be at least one active admin.');
  }

  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(
      'UPDATE users SET role = COALESCE(?, role), crew_id = CASE WHEN ? = 1 THEN ? ELSE crew_id END, display_name = COALESCE(?, display_name), active = COALESCE(?, active) WHERE id = ?',
    ).bind(role, setCrew ? 1 : 0, crewId, str(body, 'display_name', { optional: true, max: 100 }) ?? null, active, id),
    // Deactivation kills refresh tokens; access tokens die at the next request (requireAuth re-reads the user).
    ...(active === 0 ? [c.env.empire_accounts.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).bind(id)] : []),
    audit(c.env.empire_accounts, c.get('user').id, 'user.update', 'user', id, body),
  ]);
  return c.json({ ok: true });
});

app.get('/admin/crews', managers, async (c) => c.json((await c.env.empire_accounts.prepare('SELECT * FROM crews ORDER BY name').all()).results));

app.post('/admin/crews', admin, async (c) => {
  const body = await readJson(c);
  const id = newId();
  await c.env.empire_accounts.prepare('INSERT INTO crews (id, name, lead_id) VALUES (?, ?, ?)').bind(id, reqStr(body, 'name', { max: 80 }), str(body, 'lead_id', { optional: true, max: 64 }) ?? null).run();
  return c.json({ id }, 201);
});

// ---- Routes: assigned with do-not-knock enforcement ----------------------

app.get('/admin/routes', managers, async (c) => {
  const { results } = await c.env.empire_accounts.prepare(
    `SELECT r.*, u.display_name AS coworker_name, (SELECT COUNT(*) FROM route_stops WHERE route_id = r.id) AS stops,
       (SELECT COUNT(*) FROM route_stops WHERE route_id = r.id AND status = 'knocked') AS knocked
     FROM routes r JOIN users u ON u.id = r.coworker_id ORDER BY r.route_date DESC LIMIT 200`,
  ).all();
  return c.json(results);
});

/**
 * Creates a route from addresses (geocoded) and/or existing property ids.
 * Do-not-knock properties are excluded, out-of-area ones are kept but flagged for review.
 */
app.post('/admin/routes', managers, async (c) => {
  const u = c.get('user');
  const body = await readJson(c);
  const coworker = await c.env.empire_accounts.prepare(`SELECT id FROM users WHERE id = ? AND role IN ('coworker','lead') AND active = 1`).bind(reqStr(body, 'coworker_id', { max: 64 })).first<{ id: string }>();
  if (!coworker) fail(404, 'coworker_not_found');
  const date = reqStr(body, 'route_date', { pattern: isoDate });
  const permit = str(body, 'permit_ref', { optional: true, max: 80 }) ??
    (await c.env.empire_accounts.prepare(`SELECT value FROM settings WHERE key = 'solicitation_permit_ref'`).first<{ value: string }>())?.value ?? fail(400, 'permit_required');

  const addresses = Array.isArray(body.addresses) ? body.addresses.filter((a): a is string => typeof a === 'string' && a.trim().length > 4).slice(0, 300) : [];
  const ids = Array.isArray(body.property_ids) ? body.property_ids.filter((a): a is string => typeof a === 'string').slice(0, 300) : [];
  if (!addresses.length && !ids.length) fail(400, 'no_stops');

  const props = [];
  for (const address of addresses) props.push(await upsertProperty(c.env.empire_accounts, { address: address.trim() }, { geocode: true }));
  if (ids.length) {
    const { results } = await c.env.empire_accounts.prepare(`SELECT id, address, do_not_knock, seatac_valid, needs_review FROM properties WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<(typeof props)[number]>();
    props.push(...results);
  }
  const unique = [...new Map(props.map((p) => [p.id, p])).values()];
  const excluded = unique.filter((p) => p.do_not_knock);
  const stops = unique.filter((p) => !p.do_not_knock);
  if (!stops.length) fail(422, 'all_stops_do_not_knock');

  const routeId = newId();
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare('INSERT INTO routes (id, name, coworker_id, assigned_by, route_date, permit_ref) VALUES (?, ?, ?, ?, ?, ?)').bind(routeId, reqStr(body, 'name', { max: 100 }), coworker!.id, u.id, date, permit),
    ...stops.map((p, i) => c.env.empire_accounts.prepare('INSERT INTO route_stops (id, route_id, property_id, sort_order) VALUES (?, ?, ?, ?)').bind(newId(), routeId, p.id, i)),
    audit(c.env.empire_accounts, u.id, 'route.assign', 'route', routeId, { coworker_id: coworker!.id, stops: stops.length, excluded_dnk: excluded.length }),
  ]);
  return c.json({
    id: routeId,
    stops: stops.length,
    excluded_do_not_knock: excluded.map((p) => p.address),
    flagged_for_review: stops.filter((p) => !p.seatac_valid).map((p) => p.address),
  }, 201);
});

// ---- Do-not-knock list ---------------------------------------------------

app.get('/admin/dnk', dnkEditors, async (c) => {
  const { results } = await c.env.empire_accounts.prepare('SELECT id, address, dnk_reason, lat, lng, created_at FROM properties WHERE do_not_knock = 1 ORDER BY address').all();
  return c.json(results);
});

app.post('/admin/dnk', dnkEditors, async (c) => {
  const body = await readJson(c);
  const prop = await upsertProperty(c.env.empire_accounts, { address: reqStr(body, 'address', { max: 300 }) }, { geocode: true });
  const reason = str(body, 'reason', { optional: true, max: 200 }) ?? 'Resident request';
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare('UPDATE properties SET do_not_knock = 1, dnk_reason = ? WHERE id = ?').bind(reason, prop.id),
    // Pull the address from any future route so nobody is sent there.
    c.env.empire_accounts.prepare(`DELETE FROM route_stops WHERE property_id = ? AND status = 'pending' AND route_id IN (SELECT id FROM routes WHERE route_date >= date('now'))`).bind(prop.id),
    audit(c.env.empire_accounts, c.get('user').id, 'dnk.add', 'property', prop.id, { reason }),
  ]);
  return c.json({ property_id: prop.id }, 201);
});

app.delete('/admin/dnk/:id', admin, async (c) => {
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare('UPDATE properties SET do_not_knock = 0, dnk_reason = NULL WHERE id = ?').bind(c.req.param('id')),
    audit(c.env.empire_accounts, c.get('user').id, 'dnk.remove', 'property', c.req.param('id')),
  ]);
  return c.json({ ok: true });
});

// ---- Property review (out-of-area / ungeocoded) ----------------------------

app.get('/admin/properties', managers, async (c) => {
  const review = c.req.query('needs_review') === '1';
  const { results } = await c.env.empire_accounts.prepare(`SELECT * FROM properties ${review ? 'WHERE needs_review = 1' : ''} ORDER BY created_at DESC LIMIT 300`).all();
  return c.json(results);
});

app.patch('/admin/properties/:id', managers, async (c) => {
  const body = await readJson(c);
  const valid = typeof body.seatac_valid === 'boolean' ? (body.seatac_valid ? 1 : 0) : null;
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare('UPDATE properties SET seatac_valid = COALESCE(?, seatac_valid), needs_review = 0, review_note = COALESCE(?, review_note), lat = COALESCE(?, lat), lng = COALESCE(?, lng) WHERE id = ?').bind(
      valid, str(body, 'review_note', { optional: true, max: 300 }) ?? null, num(body, 'lat', { min: -90, max: 90, optional: true }) ?? null, num(body, 'lng', { min: -180, max: 180, optional: true }) ?? null, c.req.param('id'),
    ),
    audit(c.env.empire_accounts, c.get('user').id, 'property.review', 'property', c.req.param('id'), body),
  ]);
  return c.json({ ok: true });
});

app.put('/admin/service-area', admin, async (c) => {
  const body = await readJson(c);
  const geo = body.geojson as { type?: string; coordinates?: unknown };
  if (!geo || !['Polygon', 'MultiPolygon'].includes(geo.type ?? '') || !Array.isArray(geo.coordinates)) fail(400, 'invalid_geojson');
  try { pointInArea(0, 0, geo as never); } catch { fail(400, 'invalid_geojson'); }
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(`INSERT INTO service_area (id, name, geojson) VALUES ('seatac', 'SeaTac', ?) ON CONFLICT(id) DO UPDATE SET geojson = excluded.geojson`).bind(JSON.stringify(geo)),
    audit(c.env.empire_accounts, c.get('user').id, 'service_area.update', 'service_area', 'seatac'),
  ]);
  clearAreaCache();
  return c.json({ ok: true });
});

// ---- Catalog & coverage (office maintains from the dealer rate card) -------

app.get('/admin/catalog', requireAuth(...BACKOFFICE), async (c) => c.json((await c.env.empire_accounts.prepare('SELECT * FROM catalog_items ORDER BY active DESC, kind, sku').all()).results));

app.post('/admin/catalog', requireAuth(...BACKOFFICE), async (c) => {
  const b = await readJson(c);
  const id = str(b, 'id', { optional: true, max: 64 }) ?? newId();
  const int = (k: string) => num(b, k, { int: true, min: 0, optional: true }) ?? null;
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(
      `INSERT INTO catalog_items (id, sku, kind, name, name_es, speed_mbps, monthly_price_cents, promo_price_cents, promo_months, contract_months, eligibility_notes, required_tech, commission_cents, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, COALESCE(?, 0), COALESCE(?, 1))
       ON CONFLICT(id) DO UPDATE SET sku = excluded.sku, kind = excluded.kind, name = excluded.name, name_es = excluded.name_es, speed_mbps = excluded.speed_mbps,
         monthly_price_cents = excluded.monthly_price_cents, promo_price_cents = excluded.promo_price_cents, promo_months = excluded.promo_months,
         contract_months = excluded.contract_months, eligibility_notes = excluded.eligibility_notes, required_tech = excluded.required_tech,
         commission_cents = excluded.commission_cents, active = excluded.active`,
    ).bind(id, reqStr(b, 'sku', { max: 40 }), oneOf(b, 'kind', ['internet', 'tv', 'bundle', 'addon'] as const)!, reqStr(b, 'name', { max: 100 }), str(b, 'name_es', { optional: true, max: 100 }) ?? null,
      int('speed_mbps'), reqNum(b, 'monthly_price_cents', { int: true, min: 0 }), int('promo_price_cents'), int('promo_months'), int('contract_months'),
      str(b, 'eligibility_notes', { optional: true, max: 300 }) ?? null, str(b, 'required_tech', { optional: true, max: 40 }) ?? null, int('commission_cents'),
      typeof b.active === 'boolean' ? (b.active ? 1 : 0) : null),
    audit(c.env.empire_accounts, c.get('user').id, 'catalog.upsert', 'catalog_item', id, b),
  ]);
  return c.json({ id }, 201);
});

app.get('/admin/coverage', requireAuth(...BACKOFFICE), async (c) => c.json((await c.env.empire_accounts.prepare('SELECT * FROM coverage ORDER BY zip, street_norm').all()).results));

app.post('/admin/coverage', requireAuth(...BACKOFFICE), async (c) => {
  const b = await readJson(c);
  const id = newId();
  const street = str(b, 'street', { optional: true, max: 100 });
  await c.env.empire_accounts.prepare('INSERT INTO coverage (id, zip, street_norm, tech, max_speed_mbps) VALUES (?, ?, ?, ?, ?)')
    .bind(id, reqStr(b, 'zip', { pattern: /^\d{5}$/ }), street ? normalizeAddress(street) : null, reqStr(b, 'tech', { max: 40 }), num(b, 'max_speed_mbps', { int: true, min: 0, optional: true }) ?? null)
    .run();
  return c.json({ id }, 201);
});

app.delete('/admin/coverage/:id', requireAuth(...BACKOFFICE), async (c) => {
  await c.env.empire_accounts.prepare('DELETE FROM coverage WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---- Commissions (reconciliation is admin-only) --------------------------

app.get('/admin/commissions', admin, async (c) => {
  const { results } = await c.env.empire_accounts.prepare(
    `SELECT cm.*, u.display_name AS coworker_name, o.status AS order_status, o.activated_at FROM commissions cm
     JOIN orders o ON o.id = cm.order_id LEFT JOIN users u ON u.id = cm.coworker_id ORDER BY cm.status, o.created_at DESC LIMIT 300`,
  ).all();
  return c.json(results);
});

app.patch('/admin/commissions/:orderId', admin, async (c) => {
  const actual = reqNum(await readJson(c), 'actual_cents', { int: true, min: 0, max: 10_000_000 });
  const id = c.req.param('orderId');
  const [res] = await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(`UPDATE commissions SET actual_cents = ?, status = 'reconciled', reconciled_by = ?, reconciled_at = datetime('now') WHERE order_id = ?`).bind(actual, c.get('user').id, id),
    audit(c.env.empire_accounts, c.get('user').id, 'commission.reconcile', 'order', id, { actual }),
  ]);
  if (!res.meta.changes) fail(404, 'commission_not_found');
  return c.json({ ok: true });
});

// ---- Offline-sync conflicts ----------------------------------------------

app.get('/admin/conflicts', managers, async (c) => {
  const { results } = await c.env.empire_accounts.prepare(
    `SELECT s.*, u.display_name AS user_name FROM sync_conflicts s LEFT JOIN users u ON u.id = s.user_id WHERE s.status = ? ORDER BY s.created_at DESC LIMIT 200`,
  )
    .bind(c.req.query('status') ?? 'open')
    .all<{ payload_json: string }>();
  return c.json(results.map(({ payload_json, ...r }) => ({ ...r, payload: JSON.parse(payload_json) })));
});

app.patch('/admin/conflicts/:id', managers, async (c) => {
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(`UPDATE sync_conflicts SET status = 'resolved', resolved_by = ? WHERE id = ?`).bind(c.get('user').id, c.req.param('id')),
    audit(c.env.empire_accounts, c.get('user').id, 'conflict.resolve', 'sync_conflict', c.req.param('id'), await readJson(c).catch(() => ({}))),
  ]);
  return c.json({ ok: true });
});

// ---- Settings, audit, metrics ----------------------------------------------

const SETTINGS = ['solicitation_permit_ref', 'default_payment_term_days', 'active_consent_version', 'geofence_meters', 'stale_lead_days'];

app.get('/admin/settings', managers, async (c) => c.json(Object.fromEntries((await c.env.empire_accounts.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]))));

app.put('/admin/settings', admin, async (c) => {
  const body = await readJson(c);
  const entries = Object.entries(body).filter(([k, v]) => SETTINGS.includes(k) && (typeof v === 'string' || typeof v === 'number'));
  if (!entries.length) fail(400, 'no_known_settings');
  await c.env.empire_accounts.batch([
    ...entries.map(([k, v]) => c.env.empire_accounts.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(v))),
    audit(c.env.empire_accounts, c.get('user').id, 'settings.update', 'settings', null, Object.fromEntries(entries)),
  ]);
  return c.json({ ok: true });
});

app.get('/admin/audit', admin, async (c) => {
  const { results } = await c.env.empire_accounts.prepare(
    `SELECT a.*, u.display_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(Math.min(Number(c.req.query('limit') ?? 200), 1000))
    .all();
  return c.json(results);
});

/** Success-metric dashboard (spec sections 2 and 15), last 90 days unless noted. */
app.get('/admin/metrics', requireAuth(...MANAGERS, ...BACKOFFICE), async (c) => {
  const q = (sql: string) => c.env.empire_accounts.prepare(sql).first();
  const [sales, pay, fb, pulse, compliance] = await Promise.all([
    q(`SELECT
         (SELECT COUNT(*) FROM check_ins WHERE created_at >= datetime('now','-90 days')) AS door_knocks,
         (SELECT COUNT(*) FROM leads WHERE created_at >= datetime('now','-90 days')) AS leads,
         (SELECT COUNT(*) FROM appointments WHERE created_at >= datetime('now','-90 days')) AS appointments,
         (SELECT COUNT(*) FROM orders WHERE created_at >= datetime('now','-90 days')) AS orders,
         (SELECT COUNT(*) FROM orders WHERE activated_at >= datetime('now','-90 days')) AS activations,
         (SELECT COUNT(*) FROM routes WHERE route_date >= date('now','-90 days')) AS routes`),
    q(`SELECT COUNT(*) AS invoices,
         SUM(status = 'paid') AS paid, SUM(status = 'overdue') AS overdue,
         ROUND(100.0 * SUM(status = 'paid' AND date(paid_at) <= due_date) / NULLIF(SUM(status <> 'draft'), 0), 1) AS pct_paid_within_terms,
         ROUND(100.0 * SUM(status = 'overdue') / NULLIF(SUM(status <> 'draft'), 0), 1) AS overdue_rate,
         (SELECT julianday(paid_at) - julianday(sent_at) FROM invoices WHERE status = 'paid' ORDER BY julianday(paid_at) - julianday(sent_at)
            LIMIT 1 OFFSET (SELECT COUNT(*) FROM invoices WHERE status = 'paid') / 2) AS median_days_to_pay
       FROM invoices WHERE created_at >= datetime('now','-90 days')`),
    q(`SELECT
         (SELECT COUNT(*) FROM orders WHERE activated_at IS NOT NULL) AS activated_orders,
         (SELECT COUNT(*) FROM customer_feedback) AS feedback,
         ROUND(100.0 * (SELECT COUNT(*) FROM customer_feedback) / NULLIF((SELECT COUNT(*) FROM orders WHERE activated_at IS NOT NULL), 0), 1) AS submission_rate,
         (SELECT ROUND(AVG((sales_rating + install_rating + clarity_rating + support_rating) / 4.0), 2) FROM customer_feedback WHERE status = 'approved') AS avg_rating`),
    q(`SELECT
         (SELECT COUNT(*) FROM pulse_responses WHERE created_at >= datetime('now','-7 days')) AS responses_this_week,
         (SELECT COUNT(*) FROM users WHERE role IN ('coworker','lead') AND active = 1) AS coworkers,
         (SELECT ROUND(AVG((workload_score + safety_score + support_score) / 3.0), 2) FROM pulse_responses WHERE created_at >= datetime('now','-90 days')) AS score_90d`),
    q(`SELECT
         (SELECT COUNT(*) FROM leads WHERE tcpa_consent_at IS NULL) AS leads_without_consent,
         (SELECT COUNT(*) FROM check_ins ci JOIN properties p ON p.id = ci.property_id WHERE p.do_not_knock = 1) AS dnk_checkins,
         (SELECT COUNT(*) FROM properties WHERE needs_review = 1) AS properties_needing_review,
         (SELECT COUNT(*) FROM sync_conflicts WHERE status = 'open') AS open_conflicts`),
  ]);
  return c.json({ sales, payments: pay, feedback: fb, pulse, compliance });
});

export default app;

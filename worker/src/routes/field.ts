import { Hono } from 'hono';
import { STAFF, type AppEnv, type AuthUser } from '../env';
import { requireAuth } from '../lib/auth';
import { signFileUrl } from '../lib/crypto';
import { fileSecret } from '../lib/config';
import { haversineMeters } from '../lib/geo';
import { getProperty, recordConflict, upsertProperty, type Property } from '../lib/properties';
import { clientId, email, fail, isoDate, isoDateTime, normalizeAddress, num, oneOf, readJson, reqNum, reqStr, str, todayPacific } from '../lib/util';

const app = new Hono<AppEnv>();
// Per-route guard: sub-apps share the /v1 prefix, so a '*' middleware would leak onto sibling routers.
const staff = requireAuth(...STAFF);

async function setting(db: D1Database, key: string, fallback: string) {
  return (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? fallback;
}

/** Visibility: coworkers see their own; team leads see their crew; office/admin see all. */
function leadScope(u: AuthUser): [string, unknown[]] {
  if (u.role === 'coworker') return ['l.coworker_id = ?', [u.id]];
  if (u.role === 'lead') return ['(l.coworker_id = ? OR l.coworker_id IN (SELECT id FROM users WHERE crew_id = ?))', [u.id, u.crew_id]];
  return ['1 = 1', []];
}

async function loadLead(db: D1Database, u: AuthUser, id: string) {
  const [scope, args] = leadScope(u);
  return (
    (await db
      .prepare(`SELECT l.*, p.address, p.zip, p.lat, p.lng, p.seatac_valid, p.needs_review FROM leads l JOIN properties p ON p.id = l.property_id WHERE l.id = ? AND ${scope}`)
      .bind(id, ...args)
      .first<Record<string, unknown> & { coworker_id: string; property_id: string; address: string; zip: string | null; status: string }>()) ??
    fail(404, 'lead_not_found')
  );
}

function rejectDnk(db: D1Database, u: AuthUser, entity: string, prop: Property, payload: unknown) {
  return recordConflict(db, u.id, entity, payload, 'do_not_knock').then((conflict_id) =>
    fail(403, 'do_not_knock', 'This address is on the do-not-knock list. Leave the property.', { conflict_id }),
  );
}

// ---- Map data ------------------------------------------------------------

app.get('/service-area', staff, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, geojson FROM service_area WHERE active = 1').all<{ id: string; name: string; geojson: string }>();
  return c.json(results.map((r) => ({ ...r, geojson: JSON.parse(r.geojson) })));
});

app.get('/dnk/map', staff, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, lat, lng FROM properties WHERE do_not_knock = 1 AND lat IS NOT NULL').all();
  return c.json(results);
});

app.get('/routes/mine', staff, async (c) => {
  const date = c.req.query('date') ?? todayPacific();
  if (!isoDate.test(date)) fail(400, 'invalid_date');
  const u = c.get('user');
  const { results: routes } = await c.env.DB.prepare('SELECT id, name, route_date, permit_ref, status FROM routes WHERE coworker_id = ? AND route_date >= ? ORDER BY route_date LIMIT 14')
    .bind(u.id, date)
    .all<{ id: string }>();
  if (!routes.length) return c.json([]);
  const { results: stops } = await c.env.DB.prepare(
    `SELECT s.id, s.route_id, s.sort_order, s.status, p.id AS property_id, p.address, p.lat, p.lng, p.do_not_knock
     FROM route_stops s JOIN properties p ON p.id = s.property_id
     WHERE s.route_id IN (${routes.map(() => '?').join(',')}) ORDER BY s.sort_order`,
  )
    .bind(...routes.map((r) => r.id))
    .all<{ route_id: string }>();
  return c.json(routes.map((r) => ({ ...r, stops: stops.filter((s) => s.route_id === r.id) })));
});

/** Pre-check while a rep stands at a door: in SeaTac? on the do-not-knock list? */
app.post('/properties/validate', staff, async (c) => {
  const body = await readJson(c);
  const prop = await upsertProperty(c.env.DB, {
    address: reqStr(body, 'address', { max: 300 }),
    lat: num(body, 'lat', { min: -90, max: 90, optional: true }),
    lng: num(body, 'lng', { min: -180, max: 180, optional: true }),
  });
  return c.json({ property_id: prop.id, seatac_valid: !!prop.seatac_valid, do_not_knock: !!prop.do_not_knock, needs_review: !!prop.needs_review });
});

// ---- Door knock (geo-verified check-in) ------------------------------------

app.post('/check-ins', staff, async (c) => {
  const body = await readJson(c);
  const u = c.get('user');
  const id = clientId(body.id);
  const replay = await c.env.DB.prepare('SELECT * FROM check_ins WHERE id = ? AND coworker_id = ?').bind(id, u.id).first();
  if (replay) return c.json(replay);

  const prop = await getProperty(c.env.DB, reqStr(body, 'property_id', { max: 64 }));
  const lat = reqNum(body, 'lat', { min: -90, max: 90 });
  const lng = reqNum(body, 'lng', { min: -180, max: 180 });
  const outcome = oneOf(body, 'outcome', ['no_answer', 'not_interested', 'interested', 'come_back'] as const)!;
  const stopId = str(body, 'route_stop_id', { optional: true, max: 64 });
  if (prop.do_not_knock) return rejectDnk(c.env.DB, u, 'check_in', prop, body);

  let distance: number | null = null;
  if (prop.lat != null && prop.lng != null) {
    distance = Math.round(haversineMeters(lat, lng, prop.lat, prop.lng));
    const limit = Number(await setting(c.env.DB, 'geofence_meters', '100'));
    if (distance > limit) {
      const conflict_id = await recordConflict(c.env.DB, u.id, 'check_in', body, `too_far:${distance}m`);
      fail(422, 'not_at_property', `You are ${distance} m from this address. Check in at the door.`, { conflict_id, distance_m: distance });
    }
  }
  if (stopId) {
    const stop = await c.env.DB.prepare('SELECT s.id FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE s.id = ? AND r.coworker_id = ? AND s.property_id = ?')
      .bind(stopId, u.id, prop.id)
      .first();
    if (!stop) fail(403, 'not_your_stop');
  }

  const stmts = [
    c.env.DB.prepare('INSERT INTO check_ins (id, route_stop_id, property_id, coworker_id, lat, lng, distance_m, outcome, photo_key, client_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id, stopId ?? null, prop.id, u.id, lat, lng, distance, outcome,
      str(body, 'photo_key', { optional: true, max: 200 }) ?? null,
      str(body, 'client_created_at', { optional: true, pattern: isoDateTime }) ?? null,
    ),
  ];
  if (stopId) {
    stmts.push(c.env.DB.prepare(`UPDATE route_stops SET status = 'knocked' WHERE id = ?`).bind(stopId));
    stmts.push(c.env.DB.prepare(`UPDATE routes SET status = 'in_progress' WHERE id = (SELECT route_id FROM route_stops WHERE id = ?) AND status = 'assigned'`).bind(stopId));
  }
  await c.env.DB.batch(stmts);
  return c.json(await c.env.DB.prepare('SELECT * FROM check_ins WHERE id = ?').bind(id).first(), 201);
});

// ---- Leads ---------------------------------------------------------------

app.get('/leads', staff, async (c) => {
  const [scope, args] = leadScope(c.get('user'));
  const status = c.req.query('status');
  const q = c.req.query('q');
  let sql = `SELECT l.id, l.customer_name, l.phone, l.email, l.status, l.product_interest, l.created_at, l.coworker_id,
      p.address, p.seatac_valid, p.needs_review, u.display_name AS coworker_name
    FROM leads l JOIN properties p ON p.id = l.property_id LEFT JOIN users u ON u.id = l.coworker_id WHERE ${scope}`;
  const binds = [...args];
  if (status) (sql += ' AND l.status = ?'), binds.push(status);
  if (q) (sql += ' AND (l.customer_name LIKE ? OR p.address LIKE ?)'), binds.push(`%${q}%`, `%${q}%`);
  const { results } = await c.env.DB.prepare(`${sql} ORDER BY l.created_at DESC LIMIT 200`).bind(...binds).all();
  return c.json(results);
});

app.get('/leads/:id', staff, async (c) => {
  const lead = await loadLead(c.env.DB, c.get('user'), c.req.param('id'));
  const [consents, appointments] = await Promise.all([
    c.env.DB.prepare('SELECT id, kind, text_version, accepted_at, rep_id, address_snapshot FROM consents WHERE lead_id = ?').bind(lead.id).all(),
    c.env.DB.prepare('SELECT * FROM appointments WHERE lead_id = ? ORDER BY scheduled_at').bind(lead.id).all(),
  ]);
  const sign = (k: unknown) => (typeof k === 'string' ? signFileUrl(new URL(c.req.url).origin, fileSecret(c.env), 'GET', k) : null);
  return c.json({
    ...lead,
    product_interest: JSON.parse((lead.product_interest as string) ?? '[]'),
    photo_url: await sign(lead.photo_key),
    signature_url: await sign(lead.signature_key),
    consents: consents.results,
    appointments: appointments.results,
  });
});

/** Interest captured: lead + immutable TCPA and door-to-door disclosure records in one batch. */
app.post('/leads', staff, async (c) => {
  const body = await readJson(c);
  const u = c.get('user');
  const id = clientId(body.id);
  const replay = await c.env.DB.prepare('SELECT id, status FROM leads WHERE id = ? AND coworker_id = ?').bind(id, u.id).first();
  if (replay) return c.json(replay);

  const lat = num(body, 'lat', { min: -90, max: 90, optional: true });
  const lng = num(body, 'lng', { min: -180, max: 180, optional: true });
  const propertyId = str(body, 'property_id', { optional: true, max: 64 });
  const prop = propertyId ? await getProperty(c.env.DB, propertyId) : await upsertProperty(c.env.DB, { address: reqStr(body, 'address', { max: 300 }), lat, lng });
  if (prop.do_not_knock) return rejectDnk(c.env.DB, u, 'lead', prop, body);

  const name = reqStr(body, 'customer_name', { max: 120 });
  const phone = str(body, 'phone', { optional: true, max: 20, pattern: /^\+?[0-9 ()-]{7,20}$/ });
  const mail = str(body, 'email', { optional: true, max: 254, pattern: email })?.toLowerCase();
  if (!phone && !mail) fail(400, 'missing_contact', 'Phone or email is required');
  const interest = Array.isArray(body.product_interest) ? body.product_interest.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];

  // Consent is mandatory and must reference a published text version.
  if (body.tcpa_accepted !== true) fail(422, 'tcpa_consent_required');
  if (body.disclosure_accepted !== true) fail(422, 'disclosure_ack_required');
  const version = reqStr(body, 'consent_text_version', { max: 20 });
  const known = await c.env.DB.prepare(`SELECT COUNT(DISTINCT kind) AS n FROM consent_texts WHERE version = ? AND active = 1`).bind(version).first<{ n: number }>();
  if (known?.n !== 2) fail(422, 'unknown_consent_version');
  const acceptedAt = str(body, 'consented_at', { optional: true, pattern: isoDateTime }) ?? new Date().toISOString();
  const signature = str(body, 'signature_key', { optional: true, max: 200 }) ?? null;

  const consent = (kind: string) =>
    c.env.DB.prepare('INSERT INTO consents (id, lead_id, kind, text_version, accepted_at, rep_id, property_id, address_snapshot, signature_key, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      crypto.randomUUID(), id, kind, version, acceptedAt, u.id, prop.id, prop.address, signature, lat ?? null, lng ?? null,
    );
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO leads (id, property_id, coworker_id, customer_name, phone, email, product_interest, status, tcpa_consent_at, consent_text_version, disclosure_ack_at, signature_key, photo_key, client_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'interested', ?, ?, ?, ?, ?, ?)`,
    ).bind(id, prop.id, u.id, name, phone ?? null, mail ?? null, JSON.stringify(interest), acceptedAt, version, acceptedAt, signature,
      str(body, 'photo_key', { optional: true, max: 200 }) ?? null, str(body, 'client_created_at', { optional: true, pattern: isoDateTime }) ?? null),
    consent('tcpa'),
    consent('d2d_disclosure'),
  ]);
  return c.json({ id, status: 'interested', property_id: prop.id, out_of_area: !prop.seatac_valid }, 201);
});

app.patch('/leads/:id', staff, async (c) => {
  const u = c.get('user');
  const lead = await loadLead(c.env.DB, u, c.req.param('id'));
  const body = await readJson(c);
  const status = oneOf(body, 'status', ['new', 'interested', 'closed', 'not_serviceable'] as const, true);
  const reason = str(body, 'reason', { optional: true, max: 300 });
  if ((status === 'closed' || status === 'not_serviceable') && !reason) fail(400, 'reason_required');
  if (lead.status === 'order' && status) fail(409, 'lead_has_order');
  await c.env.DB.prepare(
    `UPDATE leads SET status = COALESCE(?, status),
       closed_reason = CASE WHEN ? = 'closed' THEN ? ELSE closed_reason END,
       not_serviceable_reason = CASE WHEN ? = 'not_serviceable' THEN ? ELSE not_serviceable_reason END,
       customer_name = COALESCE(?, customer_name), phone = COALESCE(?, phone), email = COALESCE(?, email), updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(status ?? null, status ?? null, reason ?? null, status ?? null, reason ?? null,
      str(body, 'customer_name', { optional: true, max: 120 }) ?? null, str(body, 'phone', { optional: true, max: 20 }) ?? null,
      str(body, 'email', { optional: true, max: 254, pattern: email }) ?? null, lead.id)
    .run();
  return c.json({ ok: true });
});

/** Qualification: coverage by ZIP (+street) → eligible catalog items. No coverage marks the lead not serviceable. */
app.post('/leads/:id/serviceability', staff, async (c) => {
  const lead = await loadLead(c.env.DB, c.get('user'), c.req.param('id'));
  const street = normalizeAddress(lead.address).replace(/^\d+[A-Z]?\s+/, '').split(' ').slice(0, 3).join(' ');
  const { results: cov } = await c.env.DB.prepare(`SELECT tech, MAX(max_speed_mbps) AS max_speed FROM coverage WHERE zip = ? AND (street_norm IS NULL OR ? LIKE street_norm || '%') GROUP BY tech`)
    .bind(lead.zip ?? '', street)
    .all<{ tech: string; max_speed: number }>();
  if (!cov.length) {
    const reason = lead.zip ? 'No coverage on file for this address' : 'Address has no ZIP code';
    await c.env.DB.prepare(`UPDATE leads SET status = 'not_serviceable', not_serviceable_reason = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'order'`).bind(reason, lead.id).run();
    return c.json({ serviceable: false, reason, items: [] });
  }
  const techs = cov.map((r) => r.tech);
  const { results: items } = await c.env.DB.prepare(
    `SELECT * FROM catalog_items WHERE active = 1 AND (required_tech IS NULL OR required_tech IN (${techs.map(() => '?').join(',')})) ORDER BY kind, monthly_price_cents`,
  )
    .bind(...techs)
    .all();
  return c.json({ serviceable: true, coverage: cov, items });
});

// ---- Appointments --------------------------------------------------------

app.post('/appointments', staff, async (c) => {
  const body = await readJson(c);
  const u = c.get('user');
  const id = clientId(body.id);
  const replay = await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ? AND created_by = ?').bind(id, u.id).first();
  if (replay) return c.json(replay);
  const lead = await loadLead(c.env.DB, u, reqStr(body, 'lead_id', { max: 64 }));
  if (lead.status === 'not_serviceable' || lead.status === 'closed') fail(409, 'lead_not_open');
  const at = reqStr(body, 'scheduled_at', { pattern: isoDateTime });
  const end = str(body, 'window_end', { optional: true, pattern: isoDateTime });
  if (Date.parse(at) < Date.now() - 3600_000) fail(400, 'appointment_in_past');
  if (end && Date.parse(end) <= Date.parse(at)) fail(400, 'invalid_window');
  const kind = oneOf(body, 'kind', ['install', 'consult'] as const, true) ?? 'install';
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO appointments (id, lead_id, kind, scheduled_at, window_end, created_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, lead.id, kind, at, end ?? null, u.id),
    c.env.DB.prepare(`UPDATE leads SET status = 'appointment', updated_at = datetime('now') WHERE id = ? AND status IN ('new','interested')`).bind(lead.id),
  ]);
  return c.json(await c.env.DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first(), 201);
});

app.patch('/appointments/:id', staff, async (c) => {
  const u = c.get('user');
  const appt = await c.env.DB.prepare('SELECT lead_id FROM appointments WHERE id = ?').bind(c.req.param('id')).first<{ lead_id: string }>();
  if (!appt) fail(404, 'appointment_not_found');
  await loadLead(c.env.DB, u, appt!.lead_id); // scope check
  const status = oneOf(await readJson(c), 'status', ['set', 'completed', 'no_show', 'cancelled'] as const)!;
  await c.env.DB.prepare('UPDATE appointments SET status = ? WHERE id = ?').bind(status, c.req.param('id')).run();
  return c.json({ ok: true });
});

export default app;

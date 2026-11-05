import { Hono } from 'hono';
import { STAFF, type AppEnv } from '../env';
import { requireAuth } from '../lib/auth';
import { staffScope } from '../lib/scope';
import { fail, isoDate } from '../lib/util';

// One endpoint feeds every map (admin console and the phone map page): pins for leads, sales,
// do-not-knock addresses and door check-ins, already limited to what this person may see.

const app = new Hono<AppEnv>();

const LAYERS = ['leads', 'sales', 'dnk', 'checkins'] as const;
type Layer = (typeof LAYERS)[number];
const LEAD_STATUSES = ['new', 'interested', 'appointment', 'not_serviceable', 'closed'] as const;
const DEFAULT_LIMIT = 2000;

app.get('/map/points', requireAuth(...STAFF), async (c) => {
  const u = c.get('user');
  const q = parseQuery((name) => c.req.query(name));
  const out: Record<string, unknown> = {};
  const truncated: Record<string, boolean> = {};

  // Fetch one extra row so we can tell whether the list was cut short.
  const run = async (layer: Layer, sql: string, binds: unknown[]) => {
    const { results } = await c.env.DB.prepare(`${sql} LIMIT ?`).bind(...binds, q.limit + 1).all();
    truncated[layer] = results.length > q.limit;
    out[layer] = results.slice(0, q.limit);
  };

  // Builds the WHERE text and pushes the matching values onto `binds`, in the same order as the placeholders.
  // `dated` is the column the from/to dates apply to; leave it out for a layer that should ignore dates.
  const where = (scope: string[], binds: unknown[], dated?: string) => {
    const parts = [...scope, 'p.lat IS NOT NULL', 'p.lng IS NOT NULL'];
    if (q.bbox) {
      parts.push('p.lng BETWEEN ? AND ? AND p.lat BETWEEN ? AND ?');
      binds.push(q.bbox[0], q.bbox[2], q.bbox[1], q.bbox[3]);
    }
    if (dated && q.from) (parts.push(`date(${dated}) >= ?`), binds.push(q.from));
    if (dated && q.to) (parts.push(`date(${dated}) <= ?`), binds.push(q.to));
    return parts.join(' AND ');
  };

  if (q.layers.includes('leads')) {
    const [scope, args] = staffScope(u, 'l.coworker_id');
    const binds = [...args];
    const parts = [scope, "l.status != 'order'"];
    if (q.status) (parts.push('l.status = ?'), binds.push(q.status));
    await run(
      'leads',
      `SELECT l.id, l.status, l.customer_name, p.address, p.lat, p.lng, l.created_at, cw.display_name AS coworker_name
       FROM leads l JOIN properties p ON p.id = l.property_id LEFT JOIN users cw ON cw.id = l.coworker_id
       WHERE ${where(parts, binds, 'l.created_at')} ORDER BY l.created_at DESC`,
      binds,
    );
  }

  if (q.layers.includes('sales')) {
    const [scope, args] = staffScope(u, 'o.coworker_id');
    const binds = [...args];
    await run(
      'sales',
      `SELECT o.id, o.status, o.created_at, o.activated_at, l.customer_name, p.address, p.lat, p.lng, cw.display_name AS coworker_name
       FROM orders o JOIN leads l ON l.id = o.lead_id JOIN properties p ON p.id = l.property_id LEFT JOIN users cw ON cw.id = o.coworker_id
       WHERE ${where([scope, "o.status != 'cancelled'"], binds, 'o.created_at')} ORDER BY o.created_at DESC`,
      binds,
    );
  }

  if (q.layers.includes('dnk')) {
    // Everyone on staff needs the warning pins. Only managers also get the street address.
    const binds: unknown[] = [];
    const showAddress = u.role !== 'coworker';
    await run(
      'dnk',
      `SELECT p.id, p.lat, p.lng${showAddress ? ', p.address' : ''}
       FROM properties p WHERE ${where(['p.do_not_knock = 1'], binds)} ORDER BY p.id`,
      binds,
    );
  }

  if (q.layers.includes('checkins')) {
    const [scope, args] = staffScope(u, 'k.coworker_id');
    const binds = [...args];
    await run(
      'checkins',
      `SELECT k.id, k.outcome, k.created_at, p.address, p.lat, p.lng, cw.display_name AS coworker_name
       FROM check_ins k JOIN properties p ON p.id = k.property_id LEFT JOIN users cw ON cw.id = k.coworker_id
       WHERE ${where([scope], binds, 'k.created_at')} ORDER BY k.created_at DESC`,
      binds,
    );
  }

  return c.json({ ...out, truncated });
});

export default app;

// ---- Reading the query string ------------------------------------------------

interface MapQuery {
  layers: Layer[];
  status?: string;
  /** minLng, minLat, maxLng, maxLat: the part of the map on screen. */
  bbox?: [number, number, number, number];
  from?: string;
  to?: string;
  limit: number;
}

function parseQuery(get: (name: string) => string | undefined): MapQuery {
  const layers = (get('layers') ?? 'leads,sales,dnk').split(',').map((s) => s.trim()).filter(Boolean);
  if (!layers.length || layers.some((l) => !LAYERS.includes(l as Layer))) fail(400, 'invalid_field', `layers must be some of ${LAYERS.join(', ')}`);

  const status = get('status');
  if (status && !LEAD_STATUSES.includes(status as (typeof LEAD_STATUSES)[number])) fail(400, 'invalid_field', `status must be one of ${LEAD_STATUSES.join(', ')}`);

  for (const name of ['from', 'to']) {
    const v = get(name);
    if (v && !isoDate.test(v)) fail(400, 'invalid_field', `${name} must look like 2026-11-05`);
  }

  const limitText = get('limit');
  const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_LIMIT) fail(400, 'invalid_field', `limit must be a whole number from 1 to ${DEFAULT_LIMIT}`);

  return { layers: layers as Layer[], status, bbox: parseBbox(get('bbox')), from: get('from'), to: get('to'), limit };
}

function parseBbox(text: string | undefined): MapQuery['bbox'] {
  if (!text) return undefined;
  const n = text.split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) fail(400, 'invalid_field', 'bbox must be minLng,minLat,maxLng,maxLat');
  const [minLng, minLat, maxLng, maxLat] = n;
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90 || minLng > maxLng || minLat > maxLat) fail(400, 'invalid_field', 'bbox is out of range');
  return [minLng, minLat, maxLng, maxLat];
}

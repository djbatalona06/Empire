import { Hono } from 'hono';
import { BACKOFFICE, MANAGERS, STAFF, type AppEnv } from '../env';
import { requireAuth } from '../lib/auth';
import { signFileUrl, verifyFileSig } from '../lib/crypto';
import { fail, oneOf, readJson, reqStr } from '../lib/util';

const app = new Hono<AppEnv>();

const KINDS = ['door_photo', 'signature', 'install_photo', 'feedback_photo'] as const;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic' };
const MAX_BYTES = 10 * 1024 * 1024;

// Key layout: <kind>/<uploader id>/<uuid>.<ext> — the uploader segment drives read access.
app.post('/uploads', requireAuth(), async (c) => {
  const u = c.get('user');
  const body = await readJson(c);
  const kind = oneOf(body, 'kind', KINDS)!;
  const type = reqStr(body, 'content_type', { max: 40 });
  if (!TYPES[type]) fail(400, 'unsupported_type');
  if ((kind === 'feedback_photo') !== (u.role === 'customer')) fail(403, 'forbidden_kind');
  const key = `${kind}/${u.id}/${crypto.randomUUID()}.${TYPES[type]}`;
  const origin = new URL(c.req.url).origin;
  return c.json({ key, upload_url: await signFileUrl(origin, c.env.JWT_SECRET, 'PUT', key), content_type: type, max_bytes: MAX_BYTES });
});

app.post('/files/sign', requireAuth(), async (c) => {
  const u = c.get('user');
  const key = reqStr(await readJson(c), 'key', { max: 200 });
  const owner = key.split('/')[1];
  const staffReader = [...MANAGERS, ...BACKOFFICE].includes(u.role);
  if (owner !== u.id && !staffReader) fail(403, 'forbidden');
  return c.json({ url: await signFileUrl(new URL(c.req.url).origin, c.env.JWT_SECRET, 'GET', key) });
});

app.put('/files/*', async (c) => {
  const key = c.req.path.slice('/v1/files/'.length);
  if (!(await verifyFileSig(c.env.JWT_SECRET, 'PUT', key, c.req.query('exp'), c.req.query('sig')))) fail(403, 'bad_signature');
  const len = Number(c.req.header('content-length') ?? 0);
  const type = c.req.header('content-type') ?? '';
  if (!len || len > MAX_BYTES) fail(400, 'invalid_size');
  if (!TYPES[type] || !key.endsWith(`.${TYPES[type]}`)) fail(400, 'type_mismatch');
  await c.env.FILES.put(key, c.req.raw.body, { httpMetadata: { contentType: type } });
  return c.json({ key }, 201);
});

app.get('/files/*', async (c) => {
  const key = c.req.path.slice('/v1/files/'.length);
  if (!(await verifyFileSig(c.env.JWT_SECRET, 'GET', key, c.req.query('exp'), c.req.query('sig')))) fail(403, 'bad_signature');
  const obj = await c.env.FILES.get(key);
  if (!obj) fail(404, 'not_found');
  return new Response(obj!.body, { headers: { 'content-type': obj!.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': 'private, max-age=600' } });
});

// ---- Reference data for the apps -----------------------------------------

app.get('/catalog', requireAuth(), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, sku, kind, name, name_es, speed_mbps, monthly_price_cents, promo_price_cents, promo_months, contract_months, eligibility_notes, required_tech, commission_cents FROM catalog_items WHERE active = 1 ORDER BY kind, monthly_price_cents').all();
  // Commission estimates are internal: staff only.
  return c.json(STAFF.includes(c.get('user').role) ? results : results.map(({ commission_cents, ...r }) => r));
});

app.get('/consent-texts', requireAuth(...STAFF), async (c) => {
  const version = c.req.query('version') ?? (await c.env.DB.prepare(`SELECT value FROM settings WHERE key = 'active_consent_version'`).first<{ value: string }>())?.value ?? 'v1';
  const { results } = await c.env.DB.prepare('SELECT version, kind, locale, body FROM consent_texts WHERE version = ? AND active = 1').bind(version).all();
  return c.json({ version, texts: results });
});

export default app;

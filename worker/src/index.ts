import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { runDaily } from './cron';
import type { AppEnv, Env } from './env';
import { configProblem } from './lib/config';
import { limitWrites } from './lib/ratelimit';
import { ApiError } from './lib/util';
import admin from './routes/admin';
import auth, { me } from './routes/auth';
import feedback from './routes/feedback';
import field from './routes/field';
import files from './routes/files';
import invoices from './routes/invoices';
import map from './routes/map';
import orders from './routes/orders';

const app = new Hono<AppEnv>();

// Every response carries a request id so a report from a user can be matched to the log line.
app.use('*', async (c, next) => {
  const id = c.req.header('x-request-id')?.slice(0, 64) || crypto.randomUUID();
  c.set('requestId', id);
  await next();
  c.res.headers.set('x-request-id', id);
});

// Refuse to serve anything with a missing or weak signing secret instead of failing in odd ways later.
app.use('/v1/*', async (c, next) => {
  const problem = configProblem(c.env);
  if (problem) {
    console.error(JSON.stringify({ level: 'error', msg: 'bad_config', problem, requestId: c.get('requestId') }));
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  await next();
});

app.use('*', secureHeaders());
// The iOS app doesn't need CORS; this only lets the admin console run from another origin in dev.
app.use('/v1/*', cors({ origin: (o, c) => (c.env.ENVIRONMENT === 'development' ? o : c.env.PUBLIC_BASE_URL), allowHeaders: ['authorization', 'content-type'] }));

app.use('/v1/*', limitWrites);

// Checks the database and file storage, so an uptime monitor notices a real outage, not just a live Worker.
app.get('/v1/health', async (c) => {
  const checks = {
    db: await c.env.DB.prepare('SELECT 1').first().then(() => true, () => false),
    files: await c.env.FILES.head('health-check').then(() => true, () => false),
  };
  const ok = checks.db && checks.files;
  return c.json({ ok, env: c.env.ENVIRONMENT, checks }, ok ? 200 : 503);
});
app.route('/v1/auth', auth);
for (const r of [me, field, orders, files, invoices, feedback, map, admin]) app.route('/v1', r);

// Magic links open the iOS app (universal links) or the Android app (App Links); on a desktop they land in the admin console.
app.get('/auth/verify', (c) => c.redirect(`/#magic=${encodeURIComponent(c.req.query('token') ?? '')}`));
app.get('/.well-known/apple-app-site-association', (c) =>
  c.json({ applinks: { details: [{ appIDs: [`${c.env.APNS_TEAM_ID ?? 'TEAMID'}.${c.env.APNS_TOPIC}`], components: [{ '/': '/auth/verify*' }] }] } }),
);
// ANDROID_CERT_SHA256: comma-separated signing-certificate fingerprints (Play Console → App integrity).
app.get('/.well-known/assetlinks.json', (c) =>
  c.json(
    (c.env.ANDROID_CERT_SHA256 ?? '').split(',').filter(Boolean).length
      ? [
          {
            relation: ['delegate_permission/common.handle_all_urls'],
            target: { namespace: 'android_app', package_name: c.env.APNS_TOPIC, sha256_cert_fingerprints: c.env.ANDROID_CERT_SHA256!.split(',').map((s) => s.trim()) },
          },
        ]
      : [],
  ),
);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
  console.error(JSON.stringify({ level: 'error', msg: String(err), requestId: c.get('requestId'), path: new URL(c.req.url).pathname, method: c.req.method }));
  return c.json({ error: 'internal_error', request_id: c.get('requestId') }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runDaily(env).then((r) => console.log('[cron]', JSON.stringify(r)))),
} satisfies ExportedHandler<Env>;

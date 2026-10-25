import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { runDaily } from './cron';
import type { AppEnv, Env } from './env';
import { ApiError } from './lib/util';
import admin from './routes/admin';
import auth, { me } from './routes/auth';
import feedback from './routes/feedback';
import field from './routes/field';
import files from './routes/files';
import invoices from './routes/invoices';
import orders from './routes/orders';

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());
// The iOS app doesn't need CORS; this only lets the admin console run from another origin in dev.
app.use('/v1/*', cors({ origin: (o, c) => (c.env.ENVIRONMENT === 'development' ? o : c.env.PUBLIC_BASE_URL), allowHeaders: ['authorization', 'content-type'] }));

app.get('/v1/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.route('/v1/auth', auth);
for (const r of [me, field, orders, files, invoices, feedback, admin]) app.route('/v1', r);

// Magic links open the iOS app via universal links; on a desktop they land in the admin console.
app.get('/auth/verify', (c) => c.redirect(`/#magic=${encodeURIComponent(c.req.query('token') ?? '')}`));
app.get('/.well-known/apple-app-site-association', (c) =>
  c.json({ applinks: { details: [{ appIDs: [`${c.env.APNS_TEAM_ID ?? 'TEAMID'}.${c.env.APNS_TOPIC}`], components: [{ '/': '/auth/verify*' }] }] } }),
);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runDaily(env).then((r) => console.log('[cron]', JSON.stringify(r)))),
} satisfies ExportedHandler<Env>;

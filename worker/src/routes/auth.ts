import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { issueTokens, requireAuth } from '../lib/auth';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { t } from '../lib/i18n';
import { sendEmail } from '../lib/notify';
import { email, fail, oneOf, readJson, reqStr, str } from '../lib/util';

const app = new Hono<AppEnv>();

async function rateLimit(c: { env: AppEnv['Bindings']; req: { header: (n: string) => string | undefined } }, key: string) {
  if (!c.env.AUTH_LIMITER) return;
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const { success } = await c.env.AUTH_LIMITER.limit({ key: `${ip}:${key}` });
  if (!success) fail(429, 'rate_limited', 'Too many attempts. Try again in a minute.');
}

// Password login, or (no password) request a magic link. Never reveals whether the email exists.
app.post('/login', async (c) => {
  const body = await readJson(c);
  const addr = reqStr(body, 'email', { max: 254, pattern: email }).toLowerCase();
  const password = str(body, 'password', { optional: true, max: 200 });
  await rateLimit(c, addr);

  const user = await c.env.DB.prepare('SELECT id, role, locale, password_hash, active FROM users WHERE email = ?')
    .bind(addr)
    .first<{ id: string; role: 'customer'; locale: string; password_hash: string | null; active: number }>();

  if (password) {
    if (!user?.active || !(await verifyPassword(password, user.password_hash))) fail(401, 'invalid_credentials');
    return c.json(await issueTokens(c.env, user!));
  }

  let devToken: string | undefined;
  if (user?.active) {
    const token = randomToken();
    await c.env.DB.prepare(`INSERT INTO magic_links (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))`)
      .bind(await sha256(token), user.id)
      .run();
    const link = `${c.env.PUBLIC_BASE_URL}/auth/verify?token=${token}`;
    const s = t(user.locale);
    c.executionCtx.waitUntil(sendEmail(c.env, addr, s.magic_subject, s.magic_body(link)));
    if (c.env.ENVIRONMENT === 'development') devToken = token;
  }
  return c.json({ sent: true, ...(devToken && { dev_token: devToken }) });
});

app.post('/verify', async (c) => {
  const token = reqStr(await readJson(c), 'token', { max: 100 });
  const row = await c.env.DB.prepare(
    `UPDATE magic_links SET used_at = datetime('now')
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
     RETURNING user_id`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string }>();
  if (!row) fail(401, 'invalid_or_expired_link');
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').bind(row!.user_id).first<{ id: string; role: 'customer' }>();
  if (!user) fail(401, 'inactive_user');
  return c.json(await issueTokens(c.env, user!));
});

// Rotating refresh tokens: each refresh revokes the old session row.
app.post('/refresh', async (c) => {
  const token = reqStr(await readJson(c), 'refresh_token', { max: 100 });
  const row = await c.env.DB.prepare(
    `UPDATE sessions SET revoked_at = datetime('now')
     WHERE refresh_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')
     RETURNING user_id`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string }>();
  if (!row) fail(401, 'invalid_refresh_token');
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').bind(row!.user_id).first<{ id: string; role: 'customer' }>();
  if (!user) fail(401, 'inactive_user');
  return c.json(await issueTokens(c.env, user!));
});

app.post('/logout', async (c) => {
  const token = str(await readJson(c), 'refresh_token', { max: 100, optional: true });
  if (token) await c.env.DB.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE refresh_hash = ?`).bind(await sha256(token)).run();
  return c.json({ ok: true });
});

app.post('/password', requireAuth(), async (c) => {
  const password = reqStr(await readJson(c), 'password', { max: 200 });
  if (password.length < 12) fail(400, 'weak_password', 'Use at least 12 characters');
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), c.get('user').id).run();
  return c.json({ ok: true });
});

export default app;

// ---- Profile & devices (mounted at /v1) ----------------------------------

export const me = new Hono<AppEnv>();

me.get('/me', requireAuth(), async (c) => {
  const u = await c.env.DB.prepare('SELECT id, email, role, display_name, phone, locale, crew_id FROM users WHERE id = ?').bind(c.get('user').id).first();
  return c.json(u);
});

me.patch('/me', requireAuth(), async (c) => {
  const body = await readJson(c);
  const locale = oneOf(body, 'locale', ['en', 'es'] as const, true);
  const name = str(body, 'display_name', { optional: true, max: 100 });
  await c.env.DB.prepare('UPDATE users SET locale = COALESCE(?, locale), display_name = COALESCE(?, display_name) WHERE id = ?')
    .bind(locale ?? null, name ?? null, c.get('user').id)
    .run();
  return c.json({ ok: true });
});

me.post('/devices', requireAuth(), async (c) => {
  const body = await readJson(c);
  const token = reqStr(body, 'apns_token', { max: 200, pattern: /^[0-9a-f]{64,200}$/i });
  const env = oneOf(body, 'env', ['sandbox', 'production'] as const, true) ?? 'production';
  await c.env.DB.prepare(
    `INSERT INTO devices (apns_token, user_id, env) VALUES (?, ?, ?)
     ON CONFLICT(apns_token) DO UPDATE SET user_id = excluded.user_id, env = excluded.env, updated_at = datetime('now')`,
  )
    .bind(token, c.get('user').id, env)
    .run();
  return c.json({ ok: true });
});

me.delete('/devices/:token', requireAuth(), async (c) => {
  await c.env.DB.prepare('DELETE FROM devices WHERE apns_token = ? AND user_id = ?').bind(c.req.param('token'), c.get('user').id).run();
  return c.json({ ok: true });
});

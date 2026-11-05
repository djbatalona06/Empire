import { Hono } from 'hono';
import type { AppEnv, Env, Role } from '../env';
import { issueTokens, requireAuth, requireSignedIn } from '../lib/auth';
import { devLoginAllowed } from '../lib/config';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { t } from '../lib/i18n';
import { sendEmail } from '../lib/notify';
import { audit, email, fail, newId, oneOf, readJson, reqStr, str } from '../lib/util';

const app = new Hono<AppEnv>();

const MAX_FAILED_PASSWORDS = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 12;

async function rateLimit(c: { env: AppEnv['Bindings']; req: { header: (n: string) => string | undefined } }, key: string) {
  if (!c.env.AUTH_LIMITER) return;
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const { success } = await c.env.AUTH_LIMITER.limit({ key: `${ip}:${key}` });
  if (!success) fail(429, 'rate_limited', 'Too many attempts. Try again in a minute.');
}

interface LoginUser {
  id: string;
  role: Role;
  locale: string;
  password_hash: string | null;
  active: number;
  require_password: number;
  locked: number;
}

const LOGIN_USER_SQL = `SELECT id, role, locale, password_hash, active, require_password,
  (locked_until IS NOT NULL AND locked_until > datetime('now')) AS locked FROM users WHERE `;

// Password login, or (no password) request a magic link. Never reveals whether the email exists.
app.post('/login', async (c) => {
  const body = await readJson(c);
  const addr = reqStr(body, 'email', { max: 254, pattern: email }).toLowerCase();
  const password = str(body, 'password', { optional: true, max: 200 });
  await rateLimit(c, addr);

  await ensureOwner(c.env, addr);
  const user = await c.env.DB.prepare(`${LOGIN_USER_SQL} email = ?`).bind(addr).first<LoginUser>();

  if (password) {
    if (!user?.active || !(await passwordMatches(c.env, user, password))) fail(401, 'invalid_credentials');
    return c.json(await issueTokens(c.env, user!, 2));
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
    if (devLoginAllowed(c.env)) devToken = token;
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
  const user = await c.env.DB.prepare('SELECT id, role, require_password FROM users WHERE id = ? AND active = 1').bind(row!.user_id).first<{ id: string; role: Role; require_password: number }>();
  if (!user) fail(401, 'inactive_user');
  // The emailed link only proves the mailbox. Accounts that need a password stay at level 1 until it is entered.
  return c.json(await issueTokens(c.env, user!, user!.require_password ? 1 : 2));
});

// Rotating refresh tokens: each refresh revokes the old session row. A refresh keeps the trust level it started with.
app.post('/refresh', async (c) => {
  const token = reqStr(await readJson(c), 'refresh_token', { max: 100 });
  const row = await c.env.DB.prepare(
    `UPDATE sessions SET revoked_at = datetime('now')
     WHERE refresh_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')
     RETURNING user_id, aal`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string; aal: number }>();
  if (!row) fail(401, 'invalid_refresh_token');
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').bind(row!.user_id).first<{ id: string; role: Role }>();
  if (!user) fail(401, 'inactive_user');
  return c.json(await issueTokens(c.env, user!, row!.aal === 1 ? 1 : 2));
});

// Second step: a signed-in level-1 session proves the password and gets a full session.
app.post('/step-up', requireSignedIn(), async (c) => {
  const password = reqStr(await readJson(c), 'password', { max: 200 });
  const user = await c.env.DB.prepare(`${LOGIN_USER_SQL} id = ?`).bind(c.get('user').id).first<LoginUser>();
  if (!user?.active || !(await passwordMatches(c.env, user, password))) fail(401, 'invalid_credentials');
  return c.json(await issueTokens(c.env, user!, 2));
});

app.post('/logout', async (c) => {
  const token = str(await readJson(c), 'refresh_token', { max: 100, optional: true });
  if (token) await c.env.DB.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE refresh_hash = ?`).bind(await sha256(token)).run();
  return c.json({ ok: true });
});

// Set or change your password. Accounts that require a password may set the FIRST one from a level-1 session
// (the mailbox is the only proof they have at that point); changing an existing one needs the current password.
app.post('/password', requireSignedIn(), async (c) => {
  const body = await readJson(c);
  const password = reqStr(body, 'password', { max: 200 });
  const current = str(body, 'current_password', { optional: true, max: 200 });
  if (password.length < MIN_PASSWORD_LENGTH) fail(400, 'weak_password', `Use at least ${MIN_PASSWORD_LENGTH} characters`);

  const me = c.get('user');
  const user = await c.env.DB.prepare(`${LOGIN_USER_SQL} id = ?`).bind(me.id).first<LoginUser>();
  if (!user?.active) fail(401, 'inactive_user');

  if (user!.require_password && user!.password_hash) {
    if (!current) fail(403, 'current_password_required', 'Enter your current password to change it.');
    if (!(await passwordMatches(c.env, user!, current!))) fail(401, 'invalid_credentials');
  }

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(await hashPassword(password), me.id),
    audit(c.env.DB, me.id, user!.password_hash ? 'password.change' : 'password.set', 'user', me.id),
  ]);
  // They just proved (or chose) a password, so hand back a full session to continue with.
  return c.json({ ok: true, ...(await issueTokens(c.env, { id: me.id, role: me.role }, 2)) });
});

export default app;

// ---- Helpers ----------------------------------------------------------------

/**
 * The owner account: if MASTER_EMAIL is set and this is that address, make sure the user exists as an admin
 * who must use a password. Any other address never creates an account here.
 */
async function ensureOwner(env: Env, addr: string) {
  const owner = env.MASTER_EMAIL?.trim().toLowerCase();
  if (!owner || addr !== owner) return;
  await env.DB.prepare(
    `INSERT INTO users (id, email, role, display_name, require_password) VALUES (?, ?, 'admin', 'Owner', 1)
     ON CONFLICT(email) DO UPDATE SET require_password = 1`,
  )
    .bind(newId(), addr)
    .run();
}

/** Checks a password and keeps the failure count. 5 wrong in a row locks the account for 15 minutes. */
async function passwordMatches(env: Env, user: LoginUser, password: string): Promise<boolean> {
  if (user.locked) fail(429, 'account_locked', `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes.`);
  if (await verifyPassword(password, user.password_hash)) {
    await env.DB.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(user.id).run();
    return true;
  }
  // The right-hand side sees the old count, so the 5th miss (old count 4) locks and starts the next round at 0.
  await env.DB.prepare(
    `UPDATE users SET
       locked_until = CASE WHEN failed_attempts + 1 >= ? THEN datetime('now', '+${LOCK_MINUTES} minutes') ELSE locked_until END,
       failed_attempts = CASE WHEN failed_attempts + 1 >= ? THEN 0 ELSE failed_attempts + 1 END
     WHERE id = ?`,
  )
    .bind(MAX_FAILED_PASSWORDS, MAX_FAILED_PASSWORDS, user.id)
    .run();
  return false;
}

// ---- Profile & devices (mounted at /v1) ----------------------------------

export const me = new Hono<AppEnv>();

// Open to level-1 sessions so the console knows whether to show "enter your password".
me.get('/me', requireSignedIn(), async (c) => {
  const u = await c.env.DB.prepare('SELECT id, email, role, display_name, phone, locale, crew_id, require_password, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?')
    .bind(c.get('user').id)
    .first<Record<string, unknown>>();
  return c.json({ ...u, has_password: !!u?.has_password, aal: c.get('user').aal });
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

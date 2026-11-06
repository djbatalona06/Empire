import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { issueTokens, requireAuth } from '../lib/auth';
import { devLoginAllowed } from '../lib/config';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { t } from '../lib/i18n';
import { sendEmail } from '../lib/notify';
import { audit, email, fail, oneOf, readJson, reqStr, str } from '../lib/util';

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

  const user = await c.env.empire_accounts.prepare('SELECT id, role, locale, password_hash, active FROM users WHERE email = ?')
    .bind(addr)
    .first<{ id: string; role: 'customer'; locale: string; password_hash: string | null; active: number }>();

  if (password) {
    if (!user?.active || !(await verifyPassword(password, user.password_hash))) fail(401, 'invalid_credentials');
    return c.json(await issueTokens(c.env, user!));
  }

  let devToken: string | undefined;
  if (user?.active) {
    const token = randomToken();
    await c.env.empire_accounts.prepare(`INSERT INTO magic_links (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))`)
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
  const row = await c.env.empire_accounts.prepare(
    `UPDATE magic_links SET used_at = datetime('now')
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
     RETURNING user_id`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string }>();
  if (!row) fail(401, 'invalid_or_expired_link');
  const user = await c.env.empire_accounts.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').bind(row!.user_id).first<{ id: string; role: 'customer' }>();
  if (!user) fail(401, 'inactive_user');
  return c.json(await issueTokens(c.env, user!));
});

// Rotating refresh tokens: each refresh revokes the old session row.
app.post('/refresh', async (c) => {
  const token = reqStr(await readJson(c), 'refresh_token', { max: 100 });
  const row = await c.env.empire_accounts.prepare(
    `UPDATE sessions SET revoked_at = datetime('now')
     WHERE refresh_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')
     RETURNING user_id`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string }>();
  if (!row) fail(401, 'invalid_refresh_token');
  const user = await c.env.empire_accounts.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').bind(row!.user_id).first<{ id: string; role: 'customer' }>();
  if (!user) fail(401, 'inactive_user');
  return c.json(await issueTokens(c.env, user!));
});

app.post('/logout', async (c) => {
  const token = str(await readJson(c), 'refresh_token', { max: 100, optional: true });
  if (token) await c.env.empire_accounts.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE refresh_hash = ?`).bind(await sha256(token)).run();
  return c.json({ ok: true });
});

app.post('/password', requireAuth(), async (c) => {
  const password = reqStr(await readJson(c), 'password', { max: 200 });
  if (password.length < 12) fail(400, 'weak_password', 'Use at least 12 characters');
  await c.env.empire_accounts.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), c.get('user').id).run();
  return c.json({ ok: true });
});

// ---- Per-device PIN (quick sign-in) ----------------------------------------
// A PIN unlocks one device that has already signed in. It is never a shared code: each person sets their own,
// and five wrong tries lock that device until a full sign-in and a new PIN reset it.

const PIN_MAX_FAILS = 5;
const DEVICE_ID = /^[A-Za-z0-9-]{16,64}$/;
const PIN = /^\d{4,8}$/;

// Refuse PINs anyone would guess first: all one digit, or counting up or down.
function checkPin(pin: string) {
  const repeated = /^(\d)\1+$/.test(pin);
  const sequential = '0123456789'.includes(pin) || '9876543210'.includes(pin);
  if (repeated || sequential) fail(400, 'weak_pin', 'Use 4 to 8 digits that are not all the same or in a row.');
}

// Enter the PIN. The attempt is counted before it is checked, so parallel guesses cannot skip the count.
app.post('/pin', async (c) => {
  const body = await readJson(c);
  const deviceId = reqStr(body, 'device_id', { pattern: DEVICE_ID });
  const pin = reqStr(body, 'pin', { pattern: PIN });
  await rateLimit(c, `pin:${deviceId}`);

  const claimed = await c.env.empire_accounts.prepare(
    `UPDATE device_pins SET failed_attempts = failed_attempts + 1 WHERE device_id = ? AND failed_attempts < ? RETURNING user_id, pin_hash`,
  )
    .bind(deviceId, PIN_MAX_FAILS)
    .first<{ user_id: string; pin_hash: string }>();
  if (!claimed) {
    const exists = await c.env.empire_accounts.prepare('SELECT 1 FROM device_pins WHERE device_id = ?').bind(deviceId).first();
    if (!exists) fail(401, 'invalid_pin', 'That PIN did not match.');
    fail(403, 'pin_locked', 'Too many wrong PINs on this device. Sign in with your password or email link to reset it.');
  }

  const user = await c.env.empire_accounts.prepare('SELECT id, role, active FROM users WHERE id = ?').bind(claimed!.user_id).first<{ id: string; role: 'customer'; active: number }>();
  if (!user?.active || !(await verifyPassword(pin, claimed!.pin_hash))) fail(401, 'invalid_pin', 'That PIN did not match.');

  await c.env.empire_accounts.prepare('UPDATE device_pins SET failed_attempts = 0, updated_at = datetime(\'now\') WHERE device_id = ?').bind(deviceId).run();
  return c.json(await issueTokens(c.env, user!));
});

// Lets the app decide whether to show the PIN pad or the normal sign-in, without revealing anything else.
app.get('/pin/status', async (c) => {
  const deviceId = c.req.query('device_id') ?? '';
  if (!DEVICE_ID.test(deviceId)) return c.json({ set: false, locked: false });
  const row = await c.env.empire_accounts.prepare('SELECT failed_attempts FROM device_pins WHERE device_id = ?').bind(deviceId).first<{ failed_attempts: number }>();
  return c.json({ set: !!row, locked: !!row && row.failed_attempts >= PIN_MAX_FAILS });
});

export default app;

// ---- Profile & devices (mounted at /v1) ----------------------------------

export const me = new Hono<AppEnv>();

me.get('/me', requireAuth(), async (c) => {
  const u = await c.env.empire_accounts.prepare('SELECT id, email, role, display_name, phone, locale, crew_id FROM users WHERE id = ?').bind(c.get('user').id).first();
  return c.json(u);
});

me.patch('/me', requireAuth(), async (c) => {
  const body = await readJson(c);
  const locale = oneOf(body, 'locale', ['en', 'es'] as const, true);
  const name = str(body, 'display_name', { optional: true, max: 100 });
  await c.env.empire_accounts.prepare('UPDATE users SET locale = COALESCE(?, locale), display_name = COALESCE(?, display_name) WHERE id = ?')
    .bind(locale ?? null, name ?? null, c.get('user').id)
    .run();
  return c.json({ ok: true });
});

me.post('/devices', requireAuth(), async (c) => {
  const body = await readJson(c);
  const token = reqStr(body, 'apns_token', { max: 200, pattern: /^[0-9a-f]{64,200}$/i });
  const env = oneOf(body, 'env', ['sandbox', 'production'] as const, true) ?? 'production';
  await c.env.empire_accounts.prepare(
    `INSERT INTO devices (apns_token, user_id, env) VALUES (?, ?, ?)
     ON CONFLICT(apns_token) DO UPDATE SET user_id = excluded.user_id, env = excluded.env, updated_at = datetime('now')`,
  )
    .bind(token, c.get('user').id, env)
    .run();
  return c.json({ ok: true });
});

me.delete('/devices/:token', requireAuth(), async (c) => {
  await c.env.empire_accounts.prepare('DELETE FROM devices WHERE apns_token = ? AND user_id = ?').bind(c.req.param('token'), c.get('user').id).run();
  return c.json({ ok: true });
});

// Sets or replaces this device's PIN. Needs a signed-in session, so a PIN can only be added by someone who has
// already proved who they are. Setting one also clears any lock on the device.
me.put('/me/pin', requireAuth(), async (c) => {
  const body = await readJson(c);
  const deviceId = reqStr(body, 'device_id', { pattern: DEVICE_ID });
  const pin = reqStr(body, 'pin', { pattern: PIN });
  checkPin(pin);
  const userId = c.get('user').id;

  const existing = await c.env.empire_accounts.prepare('SELECT user_id FROM device_pins WHERE device_id = ?').bind(deviceId).first<{ user_id: string }>();
  if (existing && existing.user_id !== userId) fail(409, 'device_in_use', 'This device is set up for another account.');

  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare(
      `INSERT INTO device_pins (device_id, user_id, pin_hash, failed_attempts) VALUES (?, ?, ?, 0)
       ON CONFLICT(device_id) DO UPDATE SET pin_hash = excluded.pin_hash, failed_attempts = 0, updated_at = datetime('now')`,
    ).bind(deviceId, userId, await hashPassword(pin)),
    audit(c.env.empire_accounts, userId, 'device_pin.set', 'user', userId, { device: deviceId.slice(-4) }),
  ]);
  return c.json({ ok: true });
});

me.delete('/me/pin/:deviceId', requireAuth(), async (c) => {
  const deviceId = c.req.param('deviceId');
  await c.env.empire_accounts.batch([
    c.env.empire_accounts.prepare('DELETE FROM device_pins WHERE device_id = ? AND user_id = ?').bind(deviceId, c.get('user').id),
    audit(c.env.empire_accounts, c.get('user').id, 'device_pin.remove', 'user', c.get('user').id, { device: deviceId.slice(-4) }),
  ]);
  return c.json({ ok: true });
});

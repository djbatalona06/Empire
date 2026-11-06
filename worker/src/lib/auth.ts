import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { AppEnv, AuthUser, Env, Role } from '../env';
import { randomToken, sha256 } from './crypto';
import { fail, newId } from './util';

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL_DAYS = 30;

export async function issueTokens(env: Env, user: { id: string; role: Role }) {
  const now = Math.floor(Date.now() / 1000);
  const access_token = await sign({ sub: user.id, role: user.role, iat: now, exp: now + ACCESS_TTL }, env.JWT_SECRET, 'HS256');
  const refresh_token = randomToken();
  await env.empire_accounts.prepare(`INSERT INTO sessions (id, user_id, refresh_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+${REFRESH_TTL_DAYS} days'))`)
    .bind(newId(), user.id, await sha256(refresh_token))
    .run();
  return { access_token, refresh_token, expires_in: ACCESS_TTL };
}

/**
 * Verifies the bearer JWT, then re-reads the user so role changes and deactivation apply immediately.
 * Pass roles to restrict the route; no roles = any signed-in user.
 */
export const requireAuth = (...roles: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) fail(401, 'unauthorized');
    const payload = await verify(header!.slice(7), c.env.JWT_SECRET, 'HS256').catch(() => fail(401, 'invalid_token'));
    const user = await c.env.empire_accounts.prepare('SELECT id, role, locale, crew_id, active FROM users WHERE id = ?')
      .bind(payload.sub)
      .first<AuthUser & { active: number }>();
    if (!user || !user.active) fail(401, 'inactive_user');
    if (roles.length && !roles.includes(user!.role)) fail(403, 'forbidden');
    c.set('user', { id: user!.id, role: user!.role, locale: user!.locale, crew_id: user!.crew_id });
    await next();
  });

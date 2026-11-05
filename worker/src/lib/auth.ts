import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import type { AppEnv, AssuranceLevel, AuthUser, Env, Role } from '../env';
import { randomToken, sha256 } from './crypto';
import { fail, newId } from './util';

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL_DAYS = 30;

/**
 * Signs an access token and stores the matching refresh token.
 * `aal` is how far the person has proved who they are (1 = mailbox, 2 = mailbox + password).
 */
export async function issueTokens(env: Env, user: { id: string; role: Role }, aal: AssuranceLevel = 2) {
  const now = Math.floor(Date.now() / 1000);
  const access_token = await sign({ sub: user.id, role: user.role, aal, iat: now, exp: now + ACCESS_TTL }, env.JWT_SECRET, 'HS256');
  const refresh_token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (id, user_id, refresh_hash, expires_at, aal) VALUES (?, ?, ?, datetime('now', '+${REFRESH_TTL_DAYS} days'), ?)`)
    .bind(newId(), user.id, await sha256(refresh_token), aal)
    .run();
  return { access_token, refresh_token, expires_in: ACCESS_TTL };
}

/**
 * Verifies the bearer JWT, then re-reads the user so role changes and deactivation apply immediately.
 * Pass roles to restrict the route; no roles = any signed-in user.
 *
 * Users flagged `require_password` need a level-2 session. A level-1 session (emailed link only) is turned away
 * with 403 `password_required`, so one guard protects every route that returns real data.
 */
export const requireAuth = (...roles: Role[]) => guard(false, roles);

/**
 * Same as requireAuth but also lets a level-1 session through. Only for the few routes a person needs
 * in order to finish signing in: reading their own profile, setting a password, and the password step.
 */
export const requireSignedIn = (...roles: Role[]) => guard(true, roles);

const guard = (allowLimited: boolean, roles: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) fail(401, 'unauthorized');
    const payload = await verify(header!.slice(7), c.env.JWT_SECRET, 'HS256').catch(() => fail(401, 'invalid_token'));
    const user = await c.env.DB.prepare('SELECT id, role, locale, crew_id, active, require_password FROM users WHERE id = ?')
      .bind(payload.sub)
      .first<Omit<AuthUser, 'aal'> & { active: number; require_password: number }>();
    if (!user || !user.active) fail(401, 'inactive_user');
    if (roles.length && !roles.includes(user!.role)) fail(403, 'forbidden');

    // Tokens issued before the owner gate existed carry no level; they were full sign-ins.
    const aal: AssuranceLevel = payload.aal === 1 ? 1 : 2;
    if (user!.require_password && aal < 2 && !allowLimited) fail(403, 'password_required', 'Enter your password to see this.');

    c.set('user', { id: user!.id, role: user!.role, locale: user!.locale, crew_id: user!.crew_id, aal });
    await next();
  });

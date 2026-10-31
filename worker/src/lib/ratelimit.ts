import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { fail } from './util';

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

// Signed uploads are protected by their signature, and the processor webhook by its own signature check.
const EXEMPT = [/^\/v1\/files\//, /^\/v1\/webhooks\//];

/**
 * Limits every write to /v1 (including sign-in, verify and refresh). The key is the caller's token, not the
 * network address, so 50 office staff behind one shared internet connection never throttle each other.
 * Does nothing when the API_LIMITER binding is absent (local dev and tests).
 */
export const limitWrites = createMiddleware<AppEnv>(async (c, next) => {
  const limiter = c.env.API_LIMITER;
  if (!limiter || READ_ONLY.has(c.req.method) || EXEMPT.some((re) => re.test(new URL(c.req.url).pathname))) return next();
  const bearer = c.req.header('authorization')?.slice(-24);
  const key = bearer ? `t:${bearer}` : `ip:${c.req.header('cf-connecting-ip') ?? 'local'}`;
  const { success } = await limiter.limit({ key });
  if (!success) fail(429, 'rate_limited', 'Too many requests. Wait a moment and try again.');
  await next();
});

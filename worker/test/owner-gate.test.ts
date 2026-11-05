import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { api as rawApi } from './helpers';

// vitest.config.ts sets MASTER_EMAIL to this address (a made-up one, never a real mailbox).
const MASTER = 'owner@example.test';
const GOOD_PASSWORD = 'correct horse battery staple';

// The sign-in limiter allows 10 tries a minute per network address + email. Each test pretends to be a
// different visitor, so tests do not use up each other's allowance.
let clientIp = '10.0.0.1';
beforeEach(() => {
  clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
});
const api: typeof rawApi = (path, opts = {}) => rawApi(path, { ...opts, headers: { 'cf-connecting-ip': clientIp, ...opts.headers } });

describe('owner account: email gets you in the door, password unlocks the data', () => {
  it('creates the owner on first sign-in and gives a limited session', async () => {
    const t = await magicSession(MASTER);
    expect(decode(t.access_token).aal).toBe(1);

    const me = await api('/v1/me', { token: t.access_token });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: MASTER, role: 'admin', aal: 1, require_password: 1, has_password: false });
  });

  it('keeps invoices, orders, leads and admin data locked until the password step', async () => {
    const t = await magicSession(MASTER);
    for (const path of ['/v1/orders', '/v1/invoices', '/v1/leads', '/v1/admin/metrics', '/v1/catalog']) {
      const res = await api(path, { token: t.access_token });
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe('password_required');
    }
  });

  it('lets the owner set a first password from the limited session, and that unlocks everything', async () => {
    await resetOwner();
    const t = await magicSession(MASTER);

    const weak = await api('/v1/auth/password', { token: t.access_token, body: { password: 'short' } });
    expect(weak.status).toBe(400);

    const set = await api('/v1/auth/password', { token: t.access_token, body: { password: GOOD_PASSWORD } });
    expect(set.status).toBe(200);
    expect(decode(set.body.access_token).aal).toBe(2);
    expect((await api('/v1/admin/metrics', { token: set.body.access_token })).status).toBe(200);
  });

  it('signs in with email + password straight to a full session', async () => {
    await ownerWithPassword();
    const res = await api('/v1/auth/login', { body: { email: MASTER, password: GOOD_PASSWORD } });
    expect(res.status).toBe(200);
    expect(decode(res.body.access_token).aal).toBe(2);
  });

  it('only gives a limited session to someone who opens the emailed link, even after a password exists', async () => {
    await ownerWithPassword();
    const t = await magicSession(MASTER);
    expect(decode(t.access_token).aal).toBe(1);
    expect((await api('/v1/orders', { token: t.access_token })).status).toBe(403);
  });

  it('upgrades a limited session with the password (step-up)', async () => {
    await ownerWithPassword();
    const t = await magicSession(MASTER);

    const wrong = await api('/v1/auth/step-up', { token: t.access_token, body: { password: 'not the password!!' } });
    expect(wrong.status).toBe(401);

    const ok = await api('/v1/auth/step-up', { token: t.access_token, body: { password: GOOD_PASSWORD } });
    expect(ok.status).toBe(200);
    expect(decode(ok.body.access_token).aal).toBe(2);
    expect((await api('/v1/orders', { token: ok.body.access_token })).status).toBe(200);
  });

  it('will not change an existing password without the current one', async () => {
    await ownerWithPassword();
    const t = await magicSession(MASTER);

    const none = await api('/v1/auth/password', { token: t.access_token, body: { password: 'another long password 1' } });
    expect(none.status).toBe(403);
    expect(none.body.error).toBe('current_password_required');

    const wrong = await api('/v1/auth/password', { token: t.access_token, body: { password: 'another long password 1', current_password: 'nope nope nope nope' } });
    expect(wrong.status).toBe(401);

    const ok = await api('/v1/auth/password', { token: t.access_token, body: { password: 'another long password 1', current_password: GOOD_PASSWORD } });
    expect(ok.status).toBe(200);
  });

  it('keeps the trust level when a refresh token is used', async () => {
    await ownerWithPassword();
    const limited = await magicSession(MASTER);
    const refreshed = await api('/v1/auth/refresh', { body: { refresh_token: limited.refresh_token } });
    expect(refreshed.status).toBe(200);
    expect(decode(refreshed.body.access_token).aal).toBe(1);

    const full = await api('/v1/auth/login', { body: { email: MASTER, password: GOOD_PASSWORD } });
    const refreshedFull = await api('/v1/auth/refresh', { body: { refresh_token: full.body.refresh_token } });
    expect(decode(refreshedFull.body.access_token).aal).toBe(2);
  });

  it('locks the account for 15 minutes after 5 wrong passwords, then recovers', async () => {
    await ownerWithPassword();
    for (let i = 0; i < 5; i++) {
      const bad = await api('/v1/auth/login', { body: { email: MASTER, password: `wrong password ${i} xx` } });
      expect(bad.status).toBe(401);
    }
    const locked = await api('/v1/auth/login', { body: { email: MASTER, password: GOOD_PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('account_locked');

    await env.DB.prepare(`UPDATE users SET locked_until = datetime('now', '-1 minute') WHERE email = ?`).bind(MASTER).run();
    const again = await api('/v1/auth/login', { body: { email: MASTER, password: GOOD_PASSWORD } });
    expect(again.status).toBe(200);
  });

  it('does not create accounts for other emails and does not reveal who exists', async () => {
    const stranger = `stranger-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const res = await api('/v1/auth/login', { body: { email: stranger } });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(res.body.dev_token).toBeUndefined();
    const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(stranger).first();
    expect(row).toBeNull();
  });

  it('applies the same gate to any user marked require_password', async () => {
    const email = `office-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await env.DB.prepare(`INSERT INTO users (id, email, role, display_name, require_password) VALUES (?, ?, 'office', 'Gated Office', 1)`).bind(crypto.randomUUID(), email).run();
    const t = await magicSession(email);
    expect((await api('/v1/invoices', { token: t.access_token })).status).toBe(403);
  });

  it('leaves everyone else on the old one-step sign-in', async () => {
    const email = `rep-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await env.DB.prepare(`INSERT INTO users (id, email, role, display_name) VALUES (?, ?, 'coworker', 'Plain Rep')`).bind(crypto.randomUUID(), email).run();
    const t = await magicSession(email);
    expect(decode(t.access_token).aal).toBe(2);
    expect((await api('/v1/leads', { token: t.access_token })).status).toBe(200);
  });
});

// ---- helpers ---------------------------------------------------------------

/** Requests a magic link (local dev hands the token back) and redeems it. */
async function magicSession(email: string) {
  const sent = await api('/v1/auth/login', { body: { email } });
  expect(sent.status).toBe(200);
  const verified = await api('/v1/auth/verify', { body: { token: sent.body.dev_token } });
  expect(verified.status).toBe(200);
  return verified.body as { access_token: string; refresh_token: string };
}

/** Puts the owner back to "no password, not locked" so tests do not depend on each other. */
async function resetOwner() {
  await env.DB.prepare(`UPDATE users SET password_hash = NULL, failed_attempts = 0, locked_until = NULL WHERE email = ?`).bind(MASTER).run();
}

async function ownerWithPassword() {
  await resetOwner();
  const t = await magicSession(MASTER);
  const set = await api('/v1/auth/password', { token: t.access_token, body: { password: GOOD_PASSWORD } });
  expect(set.status).toBe(200);
}

function decode(jwt: string): { aal: number; sub: string } {
  return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
}

import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { configProblem, devLoginAllowed } from '../src/lib/config';
import { hmac } from '../src/lib/crypto';
import { api, orderFlow, user } from './helpers';

const stripeEvent = async (object: Record<string, unknown>) => {
  const payload = JSON.stringify({ type: 'payment_intent.succeeded', data: { object } });
  const t = Math.floor(Date.now() / 1000);
  return { raw: payload, headers: { 'stripe-signature': `t=${t},v1=${await hmac('whsec_test', `${t}.${payload}`)}` } };
};

describe('health and request ids', () => {
  it('checks the database and file storage', async () => {
    const res = await api('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ db: true, files: true });
  });

  it('puts a request id on every response', async () => {
    const worker = (exports as unknown as { default: Fetcher }).default;
    const r = await worker.fetch(new Request('http://dealerdoor.test/v1/health', { headers: { 'x-request-id': 'abc-123' } }));
    expect(r.headers.get('x-request-id')).toBe('abc-123');
  });
});

describe('configuration safety', () => {
  const base = { JWT_SECRET: 'x'.repeat(40), ENVIRONMENT: 'development', PUBLIC_BASE_URL: 'http://localhost:8787' } as never;

  it('rejects a missing or short signing secret', () => {
    expect(configProblem(base)).toBeNull();
    expect(configProblem({ ...(base as object), JWT_SECRET: 'short' } as never)).toMatch(/JWT_SECRET/);
    expect(configProblem({ ...(base as object), FILE_SIGNING_SECRET: 'short' } as never)).toMatch(/FILE_SIGNING_SECRET/);
  });

  it('only allows the dev sign-in shortcut on localhost in development', () => {
    expect(devLoginAllowed(base)).toBe(true);
    expect(devLoginAllowed({ ...(base as object), PUBLIC_BASE_URL: 'https://api.example.com' } as never)).toBe(false);
    expect(devLoginAllowed({ ...(base as object), ENVIRONMENT: 'production' } as never)).toBe(false);
    expect(devLoginAllowed({ ...(base as object), PUBLIC_BASE_URL: 'http://localhost.evil.com' } as never)).toBe(false);
  });
});

describe('admin user guards', () => {
  it('stops an admin from demoting or deactivating themselves', async () => {
    const me = await user('admin');
    const demote = await api(`/v1/admin/users/${me.id}`, { method: 'PATCH', token: me.token, body: { role: 'office' } });
    expect(demote.status).toBe(409);
    expect(demote.body.error).toBe('cannot_demote_self');
    expect((await api(`/v1/admin/users/${me.id}`, { method: 'PATCH', token: me.token, body: { active: false } })).status).toBe(409);
  });

  it('keeps at least one active admin', async () => {
    await env.DB.prepare(`UPDATE users SET active = 0 WHERE role = 'admin'`).run();
    const a = await user('admin');
    const lone = await api(`/v1/admin/users/${a.id}`, { method: 'PATCH', token: a.token, body: { active: false } });
    expect(lone.status).toBe(409);
    // A second admin can be demoted by the first one, and the first one is then the only admin left.
    const b = await user('admin');
    expect((await api(`/v1/admin/users/${b.id}`, { method: 'PATCH', token: a.token, body: { role: 'office' } })).status).toBe(200);
    expect((await api(`/v1/admin/users/${a.id}`, { method: 'PATCH', token: a.token, body: { role: 'office' } })).status).toBe(409);
  });

  it('can remove a user from a crew with crew_id null, and leaves the crew alone when the key is missing', async () => {
    const admin = await user('admin');
    await env.DB.prepare(`INSERT INTO crews (id, name) VALUES ('crew-p0', 'Phase zero crew')`).run();
    const rep = await user('coworker', { crew_id: 'crew-p0' });
    await api(`/v1/admin/users/${rep.id}`, { method: 'PATCH', token: admin.token, body: { display_name: 'Renamed' } });
    expect((await env.DB.prepare('SELECT crew_id FROM users WHERE id = ?').bind(rep.id).first())?.crew_id).toBe('crew-p0');
    await api(`/v1/admin/users/${rep.id}`, { method: 'PATCH', token: admin.token, body: { crew_id: null } });
    expect((await env.DB.prepare('SELECT crew_id FROM users WHERE id = ?').bind(rep.id).first())?.crew_id).toBeNull();
  });

  it('answers 404 for a user that does not exist and hides database errors on duplicates', async () => {
    const admin = await user('admin');
    expect((await api('/v1/admin/users/nope', { method: 'PATCH', token: admin.token, body: { display_name: 'x' } })).status).toBe(404);
    const dup = await api('/v1/admin/users', { token: admin.token, body: { email: admin.email, role: 'office', display_name: 'Twin' } });
    expect(dup.status).toBe(409);
    expect(dup.body.message).not.toMatch(/UNIQUE|SQLITE/i);
  });
});

describe('processor webhook cross-checks', () => {
  it('ignores a signed event whose amount is more than the invoice balance', async () => {
    const { office, orderId } = await orderFlow();
    const inv = await api('/v1/invoices', { token: office.token, body: { order_id: orderId, amount_cents: 5000, payment_term_days: 0, description: 'Fee', send: true } });
    const res = await api('/v1/webhooks/stripe', await stripeEvent({ id: 'pi_too_much', amount: 999999, currency: 'usd', metadata: { invoice_id: inv.body.id, method: 'card' } }));
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect((await env.DB.prepare('SELECT amount_paid_cents FROM invoices WHERE id = ?').bind(inv.body.id).first())?.amount_paid_cents).toBe(0);
  });

  it('ignores a payment in another currency or for an unknown invoice', async () => {
    const { office, orderId } = await orderFlow();
    const inv = await api('/v1/invoices', { token: office.token, body: { order_id: orderId, amount_cents: 5000, payment_term_days: 0, description: 'Fee', send: true } });
    expect((await api('/v1/webhooks/stripe', await stripeEvent({ id: 'pi_cad', amount: 5000, currency: 'cad', metadata: { invoice_id: inv.body.id } }))).body.ignored).toBe(true);
    expect((await api('/v1/webhooks/stripe', await stripeEvent({ id: 'pi_ghost', amount: 5000, currency: 'usd', metadata: { invoice_id: 'does-not-exist' } }))).body.ignored).toBe(true);
  });

  it('rejects a body that is not JSON (after the signature check)', async () => {
    const t = Math.floor(Date.now() / 1000);
    const raw = 'not json';
    const res = await api('/v1/webhooks/stripe', { raw, headers: { 'stripe-signature': `t=${t},v1=${await hmac('whsec_test', `${t}.${raw}`)}` } });
    expect(res.status).toBe(400);
  });
});

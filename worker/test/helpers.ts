import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';

const worker = (exports as unknown as { default: Fetcher }).default;

// A point at SeaTac City Hall and one in downtown Seattle.
export const SEATAC = { lat: 47.437, lng: -122.277 };
export const SEATTLE = { lat: 47.6062, lng: -122.3321 };

export type Res = { status: number; body: any };
export async function api(path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}): Promise<Res> {
  const res = await worker.fetch(
    new Request(`http://dealerdoor.test${path}`, {
      method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(opts.token && { authorization: `Bearer ${opts.token}` }), ...opts.headers },
      body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    }),
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function user(role: string, extra: { crew_id?: string; email?: string } = {}) {
  const id = crypto.randomUUID();
  const email = extra.email ?? `${role}-${id.slice(0, 8)}@example.com`;
  await env.DB.prepare('INSERT INTO users (id, email, role, display_name, crew_id) VALUES (?, ?, ?, ?, ?)').bind(id, email, role, `${role} ${id.slice(0, 4)}`, extra.crew_id ?? null).run();
  return { id, email, token: await login(email) };
}

export async function login(email: string) {
  const sent = await api('/v1/auth/login', { body: { email } });
  expect(sent.body.sent).toBe(true);
  const verified = await api('/v1/auth/verify', { body: { token: sent.body.dev_token } });
  expect(verified.status).toBe(200);
  return verified.body.access_token as string;
}

export async function property(opts: { lat?: number; lng?: number; dnk?: boolean; address?: string } = {}) {
  const id = crypto.randomUUID();
  const address = opts.address ?? `${Math.floor(Math.random() * 9000) + 1000} S 188th St, SeaTac, WA 98188`;
  await env.DB.prepare('INSERT INTO properties (id, address, address_norm, zip, lat, lng, seatac_valid, do_not_knock) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .bind(id, address, `${address.toUpperCase()}-${id}`, '98188', opts.lat ?? SEATAC.lat, opts.lng ?? SEATAC.lng, opts.dnk ? 1 : 0)
    .run();
  return id;
}

export const leadBody = (property_id: string, email = `cust-${crypto.randomUUID().slice(0, 8)}@example.com`) => ({
  id: crypto.randomUUID(),
  property_id,
  customer_name: 'Ana Customer',
  phone: '206-555-0100',
  email,
  product_interest: ['internet'],
  tcpa_accepted: true,
  disclosure_accepted: true,
  consent_text_version: 'v1',
  ...SEATAC,
});

/** Rep captures a lead and submits an order; returns everything later steps need. */
export async function orderFlow() {
  const rep = await user('coworker');
  const office = await user('office');
  const lead = leadBody(await property());
  expect((await api('/v1/leads', { token: rep.token, body: lead })).status).toBe(201);
  const order = await api('/v1/orders', { token: rep.token, body: { lead_id: lead.id, skus: ['AIR', 'TV-STREAM'] } });
  expect(order.status).toBe(201);
  const customerToken = await login(lead.email);
  return { rep, office, lead, orderId: order.body.id as string, customerToken };
}

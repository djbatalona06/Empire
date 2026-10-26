import { expect, test, type APIRequestContext } from '@playwright/test';

// Walks the API in the same order the iOS app does, so a backend change that would break the app fails here first.
// It also leaves a demo customer (customer@dealerdoor.test) with an order and invoices for the iOS customer UI test.

const CUSTOMER = 'customer@dealerdoor.test';
const DOOR = { lat: 47.437, lng: -122.277 }; // seeded property p1

async function signIn(request: APIRequestContext, email: string) {
  const sent = await request.post('/v1/auth/login', { data: { email } });
  expect(sent.ok()).toBeTruthy();
  const { dev_token } = await sent.json();
  expect(dev_token, 'dev_token only exists in development').toBeTruthy();
  const verified = await request.post('/v1/auth/verify', { data: { token: dev_token } });
  expect(verified.ok()).toBeTruthy();
  const { access_token } = await verified.json();
  return { authorization: `Bearer ${access_token}` };
}

test('coworker → customer flow the iOS app depends on', async ({ request }) => {
  const rep = await signIn(request, 'rep1@dealerdoor.test');
  expect((await (await request.get('/v1/me', { headers: rep })).json()).role).toBe('coworker');

  // Route tab
  const routes = await (await request.get('/v1/routes/mine', { headers: rep })).json();
  expect(routes[0].stops.length).toBeGreaterThan(0);
  expect((await request.get('/v1/service-area', { headers: rep })).ok()).toBeTruthy();
  expect((await request.get('/v1/dnk/map', { headers: rep })).ok()).toBeTruthy();
  const consent = await (await request.get('/v1/consent-texts', { headers: rep })).json();
  expect(JSON.stringify(consent)).toContain('v1');

  // Lead capture at the door
  const leadId = crypto.randomUUID();
  const lead = await request.post('/v1/leads', {
    headers: rep,
    data: {
      id: leadId, property_id: 'p1', customer_name: 'Casey Customer', phone: '206-555-0100', email: CUSTOMER,
      product_interest: ['internet'], tcpa_accepted: true, disclosure_accepted: true, consent_text_version: 'v1', ...DOOR,
    },
  });
  expect(lead.status()).toBe(201);
  const svc = await (await request.post(`/v1/leads/${leadId}/serviceability`, { headers: rep, data: {} })).json();
  expect(svc.serviceable).toBe(true);

  const order = await request.post('/v1/orders', { headers: rep, data: { lead_id: leadId, skus: ['AIR', 'TV-STREAM'] } });
  expect(order.status()).toBe(201);
  const orderId = (await order.json()).id as string;

  // Office schedules the install and bills two dealer fees: one paid, one still open.
  const office = await signIn(request, 'office@dealerdoor.test');
  const stages = await (await request.get(`/v1/orders/${orderId}/timeline`, { headers: office })).json();
  const scheduled = stages.find((s: { stage: string }) => s.stage === 'install_scheduled');
  const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
  expect((await request.patch(`/v1/timeline/${scheduled.id}`, { headers: office, data: { status: 'complete', at } })).ok()).toBeTruthy();
  const setup = await (await request.post('/v1/invoices', { headers: office, data: { order_id: orderId, amount_cents: 4900, payment_term_days: 0, description: 'Setup fee', send: true } })).json();
  const wiring = await (await request.post('/v1/invoices', { headers: office, data: { order_id: orderId, amount_cents: 9900, payment_term_days: 30, description: 'Inside wiring', send: true } })).json();

  // Customer app: My order, Invoices, pay (Stripe mock mode locally)
  const customer = await signIn(request, CUSTOMER);
  const mine = await (await request.get('/v1/orders', { headers: customer })).json();
  expect(mine.some((o: { id: string }) => o.id === orderId)).toBe(true);
  const detail = await (await request.get(`/v1/orders/${orderId}`, { headers: customer })).json();
  expect(detail.timeline.map((s: { key: string }) => s.key)).toContain('install_scheduled');
  expect(JSON.stringify(detail)).not.toContain('note_internal');

  const paid = await (await request.post(`/v1/invoices/${setup.id}/pay`, { headers: customer, data: { method: 'card' } })).json();
  expect(paid.invoice.status).toBe('paid');
  const open = await (await request.get(`/v1/invoices/${wiring.id}`, { headers: customer })).json();
  expect(open.status).toBe('viewed');
  expect((await request.get('/v1/feedback/customer/mine', { headers: customer })).ok()).toBeTruthy();
});

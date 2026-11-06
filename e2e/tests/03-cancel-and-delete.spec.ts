import { expect, test, type APIRequestContext } from '@playwright/test';

// A customer asks to cancel inside the cooling-off window, office sees the request in the admin console,
// then the customer deletes their account. Uses its own throwaway customer so the demo customer that
// the phone UI tests rely on (customer@dealerdoor.test) is left alone.

const DOOR = { lat: 47.437, lng: -122.277 }; // seeded property p1

async function signIn(request: APIRequestContext, email: string) {
  const sent = await request.post('/v1/auth/login', { data: { email } });
  const { dev_token } = await sent.json();
  expect(dev_token, 'dev_token only exists in development').toBeTruthy();
  const verified = await request.post('/v1/auth/verify', { data: { token: dev_token } });
  expect(verified.ok()).toBeTruthy();
  return { authorization: `Bearer ${(await verified.json()).access_token}` };
}

test('cancellation request shows up for office, then the customer deletes their account', async ({ request, page }) => {
  const email = `cancel-${Date.now()}@dealerdoor.test`;
  const rep = await signIn(request, 'rep1@dealerdoor.test');
  const leadId = crypto.randomUUID();
  expect(
    (await request.post('/v1/leads', {
      headers: rep,
      data: { id: leadId, property_id: 'p1', customer_name: 'Cancel Candidate', phone: '206-555-0111', email, product_interest: ['internet'], tcpa_accepted: true, disclosure_accepted: true, consent_text_version: 'v1', ...DOOR },
    })).status(),
  ).toBe(201);
  const orderId = (await (await request.post('/v1/orders', { headers: rep, data: { lead_id: leadId, skus: ['AIR'] } })).json()).id as string;

  const customer = await signIn(request, email);
  const detail = await (await request.get(`/v1/orders/${orderId}`, { headers: customer })).json();
  expect(detail.cancel_eligible).toBe(true);
  const asked = await request.post(`/v1/orders/${orderId}/cancel-request`, { headers: customer, data: { reason: 'Changed my mind' } });
  expect(asked.ok()).toBeTruthy();

  // Office sees it in the console.
  await page.goto('/');
  await page.locator('#login-form input[name=email]').fill('office@dealerdoor.test');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.goto('/#orders');
  const row = page.locator('tr', { hasText: 'Cancel Candidate' }).first();
  await expect(row.getByText('cancel requested')).toBeVisible();
  await row.click();
  await expect(page.locator('#order-cancel-request')).toContainText('Changed my mind');

  // Deleting the account is refused until the order is closed out, then works and signs the customer out.
  const blocked = await request.delete('/v1/me', { headers: customer });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).error).toBe('account_has_open_items');

  const office = await signIn(request, 'office@dealerdoor.test');
  expect((await request.patch(`/v1/orders/${orderId}`, { headers: office, data: { status: 'cancelled', cancelled_reason: 'Customer request' } })).ok()).toBeTruthy();
  expect((await request.delete('/v1/me', { headers: customer })).ok()).toBeTruthy();
  expect((await request.get('/v1/me', { headers: customer })).status()).toBe(401);
});

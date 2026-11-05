import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Leaflet maps: the admin console's Map view, the order mini-map, and the phone map page for reps.
// Map tiles are stubbed, so the test never depends on the internet and never hits the public tile server.
//
// Nearby pins merge into numbered bubbles (clusters). Every run therefore leaves its sale at a spot of its own,
// and the test zooms to it with "Show on the big map", so old pins from earlier runs never get in the way.

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Real pins on the map. The legend uses the same classes for its little samples, so always scope to the marker class.
const pin = (kind: 'leads' | 'sales' | 'dnk') => `.leaflet-marker-icon.dd-pin-${kind}`;

async function signInApi(request: APIRequestContext, email: string) {
  const sent = await request.post('/v1/auth/login', { data: { email } });
  const verified = await request.post('/v1/auth/verify', { data: { token: (await sent.json()).dev_token } });
  return { authorization: `Bearer ${(await verified.json()).access_token}` };
}

/** Rep1 sells at a brand-new address with its own coordinates and also leaves a plain lead there. */
async function seedSale(request: APIRequestContext) {
  const rep = await signInApi(request, 'rep1@dealerdoor.test');
  const spot = { lat: 47.4 + Math.random() * 0.06, lng: -122.32 + Math.random() * 0.08 };
  const address = `${Math.floor(Math.random() * 90000) + 10000} Mapview Way, SeaTac, WA 98188`;
  const lead = (name: string) => ({
    id: crypto.randomUUID(), address, customer_name: name, phone: '206-555-0101', email: `${crypto.randomUUID().slice(0, 8)}@example.test`,
    product_interest: ['internet'], tcpa_accepted: true, disclosure_accepted: true, consent_text_version: 'v1', ...spot,
  });
  const open = lead('Map Open Lead');
  const sold = lead('Map Sold Lead');
  expect((await request.post('/v1/leads', { headers: rep, data: open })).status()).toBe(201);
  expect((await request.post('/v1/leads', { headers: rep, data: sold })).status()).toBe(201);
  const order = await request.post('/v1/orders', { headers: rep, data: { lead_id: sold.id, skus: ['AIR'] } });
  expect(order.status()).toBe(201);
  return { orderId: (await order.json()).id as string, address };
}

async function stubTiles(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }));
}

async function signInBrowser(page: Page, email: string) {
  await page.goto('/');
  await page.locator('#login-form input[name=email]').fill(email);
  await page.locator('#login-form button[type=submit]').click();
}

test('admin Map view: pins, legend, and from an order straight to its spot on the map', async ({ page, request }, info) => {
  const { orderId, address } = await seedSale(request);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await stubTiles(page);

  await signInBrowser(page, 'admin@dealerdoor.test');
  await expect(page.locator('#app')).toBeVisible();

  // The Map view draws the map, the do-not-knock hand (seeded p3), the legend and the note area.
  await page.goto('/#map');
  await expect(page.locator('#leaflet-map.leaflet-container')).toBeVisible();
  await expect(page.locator(pin('dnk')).first()).toBeVisible();
  await expect(page.locator('.dd-legend')).toContainText('Do not knock');
  await expect(page.locator('#map-note')).toHaveText('');
  await page.screenshot({ path: `screenshots/map-${info.project.name}/01-admin-map.png`, fullPage: true });

  // Open the order from the Orders list: its dialog has a small map of where it was taken.
  await page.goto('/#orders');
  await page.locator('tr.clickable', { hasText: address }).click();
  await expect(page.locator('#order-dialog')).toBeVisible();
  await expect(page.locator('#order-minimap.leaflet-container')).toBeVisible();
  await expect(page.locator('#order-title')).toContainText(orderId.slice(0, 8));
  await page.screenshot({ path: `screenshots/map-${info.project.name}/02-order-minimap.png` });

  // "Show on the big map" closes the dialog and zooms to that spot, where this run's pins stand alone.
  await page.locator('#order-show-map').click();
  await expect(page.locator('#order-dialog')).toBeHidden();
  await expect(page.locator('section[data-view="map"]')).toBeVisible();
  await expect(page.locator(pin('sales'))).toHaveCount(1);
  await expect(page.locator(pin('leads'))).toHaveCount(1);
  await page.screenshot({ path: `screenshots/map-${info.project.name}/03-sale-on-map.png`, fullPage: true });

  // The sale pin's popup names the customer and reopens the order.
  await page.locator(pin('sales')).click();
  await expect(page.locator('.dd-popup')).toContainText('Map Sold Lead');
  await expect(page.locator('.dd-popup')).toContainText(address);
  await page.locator('.dd-popup button', { hasText: 'Open order' }).click();
  await expect(page.locator('#order-dialog')).toBeVisible();
  await expect(page.locator('#order-title')).toContainText(orderId.slice(0, 8));

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a rep is sent to the phone map and sees pins, do-not-knock hands and a Near me button', async ({ page, request }, info) => {
  await seedSale(request);
  await stubTiles(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // The admin address sends reps to the phone map.
  await signInBrowser(page, 'rep1@dealerdoor.test');
  await expect(page).toHaveURL(/\/map(\.html)?$/);
  await expect(page.locator('#leaflet-map.leaflet-container')).toBeVisible();
  await expect(page.locator(pin('dnk')).first()).toBeVisible();
  // Their own leads and sales: single pins or numbered bubbles, depending on how close together they are.
  await expect.poll(() => page.locator('#leaflet-map .leaflet-marker-icon').count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('button', { name: 'Show my location on the map' })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'no sideways scrolling on a phone').toBeLessThanOrEqual(0);
  await page.screenshot({ path: `screenshots/map-${info.project.name}/04-phone-map.png` });
});

test('the map data is not available without a sign-in', async ({ request }) => {
  expect((await request.get('/v1/map/points')).status()).toBe(401);
});

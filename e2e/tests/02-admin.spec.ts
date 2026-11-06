import { expect, test } from '@playwright/test';

// Every sidebar section of the admin console, at desktop and phone width. Screenshots feed the progress gallery.
const SECTIONS = ['overview', 'review', 'routes', 'dnk', 'leads', 'orders', 'invoices', 'feedback', 'scorecards', 'commissions', 'catalog', 'users', 'settings', 'audit'];

test('admin console sections load without errors', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.locator('#login-form input[name=email]').fill('admin@dealerdoor.test');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();

  for (const [i, name] of SECTIONS.entries()) {
    await page.goto(`/#${name}`);
    const section = page.locator(`section[data-view="${name}"]`);
    await expect(section).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `screenshots/admin-${info.project.name}/${String(i + 1).padStart(2, '0')}-${name}.png`, fullPage: true });
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('privacy policy is public and linked from sign-in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { name: 'DealerDoor Privacy Policy' })).toBeVisible();
});

test('admin can download a CSV export', async ({ page }) => {
  await page.goto('/');
  await page.locator('#login-form input[name=email]').fill('admin@dealerdoor.test');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#app')).toBeVisible();

  await page.goto('/#leads');
  const download = page.waitForEvent('download');
  await page.locator('[data-export="leads"]').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^dealerdoor-leads-\d{4}-\d{2}-\d{2}\.csv$/);
});

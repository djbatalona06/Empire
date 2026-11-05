import { expect, test } from '@playwright/test';

// The owner address is made up and comes from worker/.dev.vars.example. Real addresses never go in the repo.
const OWNER = 'owner@dealerdoor.test';
const PASSWORD = 'local test password 123';

test('owner gets in with an email, and only a password unlocks the data', async ({ page }, info) => {
  const dataCalls: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (/^\/v1\/(admin|orders|invoices|leads|catalog)/.test(path)) dataCalls.push(path);
  });

  // Step 1: email only. In local development the sign-in link is applied automatically.
  await page.goto('/');
  await page.locator('#login-form input[name=email]').fill(OWNER);
  await page.locator('#login-form button[type=submit]').click();

  // The locked screen shows, the real console does not, and no private data was asked for.
  await expect(page.locator('#locked')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await page.screenshot({ path: `screenshots/owner-gate-${info.project.name}/01-locked.png` });
  expect(dataCalls, 'no private data before the password').toEqual([]);

  // Step 2: first run creates the password, later runs enter it.
  const firstRun = await page.locator('#confirm-row').isVisible();
  if (firstRun) {
    await page.locator('#unlock-form input[name=password]').fill(PASSWORD);
    await page.locator('#unlock-form input[name=confirm]').fill(PASSWORD);
  } else {
    await page.locator('#unlock-form input[name=password]').fill('definitely the wrong one');
    await page.locator('#unlock-btn').click();
    await expect(page.locator('#unlock-msg')).toContainText(/invalid credentials/i);
    await expect(page.locator('#app')).toBeHidden();
    await page.locator('#unlock-form input[name=password]').fill(PASSWORD);
  }
  await page.locator('#unlock-btn').click();

  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#locked')).toBeHidden();
  await expect(page.locator('#me-name')).toContainText('admin');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `screenshots/owner-gate-${info.project.name}/02-unlocked.png` });
  expect(dataCalls.length, 'data loads after the password').toBeGreaterThan(0);
});

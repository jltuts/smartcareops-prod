import { test, expect } from '@playwright/test';

const pages = [
  ['/', 'SmartCareOps'], ['/patient', 'Patient Portal'], ['/doctor', 'Doctor Portal'],
  ['/dispatcher', 'Dispatcher Portal'], ['/command-center', 'Command Center'],
];

for (const [path, heading] of pages) {
  test(`${path} loads directly and survives a refresh`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(path);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(page).toHaveTitle(path === '/' ? heading : `${heading} | SmartCareOps`);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    expect(errors).toEqual([]);
  });
}

test('portal links, home links, and browser history work', async ({ page }) => {
  await page.goto('/');
  for (const [path, heading] of pages.slice(1)) {
    await page.locator(`.portal-card[href="${path}"]`).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeFocused();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'SmartCareOps', exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.getByRole('link', { name: 'Back to home' }).click();
    await expect(page).toHaveURL('/');
  }
});

test('unknown routes offer a way home', async ({ page }) => {
  await page.goto('/missing');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page).toHaveTitle('SmartCareOps');
});

test('backend health endpoint works', async ({ request }) => {
  const response = await request.get(`http://127.0.0.1:${process.env.E2E_API_PORT || 8080}/health`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', service: 'smartcareops-api' });
  expect((await request.get(`http://127.0.0.1:${process.env.E2E_API_PORT || 8080}/missing`)).status()).toBe(404);
});

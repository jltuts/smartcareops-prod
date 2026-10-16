import { test, expect } from '@playwright/test';

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 412, height: 915 }]) {
  test(`About explains private evidence storage accurately on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/about');
    await page.getByText('Demo and data details', { exact: true }).click();
    const section = page.getByRole('region', { name: 'Patient-submitted evidence images' });
    await expect(section).toBeVisible();
    await expect(section).toContainText('private Google Cloud Storage');
    await expect(section).toContainText('encrypts stored data by default');
    await expect(section).toContainText('Encryption does not replace SmartCareOps access checks');
    await expect(section).not.toContainText(/guarantee|public URL|bucket|M30/i);
    expect(await section.evaluate(element => element.getBoundingClientRect().right <= innerWidth && element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole('heading', { name: 'How SmartCareOps Works' })).toHaveCount(0);
  });
}

test('About stays concise and exposes the required Google policy links', async ({ page }) => {
  await page.goto('/about');
  await expect(page.getByRole('heading', { level: 1, name: 'A clearer path through care.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clarity', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Human judgment', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Continuity', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Built around people', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Google Privacy Policy/ })).toHaveAttribute('href', 'https://policies.google.com/privacy');
  await expect(page.getByRole('link', { name: /Google Maps Platform Terms/ })).toHaveAttribute('href', 'https://cloud.google.com/maps-platform/terms');
  await expect(page.getByRole('link', { name: /Start Patient Intake/ })).toHaveAttribute('href', '/patient');
  await expect(page.getByRole('heading', { name: /Four connected workspaces|Care depends on what happens next|AI that doesn’t just assess/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

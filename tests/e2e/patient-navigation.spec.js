import { test, expect } from '@playwright/test';

test('mobile Choose voice reveals consent and start controls above fixed navigation', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/patient');
  await page.locator('#patient-mode-choice [data-intake-mode="voice"]').click();

  await expect(page.locator('#intake-fictional')).toBeInViewport();
  await expect(page.locator('#start-conversation')).toBeInViewport();
  const controls = await page.locator('.conversation-controls').boundingBox();
  const mobileNav = await page.locator('.patient-mobile-nav').boundingBox();
  expect(controls).not.toBeNull();
  expect(mobileNav).not.toBeNull();
  expect(controls.y + controls.height).toBeLessThanOrEqual(mobileNav.y);
  await expect(page.locator('#intake-fictional')).not.toBeChecked();
  await expect(page.locator('#start-conversation')).toBeDisabled();
});

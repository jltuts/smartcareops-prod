import { test, expect } from '@playwright/test';

const routes = [
  { path: '/', selector: '.site-header .smartcareops-brand' },
  { path: '/manual', selector: '.site-header .smartcareops-brand' },
  { path: '/patient', selector: '.site-header .smartcareops-brand' },
  { path: '/profile', selector: '.site-header .smartcareops-brand' },
  { path: '/doctor', selector: '.site-header .smartcareops-brand' },
  { path: '/dispatcher', selector: '.site-header .smartcareops-brand' },
  { path: '/command-center', selector: '.site-header .smartcareops-brand' },
  { path: '/admin', selector: '.site-header .smartcareops-brand' },
];

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 412, height: 915 }]) {
  test(`canonical SmartCareOps brand is consistent across headers on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const signature = [];
    for (const route of routes) {
      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      const brand = page.locator(route.selector);
      await expect(brand, `${route.path} brand`).toBeVisible();
      await expect(brand.locator('.smartcareops-brand-mark i')).toHaveCount(2);
      await expect(brand.locator('.smartcareops-brand-copy strong')).toHaveText('SmartCareOps');
      signature.push(await brand.evaluate(element => {
        const mark = element.querySelector('.smartcareops-brand-mark');
        const wordmark = element.querySelector('.smartcareops-brand-copy strong');
        const markStyle = getComputedStyle(mark);
        const wordmarkStyle = getComputedStyle(wordmark);
        return {
          markWidth: mark.getBoundingClientRect().width,
          markHeight: mark.getBoundingClientRect().height,
          markBackground: markStyle.backgroundImage,
          wordmarkSize: wordmarkStyle.fontSize,
          wordmarkWeight: wordmarkStyle.fontWeight,
          gap: getComputedStyle(element).gap,
        };
      }));
      expect(await brand.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    }
    expect(signature.every(item => JSON.stringify(item) === JSON.stringify(signature[0]))).toBe(true);
  });
}

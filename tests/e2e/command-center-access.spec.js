import { test, expect } from '@playwright/test';

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 412, height: 915 }]) {
  test(`Command Center cold-load shell transitions without exposing workspace data on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.locator('body').evaluate(body => body.classList.remove('landing-active'));

    const main = page.locator('main');
    await page.evaluate(async () => {
      const { renderAccessBoundary } = await import('/src/app/router.js');
      renderAccessBoundary(document.querySelector('main'), '/command-center', {
        status: 'AUTH_LOADING', user: null, authorizationStatus: 'IDLE', identity: null,
      });
    });

    const masthead = main.locator('.command-center-masthead');
    const brand = page.locator('.site-header .smartcareops-brand');
    await expect(brand).toBeVisible();
    await expect(brand.locator('.smartcareops-brand-mark i')).toHaveCount(2);
    await expect(brand.locator('.smartcareops-brand-copy strong')).toHaveText('SmartCareOps');
    await expect(main.getByRole('heading', { name: 'Command Center' })).toBeVisible();
    await expect(main.getByRole('status', { name: 'Restoring your session' })).toHaveText('Restoring your secure session…');
    await expect(main.locator('.command-center-access-nav span')).toHaveCount(5);
    await expect(main.locator('.command-center-access-nav a, .command-center-access-nav button')).toHaveCount(0);
    await expect(main.locator('.command-center-access-nav')).toHaveText('');
    await expect(main.locator('.command-center-access-skeleton')).toBeVisible();
    await expect(main.locator('.simulation-control-dock, .pattern-alert, .ops-supporting, #ops-content')).toHaveCount(0);
    await expect(main).not.toContainText('HOSP-001');
    await expect(main.locator('button, select, input')).toHaveCount(0);
    const loadingBounds = await masthead.boundingBox();

    await page.waitForTimeout(100);
    await page.evaluate(async () => {
      const { renderAccessBoundary } = await import('/src/app/router.js');
      renderAccessBoundary(document.querySelector('main'), '/command-center', {
        status: 'SIGNED_IN', user: { uid: 'operator-1' }, authorizationStatus: 'CHECKING', identity: null,
      });
    });
    await expect(main.getByRole('status', { name: 'Checking portal access' })).toHaveText('Checking your portal access…');
    await expect(main.locator('.command-center-access-skeleton')).toBeVisible();
    await expect(main.locator('.simulation-control-dock, .pattern-alert, .ops-supporting')).toHaveCount(0);

    await page.evaluate(async () => {
      const { renderAccessBoundary } = await import('/src/app/router.js');
      const authorized = renderAccessBoundary(document.querySelector('main'), '/command-center', {
        status: 'SIGNED_IN', user: { uid: 'operator-1' }, authorizationStatus: 'READY',
        identity: { user: { roles: ['command_center'] }, demoAccess: true, liveAvailable: true },
      });
      if (!authorized) {
        const [{ renderCommandCenter, mountCommandCenter }] = await Promise.all([import('/src/pages/command-center/index.js')]);
        const main = document.querySelector('main');
        main.innerHTML = renderCommandCenter();
        window.__commandCenterAccessCleanup = mountCommandCenter(main);
      }
    });
    await expect(main.getByRole('heading', { name: 'Command Center' })).toBeVisible();
    await expect(main.locator('.command-center-nav a')).toHaveCount(7);
    await expect(main.locator('.simulation-control-dock')).toBeVisible();
    await expect(main.locator('.command-center-access-skeleton')).toHaveCount(0);
    const authorizedBounds = await main.locator('.command-center-masthead').boundingBox();
    expect(Math.abs(authorizedBounds.x - loadingBounds.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(authorizedBounds.width - loadingBounds.width)).toBeLessThanOrEqual(2);
    await expect(brand).toBeVisible();
    await expect(brand.locator('.smartcareops-brand-mark i')).toHaveCount(2);
    await page.evaluate(() => window.__commandCenterAccessCleanup?.());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

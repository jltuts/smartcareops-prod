import { test, expect } from '@playwright/test';

const viewports = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 360, height: 800 }, { name: 'mobile-wide', width: 412, height: 915 }];

async function mountAccount(page, roles, authorizationStatus = 'READY') {
  await page.evaluate(async ({ roles, authorizationStatus }) => {
    window.__adminHeaderDispose?.();
    const { mountAuthBar } = await import('/src/auth/ui.js');
    const header = document.querySelector('.site-header');
    header.querySelector('.auth-bar')?.remove();
    const root = document.createElement('div');
    root.className = 'auth-bar';
    root.id = 'admin-header-account-test';
    header.append(root);
    let state = { status: 'SIGNED_IN', user: { displayName: 'Alex User', email: 'alex@example.invalid' }, authorizationStatus, identity: authorizationStatus === 'READY' ? { user: { roles } } : null, error: null };
    let listener;
    const dispose = mountAuthBar(root, { getState: () => state, subscribe: next => { listener = next; return () => {}; }, signIn: () => {}, signOut: () => {} });
    window.__adminHeaderUpdate = next => { state = next; listener(); };
    window.__adminHeaderDispose = () => { dispose(); root.remove(); };
  }, { roles, authorizationStatus });
}

for (const viewport of viewports) {
  test(`Admin header and route cleanup at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/admin');
    const header = page.locator('.site-header');
    const brand = header.locator('.smartcareops-brand');
    await expect(brand).toBeVisible();
    await expect(brand.locator('.smartcareops-brand-mark i')).toHaveCount(2);
    await expect(page.locator('html')).toHaveAttribute('data-page-shell', 'admin');
    await mountAccount(page, ['admin']);
    const menu = header.locator('.portal-account-menu');
    const summary = menu.locator(':scope > summary');
    await expect(summary).toHaveText('My account');
    expect((await summary.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Tab');
    await summary.focus();
    await expect(summary).toBeFocused();
    expect(await summary.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('open', '');
    await expect(menu.getByRole('link', { name: 'Admin portal' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Profile' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    for (const path of ['/', '/manual', '/patient', '/profile', '/doctor', '/dispatcher', '/command-center', '/about']) {
      await page.goto(path);
      await page.evaluate(() => { const link = document.createElement('a'); link.href = '/admin'; link.dataset.link = ''; document.body.append(link); link.click(); link.remove(); });
      await expect(page.locator('html')).toHaveAttribute('data-page-shell', 'admin');
      await expect(page.locator('.site-header .smartcareops-brand')).toBeVisible();
      await expect(page.locator('body')).not.toHaveClass(/landing-active/);
      await expect(page.locator('.admin-page')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : path + '$'}`));
    }
    await page.goto('/admin');
    await page.reload();
    await expect(brand).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    expect(await page.locator('.site-header').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
  });
}

for (const role of ['patient', 'doctor']) {
  test(`Admin account link stays hidden for ${role} and during authorization`, async ({ page }) => {
    await page.goto('/admin');
    await mountAccount(page, [role], 'CHECKING');
    const header = page.locator('.site-header');
    await expect(header.getByRole('status', { name: 'Checking portal access' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Admin portal' })).toHaveCount(0);
    await page.evaluate(next => window.__adminHeaderUpdate(next), { status: 'SIGNED_IN', user: { displayName: 'Alex User' }, authorizationStatus: 'READY', identity: { user: { roles: [role] } }, error: null });
    const menu = header.locator('.portal-account-menu');
    await menu.locator('summary').click();
    await expect(menu.getByRole('link', { name: 'Admin portal' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Profile' })).toBeVisible();
    const access = await page.evaluate(async role => {
      const { renderAccessBoundary } = await import('/src/app/router.js');
      return renderAccessBoundary(document.querySelector('#main'), '/admin', { status: 'SIGNED_IN', user: { uid: 'not-admin' }, authorizationStatus: 'READY', identity: { user: { roles: [role] } } });
    }, role);
    expect(access).toBe(true);
    await expect(page.locator('.admin-page')).toHaveCount(0);
    await expect(page.locator('#main')).toContainText("You don't currently have access");
    await expect(header.locator('.smartcareops-brand')).toBeVisible();
  });
}

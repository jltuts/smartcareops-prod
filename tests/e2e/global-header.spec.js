import { test, expect } from '@playwright/test';

const routes = ['/', '/manual', '/about', '/patient', '/profile', '/doctor', '/dispatcher', '/command-center', '/admin'];
const sizes = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 360, height: 800 }, { name: 'mobile wide', width: 412, height: 915 }];

async function installAccount(page, roles, status = 'READY', specialty) {
  await page.evaluate(async ({ roles, status, specialty }) => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    document.querySelector('.site-header .auth-bar')?.remove();
    const root = document.createElement('div');
    root.className = 'auth-bar';
    document.querySelector('.site-header').append(root);
    let state = { status: 'SIGNED_IN', user: { displayName: 'Alex Very Long Professional Name for Mobile', email: 'alex.very.long.address@example.invalid' }, authorizationStatus: status, identity: status === 'READY' ? { user: { roles, ...(specialty ? { specialty } : {}) } } : null };
    let listener;
    mountAuthBar(root, { getState: () => state, subscribe: callback => { listener = callback; return () => {}; }, signIn: () => {}, signOut: () => { state = { status: 'SIGNED_OUT', user: null }; listener(); } });
    window.updateHeaderAuth = next => { state = next; listener(); };
  }, { roles, status, specialty });
}

for (const size of sizes) {
  test(`one canonical signed-out header survives direct load and refresh on ${size.name}`, async ({ page }) => {
    await page.setViewportSize(size);
    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator('.site-header')).toBeVisible();
      await expect(page.locator('.site-header .smartcareops-brand')).toHaveCount(1);
      await expect(page.locator('.site-header .google-button')).toBeVisible();
      await expect(page.locator('.site-header .portal-account-menu')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route).toBe(true);
      await page.reload();
      await expect(page.locator('.site-header .smartcareops-brand')).toBeVisible();
      await expect(page.locator('.site-header .google-button')).toBeVisible();
    }
  });
}

test('backend roles alone determine workspace links, and unresolved access exposes none', async ({ page }) => {
  await page.goto('/');
  await installAccount(page, ['doctor'], 'CHECKING');
  const header = page.locator('.site-header');
  await expect(header.getByRole('status', { name: 'Checking portal access' })).toBeVisible();
  await expect(header.getByRole('link', { name: /Patient|Doctor|Dispatcher|Command Center|Admin portal/ })).toHaveCount(0);
  const combinations = [
    { roles: [], links: [] },
    { roles: ['patient'], links: ['Patient'] },
    { roles: ['doctor'], links: [] },
    { roles: ['doctor'], specialty: 'general_medicine', links: ['Doctor'] },
    { roles: ['dispatcher'], links: ['Dispatcher'] },
    { roles: ['command_center'], links: ['Command Center'] },
    { roles: ['admin'], links: ['Admin portal'] },
    { roles: ['patient', 'doctor', 'dispatcher', 'command_center', 'admin'], specialty: 'general_medicine', links: ['Patient', 'Doctor', 'Dispatcher', 'Command Center', 'Admin portal'] },
  ];
  for (const { roles, links, specialty } of combinations) {
    await page.evaluate(({ roles, specialty }) => window.updateHeaderAuth({ status: 'SIGNED_IN', user: { displayName: 'Alex', email: 'alex@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles, ...(specialty ? { specialty } : {}) } } }), { roles, specialty });
    const menu = header.locator('.portal-account-menu');
    await menu.locator('summary').click();
    await expect(menu.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Sign out' })).toBeVisible();
    for (const label of ['Patient', 'Doctor', 'Dispatcher', 'Command Center', 'Admin portal']) {
      await expect(menu.getByRole('link', { name: label, exact: true })).toHaveCount(links.includes(label) ? 1 : 0);
    }
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveAttribute('open');
    await expect(menu.locator('summary')).toBeFocused();
  }
});

for (const size of sizes) {
  test(`authenticated menu remains usable across public routes and sign-out on ${size.name}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await installAccount(page, ['patient']);
    for (const route of routes) {
      if (route !== '/') await page.evaluate(path => { const link = document.createElement('a'); link.href = path; link.dataset.link = ''; document.body.append(link); link.click(); link.remove(); }, route);
      await expect(page).toHaveURL(new RegExp(`${route === '/' ? '/$' : route + '$'}`));
      const header = page.locator('.site-header');
      await expect(header.locator('.smartcareops-brand')).toBeVisible();
      const menu = header.locator('.portal-account-menu');
      await expect(menu.locator('summary')).toBeVisible();
      expect((await menu.locator('summary').boundingBox()).height).toBeGreaterThanOrEqual(44);
      await menu.locator('summary').click();
      await expect(menu).toContainText('Alex Very Long Professional Name for Mobile');
      await expect(menu).toContainText('alex.very.long.address@example.invalid');
      await expect(menu.getByRole('link', { name: 'Patient', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route).toBe(true);
      const box = await menu.locator('.account-menu-panel').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
      await page.keyboard.press('Escape');
    }
    await page.goBack();
    await expect(page).toHaveURL(/\/command-center$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/admin$/);
    await page.locator('.site-header .portal-account-menu > summary').click();
    await page.locator('.site-header .auth-signout').click();
    await expect(page.locator('.site-header .google-button')).toBeVisible();
    await expect(page.locator('.site-header .portal-account-menu')).toHaveCount(0);
  });
}

test('notifications use an honest empty state outside backend-authorized staff workspaces', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/notifications**', route => { requests += 1; return route.fulfill({ json: { notifications: [], followups: [] } }); });
  await page.goto('/');
  await page.evaluate(async () => {
    const { mountGlobalNotifications } = await import('/src/components/notification-center.js');
    const root = document.createElement('div');
    document.querySelector('.site-header').append(root);
    let current = { status: 'SIGNED_IN', authorizationStatus: 'READY', identity: { user: { roles: ['patient'] } } };
    let listener;
    window.updateNotificationAuth = next => { current = next; listener(); };
    window.disposeNotificationTest = mountGlobalNotifications(root, { getState: () => current, subscribe: callback => { listener = callback; callback(); return () => {}; } });
  });
  const toggle = page.getByRole('button', { name: 'Notifications' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('.site-header .notification-panel').getByText('No notifications for this page.')).toBeVisible();
  expect(requests).toBe(0);
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await page.evaluate(() => {
    window.history.replaceState({}, '', '/doctor');
    window.updateNotificationAuth({ status: 'SIGNED_IN', authorizationStatus: 'READY', identity: { user: { roles: ['doctor'], specialty: 'general_medicine' } } });
  });
  await expect.poll(() => requests).toBeGreaterThan(0);
  await page.evaluate(() => window.updateNotificationAuth({ status: 'SIGNED_IN', authorizationStatus: 'CHECKING', identity: null }));
  await expect(toggle).toHaveCount(0);
  await page.evaluate(() => window.updateNotificationAuth({ status: 'SIGNED_IN', authorizationStatus: 'ERROR', identity: null }));
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('.site-header .notification-panel').getByText('No notifications for this page.')).toBeVisible();
  await page.evaluate(() => window.disposeNotificationTest());
});

test('mobile signed-in brand, notifications, and account fit together with 44px targets', async ({ page }) => {
  await page.route('**/api/notifications**', route => route.fulfill({ json: { notifications: [], followups: [] } }));
  for (const width of [360, 412]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/command-center');
    await installAccount(page, ['command_center']);
    await page.evaluate(async () => {
      const { mountGlobalNotifications } = await import('/src/components/notification-center.js');
      window.disposeNotificationTest = mountGlobalNotifications(document.querySelector('.site-header'), {
        getState: () => ({ status: 'SIGNED_IN', authorizationStatus: 'READY', identity: { user: { roles: ['command_center'] } } }),
        subscribe: callback => { callback(); return () => {}; },
      });
    });
    const header = page.locator('.site-header');
    const brand = header.locator(':scope > .smartcareops-brand');
    const notification = header.getByRole('button', { name: 'Notifications' });
    const account = header.locator('.portal-account-menu > summary');
    for (const target of [brand, notification, account]) expect((await target.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await notification.click();
    const panel = header.locator('.notification-panel');
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    await page.keyboard.press('Escape');
    await account.click();
    await expect(header.getByText('Demo controls')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.disposeNotificationTest());
  }
});

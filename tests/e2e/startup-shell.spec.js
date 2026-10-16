import { test, expect } from '@playwright/test';

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 412, height: 915 },
];

const routes = [
  { path: '/', shell: 'home', final: '.landing-page', loading: 'Loading SmartCareOps…' },
  { path: '/manual', shell: 'manual', final: '.manual-page', loading: 'Loading the User Manual…' },
  { path: '/patient', shell: 'patient', final: '.patient-page', loading: 'Preparing the Patient Portal…', protected: true },
  { path: '/doctor', shell: 'doctor', final: '.doctor-page', loading: 'Preparing the Doctor Portal…', protected: true, data: { pattern: '**/api/doctor/cases**', status: '#doctor-message', pending: 'Loading routed cases…', response: { cases: [], nextCursor: null, storage: 'memory' }, settled: 'No routed cases yet.' } },
  { path: '/dispatcher', shell: 'dispatcher', final: '.dispatcher-page', loading: 'Preparing the Dispatcher Portal…', protected: true, data: { pattern: '**/api/dispatcher/cases**', status: '#dispatcher-message', pending: 'Loading emergency cases…', response: { cases: [], nextCursor: null, storage: 'memory' }, settled: 'No emergency cases.' } },
  { path: '/command-center', shell: 'command-center', final: '.command-center-main', loading: 'Preparing the Command Center…', protected: true, data: { pattern: '**/api/simulation', status: '#simulation-message', pending: 'Loading synthetic network…', response: { code: 'TEMPORARY_UNAVAILABLE' }, statusCode: 503, settled: 'Simulation unavailable. Refresh to retry.' } },
  { path: '/profile', shell: 'profile', final: '.profile-page', loading: 'Preparing your profile…', protected: true, data: { pattern: '**/api/profile', status: '#profile-message', pending: 'Loading your profile…', response: { profile: { uid: 'synthetic-profile-user', email: 'synthetic@example.invalid', roles: ['patient'], status: 'active' } }, settled: '' } },
  { path: '/about', shell: 'about', final: '.public-notice', loading: 'Loading SmartCareOps…' },
  { path: '/admin', shell: 'admin', final: '.admin-page', loading: 'Checking Admin Portal access…', protected: true },
];

for (const viewport of viewports) {
  for (const routeInfo of routes) {
    test(`${routeInfo.path} ${viewport.name} first paint stays on the current branded shell while app JS is delayed`, async ({ page }) => {
      await page.setViewportSize(viewport);
      let releaseModule;
      let signalModuleRequest;
      const moduleRequested = new Promise(resolve => { signalModuleRequest = resolve; });
      const moduleGate = new Promise(resolve => { releaseModule = resolve; });
      let releaseData;
      let signalDataRequest;
      const dataRequested = routeInfo.data ? new Promise(resolve => { signalDataRequest = resolve; }) : undefined;
      const dataGate = routeInfo.data ? new Promise(resolve => { releaseData = resolve; }) : undefined;
      if (routeInfo.data) {
        await page.route(routeInfo.data.pattern, async dataRoute => {
          signalDataRequest();
          await dataGate;
          await dataRoute.fulfill({ status: routeInfo.data.statusCode || 200, json: routeInfo.data.response });
        });
      }
      await page.route('**/src/app/main.js*', async requestRoute => {
        signalModuleRequest();
        await moduleGate;
        await requestRoute.continue();
      });

      await page.goto(routeInfo.path, { waitUntil: 'commit' });
      await moduleRequested;
      const boot = page.locator(`.startup-shell.startup-${routeInfo.shell}`);
      await expect(boot).toBeVisible();
      await expect(boot.getByRole('status')).toHaveText(routeInfo.loading);
      await expect(page.locator('.site-footer')).toHaveCount(0);
      expect(await page.locator('html').getAttribute('data-page-shell')).toBe(routeInfo.shell);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toMatch(/rgb\(247, 251, 255\)|rgb\(249, 252, 254\)/);

      const brand = page.locator('.site-header .smartcareops-brand');
      await expect(brand).toBeVisible();
      await expect(brand.locator('.smartcareops-brand-mark i')).toHaveCount(2);
      await expect(brand.locator('.smartcareops-brand-copy strong')).toHaveText('SmartCareOps');
      if (routeInfo.protected) {
        await expect(boot.locator('a, button, input, select, [data-case-id], .pattern-alert, .simulation-control-dock')).toHaveCount(0);
        await expect(boot).not.toContainText(/HOSP-00[1-3]|Approve|Reject|Defer|Start Conversation|Case SC-/);
      }
      if (routeInfo.shell === 'command-center') {
        await expect(boot.locator('.startup-command-nav')).toBeVisible();
        await expect(boot).not.toContainText(/Network|Alerts|Predictive Intelligence|CareTwin|Pattern Intelligence/);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      releaseModule();
      await page.waitForLoadState('domcontentloaded');
      await expect(boot).toHaveCount(0);
      await expect(page.locator(routeInfo.final)).toBeVisible();
      await expect(page.locator('.startup-header-skeleton')).toBeHidden();
      if (['/doctor', '/dispatcher', '/command-center'].includes(routeInfo.path)) {
        await expect(page.locator('.site-header .smartcareops-brand')).toBeVisible();
      }
      if (routeInfo.path === '/admin') await expect(page.locator('.site-header .smartcareops-brand')).toBeVisible();
      if (routeInfo.data) {
        await dataRequested;
        await expect(page.locator(routeInfo.data.status)).toHaveText(routeInfo.data.pending);
        releaseData();
        await expect(page.locator(routeInfo.data.status)).toHaveText(routeInfo.data.settled);
      }

      await page.unroute('**/src/app/main.js*');
      let releaseReload;
      let signalReload;
      const reloadRequested = new Promise(resolve => { signalReload = resolve; });
      const reloadGate = new Promise(resolve => { releaseReload = resolve; });
      await page.route('**/src/app/main.js*', async requestRoute => {
        signalReload();
        await reloadGate;
        await requestRoute.continue();
      });
      await page.reload({ waitUntil: 'commit' });
      await reloadRequested;
      const refreshedShell = page.locator(`.startup-shell.startup-${routeInfo.shell}`);
      await expect(refreshedShell).toBeVisible();
      await expect(refreshedShell.getByRole('status')).toHaveText(routeInfo.loading);
      await expect(page.locator('.site-footer')).toHaveCount(0);
      releaseReload();
      await page.waitForLoadState('domcontentloaded');
      await expect(refreshedShell).toHaveCount(0);
      await expect(page.locator(routeInfo.final)).toBeVisible();
    });
  }
}

const protectedRoutes = [
  { path: '/patient', shell: '.patient-access-shell', status: 'Patient Portal', forbidden: 'Start Conversation', restoring: 'Restoring your secure session…', checking: 'Checking your portal access…' },
  { path: '/doctor', shell: '.doctor-access-shell', status: 'SmartCareOps / Doctor workspace · Fictional demo', forbidden: 'Approve', restoring: 'Restoring your secure session…', checking: 'Checking your portal access…' },
  { path: '/dispatcher', shell: '.dispatcher-access-shell', status: 'Dispatcher workspace', forbidden: 'Assign ambulance', restoring: 'Restoring your secure session…', checking: 'Checking your portal access…' },
  { path: '/command-center', shell: '.command-center-access-shell', status: 'Command Center', forbidden: 'Advance 5 min', restoring: 'Restoring your secure session…', checking: 'Checking your portal access…' },
  { path: '/profile', shell: '.profile-access-shell', status: 'Your profile', forbidden: 'Save changes', restoring: 'Restoring your secure session…', checking: 'Checking your portal access…' },
  { path: '/admin', shell: '.admin-access-shell', status: 'Admin controls', forbidden: 'Refresh applications', restoring: 'Restoring your secure session…', checking: 'Checking your portal access…' },
];

for (const viewport of viewports) {
  for (const routeInfo of protectedRoutes) {
    test(`${routeInfo.path} ${viewport.name} keeps a branded, data-free shell through delayed session and authorization`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/about');
      await page.evaluate(path => window.history.replaceState({}, '', path), routeInfo.path);
      const main = page.locator('#main');
      const renderBoundary = async auth => page.evaluate(async nextAuth => {
        const { renderAccessBoundary } = await import('/src/app/router.js');
        return renderAccessBoundary(document.querySelector('#main'), window.location.pathname, nextAuth);
      }, auth);
      const pending = { status: 'AUTH_LOADING', user: null, authorizationStatus: 'IDLE', identity: null };

      await renderBoundary(pending);
      await expect(main.locator(routeInfo.shell)).toBeVisible();
      await expect(main.getByRole('status')).toHaveText(routeInfo.restoring);
      if (routeInfo.path === '/admin') {
        await expect(page.locator('html')).toHaveAttribute('data-page-shell', 'admin');
        await expect(page.locator('.site-header .smartcareops-brand')).toBeVisible();
      }
      await expect(main.locator('a:not(.smartcareops-brand), button, input, select, [data-case-id], .pattern-alert, .simulation-control-dock')).toHaveCount(0);
      await expect(main).not.toContainText(routeInfo.forbidden);
      await page.waitForTimeout(120);

      await renderBoundary({ status: 'SIGNED_IN', user: { uid: 'verified-test-user' }, authorizationStatus: 'CHECKING', identity: null });
      await expect(main.locator(routeInfo.shell)).toBeVisible();
      await expect(main.getByRole('status')).toHaveText(routeInfo.checking);
      if (routeInfo.path === '/admin') await expect(page.locator('.site-header .smartcareops-brand')).toBeVisible();
      await expect(main.locator('a:not(.smartcareops-brand), button, input, select, [data-case-id], .pattern-alert, .simulation-control-dock')).toHaveCount(0);
      await expect(main).not.toContainText(routeInfo.forbidden);
      await page.waitForTimeout(120);

      const role = routeInfo.path.slice(1).replace('-', '_');
      const lifted = await renderBoundary({
        status: 'SIGNED_IN', user: { uid: 'verified-test-user' }, authorizationStatus: 'READY',
        identity: { user: { roles: routeInfo.path === '/profile' ? ['patient'] : [role], ...(routeInfo.path === '/doctor' ? { specialty: 'general_medicine', specialties: ['general_medicine'] } : {}) }, demoAccess: true, liveAvailable: true },
      });
      expect(lifted).toBe(false);
      if (routeInfo.path === '/admin') await expect(page.locator('html')).toHaveAttribute('data-page-shell', 'admin');
      await page.evaluate(async path => {
        const modules = {
          '/patient': () => import('/src/pages/patient/index.js'),
          '/doctor': () => import('/src/pages/doctor/index.js'),
          '/dispatcher': () => import('/src/pages/dispatcher/index.js'),
          '/command-center': () => import('/src/pages/command-center/index.js'),
          '/profile': () => import('/src/pages/profile/index.js'),
          '/admin': () => import('/src/pages/admin/index.js'),
        };
        const module = await modules[path]();
        const renderer = { '/patient': module.renderPatient, '/doctor': module.renderDoctor, '/dispatcher': module.renderDispatcher, '/command-center': module.renderCommandCenter, '/profile': module.renderProfile, '/admin': module.renderAdmin }[path];
        document.querySelector('#main').innerHTML = renderer();
      }, routeInfo.path);
      await expect(main.locator(routeInfo.shell)).toHaveCount(0);
      await expect(main.locator(routeInfo.path === '/admin' ? '.admin-heading' : routeInfo.path === '/command-center' ? '.command-center-masthead' : routeInfo.path === '/profile' ? '.profile-heading' : routeInfo.path === '/patient' ? '.patient-page-heading' : routeInfo.path === '/dispatcher' ? '.dispatcher-intro' : '.doctor-hero')).toBeVisible();
    });
  }
}

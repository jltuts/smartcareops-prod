import { test, expect } from '@playwright/test';
import { createInitialSimulationState } from '../../backend/src/simulation/engine.js';
import { installGoogleMapsStub } from './helpers/google-maps.js';

test('M20 Command Center keeps supporting operations and demo controls secondary', async ({ page }) => {
  await installGoogleMapsStub(page);
  const supportingRequests = { regional: 0, operations: 0, notifications: 0 };
  const simulation = createInitialSimulationState({ scenario: 'respiratory_outbreak', seed: 2026 });
  await page.route('**/api/simulation**', route => route.fulfill({ json: simulation }));
  await page.route('**/api/patterns**', route => route.fulfill({ json: { alert: null, scan: { detected: false, observedCount: 2, baselineCount: 2, windowMinutes: 90 } } }));
  await page.route('**/api/predictive**', route => route.fulfill({ json: { result: null } }));
  await page.route('**/api/caretwin**', route => route.fulfill({ json: { result: null } }));
  await page.route('**/api/regional**', route => route.fulfill({ status: 503, json: { code: 'REGIONAL_DISABLED' } }));
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } }));
  await page.route('**/api/notifications**', route => route.fulfill({ status: 503, json: { code: 'NOTIFICATIONS_DISABLED' } }));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/command-center');
  await expect(page.getByRole('heading', { name: 'Current Network State' })).toBeVisible();
  await expect(page.locator('.simulation-summary')).toContainText('Critical hospitals');
  await expect(page.locator('.simulation-summary')).toContainText('Incoming demand');
  await expect(page.locator('.simulation-summary')).toContainText('Projected demand');
  await expect(page.locator('.google-map-canvas')).toHaveAttribute('data-map-ready', 'true');
  await expect(page.locator('[data-map-marker="hospital"]')).toHaveCount(3);
  await expect(page.locator('[data-map-marker="ambulance"]')).toHaveCount(3);
  const nav = page.getByRole('navigation', { name: 'Command Center sections' });
  for (const section of ['Overview', 'Network', 'Alerts', 'Hospital Operations', 'Predictive Intelligence', 'CareTwin', 'Pattern Intelligence']) await expect(nav.getByRole('link', { name: section, exact: true })).toBeVisible();
  for (const portal of ['Patient', 'Doctor', 'Dispatcher', 'Profile']) await expect(nav.getByRole('link', { name: portal, exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const sectionNav = document.querySelector('.command-center-nav');
    window.commandCenterActiveChanges = [];
    const observer = new MutationObserver(() => {
      window.commandCenterActiveChanges.push(sectionNav.querySelector('a[aria-current="location"]')?.textContent.trim());
    });
    sectionNav.addEventListener('click', event => {
      if (event.target.closest('a')?.hash === '#pattern-heading') {
        observer.observe(sectionNav, { subtree: true, attributes: true, attributeFilter: ['aria-current'] });
      }
    }, { capture: true, once: true });
    window.stopCommandCenterActiveObserver = () => observer.disconnect();
  });
  const patternLink = nav.getByRole('link', { name: 'Pattern Intelligence', exact: true });
  await patternLink.click();
  await expect(page).toHaveURL(/#pattern-heading$/);
  await expect(page.locator('#pattern-heading')).toBeInViewport();
  await expect(patternLink).toHaveAttribute('aria-current', 'location');
  await page.waitForTimeout(1000);
  const activeChanges = await page.evaluate(() => {
    window.stopCommandCenterActiveObserver();
    return window.commandCenterActiveChanges;
  });
  expect(activeChanges).not.toContain('Network');
  expect(activeChanges).not.toContain('Alerts');
  await page.evaluate(() => {
    const heading = document.querySelector('#simulation-heading');
    window.scrollTo({ top: window.scrollY + heading.getBoundingClientRect().top - window.innerHeight * .24, behavior: 'instant' });
  });
  await expect(nav.getByRole('link', { name: 'Network', exact: true })).toHaveAttribute('aria-current', 'location');
  await nav.getByRole('link', { name: 'Alerts' }).click();
  await expect(page).toHaveURL(/#alerts$/);
  await expect(page.locator('#alerts')).toBeInViewport();
  await nav.getByRole('link', { name: 'Predictive Intelligence' }).click();
  await expect(page).toHaveURL(/#predictive-heading$/);
  await expect(page.locator('#predictive-heading')).toBeInViewport();

  await page.evaluate(async () => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    const root = document.querySelector('.site-header .auth-bar'); root.id = 'command-center-account-test'; root.replaceChildren();
    mountAuthBar(root, {
      getState: () => ({ status: 'SIGNED_IN', user: { displayName: 'Alex Operator', email: 'operator@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: ['patient', 'doctor', 'dispatcher', 'command_center'], specialties: ['general_medicine'] } }, error: null }),
      subscribe: () => () => {}, signIn: () => {}, signOut: () => {},
    });
  });
  const account = page.locator('#command-center-account-test');
  await expect(account).toContainText('Alex Operator');
  await account.locator('.command-center-account-menu > summary').click();
  await expect(account.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const workspace = account.getByRole('navigation', { name: 'Switch workspace' });
  for (const portal of ['Patient', 'Doctor', 'Dispatcher', 'Command Center']) await expect(workspace.getByRole('link', { name: portal, exact: true })).toBeVisible();
  const demoControls = account.locator('.account-demo-controls');
  await demoControls.locator('summary').click();
  await expect(demoControls).toContainText('Verify the fictional event boundary');
  await expect(demoControls.getByRole('link', { name: 'Open Demo Console' })).toBeVisible();
  await expect(page.locator('.cc-demo-walkthrough')).toHaveCount(0);
  await expect(page.locator('.supporting-drawer[open]')).toHaveCount(0);
  await page.locator('.notification-support > summary').click();
  await expect(page.getByRole('region', { name: 'Operational notifications' })).toContainText('Notifications are unavailable right now. Refresh to retry.');
  await expect(page.getByText(/Failed to fetch|Regional intelligence unavailable|Hospital operations unavailable|Simulated notifications are unavailable/)).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

  await account.evaluate(element => element.remove());
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Current Network State' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('M20 motion respects reduced-motion and leaves operational controls interactive', async ({ page }) => {
  await installGoogleMapsStub(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const simulation = createInitialSimulationState({ scenario: 'normal_operations', seed: 2026 });
  await page.route('**/api/simulation**', route => route.fulfill({ json: simulation }));
  await page.route('**/api/patterns**', route => route.fulfill({ json: { alert: null, scan: { detected: false, observedCount: 2, baselineCount: 2, windowMinutes: 90 } } }));
  await page.route('**/api/predictive**', route => route.fulfill({ json: { result: null } }));
  await page.route('**/api/caretwin**', route => route.fulfill({ json: { result: null } }));
  await page.route('**/api/regional**', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/notifications**', route => route.fulfill({ status: 503, json: {} }));
  await page.goto('/command-center');
  await page.getByRole('navigation', { name: 'Command Center sections' }).getByRole('link', { name: 'CareTwin' }).click();
  await expect(page).toHaveURL(/#caretwin-heading$/);
  await expect(page.locator('#caretwin-heading')).toBeInViewport();
  await expect(page.locator('.caretwin-panel')).toHaveCSS('transform', 'none');
  await page.getByText('Regional Intelligence', { exact: true }).click();
  await expect(page.locator('.regional-support')).toHaveAttribute('open', '');
});

test('M20 highlights an active pattern on the operational map without exposing raw model data', async ({ page }) => {
  await installGoogleMapsStub(page);
  const simulation = createInitialSimulationState({ scenario: 'respiratory_outbreak', seed: 2026 });
  const alert = { alertId: 'M18-map-alert', severity: 'warning', region: 'REGION-DEMO-001', observedCount: 8, baselineCount: 2, windowMinutes: 90, trend: 'rising', projectedEdDemandIncreasePercent: 32, acknowledged: false, interpretationStatus: 'unavailable' };
  await page.route('**/api/simulation**', route => route.fulfill({ json: simulation }));
  await page.route('**/api/patterns**', route => route.fulfill({ json: { alert, scan: { detected: true, observedCount: 8, baselineCount: 2, windowMinutes: 90, region: alert.region } } }));
  await page.route('**/api/predictive**', route => route.fulfill({ json: { result: null } }));
  await page.route('**/api/caretwin**', route => route.fulfill({ json: { result: null } }));
  await page.route('**/api/regional**', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: {} }));
  await page.route('**/api/notifications**', route => route.fulfill({ status: 503, json: {} }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/command-center');
  await expect(page.locator('#pattern-alert-banner')).toBeVisible();
  await expect(page.locator('[data-map-cluster="true"]')).toContainText('REGION-DEMO-001');
  const mapWidth = await page.locator('#command-network-map').evaluate(element => element.getBoundingClientRect().width);
  expect(mapWidth).toBeGreaterThan(800);
  await expect(page.locator('.network-simulation')).not.toContainText('{"edOccupied"');
});

import { test, expect } from '@playwright/test';
import { advanceSimulationState, createInitialSimulationState, resetSimulationState } from '../../backend/src/simulation/engine.js';

test('Command Center keeps a compact operational hierarchy and responsive navigation', async ({ page }) => {
  await page.route('**/api/simulation**', route => route.fulfill({ json: createInitialSimulationState({ seed: 2026 }) }));
  for (const path of ['patterns', 'predictive', 'caretwin']) await page.route(`**/api/${path}**`, route => route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } }));
  await page.goto('/command-center');
  await expect(page.locator('.site-header .landing-brand-mark')).toHaveCount(1);
  await expect(page.locator('.site-header .landing-brand-mark i')).toHaveCount(2);
  await expect(page.locator('.site-header .brand-mark')).toHaveCount(0);
  await page.evaluate(async () => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    const root = document.querySelector('.site-header .auth-bar');
    root.replaceChildren();
    mountAuthBar(root, { getState: () => ({ status: 'SIGNED_IN', user: { displayName: 'Alex Operator', email: 'operator@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: ['command_center'] } } }), subscribe: () => () => {}, signIn: () => {}, signOut: () => {} });
  });
  const accountMenu = page.locator('.site-header .command-center-account-menu');
  await expect(accountMenu.locator(':scope > summary')).toHaveText('My account');
  await expect(accountMenu.locator(':scope > summary')).toBeVisible();
  await accountMenu.locator(':scope > summary').click();
  await expect(accountMenu.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  await expect(accountMenu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(accountMenu.getByRole('navigation', { name: 'Switch workspace' })).toBeVisible();
  await expect(accountMenu.locator('.account-demo-controls > summary')).toHaveText('Demo controls');
  await accountMenu.locator(':scope > summary').click();
  const header = page.locator('.ops-header');
  await expect(header.getByRole('heading', { name: 'Command Center' })).toBeVisible();
  await expect(header).toContainText('human decision');
  const nav = page.getByRole('navigation', { name: 'Command Center sections' });
  for (const label of ['Overview', 'Network', 'Alerts', 'Hospital Operations', 'Predictive Intelligence', 'CareTwin', 'Pattern Intelligence']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  for (const label of ['Patient', 'Doctor', 'Dispatcher', 'Profile']) await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'location');
  await nav.getByRole('link', { name: 'Network', exact: true }).click();
  await expect(nav.getByRole('link', { name: 'Network', exact: true })).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('.pattern-alert-zone')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current Network State' })).toBeVisible();
  await expect(page.locator('#simulation-network')).toContainText('ED occupancy');
  const bounds = await header.boundingBox();
  expect(bounds.height).toBeLessThan(page.viewportSize().width > 850 ? 260 : 320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Command Center selects scenarios, advances, resets and restores the persisted simulation on refresh', async ({ page }) => {
  let state = createInitialSimulationState({ seed: 2026 });
  await page.route('**/api/regional**', route => route.fulfill({ status: 503, json: { code: 'REGIONAL_DISABLED' } }));
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } }));
  await page.route('**/api/simulation**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/api/simulation') return route.fulfill({ json: state });
    const input = route.request().postDataJSON();
    if (url.pathname === '/api/simulation/scenario') state = createInitialSimulationState({ scenario: input.scenario, seed: state.seed });
    else if (url.pathname === '/api/simulation/advance') state = advanceSimulationState(state, input.steps);
    else if (url.pathname === '/api/simulation/reset') state = resetSimulationState(state);
    else return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: state });
  });
  await page.goto('/command-center');
  await expect(page.getByRole('heading', { name: 'Current Network State' })).toBeVisible();
  const dock = page.getByRole('complementary', { name: 'Simulation controls' });
  await expect(dock).toBeVisible();
  await expect(page.locator('#simulation-time')).toHaveText('10:30');
  await expect(dock).toHaveCSS('position', 'static');
  const controlsBox = await page.locator('.simulation-controls').boundingBox();
  const dockBox = await dock.boundingBox();
  expect(dockBox.x).toBeGreaterThanOrEqual(controlsBox.x);
  expect(dockBox.x + dockBox.width).toBeLessThanOrEqual(controlsBox.x + controlsBox.width + 1);
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('62 / 100');

  await page.locator('#simulation-scenario').selectOption('ed_surge');
  await expect(page.locator('#simulation-message')).toHaveText('Simulation updated.');
  await page.getByRole('button', { name: 'Advance 5 min' }).click();
  await expect(page.locator('#simulation-time')).toHaveText('10:35');
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('65 / 100');
  await expect(page.locator('.simulation-metric').filter({ hasText: 'Available ambulances' })).toContainText('2 / 3');

  await page.getByRole('button', { name: 'Reset current demo scenario' }).click();
  await expect(page.locator('#simulation-time')).toHaveText('10:30');
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('62 / 100');
  await page.reload();
  await expect(page.locator('#simulation-time')).toHaveText('10:30');
  await expect(page.locator('#simulation-scenario')).toHaveValue('ed_surge');

  await page.locator('#simulation-scenario').selectOption('respiratory_outbreak');
  await page.getByRole('button', { name: 'Advance 5 min' }).click();
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('Respiratory 3');

  await page.locator('#simulation-scenario').selectOption('capacity_failure');
  await page.getByRole('button', { name: 'Advance 5 min' }).click();
  await expect(page.locator('[data-hospital-id="HOSP-002"]')).toContainText('44 / 52');
  await expect(page.locator('[data-hospital-id="HOSP-002"]')).toContainText('degraded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Command Center reports an unavailable simulation without enabling controls', async ({ page }) => {
  await page.route('**/api/simulation**', route => route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } }));
  await page.goto('/command-center');
  const dock = page.getByRole('complementary', { name: 'Simulation controls' });
  await expect(dock).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#simulation-time')).toHaveText('Unavailable');
  await expect(page.locator('#simulation-message')).toHaveText('Simulation unavailable. Refresh to retry.');
  await expect(page.locator('#simulation-scenario')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset current demo scenario' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Advance 5 min' })).toBeDisabled();
});

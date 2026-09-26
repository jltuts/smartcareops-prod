import { test, expect } from '@playwright/test';
import { advanceSimulationState, createInitialSimulationState, resetSimulationState } from '../../backend/src/simulation/engine.js';

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
  await expect(page.getByRole('heading', { name: 'Healthcare Network Simulation' })).toBeVisible();
  await expect(page.locator('#simulation-time')).toHaveText('Simulation time: 10:30');
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('62 / 100 (62%)');

  await page.locator('#simulation-scenario').selectOption('ed_surge');
  await expect(page.locator('#simulation-message')).toHaveText('Simulation updated.');
  await page.getByRole('button', { name: 'Advance 5 min' }).click();
  await expect(page.locator('#simulation-time')).toHaveText('Simulation time: 10:35');
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('65 / 100');
  await expect(page.locator('.simulation-metric').filter({ hasText: 'Available ambulances' })).toContainText('2 / 3');

  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.locator('#simulation-time')).toHaveText('Simulation time: 10:30');
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('62 / 100 (62%)');
  await page.reload();
  await expect(page.locator('#simulation-time')).toHaveText('Simulation time: 10:30');
  await expect(page.locator('#simulation-scenario')).toHaveValue('ed_surge');

  await page.locator('#simulation-scenario').selectOption('respiratory_outbreak');
  await page.getByRole('button', { name: 'Advance 5 min' }).click();
  await expect(page.locator('[data-hospital-id="HOSP-001"]')).toContainText('3 ·');

  await page.locator('#simulation-scenario').selectOption('capacity_failure');
  await page.getByRole('button', { name: 'Advance 5 min' }).click();
  await expect(page.locator('[data-hospital-id="HOSP-002"]')).toContainText('44 / 52');
  await expect(page.locator('[data-hospital-id="HOSP-002"]')).toContainText('degraded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

import { test, expect } from '@playwright/test';
import { createInitialSimulationState } from '../../backend/src/simulation/engine.js';
import { createPredictiveForecast } from '../../backend/src/simulation/predictive-forecast.js';
import { installGoogleMapsStub } from './helpers/google-maps.js';

test('M18 displays a persistent synthetic cluster alert and reuses M17/CareTwin only after operator action', async ({ page }) => {
  await installGoogleMapsStub(page);
  const simulation = createInitialSimulationState({ scenario: 'normal_operations', seed: 27 });
  const forecast = createPredictiveForecast(simulation);
  const alert = { alertId: 'M18-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'respiratory', severity: 'warning',
    generatedAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', region: 'REGION-DEMO-001',
    observedCount: 8, baselineCount: 2, windowMinutes: 90, trend: 'rising', projectedEdDemandIncreasePercent: 32,
    acknowledged: false, acknowledgedAt: null, interpretationStatus: 'succeeded', interpretation: {
      operationalImplications: 'Increasing synthetic activity may increase short-term triage workload.',
      monitoring: 'Review aggregate demand and available staffing at the next simulated interval.',
      uncertainty: 'This signal is synthetic and does not establish a real-world event.' } };
  let acknowledged = false, forecastRequests = 0, careTwinRequests = 0, actionRequests = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (/^\/api\/(dispatcher|cases\/[^/]+\/ambulance|clinical\/executions|hospital-handoff|computer-use)/.test(path)) actionRequests.push(path); });
  await page.route('**/api/regional**', route => route.fulfill({ status: 503, json: { code: 'REGIONAL_DISABLED' } }));
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } }));
  await page.route('**/api/simulation**', route => route.fulfill({ json: simulation }));
  await page.route('**/api/patterns**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/acknowledge')) acknowledged = true;
    const value = { ...alert, acknowledged, acknowledgedAt: acknowledged ? '2026-09-27T00:01:00.000Z' : null };
    await route.fulfill({ json: { alert: value, scan: { type: 'respiratory', region: 'REGION-DEMO-001', observedCount: 8, baselineCount: 2, windowMinutes: 90, detected: true } } });
  });
  await page.route('**/api/predictive**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/predictive') return route.fulfill({ json: { result: null } });
    forecastRequests++; await route.fulfill({ json: { result: { ...forecast, forecastId: 'forecast-demo', generatedAt: '2026-09-27T00:00:00.000Z', interpretationStatus: 'unavailable', interpretation: null } } });
  });
  await page.route('**/api/caretwin**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/caretwin') return route.fulfill({ json: { result: null } });
    careTwinRequests++; await route.fulfill({ json: { result: { generationId: 'caretwin-demo', baseline: { scenarioName: 'Normal Operations', simulationTime: '10:30', metrics: { networkPressureLevel: 'normal' } }, horizonMinutes: 30, plans: [], assumptions: [], comparisonStatus: 'unavailable', comparison: null, approval: { required: true, status: 'pending' } } } });
  });
  await page.goto('/command-center');
  const banner = page.locator('#pattern-alert-banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('heading', { name: '8 similar synthetic presentations detected in 90 minutes' })).toBeVisible();
  await expect(banner).toContainText('REGION-DEMO-001'); await expect(banner).toContainText('Baseline: 2');
  await expect(page.locator('[data-map-cluster="true"]')).toContainText('REGION-DEMO-001');
  await expect(page.locator('.pattern-panel').getByText(/outbreak/i)).toHaveCount(0);
  await expect(page.locator('#pattern-details')).toContainText('No real case records, transcripts, or patient identities');
  await banner.getByRole('button', { name: 'View Pattern' }).click();
  await expect(page.locator('#pattern-details')).toHaveAttribute('open', '');
  await banner.getByRole('button', { name: 'Generate Forecast' }).click();
  await expect.poll(() => forecastRequests).toBe(1);
  await banner.getByRole('button', { name: 'Evaluate with CareTwin' }).click();
  await expect.poll(() => careTwinRequests).toBe(1);
  await banner.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.locator('#pattern-alert-banner')).toContainText('Pattern alert acknowledged');
  await page.reload();
  await expect(page.locator('#pattern-alert-banner')).toContainText('Pattern alert acknowledged');
  expect(actionRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

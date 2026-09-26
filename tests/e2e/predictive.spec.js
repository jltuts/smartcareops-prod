import { test, expect } from '@playwright/test';
import { createInitialSimulationState } from '../../backend/src/simulation/engine.js';
import { createPredictiveForecast } from '../../backend/src/simulation/predictive-forecast.js';

test('Predictive Command Center restores deterministic horizons and evaluates a detected bottleneck with CareTwin', async ({ page }) => {
  const simulation = createInitialSimulationState({ scenario: 'ed_surge', seed: 31 });
  const forecast = createPredictiveForecast(simulation);
  const result = { ...forecast, forecastId: 'forecast-demo', generatedAt: '2026-09-27T00:00:00.000Z', interpretationStatus: 'succeeded', interpretation: {
    topBottleneck: forecast.bottlenecks[0]?.resource || 'No significant bottleneck identified', recommendation: 'Review a synthetic redistribution scenario before demand pressure increases.',
    why: ['The supplied M15 trajectory reaches pressured status.'], whyNot: ['The model does not represent travel or admission capability.'],
    uncertainty: ['This forecast uses a deterministic synthetic scenario.'], whatWouldChange: ['A new network snapshot could change this recommendation.'] } };
  let saved = null, generated = 0, careTwinGenerated = 0; const unrelatedActionRequests = [];
  page.on('request', request => { const url = new URL(request.url()); if (/^\/api\/(dispatcher(?:\/|$)|cases\/[^/]+\/ambulance|clinical\/executions|hospital-handoff|computer-use)/.test(url.pathname)) unrelatedActionRequests.push(url.pathname); });
  await page.route('**/api/regional**', route => route.fulfill({ status: 503, json: { code: 'REGIONAL_DISABLED' } }));
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } }));
  await page.route('**/api/simulation**', route => route.fulfill({ json: simulation }));
  await page.route('**/api/predictive**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') return route.fulfill({ json: { result: saved } });
    generated++; saved = result; return route.fulfill({ json: { result: saved } });
  });
  await page.route('**/api/caretwin**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') return route.fulfill({ json: { result: null } });
    careTwinGenerated++; return route.fulfill({ json: { result: { generationId: 'caretwin-1', baseline: { scenarioName: 'ED Surge', simulationTime: '10:30', metrics: { networkPressureLevel: 'pressured' } }, horizonMinutes: 30, plans: [], assumptions: [], comparisonStatus: 'unavailable', comparison: null, approval: { required: true, status: 'pending' } } } });
  });
  await page.goto('/command-center');
  await expect(page.getByRole('heading', { name: 'Predictive Intelligence' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate Forecast' }).click();
  for (const minutes of [30, 60, 120]) await expect(page.getByRole('heading', { name: `NEXT ${minutes} MIN` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'CURRENT' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why Not' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Uncertainty' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What would change this recommendation' })).toBeVisible();
  await page.getByRole('button', { name: 'Evaluate with CareTwin' }).click();
  await expect.poll(() => careTwinGenerated).toBe(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'NEXT 120 MIN' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Evaluate with CareTwin' })).toBeVisible();
  expect(generated).toBe(1);
  expect(unrelatedActionRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

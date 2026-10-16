import { test, expect } from '@playwright/test';
import { createInitialSimulationState } from '../../backend/src/simulation/engine.js';

test('CareTwin compares three saved futures, records human approval, and restores it after refresh without execution', async ({ page }) => {
  const simulation = createInitialSimulationState({ scenario: 'ed_surge', seed: 314159 });
  const outcomes = [
    { id: 'A', name: 'Continue current allocation', description: 'Keep current synthetic demand allocation.', outcome: { ed: { occupied: 171, effectiveCapacity: 240 }, icu: { occupied: 26, effectiveCapacity: 48 }, projectedDemand: 20, availableAmbulances: 2, pressuredHospitals: 1, networkPressure: 0.71, networkPressureLevel: 'normal', simulationTime: '11:00', hospitals: [{ hospitalId: 'HOSP-001', edOccupied: 81, edEffectiveCapacity: 100, projectedDemand: 8, operationalState: 'normal' }] } },
    { id: 'B', name: 'Redistribute one demand unit', description: 'Shift one synthetic unit each tick.', outcome: { ed: { occupied: 171, effectiveCapacity: 240 }, icu: { occupied: 26, effectiveCapacity: 48 }, projectedDemand: 20, availableAmbulances: 2, pressuredHospitals: 1, networkPressure: 0.71, networkPressureLevel: 'normal', simulationTime: '11:00', hospitals: [{ hospitalId: 'HOSP-001', edOccupied: 75, edEffectiveCapacity: 100, projectedDemand: 8, operationalState: 'normal' }] } },
    { id: 'C', name: 'Redistribute and hold reserve', description: 'Shift up to two units and keep one ambulance in reserve.', outcome: { ed: { occupied: 171, effectiveCapacity: 240 }, icu: { occupied: 26, effectiveCapacity: 48 }, projectedDemand: 20, availableAmbulances: 2, pressuredHospitals: 1, networkPressure: 0.71, networkPressureLevel: 'normal', simulationTime: '11:00', hospitals: [{ hospitalId: 'HOSP-001', edOccupied: 73, edEffectiveCapacity: 100, projectedDemand: 8, operationalState: 'normal' }] } },
  ];
  let result = null, generationCount = 0, simulationTick = 0;
  const recommendation = { comparisonSummary: 'Plan C has the lowest modeled pressure at the initially most pressured hospital.', recommendedPlan: 'C', whyRecommended: ['Plan C shows lower ED occupancy at HOSP-001 in the simulated outcome.'], whyNotOthers: [{ planId: 'A', tradeoff: 'A keeps the existing allocation and higher HOSP-001 occupancy.' }, { planId: 'B', tradeoff: 'B improves HOSP-001 less than C in this simulation.' }], uncertainty: ['Synthetic arrivals do not model patient-specific suitability.'], whatWouldChangeRecommendation: ['A changed hospital pressure pattern could alter the comparison.'] };
  await page.route('**/api/regional**', route => route.fulfill({ status: 503, json: { code: 'REGIONAL_DISABLED' } }));
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } }));
  await page.route('**/api/simulation**', route => route.fulfill({ json: { ...simulation, tick: simulationTick } }));
  await page.route('**/api/caretwin**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: { result } });
    if (path === '/api/caretwin/generate') {
      generationCount++;
      result = { generationId: 'generation-1', baselineId: 'baseline-1', baseline: { scenarioName: 'ED Surge', simulationTime: '10:30', metrics: { networkPressureLevel: 'normal' } }, horizonMinutes: 30, plans: outcomes, assumptions: ['All arrivals are synthetic.'], comparisonStatus: 'succeeded', comparison: recommendation, approval: { required: true, status: 'pending' }, createdAt: '2026-09-26T00:00:00.000Z' };
      return route.fulfill({ json: { result } });
    }
    const { decision } = request.postDataJSON(); result.approval.status = decision; return route.fulfill({ json: { result } });
  });
  await page.goto('/command-center');
  await expect(page.getByRole('heading', { name: 'Current Network State' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'CareTwin' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate Plans' }).click();
  await expect(page.getByText('Gemini comparison · Advisory recommendation: Plan C')).toBeVisible();
  await expect(page.getByText('Plan C · Recommended')).toBeVisible();
  const comparison = page.getByRole('table', { name: 'CareTwin aligned plan comparison' });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByRole('row', { name: /HOSP-001 ED 81\/100/ })).toContainText('ED 73/100');
  await expect(comparison.locator('.recommended-column')).not.toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Why Plan C' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why not the alternatives' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Uncertainty' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What would change the recommendation' })).toBeVisible();
  await expect(page.getByText(/No routing, ambulance dispatch, hospital handoff, or Computer Use is executed/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Decision recorded: approved. No plan was executed.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Decision recorded: approved. No plan was executed.')).toBeVisible();
  expect(generationCount).toBe(1); expect(simulationTick).toBe(0);
});

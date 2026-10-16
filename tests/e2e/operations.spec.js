import { test, expect } from '@playwright/test';
import { operationsFixture } from '../../backend/tests/operations-fixtures.js';
async function setup(page) {
  const f = await operationsFixture(); await f.service.tick();
  await page.route('**/api/operations**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    try {
      let result;
      if (request.method() === 'GET') result = await f.service.view();
      else if (path.includes('/approvals/')) { result = await f.service.decide(path.split('/').at(-1), request.postDataJSON().decision); await f.service.tick(); }
      else if (path.endsWith('/capacity')) { result = await f.service.changeCapacity(request.postDataJSON()); await f.service.tick(); }
      else if (path.endsWith('/run')) { result = await f.service.requestRun(request.postDataJSON().requestId); await f.service.tick(); }
      else if (path.endsWith('/reset')) result = await f.service.resetDemo(request.postDataJSON());
      else throw new Error('Unexpected command');
      await route.fulfill({ json: result });
    } catch { await route.fulfill({ status: 409, json: { code: 'OPERATIONS_STALE_APPROVAL' } }); }
  });
  await page.goto('/command-center');
  await page.getByRole('navigation', { name: 'Command Center sections' }).getByRole('link', { name: 'Hospital Operations' }).click();
  await expect(page.getByRole('heading', { name: 'Current plan OPS-PLAN-1', exact: true })).toBeVisible();
  await page.locator('.ops-technical-trace > summary').click();
  return f;
}
test('overview and direct Hospital Operations destination use current aggregate records', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#overview-assessment-status')).toHaveText('WATCH');
  await expect(page.locator('#ops-summary-assessment')).toContainText('OPS-PLAN-1');
  await expect(page.locator('#ops-summary-capacity')).toContainText('1 monitored beds');
  await expect(page.getByRole('navigation', { name: 'Command Center sections' }).getByRole('link', { name: 'Hospital Operations' })).toBeVisible();
  await expect(page.locator('.hospital-support')).toHaveCount(0);
  await expect(page.locator('.overview-boundary')).toContainText('Demo Console');
  await page.getByRole('navigation', { name: 'Command Center sections' }).getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('link', { name: 'Open Hospital Operations' }).click();
  await expect(page.getByRole('navigation', { name: 'Command Center sections' }).getByRole('link', { name: 'Hospital Operations' })).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('#operations-heading')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('hospital dashboard displays aggregate evidence and simulation labels', async ({ page }) => {
  await setup(page); await expect(page.getByText('Active cases: 4', { exact: false })).toBeVisible();
  await expect(page.getByText('Respiratory cases: 3', { exact: false })).toBeVisible();
  await expect(page.getByText('Monitored beds: 1', { exact: false })).toBeVisible();
  await expect(page.getByText('Ambulances available: 3', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operational status: WATCH' })).toBeVisible();
  await expect(page.getByText('Demo Alex')).toHaveCount(0);
});
test('approval produces a local receipt that survives refresh', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Approve simulation' }).first().click();
  await expect(page.getByText('fictional_rehearsal_recorded', { exact: false }).first()).toBeVisible(); await page.reload(); await page.locator('.ops-technical-trace > summary').click();
  await expect(page.getByText('fictional_rehearsal_recorded', { exact: false }).first()).toBeVisible();
  await expect(page.locator('#ops-summary-outcome')).toContainText('durable receipt');
  expect((await f.service.view()).receipts).toHaveLength(3);
});
test('capacity change displays v2, historical v1, alternative resources and constrained status', async ({ page }) => {
  const f = await setup(page); const first = (await f.service.view()).plans[0];
  await page.getByRole('button', { name: 'Demo: set monitored beds to 0' }).click();
  await expect(page.getByRole('heading', { name: 'Current plan OPS-PLAN-2', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operational status: CONSTRAINED' })).toBeVisible();
  await expect(page.locator('#overview-assessment-status')).toHaveText('CONSTRAINED');
  await expect(page.getByText('OPS-PLAN-1 · Snapshot', { exact: false })).toBeVisible();
  await expect(page.getByText('get_hospital_capacity · HOSP-003', { exact: false }).last()).toBeVisible();
  expect((await f.service.view()).plans[0]).toEqual(first);
});
test('demo reset restores capacity and permits a fresh bounded assessment', async ({ page }) => {
  const f = await setup(page);
  await f.service.changeCapacity({ requestId: 'exhausted-zero', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await f.store.transaction('OPS-HOSP-001', state => { state.meta.runCount = 8; state.meta.modelCalls = 8; state.meta.lastError = { code: 'OPERATIONS_BUDGET_EXHAUSTED' }; });
  await page.getByRole('button', { name: 'Refresh operations' }).click();
  await expect(page.getByRole('button', { name: 'Demo: set monitored beds to 0' })).toBeDisabled();
  await page.getByRole('button', { name: 'Reset Hospital Operations demo' }).click();
  await expect(page.getByText('Monitored beds: 2', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Demo: set monitored beds to 0' }).click();
  await expect(page.getByRole('heading', { name: 'Current plan OPS-PLAN-2', exact: true })).toBeVisible();
});
test('stale approval fails safely', async ({ page }) => {
  const f = await setup(page); await f.service.changeCapacity({ requestId: 'external', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await page.getByRole('button', { name: 'Approve simulation' }).first().click();
  await expect(page.locator('#ops-message')).toContainText('action is out of date'); expect((await f.service.view()).receipts).toHaveLength(2);
});
test('rejected simulation does not execute', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Reject simulation' }).first().click();
  await expect(page.getByText('HIGH_IMPACT · rejected', { exact: false })).toBeVisible(); expect((await f.service.view()).receipts).toHaveLength(2);
});
test('disabled backend shows safe unavailable state', async ({ page }) => {
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } })); await page.goto('/command-center');
  await expect(page.locator('#ops-message')).toContainText('Hospital Operations is unavailable');
  await expect(page.locator('#overview-assessment-status')).toHaveText('Unavailable');
  await expect(page.getByRole('button', { name: 'Request assessment' })).toBeDisabled();
});
test('a failed refresh disables previously visible approvals until current records return', async ({ page }) => {
  await setup(page);
  const approval = page.getByRole('button', { name: 'Approve simulation' }).first();
  await expect(approval).toBeEnabled();
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } }));
  await page.getByRole('button', { name: 'Refresh operations' }).click();
  await expect(page.locator('#ops-message')).toContainText('unavailable');
  await expect(approval).toBeDisabled();
});
test('model summaries render as text without HTML execution', async ({ page }) => {
  const f = await setup(page); await f.store.transaction('OPS-HOSP-001', state => { state.plans['OPS-PLAN-1'].assessment.changeSummary = '<img src=x onerror="window.opsInjected=true">'; });
  await page.getByRole('button', { name: 'Refresh operations' }).click();
  await expect(page.getByText('<img src=x onerror="window.opsInjected=true">', { exact: true })).toBeVisible(); expect(await page.evaluate(() => window.opsInjected)).toBeUndefined();
});

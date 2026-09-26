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
      else throw new Error('Unexpected command');
      await route.fulfill({ json: result });
    } catch { await route.fulfill({ status: 409, json: { code: 'OPERATIONS_STALE_APPROVAL' } }); }
  });
  await page.goto('/command-center'); await expect(page.getByRole('heading', { name: 'Current plan OPS-PLAN-1', exact: true })).toBeVisible(); return f;
}
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
  await expect(page.getByText('fictional_rehearsal_recorded', { exact: false })).toBeVisible(); await page.reload();
  await expect(page.getByText('fictional_rehearsal_recorded', { exact: false })).toBeVisible(); expect((await f.service.view()).receipts).toHaveLength(3);
});
test('capacity change displays v2, historical v1, alternative resources and constrained status', async ({ page }) => {
  const f = await setup(page); const first = (await f.service.view()).plans[0];
  await page.getByRole('button', { name: 'Demo: set monitored beds to 0' }).click();
  await expect(page.getByRole('heading', { name: 'Current plan OPS-PLAN-2', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operational status: CONSTRAINED' })).toBeVisible();
  await expect(page.getByText('OPS-PLAN-1 · Snapshot', { exact: false })).toBeVisible();
  await expect(page.getByText('get_hospital_capacity · HOSP-003', { exact: false }).last()).toBeVisible();
  expect((await f.service.view()).plans[0]).toEqual(first);
});
test('stale approval fails safely', async ({ page }) => {
  const f = await setup(page); await f.service.changeCapacity({ requestId: 'external', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await page.getByRole('button', { name: 'Approve simulation' }).first().click();
  await expect(page.locator('#ops-message')).toContainText('action is stale'); expect((await f.service.view()).receipts).toHaveLength(2);
});
test('rejected simulation does not execute', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Reject simulation' }).first().click();
  await expect(page.getByText('HIGH_IMPACT · rejected', { exact: false })).toBeVisible(); expect((await f.service.view()).receipts).toHaveLength(2);
});
test('disabled backend shows safe unavailable state', async ({ page }) => {
  await page.route('**/api/operations**', route => route.fulfill({ status: 503, json: { code: 'OPERATIONS_DISABLED' } })); await page.goto('/command-center');
  await expect(page.locator('#ops-message')).toContainText('Hospital operations unavailable'); await expect(page.getByRole('button', { name: 'Request assessment' })).toBeDisabled();
});
test('model summaries render as text without HTML execution', async ({ page }) => {
  const f = await setup(page); await f.store.transaction('OPS-HOSP-001', state => { state.plans['OPS-PLAN-1'].assessment.changeSummary = '<img src=x onerror="window.opsInjected=true">'; });
  await page.getByRole('button', { name: 'Refresh operations' }).click();
  await expect(page.getByText('<img src=x onerror="window.opsInjected=true">', { exact: true })).toBeVisible(); expect(await page.evaluate(() => window.opsInjected)).toBeUndefined();
});

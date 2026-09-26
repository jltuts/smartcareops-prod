import { test, expect } from '@playwright/test';
import { resourceFixture } from '../../backend/tests/resources-fixtures.js';
import { observationSet } from '../../backend/tests/clinical-fixtures.js';

async function setup(page) {
  const f = await resourceFixture(); await f.service.append(observationSet()); await f.service.tick();
  await page.route('**/api/clinical**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    try {
      let result;
      if (request.method() === 'GET') result = await f.service.view();
      else if (path.endsWith('/resources/capacity')) { result = await f.service.changeCapacity(request.postDataJSON()); await f.service.tick(); }
      else if (path.includes('/approvals/')) { result = await f.service.decide(path.split('/').at(-1), request.postDataJSON().decision); await f.service.tick(); }
      else throw new Error('Unexpected request');
      await route.fulfill({ json: result });
    } catch { await route.fulfill({ status: 409, json: { code: 'STALE_APPROVAL' } }); }
  });
  await page.goto('/doctor'); await expect(page.getByRole('heading', { name: 'Revision 1 · current' })).toBeVisible(); return f;
}

test('operational investigation shows fictional hospitals, capabilities, specialists, capacity, distance and ETA', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('heading', { name: 'Operational resources · Simulation' })).toBeVisible();
  const plan = page.locator('[data-revision="1"]');
  for (const label of ['HOSP-001', 'HOSP-003', 'Capability match: yes', 'pulmonology specialist: available', 'Monitored beds: 2', 'Distance', 'ETA', 'Simulation · m9-demo:1', 'RESOURCE-SNAPSHOT-']) await expect(plan.getByText(label, { exact: false }).first()).toBeVisible();
  expect(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth)).toBe(true);
});

test('capacity control replans, preserves immutable history and invalidates pending approval', async ({ page }) => {
  const f = await setup(page), before = await f.store.read(f.caseId), id = Object.keys(before.approvals)[0];
  await page.getByRole('button', { name: 'Set HOSP-001 monitored beds to 0 (simulation)', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PLAN UPDATED · Revision 2 · current' })).toBeVisible();
  await expect(page.locator('[data-revision="2"]').getByText(/^Monitored beds: 0 ·/)).toBeVisible();
  await expect(page.locator('[data-revision="1"]').getByText(/^Monitored beds: 2 ·/)).toBeVisible();
  await expect(page.getByText('Resource change: HOSP-001', { exact: false })).toBeVisible();
  await expect(page.locator('[data-revision="1"]').getByRole('button', { name: 'Approve simulated action' })).toHaveCount(0);
  const after = await f.store.read(f.caseId); expect(after.plans.revision_1).toEqual(before.plans.revision_1); expect(after.approvals[id].status).toBe('superseded');
  await page.reload(); await expect(page.getByRole('heading', { name: 'PLAN UPDATED · Revision 2 · current' })).toBeVisible();
});

test('resource replan preserves a completed receipt without duplicate action after refresh', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Approve simulated action' }).click();
  await expect(page.getByText('Verified receipt:', { exact: false })).toBeVisible();
  const receipts = (await f.service.view()).receipts;
  await page.getByRole('button', { name: 'Set HOSP-001 monitored beds to 0 (simulation)', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PLAN UPDATED · Revision 2 · current' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Approve simulated action' })).toHaveCount(0);
  expect((await f.service.view()).receipts).toEqual(receipts);
});

test('capacity race rejects the stale UI command without corrupting resources', async ({ page }) => {
  const f = await setup(page);
  await f.service.changeCapacity({ requestId: 'concurrent', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 1 });
  await page.getByRole('button', { name: 'Set HOSP-001 monitored beds to 0 (simulation)', exact: true }).click();
  await expect(page.getByText('Request could not be confirmed. Refresh to check the durable result.')).toBeVisible();
  expect((await f.service.view()).resourceEnvironment.hospitals[0].capacity.monitoredBedsAvailable).toBe(2);
});

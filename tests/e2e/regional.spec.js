import { test, expect } from '@playwright/test';
import { regionalFixture } from '../../backend/tests/regional-fixtures.js';
async function setup(page) {
  const f = await regionalFixture(); await f.service.tick();
  await page.route('**/api/regional**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    try {
      let result;
      if (req.method() === 'GET') result = await f.service.view();
      else if (path.includes('/approvals/')) { result = await f.service.decide(path.split('/').at(-1), req.postDataJSON().decision); await f.service.tick(); }
      else if (path.endsWith('/capacity')) { result = await f.service.changeCapacity(req.postDataJSON()); await f.service.tick(); }
      else if (path.endsWith('/run')) { result = await f.service.requestRun(req.postDataJSON().requestId); await f.service.tick(); }
      else throw new Error('Unexpected command'); await route.fulfill({ json: result });
    } catch { await route.fulfill({ status: 409, json: { code: 'REGIONAL_STALE_APPROVAL' } }); }
  });
  await page.goto('/command-center'); await page.getByText('Regional Intelligence', { exact: true }).click(); await expect(page.getByRole('heading', { name: 'Regional plan REG-PLAN-1', exact: true })).toBeVisible(); return f;
}
test('regional UI shows suspected signal, bounded window, uncertainty, geography and hospital evidence', async ({ page }) => {
  await setup(page); const region = page.locator('#regional-workspace');
  await expect(region.getByText('Possible emerging respiratory cluster', { exact: true })).toBeVisible(); await expect(region.getByText('Time window: 18 hours', { exact: false })).toBeVisible();
  await expect(region.getByRole('img', { name: 'Three fictional hospitals plotted from simulated coordinates' })).toBeVisible();
  await expect(region.getByText('Hospital handoff:', { exact: false })).toBeVisible(); await expect(region.getByText('Fever total: unknown', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('regional UI approval produces simulation receipt and survives refresh', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Approve regional simulation' }).first().click();
  await expect(page.locator('#regional-workspace').getByText('fictional_rehearsal_recorded', { exact: false })).toBeVisible(); await page.reload(); await page.getByText('Regional Intelligence', { exact: true }).click();
  await expect(page.locator('#regional-workspace').getByText('fictional_rehearsal_recorded', { exact: false })).toBeVisible(); expect((await f.service.view()).receipts).toHaveLength(3);
});
test('regional resource change creates plan v2 and preserves v1', async ({ page }) => {
  const f = await setup(page), before = (await f.service.view()).plans[0]; await page.getByRole('button', { name: 'Demo: set HOSP-003 monitored beds to 0' }).click();
  await expect(page.getByRole('heading', { name: 'Regional plan REG-PLAN-2', exact: true })).toBeVisible();
  await expect(page.getByText('REG-PLAN-1 · Snapshot', { exact: false })).toBeVisible(); expect((await f.service.view()).plans[0]).toEqual(before);
});
test('regional stale approval fails safely', async ({ page }) => {
  const f = await setup(page); await f.service.changeCapacity({ requestId: 'external', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await page.getByRole('button', { name: 'Approve regional simulation' }).first().click(); await expect(page.locator('#regional-message')).toContainText('action is out of date'); expect((await f.service.view()).receipts).toHaveLength(2);
});
test('regional rejected simulation does not execute', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Reject regional simulation' }).first().click();
  await expect(page.locator('#regional-workspace').getByText('HIGH_IMPACT · rejected', { exact: false })).toBeVisible(); expect((await f.service.view()).receipts).toHaveLength(2);
});
test('regional disabled state leaves hospital surface available', async ({ page }) => {
  await page.goto('/command-center'); await page.getByText('Regional Intelligence', { exact: true }).click(); await expect(page.locator('#regional-message')).toContainText('This supporting regional view is not included in the current demo configuration.');
  await page.getByRole('navigation', { name: 'Command Center sections' }).getByRole('link', { name: 'Hospital Operations' }).click();
  await expect(page.getByRole('heading', { name: 'Hospital Operations', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request regional assessment' })).toBeDisabled();
});

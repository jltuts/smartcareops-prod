import { test, expect } from '@playwright/test';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { emergencyIntake } from '../../backend/tests/safety-fixtures.js';
import { routingIntake } from '../../backend/tests/routing-fixtures.js';

async function fixture(page) {
  const store = createMemoryCaseStore(), id = newCaseId();
  await store.createCase({ caseId: id, intake: emergencyIntake() });
  await store.createCase({ caseId: newCaseId(), intake: routingIntake() });
  await page.route('**/api/dispatcher/cases**', async route => {
    const url = new URL(route.request().url()), parts = url.pathname.split('/');
    try {
      let result;
      if (url.pathname === '/api/dispatcher/cases') result = await store.listDispatcherCases({ after: url.searchParams.get('after') || undefined });
      else if (parts.at(-1) === 'acknowledge') {
        expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({});
        result = await store.acknowledgeEmergency(parts[4]);
      } else result = await store.getDispatcherCase(parts[4]);
      await route.fulfill({ json: result });
    } catch { await route.fulfill({ status: 404, json: {} }); }
  });
  await page.route(`**/api/cases/${id}`, async route => route.fulfill({ json: await store.getCase(id) }));
  return { store, id };
}
test('dispatcher shows emergency only, opens facts, acknowledges and preserves state on refresh', async ({ page }) => {
  const { store, id } = await fixture(page), triggeredAt = (await store.getCase(id)).emergency.triggeredAt;
  await page.goto('/dispatcher'); await expect(page.locator('.dispatcher-card')).toHaveCount(1);
  await expect(page.locator('.dispatcher-card')).toContainText('Pending dispatcher');
  await expect(page.locator('.dispatcher-card')).toContainText('confirmed current chest pain red flag');
  await page.getByRole('button', { name: `Open emergency case ${id}`, exact: true }).click();
  await expect(page.locator('#dispatcher-detail')).toContainText('current chest pain (confirmed)');
  await expect(page.locator('#dispatcher-detail')).toContainText('Validated patient-reported facts and vitals');
  await page.getByRole('button', { name: `Acknowledge ${id}`, exact: true }).click();
  await expect(page.locator('#dispatcher-action')).toHaveText('Dispatcher acknowledged. No emergency response has been dispatched.');
  await expect(page.locator('.dispatcher-card')).toContainText('Dispatcher acknowledged');
  await expect(page.getByRole('button', { name: `Acknowledge ${id}`, exact: true })).toHaveCount(0);
  await expect(page.locator('#dispatcher-detail')).toContainText('Acknowledged by demo dispatcher');
  const timestamp = (await store.getCase(id)).emergency.acknowledgedAt;
  await page.reload(); await expect(page.locator('.dispatcher-card')).toContainText('Dispatcher acknowledged');
  expect((await store.getCase(id)).emergency.triggeredAt).toBe(triggeredAt);
  expect((await store.getCase(id)).emergency.acknowledgedAt).toBe(timestamp);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('patient saved case changes from pending to acknowledged, without normal routing', async ({ page }) => {
  const { store, id } = await fixture(page);
  await page.addInitScript(caseId => sessionStorage.setItem('smartcareops-case-id', caseId), id);
  await page.goto('/patient');
  await expect(page.locator('#patient-case-emergency')).toBeVisible();
  await expect(page.locator('#patient-case-emergency-status')).toHaveText('Status: Pending dispatcher');
  await expect(page.getByRole('button', { name: 'Route to doctor', exact: true })).toBeHidden();
  await store.acknowledgeEmergency(id);
  await expect(page.locator('#patient-case-emergency-status')).toHaveText('Status: Dispatcher acknowledged', { timeout: 10000 });
  await expect(page.locator('#patient-case-routing')).toHaveText('Normal doctor routing skipped.');
  await page.reload(); await expect(page.locator('#patient-case-emergency-status')).toHaveText('Status: Dispatcher acknowledged');
  await expect(page.locator('#patient-case-emergency')).toContainText('No ambulance or emergency service has been contacted');
});
test('acknowledgement failure never claims success and allows retry', async ({ page }) => {
  const { id } = await fixture(page);
  await page.route(`**/api/dispatcher/cases/${id}/acknowledge`, route => route.fulfill({ status: 503, json: {} }));
  await page.goto('/dispatcher'); await page.getByRole('button', { name: `Acknowledge ${id}`, exact: true }).click();
  await expect(page.locator('#dispatcher-action')).toHaveText('Acknowledgement could not be confirmed. Refresh or retry.');
  await expect(page.locator('.dispatcher-card')).toContainText('Pending dispatcher');
  await expect(page.getByRole('button', { name: `Acknowledge ${id}`, exact: true })).toBeEnabled();
});
test('dispatcher handles empty and unavailable queue states', async ({ page }) => {
  let failed = true;
  await page.route('**/api/dispatcher/cases', route => route.fulfill(failed ? { status: 503, json: {} } : { json: { cases: [], nextCursor: null } }));
  await page.goto('/dispatcher'); await expect(page.locator('#dispatcher-message')).toHaveText('Emergency queue unavailable. Refresh to retry.');
  failed = false; await page.getByRole('button', { name: 'Refresh emergencies' }).click();
  await expect(page.locator('#dispatcher-message')).toHaveText('No emergency cases.');
});
test('dispatcher pagination and patient text are safe', async ({ page }) => {
  const { store } = await fixture(page);
  for (let i = 0; i < 50; i++) {
    const intake = emergencyIntake(); intake.patient.preferredName = '<img src=x onerror="window.injected=true">';
    await store.createCase({ caseId: newCaseId(), intake });
  }
  await page.goto('/dispatcher'); await expect(page.locator('.dispatcher-card')).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more emergencies' }).click(); await expect(page.locator('.dispatcher-card')).toHaveCount(51);
  await expect(page.getByRole('button', { name: 'Load more emergencies' })).toBeHidden();
  await expect(page.locator('.dispatcher-card img')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

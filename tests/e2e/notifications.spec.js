import { test, expect } from '@playwright/test';
import { regionalFixture, regionalAssessment } from '../../backend/tests/regional-fixtures.js';
import { createNotificationCenter } from '../../backend/src/notifications/service.js';
async function setup(page) {
  const f = await regionalFixture({ notificationsEnabled: true, model: context => ({ ...regionalAssessment(context), recommendedActions: ['notify_participating_hospital', 'notify_command_center', 'schedule_followup_review'] }) });
  await f.service.tick(); const center = createNotificationCenter({ sources: [{ scope: 'regional', subjectId: 'REGION-DEMO-001', store: f.store, service: f.service }] });
  await page.route('**/api/notifications**', async route => {
    try { const req = route.request(); if (req.method() === 'POST') { await center.decide(new URL(req.url()).pathname.split('/')[3], req.postDataJSON().decision); await f.service.tick(); await route.fulfill({ json: { simulation: true } }); }
      else await route.fulfill({ json: await center.view(new URL(req.url()).searchParams.get('recipientType')) }); }
    catch { await route.fulfill({ status: 409, json: { code: 'STALE_NOTIFICATION' } }); }
  });
  await page.goto('/command-center'); return f;
}
test('notification inbox approves a simulated hospital notice and preserves its receipt on refresh', async ({ page }) => {
  const f = await setup(page), panel = page.getByRole('region', { name: 'Simulated notification center' });
  const card = panel.locator('article').filter({ hasText: 'Simulated participating-hospital notice' });
  await expect(card).toContainText('SIMULATION · pending'); await card.getByRole('button', { name: 'Approve simulated notice' }).click();
  await expect(card).toContainText('Simulated notification delivered'); await page.reload(); await expect(card).toContainText('Receipt:');
  expect((await f.service.view()).receipts.filter(r => r.notificationId)).toHaveLength(1);
});
test('stale inbox approval fails without delivery and refresh exposes supersession', async ({ page }) => {
  const f = await setup(page), panel = page.getByRole('region', { name: 'Simulated notification center' });
  await expect(panel.getByRole('button', { name: 'Approve simulated notice' }).first()).toBeVisible();
  await f.service.changeCapacity({ requestId: 'changed', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await panel.getByRole('button', { name: 'Approve simulated notice' }).first().click(); await expect(panel).toContainText('Decision unavailable');
  await panel.getByRole('button', { name: 'Refresh notifications' }).click(); await expect(panel.locator('article').first()).toContainText('superseded');
  expect((await f.service.view()).receipts.filter(r => r.notificationId)).toHaveLength(0);
});
test('notification rejection cancels notice and mobile inbox fits viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await setup(page), panel = page.getByRole('region', { name: 'Simulated notification center' });
  await panel.getByRole('button', { name: 'Reject simulated notice' }).first().click(); await expect(panel).toContainText('SIMULATION · cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await f.service.view()).receipts.filter(r => r.notificationId)).toHaveLength(0);
});
test('disabled notification service has a safe local status', async ({ page }) => {
  await page.goto('/doctor'); await expect(page.getByRole('region', { name: 'Simulated notification center' })).toContainText('Simulated notifications are unavailable or disabled.');
});

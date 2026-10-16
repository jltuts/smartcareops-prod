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
  await page.goto('/command-center'); await page.locator('.notification-support > summary').click(); return f;
}
test('notification inbox approves a simulated hospital notice and preserves its receipt on refresh', async ({ page }) => {
  const f = await setup(page), panel = page.getByRole('region', { name: 'Operational notifications' });
  const card = panel.locator('article').filter({ hasText: 'Simulated participating-hospital notice' });
  await expect(card).toContainText('Action required'); await card.getByRole('button', { name: 'Approve simulated notice' }).click();
  await expect(card).toContainText('Simulated notification delivered'); await page.reload(); await page.locator('.notification-support > summary').click(); await expect(card).toContainText('Receipt:');
  expect((await f.service.view()).receipts.filter(r => r.notificationId)).toHaveLength(1);
});
test('stale inbox approval fails without delivery and refresh exposes supersession', async ({ page }) => {
  const f = await setup(page), panel = page.getByRole('region', { name: 'Operational notifications' });
  await expect(panel.getByRole('button', { name: 'Approve simulated notice' }).first()).toBeVisible();
  await f.service.changeCapacity({ requestId: 'changed', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await panel.getByRole('button', { name: 'Approve simulated notice' }).first().click(); await expect(panel).toContainText('Decision unavailable');
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(panel.locator('article').first()).toContainText('superseded');
  expect((await f.service.view()).receipts.filter(r => r.notificationId)).toHaveLength(0);
});
test('notification rejection cancels notice and mobile inbox fits viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await setup(page), panel = page.getByRole('region', { name: 'Operational notifications' });
  await panel.getByRole('button', { name: 'Reject simulated notice' }).first().click(); await expect(panel).toContainText('cancelled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await f.service.view()).receipts.filter(r => r.notificationId)).toHaveLength(0);
});
test('disabled notification service has a safe local status', async ({ page }) => {
  await page.route('**/api/notifications**', route => route.fulfill({ status: 503, json: { code: 'NOTIFICATIONS_DISABLED' } }));
  await page.goto('/doctor');
  await expect(page.locator('main .notification-center')).toHaveCount(0);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Doctor notifications' })).toContainText('Notifications are unavailable right now. Refresh to retry.');
});

const notice = (overrides = {}) => ({
  notificationId: 'NOTIF-00000000000000000000000000000001',
  subject: 'Fictional case review requested',
  messageSummary: 'DEMO: New fictional observations and a clinical plan are available for doctor review. This is not a medical order.',
  status: 'sent', deliveryMode: 'in_app', recipientType: 'doctor', recipientId: 'DEMO-DOCTOR-REVIEW',
  agentType: 'Clinical Agent', scope: 'clinical', createdAt: '2026-09-28T01:00:00.000Z',
  sourceRevisionId: 'clinical_revision_1', sourceActionId: 'notify_doctor', receiptId: 'receipt_doctor_1', stale: false, canApprove: false,
  ...overrides,
});
const payload = notifications => ({ simulation: true, notifications, receipts: [], followups: [], unavailableScopes: [] });

test('portal headers request only their role notification view and expose an accessible panel', async ({ page }) => {
  const requests = [];
  await page.route('**/api/notifications**', route => {
    requests.push(route.request().url());
    const recipientType = new URL(route.request().url()).searchParams.get('recipientType');
    return route.fulfill({ json: payload(recipientType === 'doctor' ? [notice()] : recipientType === 'dispatcher' ? [notice({ notificationId: 'NOTIF-00000000000000000000000000000002', subject: 'Fictional dispatcher review requested', recipientType: 'dispatcher', recipientId: 'DEMO-DISPATCHER-001' })] : []) });
  });
  for (const [path, label, recipientType] of [['/doctor', 'Doctor notifications', 'doctor'], ['/dispatcher', 'Dispatcher notifications', 'dispatcher'], ['/command-center', 'Operational notifications', null]]) {
    await page.goto(path);
    const button = page.getByRole('button', { name: 'Notifications', exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('region', { name: label })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
    await expect(page.locator('main > .notification-center')).toHaveCount(0);
    const request = requests.findLast(url => new URL(url).pathname === '/api/notifications');
    expect(new URL(request).searchParams.get('recipientType')).toBe(recipientType);
  }
});

test('new informational popup dismisses while action-required history remains in the panel', async ({ page }) => {
  let notifications = [];
  await page.route('**/api/notifications**', route => route.fulfill({ json: payload(notifications) }));
  await page.goto('/doctor');
  const toggle = page.getByRole('button', { name: 'Notifications', exact: true });
  await toggle.click();
  const panel = page.getByRole('region', { name: 'Doctor notifications' });
  await expect(panel).toContainText('No notifications for this workspace.');
  notifications = [notice()];
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  const popup = page.locator('.notification-popup');
  await expect(popup).toContainText('Fictional case review requested');
  await popup.getByRole('button', { name: 'Dismiss' }).click();
  await expect(popup).toHaveCount(0);
  notifications = [notice(), notice({ notificationId: 'NOTIF-00000000000000000000000000000003', subject: 'Review before simulated delivery', status: 'pending', canApprove: true, receiptId: null })];
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.notification-popup')).toHaveCount(0);
  await expect(panel.getByText('Action required')).toBeVisible();
  await panel.getByRole('button', { name: 'Close notifications' }).click();
  await toggle.click();
  await expect(panel.getByText('Action required')).toBeVisible();
});

test('notification control and panel fit the mobile viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route('**/api/notifications**', route => route.fulfill({ json: payload([notice({ subject: 'Fictional dispatcher review requested', recipientType: 'dispatcher', recipientId: 'DEMO-DISPATCHER-001' })]) }));
  await page.goto('/dispatcher');
  const toggle = page.getByRole('button', { name: 'Notifications', exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('region', { name: 'Dispatcher notifications' })).toBeVisible();
  const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => {
    const rect = element.getBoundingClientRect(); return rect.right > innerWidth + 1 || rect.left < -1;
  }).map(element => ({ tag: element.tagName, className: element.className, id: element.id, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
  expect(overflow).toEqual([]);
});

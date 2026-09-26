import { test, expect } from '@playwright/test';
import { emptyIntake } from '../../backend/src/intake/schema.js';
test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
const caseId = 'SC-11111111-1111-4111-8111-111111111111';
for (const storage of ['firestore', 'memory', 'firestore_emulator']) test(`case card reads saved ${storage} status and receipt after refresh`, async ({ page }) => {
  const intake = emptyIntake(); intake.patient.name = 'Demo Alex';
  let record = { caseId, workflowStatus: 'intake_completed', handoffStatus: 'not_started', storage }, reads = 0;
  await page.route(`**/api/cases/${caseId}`, route => { reads++; return route.fulfill({ json: record }); });
  await page.routeWebSocket('**/api/live', socket => socket.onMessage(raw => {
    if (JSON.parse(raw).type === 'start') {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.send(JSON.stringify({ type: 'intake-update', intake }));
      socket.send(JSON.stringify({ type: 'intake-complete', completionToken: 'test-only', patientCase: record }));
    }
  }));
  await page.goto('/patient'); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#patient-case-id')).toHaveText(caseId);
  await expect(page.locator('#patient-case-status')).toHaveText('Intake completed');
  await expect(page.locator('#patient-case-storage')).toHaveText(storage === 'memory' ? 'Memory — dev only; lost on backend restart' : storage === 'firestore_emulator' ? 'Firestore emulator — local test only' : 'Firestore');
  expect(reads).toBeGreaterThan(0);
  record = { ...record, workflowStatus: 'handoff_completed', handoffStatus: 'completed', handoffReceipt: { caseId: 'DEMO-1234ABCD' } };
  await page.reload();
  await expect(page.locator('#patient-case-status')).toHaveText('Handoff completed');
  await expect(page.locator('#patient-case-receipt')).toHaveText('Hospital receipt: DEMO-1234ABCD');
  expect(reads).toBeGreaterThan(1);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('Demo Alex');
});
test('case read failure is explicit and starting a new intake clears the previous card', async ({ page }) => {
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.route(`**/api/cases/${caseId}`, route => route.fulfill({ status: 503, json: { code: 'CASE_STORE_UNAVAILABLE' } }));
  await page.routeWebSocket('**/api/live', socket => socket.onMessage(() => socket.send(JSON.stringify({ type: 'ready' }))));
  await page.goto('/patient');
  await expect(page.locator('#patient-case-storage')).toHaveText('Unavailable — persistence not confirmed');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#patient-case')).toBeHidden();
  await page.getByRole('button', { name: 'End Conversation' }).click();
});

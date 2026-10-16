import { test, expect } from '@playwright/test';

test('mode choice is keyboard accessible and never starts intake or grants consent', async ({ page }, testInfo) => {
  let microphone = 0, sessions = 0;
  await page.addInitScript(() => {
    window.modeMicrophoneCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.modeMicrophoneCalls++; throw new Error('Not started by mode choice'); };
  });
  page.on('request', request => { if (/\/api\/(live\/session|intake\/chat\/session)$/.test(request.url()) && request.method() === 'POST') sessions++; });
  await page.route('**/api/cases?*', route => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.goto('/patient');
  await expect(page.locator('#patient-mode-choice')).toBeVisible();
  const photo = page.locator('.patient-intake-photo');
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.patient-case-illustration')).toBeHidden();
  await expect(page.locator('#conversation-area')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('mode-choice.png'), fullPage: true });
  const voice = page.locator('#patient-mode-choice [data-intake-mode="voice"]');
  await voice.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#intake-fictional')).toBeFocused();
  await expect(page.locator('#start-conversation')).toBeDisabled();
  await expect(page.locator('#chat-fictional')).toBeHidden();
  await expect(page.locator('.conversation-status')).toBeHidden();
  await expect(page.locator('.patient-transcript-wrap')).toBeHidden();
  await page.locator('#intake-fictional').check();
  await expect(page.locator('#start-conversation')).toBeEnabled();
  await page.locator('.patient-mode-toolbar [data-intake-mode="chat"]').click();
  await expect(page.locator('#chat-fictional')).toBeFocused();
  await expect(page.locator('#start-chat-intake')).toBeDisabled();
  await expect(page.locator('#start-conversation')).toBeHidden();
  await page.locator('#chat-fictional').check();
  await expect(page.locator('#start-chat-intake')).toBeEnabled();
  microphone = await page.evaluate(() => window.modeMicrophoneCalls);
  expect(microphone).toBe(0); expect(sessions).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('saved-case hero uses the approved photo while retaining its status and action', async ({ page }, testInfo) => {
  const caseId = 'SC-20000000-0000-4000-8000-000000000002';
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.route('**/api/cases?*', route => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route(`**/api/cases/${caseId}`, route => route.fulfill({ json: {
    caseId, storage: 'firestore', workflowStatus: 'submitted_for_clinical_review',
    clinicalReview: { status: 'approved', updatedAt: '2026-09-29T02:00:00.000Z' },
    doctorAttribution: { status: 'available', displayName: 'Dr. Fictional Rivera', specialty: 'general_medicine' },
  } }));
  await page.goto('/patient');
  await expect(page.locator('#care-journey-heading')).toHaveText('Your care is in progress.');
  await expect(page.locator('#patient-current-status')).toHaveText('Clinical review approved');
  await expect(page.locator('.patient-view-case')).toBeVisible();
  await expect(page.locator('#patient-mode-choice')).toBeHidden();
  const photo = page.locator('.patient-intake-photo');
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.patient-case-illustration')).toBeHidden();
  await page.locator('.patient-care-card').screenshot({ path: testInfo.outputPath('saved-case-hero.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { test, expect } from '@playwright/test';
import { emptyIntake } from '../../backend/src/intake/schema.js';

async function mockChatApi(page) {
  const sessionId = 'a'.repeat(64), questions = [
    'What name would you like me to use?', 'What are you feeling today?', 'When did this start, or when did it last change?',
    'How severe is it from 1 to 10, with 10 being the most severe?', 'Is this new, recurring, or related to a condition you already know about?',
    "Is there anything else you'd like to add before we finish?",
  ];
  let step = 0;
  const state = { sessionId, revision: 0, status: 'collecting', progress: { phase: 'main_concern', status: 'collecting', path: null, answered: 0, total: 5 },
    question: questions[0], messages: [{ role: 'SmartCareOps', text: questions[0] }], intake: emptyIntake() };
  await page.route('**/api/intake/chat/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/session') && request.method() === 'POST') return route.fulfill({ status: 201, json: state });
    if (url.pathname.endsWith('/session') && request.method() === 'GET') return route.fulfill({ json: state });
    if (url.pathname.endsWith('/session') && request.method() === 'DELETE') return route.fulfill({ json: { status: 'cancelled' } });
    if (url.pathname.endsWith('/message') && request.method() === 'POST') {
      const input = request.postDataJSON(); state.messages.push({ role: 'Patient', text: input.message }); state.revision++;
      if (/can't breathe|cannot breathe/i.test(input.message)) {
        state.status = 'emergency'; state.question = null; state.progress = { ...state.progress, phase: 'emergency', status: 'emergency' };
        state.messages.push({ role: 'SmartCareOps', text: "This information may require urgent attention. I'm stopping the standard intake. Emergency escalation is pending. No dispatcher or emergency service has been contacted." },
          { role: 'SmartCareOps', text: 'Current demo hospital information is unavailable.' },
          { role: 'SmartCareOps', text: 'Your emergency case has been sent to the SmartCareOps command center for dispatcher review. No ambulance or hospital referral has been confirmed.' });
        state.patientCase = { caseId: 'SC-10000000-0000-4000-8000-000000000001', workflowStatus: 'emergency_pending_dispatcher' };
      } else {
        step++;
        if (step >= questions.length) {
          state.status = 'completed'; state.question = null; state.progress = { ...state.progress, phase: 'review', status: 'ready_to_complete' };
          state.messages.push({ role: 'SmartCareOps', text: 'Thank you. Your intake is complete.' });
          state.patientCase = { caseId: 'SC-10000000-0000-4000-8000-000000000002', workflowStatus: 'submitted_for_clinical_review' };
        } else {
          state.question = questions[step]; state.progress = { ...state.progress, phase: step < 2 ? 'main_concern' : step === 5 ? 'review' : 'relevant_follow_up', answered: step };
          state.messages.push({ role: 'SmartCareOps', text: questions[step] });
        }
      }
      return route.fulfill({ json: state });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('**/api/intake/evidence/share', async route => {
    const input = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { evidence: { evidenceId: input.evidenceId, kind: 'body_area' } } });
  });
  await page.route('**/api/intake/medicine/scan', route => route.fulfill({ json: { candidate: { status: 'identified', name: 'Demo medicine', strength: '10 mg' } } }));
  await page.route('**/api/intake/medicine/confirm', route => route.fulfill({ status: 201, json: { receiptId: 'medicine-demo', medication: { source: 'packaging_shown', verification: 'patient_reported' } } }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.chatMicrophoneRequests = 0;
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (navigator.mediaDevices && original) navigator.mediaDevices.getUserMedia = (...args) => { window.chatMicrophoneRequests++; return original(...args); };
  });
  await mockChatApi(page);
  await page.goto('/patient');
});

test('Patient completes a typed intake without microphone or Live WebSocket use', async ({ page }) => {
  await page.locator('[data-intake-mode="chat"]').first().click();
  await expect(page.locator('#chat-fictional')).toBeFocused();
  const chatStart = page.getByRole('button', { name: 'Start Chat Intake' });
  await expect(chatStart).toBeDisabled();
  await page.locator('#chat-fictional').check();
  const started = page.waitForResponse(response => response.url().includes('/api/intake/chat/session') && response.request().method() === 'POST');
  await chatStart.click();
  const startedResponse = await started;
  expect(startedResponse.status(), await startedResponse.text()).toBe(201);
  await expect(page.locator('#chat-intake-messages')).toContainText('What name would you like me to use?');
  const chatRegion = page.locator('#chat-conversation-box');
  await expect(chatRegion).toBeVisible();
  await expect(chatRegion).toBeFocused();
  const headerBottom = await page.locator('.site-header').evaluate(node => node.getBoundingClientRect().bottom);
  const conversationTop = await chatRegion.evaluate(node => node.getBoundingClientRect().top);
  expect(conversationTop).toBeGreaterThanOrEqual(headerBottom);
  await expect(page.locator('#chat-evidence')).toBeVisible();
  await expect(page.locator('#start-conversation')).toBeDisabled();
  await expect(page.locator('.patient-mode-toolbar [data-intake-mode="voice"]')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.chatMicrophoneRequests)).toBe(0);

  const image = Buffer.from('/9j/2Q==', 'base64');
  const evidenceChoices = page.locator('#chat-evidence [data-chat-evidence-kind]');
  await expect(evidenceChoices).toHaveCount(2);
  await expect(evidenceChoices.first()).toHaveAttribute('aria-checked', 'false');
  await expect(evidenceChoices.last()).toHaveAttribute('aria-checked', 'false');
  await page.locator('[data-chat-evidence-kind="body_area"]').click();
  await page.locator('#chat-evidence-image').setInputFiles({ name: 'pain-location.jpg', mimeType: 'image/jpeg', buffer: image });
  await page.locator('#chat-evidence-description').fill('Pain on the outer part of my left shoulder.');
  await page.locator('#chat-evidence-confirm').check();
  await page.getByRole('button', { name: 'Share image with case' }).click();
  await expect(page.locator('#chat-evidence-status')).toContainText('Image shared with this intake');

  const answer = page.locator('#chat-intake-answer');
  await answer.fill('Louis'); await answer.press('Enter');
  await expect(page.locator('#chat-intake-messages')).toContainText('What are you feeling today?');
  for (const [value, next] of [
    ['I feel unwell', 'When did this start'],
    ['Yesterday', 'How severe is it'],
    ['Moderate', 'Is this new'],
    ['It is new', "Is there anything else you'd like to add"],
  ]) {
    await answer.fill(value); await page.getByRole('button', { name: 'Send answer' }).click();
    await expect(page.locator('#chat-intake-messages')).toContainText(next);
  }
  await answer.fill('Nothing else'); await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.locator('#chat-intake-status')).toHaveText('Your typed intake was saved.');
  await expect(page.locator('#chat-view-cases')).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('smartcareops-chat-intake-session'))).toBeNull();
  await expect.poll(() => page.evaluate(() => window.chatMicrophoneRequests)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator('#chat-intake-messages').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
});

test('Chat Intake offers unselected icon choices and saves a reviewed medicine package', async ({ page }) => {
  await page.locator('[data-intake-mode="chat"]').first().click(); await page.locator('#chat-fictional').check(); await page.getByRole('button', { name: 'Start Chat Intake' }).click();
  const answer = page.locator('#chat-intake-answer');
  for (const value of ['Louis', 'Dizzy', 'Yesterday', '6', 'New']) {
    await answer.fill(value); await page.getByRole('button', { name: 'Send answer' }).click();
  }
  await expect(page.locator('#chat-intake-messages')).toContainText("Is there anything else you'd like to add before we finish?");
  const choices = page.locator('#chat-evidence [data-chat-evidence-kind]');
  await expect(page.locator('#chat-evidence-question')).toHaveText('What would you like to submit as clinical photo?');
  await expect(choices).toHaveText(['Medicine package', 'Pain location']);
  await expect(choices.locator('svg')).toHaveCount(2);
  await expect(choices.first()).toHaveAttribute('aria-checked', 'false');
  await expect(choices.last()).toHaveAttribute('aria-checked', 'false');
  await choices.first().click();
  await expect(choices.first()).toHaveAttribute('aria-checked', 'true');
  const sources = page.locator('#chat-medicine-source .patient-evidence-choice');
  await expect(sources).toHaveText(['Use camera', 'Upload photo']);
  await expect(sources.first()).toHaveAttribute('aria-checked', 'false');
  await expect(sources.last()).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('radio', { name: 'Upload photo' }).click();
  await expect(sources.last()).toHaveAttribute('aria-checked', 'true');
  const fileControlStyle = await page.locator('#chat-evidence-image').evaluate(input => {
    const control = getComputedStyle(input), button = getComputedStyle(input, '::file-selector-button');
    return { minHeight: control.minHeight, fontSize: control.fontSize, buttonBackground: button.backgroundColor, buttonRadius: button.borderRadius };
  });
  expect(fileControlStyle).toEqual({ minHeight: '44px', fontSize: '13px', buttonBackground: 'rgb(234, 247, 251)', buttonRadius: '7px' });
  await page.locator('#chat-evidence-image').setInputFiles({ name: 'medicine.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('/9j/2Q==', 'base64') });
  await page.getByRole('button', { name: 'Read medicine package' }).click();
  await expect(page.locator('#chat-medicine-name')).toHaveValue('Demo medicine');
  await expect(page.locator('#chat-medicine-strength')).toHaveValue('10 mg');
  await page.locator('#chat-medicine-how-taken').fill('One tablet when needed.');
  await page.locator('#chat-medicine-confirm').check();
  await page.getByRole('button', { name: 'Save confirmed medicine' }).click();
  await expect(page.locator('#chat-evidence-status')).toContainText('Medicine entry saved to this intake');
  await expect(page.locator('#chat-intake-status')).toHaveText('Medicine saved. Continue your chat intake.');
  await expect(page.locator('#chat-intake-messages li').last()).toContainText("Is there anything else you'd like to add before we finish?");
  await expect(answer).toBeFocused();
  await answer.fill('No, nothing else.'); await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.locator('#chat-intake-status')).toHaveText('Your typed intake was saved.');
  const transcript = page.locator('#chat-intake-messages');
  await expect(transcript).toContainText("Is there anything else you'd like to add before we finish?");
  await expect(transcript).toContainText('Thank you. Your intake is complete.');
});

test('Chat Intake can capture a medicine package with the camera before reading it', async ({ page }) => {
  await page.evaluate(() => {
    const track = { stop() { window.__chatCameraStopped = (window.__chatCameraStopped || 0) + 1; }, getCapabilities: () => ({ focusMode: [] }) };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async constraints => { window.__chatCameraConstraints = constraints; return stream; } } });
    Object.defineProperties(HTMLVideoElement.prototype, { videoWidth: { configurable: true, get: () => 1600 }, videoHeight: { configurable: true, get: () => 1200 } });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get() { return this.__chatStream || null; }, set(value) { this.__chatStream = value; } });
    HTMLVideoElement.prototype.play = async function () {};
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new Blob([new Uint8Array([255, 216, 1, 2, 255, 217])], { type: 'image/jpeg' })); };
  });
  await page.locator('[data-intake-mode="chat"]').first().click(); await page.locator('#chat-fictional').check(); await page.getByRole('button', { name: 'Start Chat Intake' }).click();
  await page.locator('[data-chat-evidence-kind="medicine_package"]').click();
  await page.getByRole('radio', { name: 'Use camera' }).click();
  await expect(page.locator('#chat-evidence-camera')).toBeVisible();
  expect(await page.evaluate(() => window.__chatCameraConstraints)).toEqual({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  await page.getByRole('button', { name: 'Capture photo' }).click();
  await expect(page.locator('#chat-evidence-preview')).toBeVisible();
  await expect(page.locator('#chat-evidence-camera-review')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read medicine package' })).toBeDisabled();
  await page.getByRole('button', { name: 'Use this photo' }).click();
  await expect(page.locator('#chat-medicine-name')).toHaveValue('Demo medicine');
  await expect(page.locator('#chat-medicine-strength')).toHaveValue('10 mg');
  await expect(page.getByRole('button', { name: 'Save confirmed medicine' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read medicine package' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__chatCameraStopped)).toBeGreaterThan(0);
});

test('typed intake restores after refresh and emergency hospital information is visible', async ({ page }) => {
  await page.locator('[data-intake-mode="chat"]').first().click(); await page.locator('#chat-fictional').check(); await page.getByRole('button', { name: 'Start Chat Intake' }).click();
  const answer = page.locator('#chat-intake-answer');
  await answer.fill('Louis'); await page.getByRole('button', { name: 'Send answer' }).click();
  const sessionId = await page.evaluate(() => sessionStorage.getItem('smartcareops-chat-intake-session'));
  expect(sessionId).toMatch(/^[a-f0-9]{64}$/);
  await page.reload();
  await expect(page.locator('#chat-intake-messages')).toContainText('What are you feeling today?');
  await expect(page.locator('.patient-page')).toHaveAttribute('data-intake-mode', 'chat');
  await expect(page.locator('.patient-mode-toolbar [data-intake-mode="voice"]')).toBeDisabled();
  await page.locator('#chat-intake-answer').fill("I can't breathe"); await page.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.locator('#chat-intake-messages')).toContainText('This information may require urgent attention.');
  await expect(page.locator('#chat-intake-messages')).toContainText(/hospital information available in this demo|Current demo hospital information is unavailable/);
  await expect(page.locator('#chat-intake-messages')).toContainText('sent to the SmartCareOps command center for dispatcher review');
  await expect(page.locator('#chat-intake-status')).toContainText('No ambulance or hospital referral has been confirmed.');
  await expect.poll(() => page.evaluate(() => window.chatMicrophoneRequests)).toBe(0);
});

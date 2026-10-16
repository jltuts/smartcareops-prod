import { test, expect } from '@playwright/test';
import { emptyIntake } from '../../backend/src/intake/schema.js';
import { finalizationFailure } from '../../backend/src/intake/finalization.js';

for (const code of ['INVALID_RESPONSE', 'RATE_LIMIT']) {
  test(`finalization ${code} displays diagnostics and preserves facts while stopping capture`, async ({ page }) => {
    let relay;
    await page.routeWebSocket('**/api/live', socket => {
      relay = socket;
      socket.onMessage(raw => {
        if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
      });
    });
    await page.goto('/patient');
    await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    const intake = emptyIntake(); intake.patient.name = 'JL';
    intake.evidence.name = { utteranceId: 1, patientReportedText: 'My name is JL.' };
    relay.send(JSON.stringify({ type: 'intake-update', intake }));
    const error = finalizationFailure(code, code === 'RATE_LIMIT' ? 'extraction' : 'validation', [6], code === 'RATE_LIMIT' ? { httpStatus: 429 } : { reason: 'invalid schema' });
    relay.send(JSON.stringify({ type: 'finalization-error', error }));
    relay.send(JSON.stringify({ type: 'error', message: error.userMessage }));
    await expect(page.locator('#intake-status')).toHaveText(error.userMessage);
    await expect(page.locator('#intake-error-detail')).toBeVisible();
    await expect(page.locator('#intake-error-detail')).toContainText(`Code: ${code}`);
    await expect(page.locator('#intake-error-detail')).toContainText('Utterance: 6');
    await expect(page.locator('#intake-error-detail')).toContainText(code === 'RATE_LIMIT' ? 'HTTP: 429' : 'Reason: invalid schema');
    await expect(page.locator('[data-intake="patient"]')).toContainText('JL');
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  });
}

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('starting voice intake focuses a bounded transcript while the evidence dropdown stays visible', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await page.locator('#intake-fictional').check();
  await page.getByRole('button', { name: 'Start Conversation' }).click();
  const transcriptRegion = page.locator('.patient-transcript-wrap');
  const evidence = page.locator('#medicine-flow');
  await expect(transcriptRegion).toBeFocused();
  await expect(evidence).toBeVisible();
  await expect(evidence.getByText('What would you like to submit as clinical photo?')).toBeVisible();
  const headerBottom = await page.locator('.site-header').evaluate(node => node.getBoundingClientRect().bottom);
  const transcriptTop = await transcriptRegion.evaluate(node => node.getBoundingClientRect().top);
  expect(transcriptTop).toBeGreaterThanOrEqual(headerBottom);
  const evidenceBox = await evidence.boundingBox();
  expect(evidenceBox.y + evidenceBox.height).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerHeight)
  );
  await expect(page.locator('#patient-evidence-kind')).toHaveValue('');
  await expect(page.locator('#patient-evidence-kind option:not([value=""])')).toHaveText(['Medicine package', 'Pain location']);
  await expect(evidence.getByRole('radio')).toHaveText(['Medicine package', 'Pain location']);
  await expect(evidence.getByRole('radio').first()).toHaveAttribute('aria-checked', 'false');
  await expect(evidence.getByRole('radio').last()).toHaveAttribute('aria-checked', 'false');
  const initialChoiceBackgrounds = await evidence.getByRole('radio').evaluateAll(buttons => buttons.map(button => getComputedStyle(button).backgroundColor));
  expect(new Set(initialChoiceBackgrounds).size).toBe(1);
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  for (let index = 0; index < 12; index++) relay.send(JSON.stringify({ type: 'transcript', role: index % 2 ? 'Patient' : 'Gemini', text: `Transcript entry ${index + 1}`, finished: true }));
  await expect.poll(() => page.locator('#transcript li').count()).toBe(12);
  expect(await page.locator('#transcript').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
});

test('adaptive intake progress remains readable, accessible, and overflow-free on desktop and mobile', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
  const start = page.getByRole('button', { name: 'Start Conversation' });
  const box = await start.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await start.click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'intake-progress', progress: { phase: 'safety', status: 'collecting', answered: 2, total: 8 } }));
  const progress = page.locator('.intake-progress');
  await expect(progress.locator('li')).toHaveText(['Main concern', 'Safety questions', 'Relevant follow-up', 'Review and submit']);
  await expect(progress.locator('[aria-current="step"]')).toHaveText('Safety questions');
  await expect(page.locator('#intake-progress-state')).toHaveText('Continue with the current question.');
  await expect(progress).not.toContainText(/core\.|chest\.|routing|milestone/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  relay.send(JSON.stringify({ type: 'intake-progress', progress: { phase: 'safety', status: 'clarifying', answered: 2, total: 8 } }));
  await expect(page.locator('#intake-progress-state')).toHaveText('Clarifying the current question.');
  relay.send(JSON.stringify({ type: 'intake-progress', progress: { phase: 'emergency', status: 'emergency', answered: 3, total: 8 } }));
  await expect(page.locator('#intake-progress-state')).toHaveText('Emergency flow committed.');
});

test('durable finalization polling survives an immediate refresh with an aborted pending poll', async ({ page }) => {
  const ticket = '10000000-0000-4000-8000-000000000001';
  const caseId = 'SC-20000000-0000-4000-8000-000000000001';
  let ready = false, relay, requests = 0;
  await page.route('**/api/intake-finalization', async route => {
    requests++;
    if (requests === 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (route.request().isNavigationRequest()) return;
    }
    await route.fulfill(ready ? { json: {
    type: 'intake-complete', status: 'COMPLETED', snapshot: emptyIntake(),
    patientCase: { caseId, workflowStatus: 'submitted_for_clinical_review', handoffStatus: 'not_started', storage: 'firestore' },
    } } : { status: 202, json: { status: 'PENDING' } });
  });
  await page.route(`**/api/cases/${caseId}`, route => route.fulfill({ json: { caseId, workflowStatus: 'submitted_for_clinical_review', handoffStatus: 'not_started', storage: 'firestore' } }));
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient'); await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check(); await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'completion-pending', id: 1, resultTicket: ticket }));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('smartcareops-finalization-id'))).toBe(ticket);
  await expect(page.locator('#handoff-status')).toContainText('Finalizing and saving');
  await page.reload();
  await expect(page.locator('#handoff-status')).toContainText('Finalizing and saving');
  await expect(page.locator('#handoff-status')).not.toContainText('Waiting to begin');
  await expect.poll(() => requests).toBeGreaterThan(1);
  ready = true;
  await expect(page.locator('#patient-case-status')).toHaveText('Waiting for clinical review');
  await expect(page.locator('#patient-case-storage')).toHaveText('Firestore');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('smartcareops-finalization-id'))).toBeNull();
  await page.reload();
  await expect(page.locator('#patient-case-id')).toHaveText(caseId);
  await expect(page.locator('#patient-case-status')).toHaveText('Waiting for clinical review');
});

test('provider enrichment failure preserves durable intake success and review workflow', async ({ page }) => {
  const ticket = '10000000-0000-4000-8000-000000000003';
  const patientCase = { caseId: 'SC-20000000-0000-4000-8000-000000000003', workflowStatus: 'submitted_for_clinical_review',
    handoffStatus: 'not_started', storage: 'firestore', enrichmentStatus: 'failed', automaticHandoff: null, hospitalHandoffs: [] };
  let polls = 0, relay;
  await page.route('**/api/intake-finalization', route => route.fulfill(++polls === 1
    ? { status: 202, json: { status: 'PENDING', patientCase: { ...patientCase, enrichmentStatus: 'pending' } } }
    : { json: { type: 'intake-complete', status: 'COMPLETED', snapshot: emptyIntake(), patientCase,
      enrichmentStatus: 'failed', enrichmentErrorCategory: 'INVALID_RESPONSE' } }));
  await page.route(`**/api/cases/${patientCase.caseId}`, route => route.fulfill({ json: patientCase }));
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket; socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient'); await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check(); await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'completion-pending', id: 1, resultTicket: ticket }));
  await expect(page.locator('#patient-case-id')).toHaveText(patientCase.caseId);
  await expect(page.locator('#patient-case-status')).toHaveText('Waiting for clinical review');
  await expect(page.locator('#handoff-status')).toHaveText('Your intake has been submitted for clinical review.');
  await expect(page.locator('#intake-status')).toHaveText('Intake saved for clinical review.');
  await expect(page.locator('#handoff-start')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('smartcareops-finalization-id'))).toBeNull();
  await page.reload();
  await expect(page.locator('#patient-case-id')).toHaveText(patientCase.caseId);
  await expect(page.locator('#patient-case-status')).toHaveText('Waiting for clinical review');
});

test('terminal finalization failure remains recoverable after refresh', async ({ page }) => {
  const ticket = '10000000-0000-4000-8000-000000000002';
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), { key: 'smartcareops-finalization-id', value: ticket });
  await page.route('**/api/intake-finalization', route => route.fulfill({ json: {
    status: 'FAILED', error: finalizationFailure('INVALID_RESPONSE', 'validation', [1], { reason: 'invalid schema' }),
  } }));
  await page.goto('/patient');
  await expect(page.locator('#intake-error-detail')).toContainText('Code: INVALID_RESPONSE');
  await expect(page.locator('#handoff-status')).toHaveText('Your intake was captured, but the clinical summary could not be saved. Please try again.');
  await expect(page.locator('#handoff-status')).not.toContainText('Finalizing');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('smartcareops-finalization-id'))).toBe(ticket);
  await page.reload();
  await expect(page.locator('#intake-error-detail')).toContainText('Code: INVALID_RESPONSE');
  await expect(page.locator('#handoff-status')).toHaveText('Your intake was captured, but the clinical summary could not be saved. Please try again.');
  await expect(page.locator('#handoff-status')).not.toContainText('Waiting to begin');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('smartcareops-finalization-id'))).toBe(ticket);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.testStreams = [];
    window.testMicRequests = 0;
    window.testAudioContexts = [];
    window.testWorkletModuleUrls = [];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        window.testAudioContexts.push(this);
        const addModule = this.audioWorklet.addModule.bind(this.audioWorklet);
        this.audioWorklet.addModule = url => {
          window.testWorkletModuleUrls.push(new URL(url, window.location.href).href);
          return addModule(url);
        };
      }
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.testMicRequests++;
      const stream = await original(constraints);
      window.testStreams.push(stream);
      return stream;
    };
  });
});

test('mobile audio session is routed for simultaneous microphone capture and playback', async ({ page }) => {
  await page.addInitScript(() => {
    window.testAudioSessionTypes = [];
    let type = 'auto';
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: {
      get type() { return type; },
      set type(value) { type = value; window.testAudioSessionTypes.push(value); },
    } });
  });
  await page.routeWebSocket('**/api/live', socket => {
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
  await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
  await page.getByRole('button', { name: 'End Conversation' }).click();
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('auto');
  expect(await page.evaluate(() => window.testAudioSessionTypes)).toEqual(['play-and-record', 'auto']);
});

test('browser TTS speaks warning and hospital text, then keeps a tap-to-replay control after the session closes', async ({ page }) => {
  let relay; const received = [];
  await page.addInitScript(() => {
    window.testEmergencySpeech = []; window.testEmergencyCancels = 0;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const voice = { name: 'SmartCareOps test voice', lang: 'en-US', default: true };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(utterance) { window.testEmergencySpeech.push({ text: utterance.text, voice: utterance.voice?.name }); window.testEmergencyUtterance = utterance; },
      cancel() { window.testEmergencyCancels++; }, getVoices() { return [voice]; },
    } });
  });
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => {
      const message = JSON.parse(raw); received.push(message);
      if (message.type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
  await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'audio', data: 'AAAAAA==' }));
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  const warning = 'This information may require urgent attention. Emergency escalation is pending.';
  const facility = 'Based on the hospital information available in this demo, Northstar General is about 2.3 kilometers away.';
  relay.send(JSON.stringify({ type: 'emergency-escalation', id: 1, message: warning, snapshot: emptyIntake() }));
  relay.send(JSON.stringify({ type: 'transcript', role: 'Gemini', text: 'To support best…', finished: true }));
  relay.send(JSON.stringify({ type: 'audio', data: 'AQIDBA==' }));
  relay.send(JSON.stringify({ type: 'emergency-phase-speech', id: 1, phase: 'warning', text: warning }));
  await expect.poll(() => page.evaluate(() => window.testEmergencySpeech)).toEqual([{ text: warning, voice: 'SmartCareOps test voice' }]);
  expect(await page.evaluate(() => window.testEmergencyCancels)).toBe(1);
  await expect(page.locator('#transcript')).toContainText(warning);
  await expect(page.locator('#transcript')).not.toContainText('To support best');
  expect(received.some(message => message.type === 'emergency-phase-settled')).toBe(false);
  await page.evaluate(() => window.testEmergencyUtterance.onend());
  await expect.poll(() => received.some(message => message.type === 'emergency-phase-settled' && message.phase === 'warning')).toBe(true);
  relay.send(JSON.stringify({ type: 'emergency-phase-speech', id: 1, phase: 'facility', text: facility }));
  await expect.poll(() => page.evaluate(() => window.testEmergencySpeech)).toEqual([
    { text: warning, voice: 'SmartCareOps test voice' }, { text: facility, voice: 'SmartCareOps test voice' },
  ]);
  expect(await page.evaluate(() => window.testEmergencyCancels)).toBe(1);
  expect(received.some(message => message.type === 'emergency-phase-settled' && message.phase === 'facility')).toBe(false);
  await page.evaluate(() => window.testEmergencyUtterance.onend());
  await expect.poll(() => received.some(message => message.type === 'emergency-phase-settled' && message.phase === 'facility')).toBe(true);
  relay.send(JSON.stringify({ type: 'emergency-playback-ready', id: 1 }));
  await expect(page.getByRole('button', { name: 'Play emergency message again' })).toBeVisible();
  await page.getByRole('button', { name: 'Play emergency message again' }).click();
  await expect.poll(() => page.evaluate(() => window.testEmergencySpeech.length)).toBe(3);
  expect(await page.evaluate(() => window.testEmergencySpeech[2])).toEqual({ text: facility, voice: 'SmartCareOps test voice' });
  expect(await page.evaluate(() => window.testEmergencyCancels)).toBe(2);
});

test('browser TTS failure keeps emergency text visible and retries locally before acknowledgement', async ({ page }) => {
  let relay; const received = [];
  await page.addInitScript(() => {
    window.testEmergencySpeech = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const voice = { name: 'Retry voice', lang: 'en-US', default: true };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(utterance) { window.testEmergencySpeech.push({ text: utterance.text, voice: utterance.voice?.name }); window.testEmergencyUtterance = utterance; },
      cancel() {}, getVoices() { return [voice]; },
    } });
  });
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { const message = JSON.parse(raw); received.push(message); if (message.type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
  await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  const warning = 'This information may require urgent attention.';
  relay.send(JSON.stringify({ type: 'emergency-escalation', id: 1, message: warning, snapshot: emptyIntake() }));
  relay.send(JSON.stringify({ type: 'emergency-phase-speech', id: 1, phase: 'warning', text: warning }));
  await expect.poll(() => page.evaluate(() => window.testEmergencySpeech.length)).toBe(1);
  await page.evaluate(() => window.testEmergencyUtterance.onerror(new Event('error')));
  await expect(page.getByRole('button', { name: 'Retry emergency speech' })).toBeVisible();
  await expect(page.locator('#session-help')).toContainText('authorized text remains visible');
  await expect(page.locator('#transcript')).toContainText(warning);
  expect(received.some(message => message.type === 'emergency-phase-settled')).toBe(false);
  await page.getByRole('button', { name: 'Retry emergency speech' }).click();
  await expect.poll(() => page.evaluate(() => window.testEmergencySpeech.length)).toBe(2);
  const voices = await page.evaluate(() => window.testEmergencySpeech.map(item => item.voice));
  expect(voices).toEqual(['Retry voice', 'Retry voice']);
  await page.evaluate(() => window.testEmergencyUtterance.onend());
  await expect.poll(() => received.some(message => message.type === 'emergency-phase-settled' && message.phase === 'warning')).toBe(true);
});

test('terminal playback cannot reopen; capture stops before delayed summary arrives', async ({ page }) => {
  let relay; const received = [];
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => {
      const message = JSON.parse(raw); received.push(message);
      if (message.type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(96000).toString('base64') }));
  relay.send(JSON.stringify({ type: 'turn-complete' }));
  relay.send(JSON.stringify({ type: 'completion-pending', id: 1 }));
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  expect(received.some(m => m.type === 'completion-settled')).toBe(false);
  const audioCount = received.filter(m => m.type === 'audio').length;
  relay.send(JSON.stringify({ type: 'completion-reopened' }));
  relay.send(JSON.stringify({ type: 'interrupted' }));
  relay.send(JSON.stringify({ type: 'transcript', role: 'Patient', text: 'Thank you. Goodbye.', finished: true }));
  await expect.poll(() => received.some(m => m.type === 'completion-settled')).toBe(true);
  expect(received.filter(m => m.type === 'completion-interrupted')).toHaveLength(0);
  expect(received.filter(m => m.type === 'audio')).toHaveLength(audioCount);
  await expect(page.locator('#transcript')).not.toContainText('Goodbye');
  await expect.poll(() => page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  const intake = emptyIntake(); intake.patient.name = 'JL';
  intake.evidence.name = { utteranceId: 1, patientReportedText: 'My name is JL.' };
  relay.send(JSON.stringify({ type: 'intake-update', intake }));
  relay.send(JSON.stringify({ type: 'intake-complete', completionToken: 'stable-token' }));
  await expect(page.locator('#connection-status')).toHaveText('Completed');
  await expect(page.locator('#handoff-start')).toHaveCount(0);
  await expect(page.locator('#handoff-start')).toHaveCount(0);
  expect(received.filter(m => m.type === 'completion-settled')).toHaveLength(1);
});

test('live controls, transcript, playback state and end release microphone', async ({ page }) => {
  let relay;
  let audioChunks = 0;
  let ended = false;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
      if (message.type === 'audio') audioChunks++;
      if (message.type === 'end') ended = true;
    });
  });
  await page.goto('/patient');
  expect(await page.evaluate(() => window.testMicRequests)).toBe(0);
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
  await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect(page.locator('.patient-mode-toolbar [data-intake-mode="chat"]')).toBeDisabled();
  const workletModuleUrls = await page.evaluate(() => window.testWorkletModuleUrls);
  expect(workletModuleUrls).toEqual(['http://127.0.0.1:4173/audio-worklet-processor.js']);
  expect(workletModuleUrls[0]).not.toMatch(/^(data|blob):/);
  await expect(page.locator('#ai-state')).toHaveText('Preparing first question');
  await page.waitForTimeout(150);
  expect(audioChunks).toBe(0);
  relay.send(JSON.stringify({ type: 'transcript', role: 'Gemini', text: 'May I have your name?', finished: true }));
  relay.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(48000).toString('base64') }));
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  relay.send(JSON.stringify({ type: 'turn-complete' }));
  await page.waitForTimeout(150);
  expect(audioChunks).toBe(0);
  await expect(page.locator('#ai-state')).toHaveText('Listening');
  await expect.poll(() => audioChunks).toBeGreaterThan(0);
  relay.send(JSON.stringify({ type: 'transcript', role: 'Gemini', text: 'Thank you, Louis.', finished: true }));
  relay.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(48000).toString('base64') }));
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  const chunksBeforeReplyPlayback = audioChunks;
  await page.waitForTimeout(150);
  expect(audioChunks).toBe(chunksBeforeReplyPlayback);
  relay.send(JSON.stringify({ type: 'turn-complete' }));
  await expect(page.locator('#ai-state')).toHaveText('Listening');
  await expect.poll(() => audioChunks).toBeGreaterThan(chunksBeforeReplyPlayback);
  // The fake microphone emits a continuous tone. Stop that tone while checking
  // the post-utterance state so new synthetic speech cannot overwrite Thinking.
  await page.evaluate(() => window.testStreams.forEach(stream => stream.getAudioTracks().forEach(track => { track.enabled = false; })));
  await page.waitForTimeout(150);
  relay.send(JSON.stringify({ type: 'transcript', role: 'Patient', text: 'I have a fever and cough.', finished: true }));
  await expect(page.locator('#ai-state')).toHaveText('Thinking');
  relay.send(JSON.stringify({ type: 'transcript', role: 'Gemini', text: 'When did your symptoms start?', finished: true }));
  // One second of PCM exercises scheduling and playback completion without a real API call.
  relay.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(48000).toString('base64') }));
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  relay.send(JSON.stringify({ type: 'turn-complete' }));
  await expect(page.locator('#ai-state')).toHaveText('Listening');
  await expect(page.locator('#transcript')).toContainText('I have a fever and cough.');
  await expect(page.locator('#transcript')).toContainText('When did your symptoms start?');
  relay.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(144000).toString('base64') }));
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  await page.getByRole('button', { name: 'End Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Disconnected');
  await expect.poll(() => ended).toBe(true);
  expect(await page.evaluate(() => window.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.testAudioContexts.every(context => context.state === 'closed'))).toBe(true);
  const stoppedCount = audioChunks;
  await page.waitForTimeout(150);
  expect(audioChunks).toBe(stoppedCount);
  expect(await page.evaluate(() => window.testMicRequests)).toBe(1);
});

test('fictional facility options and appointment receipt stay bounded in the active Patient Live view', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
  await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  const options = { type: 'facility-options', result: { snapshotId: 'snapshot-1', simulation: true, options: [
    { hospitalId: 'hospital-a', hospitalName: 'Fictional Harbor Hospital', distanceMeters: 2400, specialty: 'general_medicine', nextAvailableMinutes: 25, capacity: { emergencyBedsAvailable: 2, monitoredBedsAvailable: 1, icuBedsAvailable: 0 }, departmentCapacity: { emergencyOccupied: 44, emergencyCapacity: 80, emergencyAvailable: 36, icuOccupied: 9, icuCapacity: 16, icuAvailable: 7, operationalState: 'normal' } },
    { hospitalId: 'hospital-b', hospitalName: 'Fictional North Clinic', distanceMeters: 3900, specialty: 'general_medicine', nextAvailableMinutes: 40, capacity: { emergencyBedsAvailable: 1, monitoredBedsAvailable: 0, icuBedsAvailable: 0 } },
  ] } };
  relay.send(JSON.stringify(options)); relay.send(JSON.stringify(options));
  const panel = page.locator('#facility-coordination-status');
  await expect(panel).toHaveCount(1);
  await expect(panel).toContainText('Demo hospital information');
  await expect(panel).toContainText('not live or guaranteed and has not been verified with a hospital');
  await expect(panel).toContainText('not confirmed referrals');
  await expect(panel.locator('li')).toHaveCount(2);
  await expect(panel.locator('li').first()).toContainText('about 2.4 km away · general medicine · simulated capacity: ED 44/80 (36 available), ICU 9/16 (7 available), normal');
  await expect(panel.locator('p').filter({ hasText: 'capacity shown here' })).toHaveCount(1);
  await expect(page.locator('#connection-status')).toHaveText('Connected');

  relay.send(JSON.stringify({ type: 'appointment-request', result: { state: 'requested', simulation: true, contacted: false, confirmed: false,
    selection: { hospitalId: 'hospital-a', hospitalName: 'Fictional Harbor Hospital', specialty: 'general_medicine', date: '2026-10-01', time: '10:30', distanceMeters: 2400 } } }));
  await expect(panel).toContainText('Fictional appointment request');
  await expect(panel).toContainText('No hospital or Doctor was contacted');
  await expect(panel).toContainText('not a confirmed booking');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.locator('#connection-status')).toHaveText('Connected');
});

for (const [name, message] of [['NotAllowedError', 'Microphone permission denied'], ['NotFoundError', 'No microphone found']]) {
  test(`handles ${name}`, async ({ page }) => {
    await page.addInitScript(errorName => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Unavailable', errorName); };
    }, name);
    await page.goto('/patient');
    await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.locator('#connection-status')).toHaveText('Error');
    await expect(page.getByRole('button', { name: 'Start Conversation' })).toBeEnabled();
  });
}

test('unsupported audio initialization reports a hosting-safe message', async ({ page }) => {
  await page.addInitScript(() => { window.AudioWorkletNode = undefined; });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
  await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to start audio. Check your browser and microphone settings, then try again.');
  await expect(page.getByRole('alert')).not.toContainText('localhost');
  await expect(page.locator('#connection-status')).toHaveText('Error');
});

test('late microphone permission after End does not start recording', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => new Promise(resolve => {
      window.resolveMicrophone = async () => resolve(await original(constraints));
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect.poll(() => page.evaluate(() => typeof window.resolveMicrophone)).toBe('function');
  await page.getByRole('button', { name: 'End Conversation' }).click();
  await page.evaluate(() => window.resolveMicrophone());
  await expect.poll(() => page.evaluate(() => window.testStreams.length === 1 && window.testStreams[0].getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#connection-status')).toHaveText('Disconnected');
});

test('navigation and connection interruption release microphone', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => {
      if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.close({ code: 1011, reason: 'Test interruption' });
  await expect(page.locator('#connection-status')).toHaveText('Error');
  expect(await page.evaluate(() => window.testStreams[0].getTracks()[0].readyState)).toBe('ended');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await page.locator('.patient-brand').click();
  expect(await page.evaluate(() => window.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('API error releases microphone and supports a new attempt', async ({ page }) => {
  await page.routeWebSocket('**/api/live', socket => {
    socket.onMessage(raw => {
      if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'error', message: 'Gemini is not configured. Set GEMINI_API_KEY in backend/.env and restart the backend.' }));
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.getByRole('alert')).toContainText('Gemini is not configured');
  await expect(page.getByRole('button', { name: 'Start Conversation' })).toBeEnabled();
  expect(await page.evaluate(() => window.testStreams[0].getTracks()[0].readyState)).toBe('ended');
});

test('barge-in clears queued audio and transcript content is plain text', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => {
      if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'transcript', role: 'Patient', text: '<img src=x onerror=alert(1)>', finished: true }));
  await expect(page.locator('#transcript')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#transcript img')).toHaveCount(0);
  relay.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(144000).toString('base64') }));
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  relay.send(JSON.stringify({ type: 'interrupted' }));
  await expect(page.locator('#ai-state')).toHaveText('Listening');
  await page.getByRole('button', { name: 'End Conversation' }).click();
});

for (const manual of [false, true]) {
  test(`completion drains queued audio; manual override ${manual}`, async ({ page }) => {
    let relay;
    let ends = 0;
    let socketClosed = false;
    await page.routeWebSocket('**/api/live', socket => {
      relay = socket;
      socket.onClose(() => { socketClosed = true; });
      socket.onMessage(raw => {
        const message = JSON.parse(raw);
        if (message.type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
        if (message.type === 'end') ends++;
      });
    });
    await page.goto('/patient');
    await page.locator('[data-intake-mode="voice"]').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    await page.evaluate(() => window.testAudioContexts[0].suspend());
    for (let chunk = 0; chunk < 2; chunk++) relay.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(24000).toString('base64') }));
    relay.send(JSON.stringify({ type: 'turn-complete' }));
    relay.send(JSON.stringify({ type: 'intake-complete' }));
    relay.send(JSON.stringify({ type: 'intake-complete' }));
    await expect(page.locator('#ai-state')).toHaveText('Speaking');
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    expect(ends).toBe(0);
    expect(socketClosed).toBe(false);
    expect(await page.evaluate(() => window.testStreams[0].getTracks()[0].readyState)).toBe('live');
    if (manual) await page.getByRole('button', { name: 'End Conversation' }).click();
    else await page.evaluate(() => window.testAudioContexts[0].resume());
    await expect(page.locator('#connection-status')).toHaveText(manual ? 'Disconnected' : 'Completed');
    await expect.poll(() => ends).toBe(1);
    await expect.poll(() => socketClosed).toBe(true);
    expect(await page.evaluate(() => window.testStreams[0].getTracks()[0].readyState)).toBe('ended');
    await expect.poll(() => page.evaluate(() => window.testAudioContexts[0].state)).toBe('closed');
    await expect(page.getByRole('button', { name: 'Start Conversation' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'End Conversation' })).toBeDisabled();
  });
}

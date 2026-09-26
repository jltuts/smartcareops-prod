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
    await page.locator('#intake-fictional').check();
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
  await page.goto('/patient'); await page.locator('#intake-fictional').check(); await page.getByRole('button', { name: 'Start Conversation' }).click();
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
  await page.goto('/patient'); await page.locator('#intake-fictional').check(); await page.getByRole('button', { name: 'Start Conversation' }).click();
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
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); window.testAudioContexts.push(this); }
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
  await page.locator('#intake-fictional').check();
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
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect.poll(() => audioChunks).toBeGreaterThan(0);
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

for (const [name, message] of [['NotAllowedError', 'Microphone permission denied'], ['NotFoundError', 'No microphone found']]) {
  test(`handles ${name}`, async ({ page }) => {
    await page.addInitScript(errorName => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Unavailable', errorName); };
    }, name);
    await page.goto('/patient');
    await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.locator('#connection-status')).toHaveText('Error');
    await expect(page.getByRole('button', { name: 'Start Conversation' })).toBeEnabled();
  });
}

test('late microphone permission after End does not start recording', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => new Promise(resolve => {
      window.resolveMicrophone = async () => resolve(await original(constraints));
    });
  });
  await page.goto('/patient');
  await page.locator('#intake-fictional').check();
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
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.close({ code: 1011, reason: 'Test interruption' });
  await expect(page.locator('#connection-status')).toHaveText('Error');
  expect(await page.evaluate(() => window.testStreams[0].getTracks()[0].readyState)).toBe('ended');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await page.getByRole('link', { name: 'Back to home' }).click();
  expect(await page.evaluate(() => window.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('API error releases microphone and supports a new attempt', async ({ page }) => {
  await page.routeWebSocket('**/api/live', socket => {
    socket.onMessage(raw => {
      if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'error', message: 'Gemini is not configured. Set GEMINI_API_KEY in backend/.env and restart the backend.' }));
    });
  });
  await page.goto('/patient');
  await page.locator('#intake-fictional').check();
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
  await page.locator('#intake-fictional').check();
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
    await page.locator('#intake-fictional').check();
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

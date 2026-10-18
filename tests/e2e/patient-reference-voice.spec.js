import { test, expect } from '@playwright/test';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('reference voice unlocks suspended playback during the Start tap before requesting Gemini speech', async ({ page }) => {
  await page.addInitScript(() => {
    window.playbackResumeDuringTap = [];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        this.testPlaybackContext = args[0]?.sampleRate === 24000;
        this.testSuspended = this.testPlaybackContext;
      }
      get state() { return this.testSuspended ? 'suspended' : super.state; }
      resume() {
        if (!this.testPlaybackContext) return super.resume();
        const duringTap = navigator.userActivation.isActive;
        window.playbackResumeDuringTap.push(duringTap);
        if (!duringTap) return new Promise(() => {});
        this.testSuspended = false;
        return super.resume();
      }
    };
  });
  await page.route('**/api/live/session', route => route.fulfill({ json: {
    geminiToken: 'auth_tokens/reference-mobile-unlock-test', model: 'gemini-3.8-live', preferredLanguage: 'en', intakeSessionId: 'c'.repeat(64),
  } }));
  let opening;
  await page.routeWebSocket('wss://generativelanguage.googleapis.com/**', ws => {
    ws.onMessage(raw => {
      const data = JSON.parse(raw);
      if (data.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (data.realtimeInput?.text) opening = data.realtimeInput.text;
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await page.locator('#intake-fictional').check();
  await page.locator('#start-conversation').click();
  await expect.poll(() => page.evaluate(() => window.playbackResumeDuringTap)).toEqual([true]);
  await expect.poll(() => opening).toContain('What would you like me to call you?');
  await page.locator('#end-conversation').click();
});

test('reference voice identifies the stalled opening stage without changing the first turn', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/live/session', route => route.fulfill({ json: {
    geminiToken: 'auth_tokens/reference-opening-test', model: 'gemini-3.8-live', preferredLanguage: 'en', intakeSessionId: 'a'.repeat(64),
  } }));
  let socket, opening;
  await page.routeWebSocket('wss://generativelanguage.googleapis.com/**', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const data = JSON.parse(raw);
      if (data.realtimeInput?.text) opening = data.realtimeInput.text;
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await page.locator('#intake-fictional').check();
  await page.locator('#start-conversation').click();
  await expect(page.locator('#connection-status')).toHaveText('Connected — voice test');
  await page.clock.fastForward(12000);
  await expect(page.locator('#session-help')).toContainText('Still waiting: Gemini setup confirmation.');
  socket.send(JSON.stringify({ setupComplete: {} }));
  await expect.poll(() => opening).toContain('What would you like me to call you?');
  await page.clock.fastForward(12000);
  await expect(page.locator('#session-help')).toContainText('Still waiting: Gemini opening response.');
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Hello, this is SmartCareOps. What would you like me to call you?', finished: true } } }));
  await expect(page.locator('#transcript')).toContainText('What would you like me to call you?');
  await expect(page.locator('#session-help')).not.toContainText('Still waiting:');
  await page.locator('#end-conversation').click();
  await expect(page.locator('#connection-status')).toHaveText('Disconnected');
});

test('reference voice reports the audio context while playback initialization is pending', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) {
        super(...args);
        if (args[0]?.sampleRate === 24000) {
          Object.defineProperty(this.audioWorklet, 'addModule', { value: () => new Promise(() => {}) });
        }
      }
    };
  });
  await page.route('**/api/live/session', route => route.fulfill({ json: {
    geminiToken: 'auth_tokens/reference-audio-init-test', model: 'gemini-3.8-live', preferredLanguage: 'en', intakeSessionId: 'a'.repeat(64),
  } }));
  await page.routeWebSocket('wss://generativelanguage.googleapis.com/**', ws => {
    ws.onMessage(raw => { if (JSON.parse(raw).setup) ws.send(JSON.stringify({ setupComplete: {} })); });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await page.locator('#intake-fictional').check();
  await page.locator('#start-conversation').click();
  await expect(page.locator('#session-help')).toContainText('Gemini setup confirmed; preparing phone audio.');
  await page.clock.fastForward(12000);
  await expect(page.locator('#session-help')).toContainText('Still waiting: audio player initialization. Audio context: running.');
  await page.locator('#end-conversation').click();
});

test('reference voice keeps streaming through partial transcripts, playback, and interruption, then releases devices', async ({ page }) => {
  await page.addInitScript(() => {
    window.referenceStreams = [];
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await get(options); window.referenceStreams.push(stream); return stream;
    };
  });
  await page.route('**/api/live/session', route => route.fulfill({ json: {
    geminiToken: 'auth_tokens/reference-test', model: 'gemini-3.8-live', preferredLanguage: 'en', intakeSessionId: 'a'.repeat(64),
  } }));
  let socket, audioFrames = 0, setup;
  const textTurns = [], toolResponses = [], clinicalRequests = [], savedIntakes = [];
  page.on('request', request => { if (/\/api\/intake\//.test(request.url())) clinicalRequests.push(request.url()); });
  await page.route('**/api/intake/voice/complete', async route => {
    savedIntakes.push({ body: route.request().postDataJSON(), key: await route.request().headerValue('idempotency-key') });
    await route.fulfill({ json: { status: 'COMPLETED', patientCase: { caseId: 'SC-11111111-1111-4111-8111-111111111111', storage: 'firestore', workflowStatus: 'submitted_for_clinical_review' } } });
  });
  await page.routeWebSocket('wss://generativelanguage.googleapis.com/**', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const data = JSON.parse(raw);
      if (data.setup) { setup = data.setup; ws.send(JSON.stringify({ setupComplete: {} })); }
      if (data.realtimeInput?.audio) audioFrames++;
      if (data.realtimeInput?.text || data.clientContent) textTurns.push(data);
      if (data.toolResponse) toolResponses.push(data.toolResponse);
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await page.locator('#intake-fictional').check();
  await page.locator('#start-conversation').click();
  await expect(page.locator('.patient-transcript-wrap')).toBeFocused();
  await expect.poll(() => audioFrames).toBeGreaterThan(3);
  expect(setup.generationConfig.temperature).toBe(1);
  expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
  expect(setup.systemInstruction.parts[0].text).toContain('Thank you. Your intake is complete.');
  expect(setup.systemInstruction.parts[0].text).toContain('I got all the information I need for this intake. Is there anything else you want to say?');
  expect(setup.systemInstruction.parts[0].text).toContain('How severe is it from 1 to 10, with 10 being the most severe?');
  expect(setup.systemInstruction.parts[0].text).toContain('What is your concern?');
  expect(setup.systemInstruction.parts[0].text).toContain('Do not infer an answer from an unrelated word.');
  expect(setup.systemInstruction.parts[0].text).toContain('SmartCareOps opens those controls automatically');
  expect(setup.systemInstruction.parts[0].text).toContain('Choose Use camera, then Capture photo');
  expect(setup.tools[0].functionDeclarations[0].name).toBe('complete_intake');
  expect(setup.tools[0].functionDeclarations[1].name).toBe('trigger_emergency');
  expect(setup.tools[0].functionDeclarations).toHaveLength(2);
  expect(textTurns).toHaveLength(1);
  expect(textTurns[0].realtimeInput.text).toBe('Begin the intake now. Ask exactly: "Hello, this is SmartCareOps. What would you like me to call you?"');
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'I got all the information I need for this intake. Is there anything else you want to say?', finished: true }, turnComplete: true } }));
  socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'I take medicine every morning.', finished: true } } }));
  await expect(page.locator('#patient-evidence-kind')).toHaveValue('');
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'I got all the information I need for this intake. Is there anything else you want to say?', finished: true }, turnComplete: true } }));
  socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'A yes, I want to show my medicine.' } } }));
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Thank you. I have noted that you want to share your medicine.' } } }));
  await expect(page.locator('#patient-evidence-kind')).toHaveValue('medicine_package');
  await expect(page.getByRole('button', { name: 'Use camera' })).toBeFocused();
  await expect(page.locator('#medicine-camera')).toBeHidden();
  socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'complete-too-early', name: 'complete_intake', args: {} }] } }));
  await expect.poll(() => toolResponses.length).toBe(1);
  expect(toolResponses[0].functionResponses[0]).toMatchObject({
    id: 'complete-too-early', name: 'complete_intake',
    response: { result: 'Keep the intake open. The requested medicine evidence has not been saved yet.' },
  });
  await expect(page.locator('#connection-status')).toHaveText('Connected — voice test');
  await page.evaluate(sessionId => document.querySelector('#main').dispatchEvent(new CustomEvent('smartcareops:medicine-saved', {
    detail: { intakeSessionId: sessionId, receiptId: 'medicine-test-receipt' },
  })), 'a'.repeat(64));
  await expect.poll(() => textTurns.length).toBe(2);
  expect(textTurns[1].realtimeInput.text).toContain('The patient has saved the confirmed medicine package entry.');
  await expect(page.locator('.patient-transcript-wrap')).toBeFocused();
  socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'I feel ', finished: false } } }));
  socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'dizzy.', finished: true },
    outputTranscription: { text: 'I hear you.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(96000).toString('base64') } }] } } }));
  await expect(page.locator('#transcript')).toContainText('I feel dizzy.');
  await expect(page.locator('#ai-state')).toHaveText('Speaking');
  const duringPlayback = audioFrames;
  await expect.poll(() => audioFrames).toBeGreaterThan(duringPlayback + 3);
  socket.send(JSON.stringify({ serverContent: { interrupted: true, inputTranscription: { text: 'Actually, a headache.', finished: true } } }));
  await expect(page.locator('#transcript')).toContainText('Actually, a headache.');
  const afterInterruption = audioFrames;
  await expect.poll(() => audioFrames).toBeGreaterThan(afterInterruption + 3);
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Understood.', finished: true }, turnComplete: true } }));
  await expect(page.locator('#transcript')).toContainText('Understood.');
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'How severe is it from 1 to 10, with 10 being the most severe?', finished: true }, turnComplete: true } }));
  socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'X', finished: true } } }));
  await expect(page.locator('#transcript li').last()).toHaveText(/Patient10/);
  expect(clinicalRequests).toEqual([]);
  expect(textTurns).toHaveLength(2);
  socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'complete-1', name: 'complete_intake', args: {} }] } }));
  await expect.poll(() => toolResponses.length).toBe(2);
  expect(toolResponses[1].functionResponses[0]).toMatchObject({ id: 'complete-1', name: 'complete_intake' });
  socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
  await expect(page.locator('#connection-status')).toHaveText('Connected — voice test');
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Thank you. Your intake is complete.', finished: true },
    modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') } }] }, turnComplete: true } }));
  await expect(page.locator('#connection-status')).toHaveText('Connected — voice test');
  await expect(page.locator('#connection-status')).toHaveText('Complete');
  await expect.poll(() => savedIntakes.length).toBe(1);
  expect(savedIntakes[0].body).toMatchObject({ intakeSessionId: 'a'.repeat(64), outcome: 'completed' });
  expect(savedIntakes[0].body.turns.some(turn => turn.role === 'Patient' && turn.text.includes('dizzy'))).toBe(true);
  expect(savedIntakes[0].body.turns.some(turn => turn.role === 'Patient' && turn.text === '10')).toBe(true);
  expect(savedIntakes[0].key).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => page.evaluate(() => window.referenceStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  await page.locator('#start-conversation').click();
  await expect.poll(() => page.evaluate(() => window.referenceStreams.length)).toBe(2);
  await page.locator('#end-conversation').click();
  await expect.poll(() => page.evaluate(() => window.referenceStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
});

test('reference voice guides a requested Pain location image and keeps intake open until it is shared', async ({ page }) => {
  await page.addInitScript(() => {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => get(options);
  });
  await page.route('**/api/live/session', route => route.fulfill({ json: {
    geminiToken: 'auth_tokens/reference-pain-location-test', model: 'gemini-3.8-live', preferredLanguage: 'en', intakeSessionId: 'd'.repeat(64),
  } }));
  let socket, audioFrames = 0, setup;
  const textTurns = [], toolResponses = [];
  await page.routeWebSocket('wss://generativelanguage.googleapis.com/**', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const data = JSON.parse(raw);
      if (data.setup) { setup = data.setup; ws.send(JSON.stringify({ setupComplete: {} })); }
      if (data.realtimeInput?.audio) audioFrames++;
      if (data.realtimeInput?.text) textTurns.push(data.realtimeInput.text);
      if (data.toolResponse) toolResponses.push(data.toolResponse);
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await page.locator('#intake-fictional').check();
  await page.locator('#start-conversation').click();
  await expect.poll(() => audioFrames).toBeGreaterThan(3);
  expect(setup.systemInstruction.parts[0].text).toContain('I opened the Pain location controls. Choose Use camera, then Capture photo.');

  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'I got all the information I need for this intake. Is there anything else you want to say?', finished: true }, turnComplete: true } }));
  socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'I want to show the pain location.', finished: true } } }));
  await expect(page.locator('#patient-evidence-kind')).toHaveValue('body_area');
  await expect(page.getByRole('button', { name: 'Use camera' })).toBeFocused();
  await expect(page.locator('#medicine-camera')).toBeHidden();

  socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'complete-before-share', name: 'complete_intake', args: {} }] } }));
  await expect.poll(() => toolResponses.length).toBe(1);
  expect(toolResponses[0].functionResponses[0]).toMatchObject({
    id: 'complete-before-share', name: 'complete_intake',
    response: { result: 'Keep the intake open. The requested Pain location image has not been shared yet.' },
  });

  await page.evaluate(sessionId => document.querySelector('#main').dispatchEvent(new CustomEvent('smartcareops:body-evidence-shared', {
    detail: { intakeSessionId: sessionId, evidenceId: 'body-area-test' },
  })), 'd'.repeat(64));
  await expect.poll(() => textTurns.length).toBe(2);
  expect(textTurns[1]).toContain('The patient has shared the confirmed Pain location image and description.');
  await expect(page.locator('.patient-transcript-wrap')).toBeFocused();
  await page.locator('#end-conversation').click();
});

for (const emergencyCase of [
  {
    language: 'en', speechLanguage: 'en', concern: 'What is your concern?',
    warning: "This information may require urgent attention. I'm stopping the standard intake. Emergency escalation is pending. No dispatcher or emergency service has been contacted.",
    facility: 'Current demo hospital information is unavailable.',
  },
  {
    language: 'fil', speechLanguage: 'fil-PH', concern: 'Ano ang iyong ipinag-aalala?',
    warning: 'Maaaring kailanganin ng agarang atensyon ang impormasyong ito. Itinitigil ko ang karaniwang intake. Nakabinbin ang emergency escalation. Walang dispatcher o serbisyong pang-emergency na nakontak.',
    facility: 'Hindi available ang kasalukuyang impormasyon ng demo hospital.',
  },
].flatMap(item => ['success', 'stall-warning', 'stall-facility', 'error-warning'].map(speechMode => ({ ...item, speechMode })))) {
test(`reference voice ${emergencyCase.speechMode}: bounded ${emergencyCase.language} emergency playback and single save`, async ({ page }) => {
  await page.addInitScript(speechMode => {
    window.referenceStreams = [];
    window.emergencySpeech = [];
    window.emergencySpeechMode = speechMode;
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await get(options); window.referenceStreams.push(stream); return stream;
    };
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.lang = ''; } };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(utterance) {
        window.emergencySpeech.push({ text: utterance.text, language: utterance.lang });
        const mode = window.emergencySpeechMode;
        const count = window.emergencySpeech.length;
        if (mode === 'stall-warning' && count === 1 || mode === 'stall-facility' && count === 2) { window.lateEmergencyEnd = utterance.onend; return; }
        queueMicrotask(() => mode === 'error-warning' ? utterance.onerror?.() : utterance.onend?.());
      },
      cancel() {},
    } });
  }, emergencyCase.speechMode);
  await page.route('**/api/live/session', route => route.fulfill({ json: {
    geminiToken: 'auth_tokens/reference-emergency-test', model: 'gemini-3.8-live', preferredLanguage: emergencyCase.language, intakeSessionId: 'b'.repeat(64),
  } }));
  let socket, audioFrames = 0;
  const toolResponses = [], clinicalRequests = [], savedIntakes = [];
  page.on('request', request => { if (/\/api\/intake\//.test(request.url())) clinicalRequests.push(request.url()); });
  await page.route('**/api/intake/voice/complete', async route => {
    savedIntakes.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'EMERGENCY_ESCALATED', patientCase: { caseId: 'SC-22222222-2222-4222-8222-222222222222', storage: 'firestore', workflowStatus: 'emergency_pending_dispatcher' } } });
  });
  await page.routeWebSocket('wss://generativelanguage.googleapis.com/**', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const data = JSON.parse(raw);
      if (data.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (data.realtimeInput?.audio) audioFrames++;
      if (data.toolResponse) toolResponses.push(data.toolResponse);
    });
  });
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await page.locator('#conversation-language').selectOption(emergencyCase.language);
  await page.locator('#intake-fictional').check();
  await page.locator('#start-conversation').click();
  await expect.poll(() => audioFrames).toBeGreaterThan(3);
  socket.send(JSON.stringify({ serverContent: { outputTranscription: { text: emergencyCase.concern, finished: true }, turnComplete: true } }));
  socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: "I need an emergency. I can't breathe.", finished: true } } }));
  if (emergencyCase.speechMode.startsWith('stall')) await page.clock.install();
  socket.send(JSON.stringify({ toolCall: { functionCalls: [
    { id: 'complete-must-lose', name: 'complete_intake', args: {} },
    { id: 'emergency-1', name: 'trigger_emergency', args: { reason: 'current_chest_pain' } },
  ] } }));
  await expect.poll(() => toolResponses.length).toBe(1);
  expect(toolResponses[0].functionResponses).toEqual([expect.objectContaining({ id: 'emergency-1', name: 'trigger_emergency' })]);
  socket.send(JSON.stringify({ serverContent: {
    outputTranscription: { text: '<no speech>{pause}', finished: true },
    modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(4800).toString('base64') } }] },
    turnComplete: true,
  } }));
  await expect(page.locator('#connection-status')).toHaveText('Emergency escalation');
  await expect(page.locator('#transcript')).toContainText(emergencyCase.warning);
  if (emergencyCase.speechMode.startsWith('stall')) {
    await expect(page.locator('#ai-state')).toHaveText(emergencyCase.speechMode === 'stall-warning' ? 'Speaking urgent warning' : 'Speaking hospital information');
    expect(savedIntakes).toHaveLength(0);
    await page.clock.runFor(55001);
  }
  await expect(page.locator('#transcript')).toContainText(emergencyCase.facility);
  if (emergencyCase.speechMode === 'success') await expect.poll(() => page.evaluate(() => window.emergencySpeech)).toEqual([
    { text: emergencyCase.warning, language: emergencyCase.speechLanguage },
    { text: emergencyCase.facility, language: emergencyCase.speechLanguage },
  ]);
  await expect(page.locator('#ai-state')).toHaveText(emergencyCase.speechMode === 'success' ? 'Emergency information complete' : 'Speech unavailable');
  await expect(page.locator('#session-help')).toContainText('No dispatcher or emergency service has been contacted');
  await expect.poll(() => page.evaluate(() => window.referenceStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  await expect.poll(() => savedIntakes.length).toBe(1);
  expect(savedIntakes[0]).toMatchObject({ intakeSessionId: 'b'.repeat(64), outcome: 'emergency' });
  expect(clinicalRequests).toEqual([expect.stringContaining('/api/intake/voice/complete')]);
  if (emergencyCase.speechMode !== 'success') {
    await page.evaluate(() => { window.lateEmergencyEnd?.(); window.emergencySpeechMode = 'success'; });
    await page.getByRole('button', { name: 'Retry emergency speech', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play emergency message again' })).toBeVisible();
    expect(await page.evaluate(() => window.emergencySpeech.at(-1))).toEqual({ text: `${emergencyCase.warning} ${emergencyCase.facility}`, language: emergencyCase.speechLanguage });
    expect(savedIntakes).toHaveLength(1);
    await expect(page.locator('#end-conversation')).toBeDisabled();
  }
  await expect(page.locator('#transcript')).not.toContainText('Thank you. Your intake is complete.');
  await expect(page.locator('#transcript')).not.toContainText('<no speech>{pause}');
});
}

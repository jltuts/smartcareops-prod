import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { attachLiveRelay } from '../../backend/src/live.js';
import { createCompletedCases } from '../../backend/src/agent/cases.js';
const { WebSocket } = createRequire(new URL('../../backend/src/live.js', import.meta.url))('ws');

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

for (const run of ['legacy', 'jl', 'bp-concern', 'noisy-batch', 'no-and-nothing-else']) test(`normal completion owns terminal workflow: ${run}`, async ({ page }) => {
  const exactRun = run === 'jl';
  const concernRun = run === 'bp-concern';
  const noisyRun = run === 'noisy-batch';
  const conjunctionRun = run === 'no-and-nothing-else';
  const completionLogs = [];
  const server = createServer(), cases = createCompletedCases();
  let callbacks, issued = 0, completed = 0, closed = false, snapshot, token, geminiClosed = 0, relayed = 0, escalations = 0;
  const extracted = [];
  const turns = exactRun ? [
    ["Hello. I'm the SmartCareOps clinical intake assistant. May I have your name?", 'Hey, my name is J.L.', { kind: 'name', value: 'J.L.' }],
    ['What are you feeling today?', "I'm feeling dizzy.", { kind: 'symptom', label: 'dizzy', status: 'confirmed' }],
    ['Have you had any chest pain with that?', 'No.', { kind: 'symptom', label: 'chest pain', status: 'denied' }],
    ['Are you having any difficulty breathing?', 'No.', { kind: 'symptom', label: 'difficulty breathing', status: 'denied' }],
    ['When did you first start feeling dizzy?', 'yesterday', { kind: 'onset', value: 'yesterday' }],
    ["Is there anything else you'd like to add before we finish?", 'Yes, my blood pressure is 190/80.', { kind: 'bloodPressure', value: 190, secondaryValue: 80 }],
    ["Is there anything else you'd like to add?", 'No nada de amor.', null],
  ] : [
    ['May I have your name?', 'JL', { kind: 'name', value: 'JL' }],
    ['What are you feeling?', 'I feel dizzy.', { kind: 'symptom', label: 'dizzy', status: 'confirmed' }],
    ['When did it start?', 'Yesterday.', { kind: 'onset', value: 'Yesterday' }],
    ['Are you having chest pain?', 'Nope.', { kind: 'symptom', label: 'chest pain', status: 'denied' }],
    ['Are you having difficulty breathing?', 'Nope.', { kind: 'symptom', label: 'difficulty breathing', status: 'denied' }],
    ['What is your blood pressure?', 'My blood pressure is 180/120.', { kind: 'bloodPressure', value: 180, secondaryValue: 120 }],
    ["Is there anything else you'd like to add before we finish?", 'Know nothing at all.', null],
  ];
  if (concernRun) turns[5] = ['What is your blood pressure?', 'Yes, my blood pressure is 190/45.', { kind: 'bloodPressure', value: 190, secondaryValue: 45 }];
  if (noisyRun) turns.splice(0, turns.length,
    ['May I have your name?', 'My name is J.', { kind: 'name', value: 'J' }],
    ['What are you feeling?', 'I feel dizzy.', { kind: 'symptom', label: 'dizzy', status: 'confirmed' }],
    ['Are you having chest pain?', 'No, no chest pain.', { kind: 'symptom', label: 'chest pain', status: 'denied' }],
    ['Are you having difficulty breathing?', 'No. No.', { kind: 'symptom', label: 'difficulty breathing', status: 'denied' }],
    ['When did the dizziness start?', 'yesterday shark suddenly', { kind: 'onset', value: 'yesterday' }],
    ["Is there anything else you'd like to add before we finish?", 'Yes, my blood pressure is 145/90.', { kind: 'bloodPressure', value: 145, secondaryValue: 90 }],
    ["Is there anything else you'd like to add before we finish?", 'No, nothing else.', null]);
  const sockets = attachLiveRelay(server, {
    apiKey: 'fake',
    completionLog: detail => completionLogs.push(detail),
    connect: async options => {
      callbacks = options.callbacks;
      queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput() {}, close() { geminiClosed++; } };
    },
    // Only Gemini is mocked. Completion, extraction queue, validation and token storage are real.
    extract: async ({ utterances }) => {
      extracted.push(...utterances.map(u => u.text));
      return { updates: utterances.flatMap(u => {
        const fact = turns[u.id - 1][2];
        const update = { label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text, ...fact };
        return fact ? noisyRun && u.id === 5 ? [update, { ...update, status: 'unclear' }] : [update] : [];
      }) };
    },
    onCompleted: intake => { issued++; snapshot = structuredClone(intake); token = cases.issue(intake); return token; },
  });
  sockets.on('connection', ws => {
    ws.on('close', () => { closed = true; });
  });
  if (conjunctionRun) turns.splice(0, turns.length,
    ['May I have your name?', 'Hi, my name is JL.', { kind: 'name', value: 'JL' }],
    ['What are you feeling?', "I'm feeling dizzy.", { kind: 'symptom', label: 'dizzy', status: 'confirmed' }],
    ['When did it start?', 'It started yesterday.', { kind: 'onset', value: 'yesterday' }],
    ['Are you feeling nauseous?', 'Non.', null],
    ['Are you feeling nauseous?', 'Oh!', null],
    ['Are you feeling nauseous?', "I'm not nauseous.", { kind: 'symptom', label: 'nauseous', status: 'denied' }],
    ['Are you having chest pain?', 'No.', { kind: 'symptom', label: 'chest pain', status: 'denied' }],
    ["Is there anything else you'd like to add?", "I don't have chest pain. I don't have difficulty breathing. And I want to add my blood pressure. My blood pressure is 145/90.", { kind: 'bloodPressure', value: 145, secondaryValue: 90 }],
    ["Got it. Thank you, JL. Is there anything else you'd like to add?", 'No and nothing else.', null]);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await page.route('**/api/intake-finalization', async route => {
      const response = await route.fetch({ url: `http://127.0.0.1:${server.address().port}/api/intake-finalization` });
      if (response.status() === 200 && (await response.json()).type === 'intake-complete') completed++;
      await route.fulfill({ response });
    });
    await page.addInitScript(() => {
      window.capturedStreams = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints); window.capturedStreams.push(stream); return stream;
      };
    });
    await page.routeWebSocket('**/api/live', async socket => {
      const backend = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://127.0.0.1:4173' });
      const opened = once(backend, 'open');
      socket.onMessage(async raw => { await opened; if (backend.readyState === WebSocket.OPEN) backend.send(raw); });
      socket.onClose(() => backend.close());
      backend.on('message', raw => {
        relayed++;
        if (JSON.parse(raw).type === 'intake-complete') completed++;
        if (JSON.parse(raw).type === 'emergency-escalation') escalations++;
        socket.send(raw.toString());
      });
      backend.on('close', () => socket.close());
      await opened;
    });
    await page.goto('/patient');
    await page.locator('[data-intake-mode="voice"]:visible').first().click(); await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    await page.evaluate(() => window.capturedStreams.forEach(s => s.getTracks().forEach(t => { t.enabled = false; })));
    const emit = content => callbacks.onmessage({ serverContent: content });
    for (const [question, text] of turns) {
      emit({ outputTranscription: { text: question }, turnComplete: true });
      emit({ inputTranscription: { text, finished: true } });
      if (concernRun && text.includes('190/45')) {
        // Even an explicit model claim is conversation, not a backend state change.
        callbacks.onmessage({ emergency_escalated: true, caseStatus: 'pending_dispatcher', serverContent: {
          outputTranscription: { text: 'This blood pressure concerns me. Emergency escalation is pending.' }, turnComplete: true,
        } });
        await expect(page.locator('[data-intake="vitals"]')).toContainText('190 / 45');
        await expect(page.locator('#connection-status')).toHaveText('Connected');
        await expect(page.locator('#handoff-status')).not.toContainText('Pending dispatcher');
        expect(escalations).toBe(0); expect(issued).toBe(0);
      }
    }
    const finalText = `Thank you, ${noisyRun ? 'J' : exactRun ? 'J.L.' : 'JL'}. Your intake is complete.`;
    emit({ outputTranscription: { text: finalText }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(48000).toString('base64') } }] }, turnComplete: true });
    emit({ outputTranscription: { text: finalText }, turnComplete: true });
    await expect(page.locator('#connection-status')).toHaveText('Completed');
    await expect.poll(() => closed).toBe(true);
    expect(issued).toBe(1); expect(completed).toBe(1);
    expect(escalations).toBe(0);
    expect(geminiClosed).toBe(1);
    const committedMessages = relayed;
    emit({ inputTranscription: { text: 'Thank you. Goodbye.', finished: true } });
    emit({ outputTranscription: { text: 'Goodbye.' }, turnComplete: true });
    await page.waitForTimeout(50);
    expect(relayed).toBe(committedMessages);
    expect(cases.get(token, snapshot)).toEqual(snapshot);
    expect(extracted).toEqual(turns.slice(0, -1).map(turn => turn[1]));
    await expect.poll(() => page.evaluate(() => window.capturedStreams.length > 0 && window.capturedStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
    await expect(page.locator('[data-intake="patient"]')).toContainText(noisyRun ? 'J' : exactRun ? 'J.L.' : 'JL');
    await expect(page.locator('[data-intake="vitals"]')).toContainText(noisyRun || conjunctionRun ? '145 / 90' : exactRun ? '190 / 80' : concernRun ? '190 / 45' : '180 / 120');
    if (conjunctionRun) {
      expect(completionLogs.some(item => item.utteranceId === 9 && item.workflowState === 'awaiting_final_confirmation' && item.finishIntentRecognized === true && item.remainingClarifications === 0 && item.extractionPending === true && item.completionCommitted === false)).toBe(true);
      expect(completionLogs.at(-1)).toMatchObject({ utteranceId: 9, workflowState: 'completed', finishIntentRecognized: true, remainingClarifications: 0, extractionPending: false, completionCommitted: true });
      expect(snapshot.onset.value).toBe('yesterday');
      expect(snapshot.symptoms.find(s => s.name === 'dizzy').status).toBe('confirmed');
      const stored = structuredClone(snapshot);
      snapshot.patient.name = 'Changed after completion';
      expect(cases.get(token, stored)).toEqual(stored);
    }
    if (noisyRun) {
      expect(snapshot.onset.value).toBe('yesterday');
      for (const name of ['chest pain', 'difficulty breathing']) expect(snapshot.symptoms.find(s => s.name === name).status).toBe('denied');
    }
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    await expect(page.locator('#handoff-start')).toHaveCount(0);
  } finally {
    for (const ws of sockets.clients) ws.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    cases.clear();
  }
});

import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { attachLiveRelay } from '../../backend/src/live.js';
const { WebSocket } = createRequire(new URL('../../backend/src/live.js', import.meta.url))('ws');

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

for (const outcome of ['success', 'invalid-schema', 'clarification', 'late-red-flag']) test(`voice closes before delayed summary ${outcome}, without patient finish approval`, async ({ page }) => {
  const server = createServer();
  let callbacks, release, geminiClosed = 0, socketClosed = false, issued = 0, completed = 0;
  const voiceLogs = [], finalLogs = [], inputs = [];
  const sockets = attachLiveRelay(server, {
    apiKey: 'fake', voiceLog: d => voiceLogs.push(d), finalizationLog: d => finalLogs.push(d),
    connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput: input => inputs.push(input), close() { geminiClosed++; } }; },
    extract: ({ utterances }) => new Promise(resolve => { release = () => resolve({ updates: utterances.flatMap(u => {
      const base = { label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text };
      if (u.id === 1) return [{ ...base, kind: 'name', value: 'JL' }];
      if (outcome === 'invalid-schema') return [{ ...base, kind: 'bloodPressure', value: 145, secondaryValue: 90, status: 'confirmed' }];
      if (outcome === 'late-red-flag') return [{ ...base, kind: 'redFlag', label: 'current chest pain', status: 'confirmed' }];
      return [];
    }) }); }),
    onCompleted: () => { issued++; return 'one-token'; },
  });
  sockets.on('connection', ws => ws.on('close', () => { socketClosed = true; }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await page.addInitScript(() => {
      window.voiceStreams = []; window.voiceContexts = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { const stream = await original(constraints); window.voiceStreams.push(stream); return stream; };
      const Native = window.AudioContext;
      window.AudioContext = class extends Native { constructor(...args) { super(...args); window.voiceContexts.push(this); } };
    });
    await page.route('**/api/intake-finalization', async route => {
      const response = await route.fetch({ url: `http://127.0.0.1:${server.address().port}/api/intake-finalization` });
      if (response.status() === 200 && (await response.json()).type === 'intake-complete') completed++;
      await route.fulfill({ response });
    });
    await page.routeWebSocket('**/api/live', async socket => {
      const backend = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://127.0.0.1:4173' });
      const opened = once(backend, 'open');
      socket.onMessage(async raw => { await opened; if (backend.readyState === WebSocket.OPEN) backend.send(raw); });
      socket.onClose(() => backend.close());
      backend.on('message', raw => socket.send(raw.toString()));
      backend.on('close', () => socket.close());
      await opened;
    });
    await page.goto('/patient');
    await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: 'My name is JL.', finished: true } });
    if (outcome === 'clarification') {
      emit({ outputTranscription: { text: 'Are you having chest pain?' }, turnComplete: true });
      emit({ inputTranscription: { text: 'I have chess playing.', finished: true } });
    }
    // No final question or recognized patient finish phrase is needed.
    emit({ inputTranscription: { text: outcome === 'invalid-schema' ? 'My blood pressure is 145/90.' : outcome === 'late-red-flag' ? 'I have chest pain now.' : 'Some unrecognized ASR words.', finished: true } });
    emit({ outputTranscription: { text: 'Thank you, JL. Your intake ' } });
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    expect(voiceLogs).toHaveLength(0);
    emit({ outputTranscription: { text: 'is complete.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(96000).toString('base64') } }] }, turnComplete: true });
    await expect(page.locator('#ai-state')).toHaveText('Speaking');
    expect(geminiClosed).toBe(0); expect(socketClosed).toBe(false);
    const inputCount = inputs.length;
    emit({ inputTranscription: { text: 'Thank you. Goodbye.', finished: true }, interrupted: true });
    emit({ outputTranscription: { text: 'Can I help with anything else?' }, turnComplete: true });
    await expect(page.locator('#connection-status')).toHaveText('Intake ended — finalizing summary');
    await expect.poll(() => socketClosed).toBe(true);
    expect(geminiClosed).toBe(1); expect(issued).toBe(0); expect(inputs).toHaveLength(inputCount);
    await expect.poll(() => page.evaluate(() => window.voiceStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')) && window.voiceContexts.every(c => c.state === 'closed'))).toBe(true);
    expect(voiceLogs).toEqual([{ event: 'gemini_intake_complete', voiceState: 'ENDING' }, { event: 'closed', reason: 'gemini_intake_complete' }]);
    expect(finalLogs).toHaveLength(1);
    expect(finalLogs[0]).toMatchObject({ stage: 'finalization_started', finalTurnReceived: true, outcome: 'pending' });
    await expect.poll(() => !!release).toBe(true); release();
    await expect(page.locator('#connection-status')).toHaveText(outcome === 'success' ? 'Completed' : outcome === 'late-red-flag' ? 'Emergency escalation' : 'Intake ended — summary needs review');
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    if (outcome === 'success') {
      await expect(page.locator('#handoff-start')).toHaveCount(0);
      await expect(page.locator('[data-intake="patient"]')).toContainText('JL');
    } else if (outcome === 'late-red-flag') {
      await expect(page.locator('#handoff-start')).toHaveCount(0);
      await expect(page.locator('#handoff-status')).toContainText('Pending dispatcher workflow');
    } else {
      await expect(page.locator('#handoff-start')).toHaveCount(0);
      await expect(page.locator('#intake-error-detail')).toContainText(outcome === 'invalid-schema' ? 'INVALID_RESPONSE' : 'UNRESOLVED_CLARIFICATION');
      await expect(page.locator('#intake-status')).toContainText('Previous valid information has been preserved');
      await expect(page.locator('[data-intake="patient"]')).toContainText('JL');
    }
    expect(issued).toBe(outcome === 'success' ? 1 : 0); expect(completed).toBe(issued);
    expect(finalLogs).toHaveLength(2);
    expect(finalLogs.at(-1)).toMatchObject({ stage: outcome === 'success' || outcome === 'late-red-flag' ? 'case_persistence' : 'finalization_decision', outcome: outcome === 'success' || outcome === 'late-red-flag' ? 'succeeded' : 'failed' });
    emit({ inputTranscription: { text: 'Goodbye.', finished: true } });
    emit({ outputTranscription: { text: 'Your intake is complete.' }, turnComplete: true });
    await expect(page.locator('#transcript')).not.toContainText('Goodbye');
    await expect(page.locator('#transcript')).not.toContainText('Can I help');
    expect(geminiClosed).toBe(1);
  } finally {
    release?.();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

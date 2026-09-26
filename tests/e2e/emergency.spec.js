import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { attachLiveRelay } from '../../backend/src/live.js';
import { emergencyMessage } from '../../backend/src/emergency.js';
const { WebSocket } = createRequire(new URL('../../backend/src/live.js', import.meta.url))('ws');

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

for (const finalSpeech of [true, false]) test(`emergency terminal UI preserves snapshot and blocks normal handoff; speech=${finalSpeech}`, async ({ page }) => {
  const server = createServer();
  let callbacks, geminiClosed = 0, wsClosed = false, tokens = 0;
  const events = [];
  const relay = attachLiveRelay(server, { apiKey: 'fake', emergencyTimeoutMs: finalSpeech ? 10000 : 2000,
    connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, close() { geminiClosed++; } }; },
    onCompleted() { tokens++; return 'forbidden'; },
    extract: async ({ utterances }) => ({ updates: utterances.filter(u => u.text === 'I have chest pain now.').map(u => ({ kind: 'redFlag', label: 'current chest pain', value: null, secondaryValue: null, unit: null, qualitative: null, status: 'confirmed', evidenceId: u.id, quote: u.text })) }),
  });
  relay.on('connection', ws => ws.on('close', () => { wsClosed = true; }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await page.addInitScript(() => {
      window.streams = [];
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async options => { const stream = await get(options); window.streams.push(stream); return stream; };
    });
    await page.routeWebSocket('**/api/live', async socket => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://localhost:5173' });
      const opened = once(ws, 'open');
      socket.onMessage(async raw => { await opened; if (ws.readyState === WebSocket.OPEN) ws.send(raw); });
      socket.onClose(() => ws.close());
      ws.on('message', raw => { events.push(JSON.parse(raw)); socket.send(raw.toString()); });
      ws.on('close', () => socket.close());
      await opened;
    });
    await page.goto('/patient');
    await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: 'I have chest pain now.', finished: true } });
    await expect(page.locator('#connection-status')).toHaveText('Emergency escalation');
    await expect(page.locator('#handoff-status')).toContainText('Pending dispatcher workflow');
    await expect(page.locator('#handoff-status')).toContainText('No dispatcher or emergency service has been contacted');
    await expect.poll(() => page.evaluate(() => window.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
    if (finalSpeech) {
      emit({ outputTranscription: { text: emergencyMessage }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: Buffer.alloc(48000).toString('base64') } }] }, turnComplete: true });
      await expect(page.locator('#ai-state')).toHaveText('Speaking');
      expect(wsClosed).toBe(false);
      emit({ outputTranscription: { text: emergencyMessage }, turnComplete: true });
    }
    await expect.poll(() => wsClosed).toBe(true);
    expect(geminiClosed).toBe(1); expect(tokens).toBe(0);
    expect(events.filter(e => e.type === 'emergency-escalation')).toHaveLength(1);
    const count = events.length;
    for (const text of ['Okay', 'Thank you', 'Goodbye']) emit({ inputTranscription: { text, finished: true }, outputTranscription: { text: emergencyMessage }, turnComplete: true });
    await page.waitForTimeout(50); expect(events).toHaveLength(count);
    await expect(page.locator('#connection-status')).toHaveText('Emergency escalation');
    await expect(page.locator('[data-intake="redFlags"]')).toContainText('current chest pain');
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    await expect(page.locator('#conversation-error')).toBeHidden();
  } finally {
    for (const ws of relay.clients) ws.terminate();
    await new Promise(resolve => relay.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

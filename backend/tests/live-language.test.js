import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { attachLiveRelay, systemInstructionForLanguage } from '../src/live.js';
import { DEFAULT_LIVE_LANGUAGE, LIVE_SUPPORTED_LANGUAGES, isSupportedByLiveModel, liveLanguagesForModel } from '../../shared/live-languages.js';

test('documented Gemini 3.8 Live language list is unique and unknown model overrides fail closed to English', () => {
  assert.equal(DEFAULT_LIVE_LANGUAGE, 'en');
  assert.equal(LIVE_SUPPORTED_LANGUAGES.length, 99);
  assert.equal(new Set(LIVE_SUPPORTED_LANGUAGES.map(({ code }) => code)).size, 99);
  assert(LIVE_SUPPORTED_LANGUAGES.some(({ code, label }) => code === 'fil' && /Tagalog/.test(label)));
  assert.equal(isSupportedByLiveModel('fil', 'gemini-3.8-live'), true);
  assert.equal(isSupportedByLiveModel('fil', 'unrecognized-model'), false);
  assert.deepEqual(liveLanguagesForModel('unrecognized-model').map(({ code }) => code), ['en']);
});

test('language-specific instructions set the initial greeting and preserve sustained-switch policy and safeguards', () => {
  const english = systemInstructionForLanguage('en');
  const tagalog = systemInstructionForLanguage('fil');
  assert.match(english, /INITIAL CONVERSATION LANGUAGE: English \(en\)/);
  assert.match(tagalog, /INITIAL CONVERSATION LANGUAGE: Filipino \/ Tagalog \(fil\)/);
  assert.match(tagalog, /first spoken greeting/);
  assert.match(tagalog, /sustains that choice, follow the new language/);
  assert.match(tagalog, /a name, one short word, or incidental phrase never switches languages/);
  assert.match(tagalog, /Detect the patient's language from coherent conversational turns/);
  assert.match(tagalog, /A single incidental Portuguese word such as "Não" inside an otherwise English conversation does not switch the active language/);
  assert.match(tagalog, /preserve all existing evidence, consent, emergency, completion, and human-review boundaries/i);
  assert.match(tagalog, /MEDICATION PACKAGE REVIEW/);
});

test('Live relay uses server-bound selected language before the first response and remains audio-only', async t => {
  let capturedConfig;
  const inputs = [];
  const server = createServer();
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: ['http://localhost:5173'],
    authorizeUpgrade: async () => ({ uid: 'fictional-patient', roles: ['patient'], preferredLanguage: 'fil', intakeSessionId: 'a'.repeat(64), patientCaseId: 'SC-test' }),
    connect: async options => {
      capturedConfig = options.config;
      queueMicrotask(() => options.callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput(value) { inputs.push(value); }, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const ws of relay.clients) ws.terminate();
    relay.close();
    await new Promise(resolve => server.close(resolve));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, ['smartcareops.live.v1', `smartcareops.session.${'A'.repeat(43)}`], { origin: 'http://localhost:5173' });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true, preferredLanguage: 'en' }));
  const until = Date.now() + 3000;
  while (!capturedConfig && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert(capturedConfig, 'Live connection config should be sent for the initial response');
  assert.deepEqual(capturedConfig.responseModalities, ['AUDIO']);
  assert.match(capturedConfig.systemInstruction, /INITIAL CONVERSATION LANGUAGE: Filipino \/ Tagalog \(fil\)/);
  assert.doesNotMatch(capturedConfig.systemInstruction, /send (?:an )?(?:image|video)|stream (?:image|video)|video frame/i);
  assert.equal(capturedConfig.responseModalities.includes('IMAGE'), false);
  const inputUntil = Date.now() + 3000;
  while (!inputs.length && Date.now() < inputUntil) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(inputs[0], { text: 'Greet the patient in Filipino / Tagalog and ask only for their name. Then wait for their answer.' });
  // Configuration-order coverage is mocked; it is not proof that a real model speaks Tagalog.
  ws.close();
});

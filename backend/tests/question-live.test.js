import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { attachLiveRelay } from '../src/live.js';
import { createMemoryLiveSessionStore, LIVE_PROTOCOL } from '../src/live-session.js';
import { createFacilityCoordinator } from '../src/facility-coordination.js';

const origin = 'http://localhost:5173';
const patient = { uid: 'adaptive-patient', roles: ['patient'] };
const waitFor = async check => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
const update = (kind, evidenceId, quote, values = {}) => ({ kind, label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId, quote, ...values });

test('exact severe-breathing confirmation immediately reaches the emergency hospital lookup without another extraction', async t => {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const realtime = []; const clientContent = []; const extractedUtteranceIds = []; let callbacks, emergencyLookup, emergencyLookupCount = 0;
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], medicationStore: store, questionPlanStore: store,
    facilityCoordinator: { async lookupEmergency(input) { emergencyLookup = input; emergencyLookupCount++; return { options: [{ hospitalId: 'HOSP-001', hospitalName: 'SmartCare General Hospital (fictional)', distanceMeters: 2300, capacity: { emergencyBedsAvailable: 3 } }] }; } },
    authorizeUpgrade: input => store.consume(input),
    extract: async ({ utterances }) => { extractedUtteranceIds.push(...utterances.map(item => item.id)); return { updates: utterances.map(item => item.id === 1
      ? update('name', item.id, item.text, { value: 'JL' })
      : update('symptom', item.id, item.text, { label: 'difficulty breathing', status: 'confirmed' })) }; },
    onEmergency: async (_intake, context) => ({ caseId: context.caseId, workflowStatus: 'pending_dispatcher', emergency: true }),
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => realtime.push(value), sendClientContent: value => clientContent.push(value), sendToolResponse() {}, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.clients) client.terminate(); relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  const issued = await store.create({ ...patient, origin });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => realtime.some(item => item.text?.includes('core.name')));
  const emit = content => callbacks.onmessage({ serverContent: content });

  emit({ outputTranscription: { text: 'May I have your name?', finished: true }, turnComplete: true });
  emit({ inputTranscription: { text: 'JL', finished: true }, turnComplete: true });
  assert.equal(realtime.some(item => item.text?.includes('core.main_concern')), false, 'next question waits for the unsolicited name turn to end');
  emit({
    outputTranscription: { text: 'Thank you, JL. I am now waiting for the next authorized question.', finished: true },
    modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }] },
    turnComplete: true,
  });
  await waitFor(() => realtime.some(item => item.text?.includes('core.main_concern')));
  assert.equal(messages.some(item => item.type === 'transcript' && item.text?.includes('waiting for the next authorized question')), false);
  assert.equal(messages.some(item => item.type === 'audio' && item.data === 'AAAAAA=='), false);
  emit({
    outputTranscription: { text: 'Thank you, JL. What are you feeling today?', finished: true },
    modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQEBAQ==' } }] },
    turnComplete: true,
  });
  await waitFor(() => messages.some(item => item.type === 'transcript' && item.text === 'Thank you, JL. What are you feeling today?') &&
    messages.some(item => item.type === 'audio' && item.data === 'AQEBAQ=='));
  messages.length = 0;
  emit({ inputTranscription: { text: 'I have difficulty breathing.', finished: true }, turnComplete: true });
  await waitFor(() => realtime.some(item => item.text?.includes('breathing.severe_now')));
  assert.equal(realtime.some(item => item.text?.includes('core.severity')), false);
  emit({ outputTranscription: { text: 'Is the breathing difficulty severe right now?', finished: true }, turnComplete: true });
  emit({ inputTranscription: { text: 'Yes', finished: true }, turnComplete: true });
  await waitFor(() => messages.some(item => item.type === 'emergency-escalation'));
  assert.equal(emergencyLookupCount, 0, 'hospital lookup waits for warning playback');
  await waitFor(() => messages.some(item => item.type === 'emergency-phase-speech' && item.phase === 'warning'));
  assert.equal(realtime.some(item => item.text?.includes('Emergency escalation is pending')), false);
  assert.deepEqual(clientContent, [{ turnComplete: true }]);
  assert.equal(extractedUtteranceIds.includes(3), false);
  const escalation = messages.find(item => item.type === 'emergency-escalation');
  assert.equal(messages.find(item => item.type === 'emergency-phase-speech' && item.phase === 'warning').text, escalation.message);
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'warning' }));
  await waitFor(() => emergencyLookupCount === 1);
  assert.equal(emergencyLookup.patientUid, patient.uid);
  assert.equal(emergencyLookup.intake.redFlags.some(flag => flag.type === 'severe difficulty breathing' && flag.status === 'confirmed'), true);
  await waitFor(() => messages.some(item => item.type === 'emergency-phase-speech' && item.phase === 'facility'));
  const facilityMessage = messages.find(item => item.type === 'emergency-phase-speech' && item.phase === 'facility').text;
  assert.match(facilityMessage, /about 2\.3 kilometers away/);
  assert.match(facilityMessage, /simulated emergency department shows 3 available beds/);
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'facility' }));
  await waitFor(() => messages.some(item => item.type === 'emergency-playback-ready'));
  assert.equal(messages.some(item => item.type === 'audio' || item.type === 'transcript' && [escalation.message, facilityMessage].includes(item.text)), false);
  ws.send(JSON.stringify({ type: 'emergency-settled', id: escalation.id }));
  assert.equal(messages.some(item => item.type === 'facility-options' || item.type === 'appointment-request'), false);
  const plan = await store.getQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid });
  assert.equal(plan.emergency, true); assert.equal(plan.activeQuestionId, null);
  assert.equal(messages.some(item => item.type === 'intake-progress' && item.progress.phase === 'emergency'), true);

  if (ws.readyState === WebSocket.OPEN) ws.close();
});

test('an explicit cannot-breathe statement reaches the emergency hospital lookup from the final-addition stage', async t => {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const realtime = []; let callbacks, lookupInput, lookupCount = 0, extractionCount = 0;
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], medicationStore: store, questionPlanStore: store,
    facilityCoordinator: { async lookupEmergency(input) { lookupInput = input; lookupCount++; return { options: [] }; } },
    authorizeUpgrade: input => store.consume(input),
    extract: async () => { extractionCount++; return { updates: [] }; },
    onEmergency: async (_intake, context) => ({ caseId: context.caseId, workflowStatus: 'pending_dispatcher', emergency: true }),
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => realtime.push(value), sendClientContent() {}, sendToolResponse() {}, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.clients) client.terminate(); relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  const issued = await store.create({ ...patient, origin });
  await store.saveQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid, plan: {
    version: 1, revision: 0, path: 'breathing', activeQuestionId: 'core.final_addition',
    answers: { 'core.name': { state: 'answered', patientReportedText: 'Louis', utteranceId: 1 },
      'core.main_concern': { state: 'answered', patientReportedText: 'Asthma concern', utteranceId: 2 } },
    asked: ['core.name', 'core.main_concern'], processedUtteranceIds: [], clarificationCounts: {}, status: 'ready_to_finish', emergency: false,
  } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => realtime.some(item => item.text?.includes('core.final_addition')));
  callbacks.onmessage({ serverContent: { outputTranscription: { text: "Is there anything else you'd like to add before we finish?", finished: true }, turnComplete: true } });
  callbacks.onmessage({ serverContent: { inputTranscription: { text: "Yes. I think I'm having an asthma attack. I can't breathe.", finished: true }, turnComplete: true } });
  await waitFor(() => messages.some(item => item.type === 'emergency-escalation'));
  assert.equal(lookupCount, 0);
  assert.equal(extractionCount, 0);
  assert.equal(messages.some(item => item.type === 'intake-progress' && item.progress.phase === 'emergency'), true);
  ws.close();
});

test('an immediate cannot-breathe main concern reaches the emergency hospital lookup', async t => {
  const store = createMemoryLiveSessionStore();
  const coordinator = createFacilityCoordinator({ now: () => Date.parse('2026-10-01T00:00:00Z') });
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const realtime = []; const clientContent = []; let callbacks, lookupInput, lookupResult, lookupCount = 0, extractionCount = 0;
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], medicationStore: store, questionPlanStore: store,
    facilityCoordinator: { async lookupEmergency(input) {
      lookupInput = input; lookupCount++;
      lookupResult = await coordinator.lookupEmergency(input);
      return lookupResult;
    } },
    authorizeUpgrade: input => store.consume(input),
    extract: async () => { extractionCount++; return { updates: [] }; },
    onEmergency: async (_intake, context) => ({ caseId: context.caseId, workflowStatus: 'pending_dispatcher', emergency: true }),
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => realtime.push(value), sendClientContent: value => clientContent.push(value), sendToolResponse() {}, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.clients) client.terminate(); relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  const issued = await store.create({ ...patient, origin });
  await store.saveQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid, plan: {
    version: 1, revision: 0, path: null, activeQuestionId: 'core.main_concern',
    answers: { 'core.name': { state: 'answered', patientReportedText: 'Louis', utteranceId: 1 } },
    asked: ['core.name'], processedUtteranceIds: [], clarificationCounts: {}, status: 'collecting', emergency: false,
  } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => realtime.some(item => item.text?.includes('core.main_concern')));
  callbacks.onmessage({ serverContent: { outputTranscription: { text: 'What are you feeling today?', finished: true }, turnComplete: true } });
  callbacks.onmessage({ serverContent: { inputTranscription: { text: "I can't breathe.", finished: true }, turnComplete: true } });
  await waitFor(() => messages.some(item => item.type === 'emergency-escalation'));
  assert.equal(lookupCount, 0);
  assert.equal(extractionCount, 0);
  const escalation = messages.find(item => item.type === 'emergency-escalation');
  await waitFor(() => messages.some(item => item.type === 'emergency-phase-speech' && item.phase === 'warning'));
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'warning' }));
  await waitFor(() => lookupCount === 1);
  assert.equal(lookupInput.intake.redFlags.some(flag => flag.type === 'severe difficulty breathing' && flag.status === 'confirmed'), true);
  assert.equal(lookupResult.options[0].hospitalName, 'SmartCare General Hospital (fictional)');
  assert.equal(lookupResult.options[0].capacity.emergencyBedsAvailable, 3);
  await waitFor(() => messages.some(item => item.type === 'emergency-phase-speech' && item.phase === 'facility'));
  assert.match(messages.find(item => item.type === 'emergency-phase-speech' && item.phase === 'facility').text, /3 available beds/);
  assert.equal(messages.some(item => item.type === 'intake-progress' && item.progress.phase === 'emergency'), true);
  ws.close();
});

test('emergency warning is published as exact browser-speech text without Gemini audio', async t => {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const realtime = []; const clientContent = []; let callbacks;
  const warning = 'This information may require urgent attention. I\'m stopping the standard intake. Emergency escalation is pending. No dispatcher or emergency service has been contacted.';
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], medicationStore: store, questionPlanStore: store,
    emergencyTimeoutMs: 300, emergencyPlaybackTimeoutMs: 500,
    facilityCoordinator: { async lookupEmergency() { return { options: [{ hospitalId: 'HOSP-001', hospitalName: 'Northstar General', distanceMeters: 2300, capacity: { emergencyBedsAvailable: 38 } }] }; } },
    authorizeUpgrade: input => store.consume(input),
    extract: async () => ({ updates: [] }),
    onEmergency: async (_intake, context) => ({ caseId: context.caseId, workflowStatus: 'pending_dispatcher', emergency: true }),
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => realtime.push(value), sendClientContent: value => clientContent.push(value), sendToolResponse() {}, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.clients) client.terminate(); relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  const issued = await store.create({ ...patient, origin });
  await store.saveQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid, plan: {
    version: 1, revision: 0, path: null, activeQuestionId: 'core.main_concern',
    answers: { 'core.name': { state: 'answered', patientReportedText: 'Louis', utteranceId: 1 } },
    asked: ['core.name'], processedUtteranceIds: [], clarificationCounts: {}, status: 'collecting', emergency: false,
  } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => realtime.some(item => item.text?.includes('core.main_concern')));
  callbacks.onmessage({ serverContent: { outputTranscription: { text: 'What are you feeling today?', finished: true }, turnComplete: true } });
  callbacks.onmessage({ serverContent: { inputTranscription: { text: "I can't breathe.", finished: true }, turnComplete: true } });
  await waitFor(() => messages.some(item => item.type === 'emergency-escalation'));
  await waitFor(() => messages.some(item => item.type === 'emergency-phase-speech'));
  const speech = messages.find(item => item.type === 'emergency-phase-speech');
  assert.deepEqual({ phase: speech.phase, text: speech.text }, { phase: 'warning', text: warning });
  assert.equal(messages.some(item => item.type === 'audio' || item.type === 'transcript' && item.text === warning), false);
  assert.equal(clientContent.length, 1);
  assert.deepEqual(clientContent[0], { turnComplete: true });
});

test('emergency warning rejects a spontaneous turn that starts after emergency validation', async t => {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const realtime = []; const clientContent = []; const events = []; let callbacks, lookupCount = 0;
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], medicationStore: store, questionPlanStore: store,
    facilityCoordinator: { async lookupEmergency() { events.push('lookup'); lookupCount++; return { options: [] }; } },
    authorizeUpgrade: input => store.consume(input),
    extract: async () => ({ updates: [] }),
    onEmergency: async (_intake, context) => ({ caseId: context.caseId, workflowStatus: 'pending_dispatcher', emergency: true }),
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => realtime.push(value), sendClientContent: value => { events.push('interrupt-request'); clientContent.push(value); }, sendToolResponse() {}, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.clients) client.terminate(); relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  const issued = await store.create({ ...patient, origin });
  await store.saveQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid, plan: {
    version: 1, revision: 0, path: null, activeQuestionId: 'core.main_concern',
    answers: { 'core.name': { state: 'answered', patientReportedText: 'Louis', utteranceId: 1 } },
    asked: ['core.name'], processedUtteranceIds: [], clarificationCounts: {}, status: 'collecting', emergency: false,
  } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = []; ws.on('message', raw => { const message = JSON.parse(raw); messages.push(message); events.push(message.type); });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => realtime.some(item => item.text?.includes('core.main_concern')));
  const emit = content => callbacks.onmessage({ serverContent: content });
  emit({ outputTranscription: { text: 'What are you feeling today?', finished: true }, turnComplete: true });
  emit({ inputTranscription: { text: "I can't breathe.", finished: true }, turnComplete: true });
  await waitFor(() => messages.some(item => item.type === 'emergency-escalation'));
  const escalation = messages.find(item => item.type === 'emergency-escalation');
  assert.deepEqual(clientContent, [{ turnComplete: true }]);
  await waitFor(() => messages.some(item => item.type === 'emergency-phase-speech' && item.phase === 'warning'));
  assert.equal(events.indexOf('interrupt-request') < events.indexOf('emergency-phase-speech'), true);
  assert.equal(lookupCount, 0);
  emit({ outputTranscription: { text: 'To support best...', finished: false }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'BAUG' } }] } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(messages.some(item => item.type === 'audio' && item.data === 'BAUG'), false);
  assert.equal(messages.some(item => item.type === 'transcript' && item.text.includes('To support best')), false);
  assert.equal(messages.filter(item => item.type === 'emergency-phase-speech').length, 1);
  assert.equal(clientContent.length, 1);
  emit({ interrupted: true });
  emit({ modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'BwgJ' } }] } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(messages.some(item => item.type === 'audio' && item.data === 'BwgJ'), false);
  assert.equal(messages.some(item => item.type === 'transcript' && item.text === escalation.message), false);
  assert.equal(lookupCount, 0);
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'warning' }));
  await waitFor(() => lookupCount === 1);
  assert.equal(events.indexOf('emergency-phase-speech') < events.indexOf('lookup'), true);
});

test('Live sends the backend completion instruction once and ignores later Patient audio', async t => {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const realtime = []; let callbacks;
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], questionPlanStore: store,
    authorizeUpgrade: input => store.consume(input),
    extract: async () => ({ updates: [] }),
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => realtime.push(value), sendClientContent() {}, sendToolResponse() {}, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.clients) client.terminate(); relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  const issued = await store.create({ ...patient, origin });
  await store.saveQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid, plan: {
    version: 1, revision: 0, path: 'general', activeQuestionId: 'core.final_addition', answers: {}, asked: [],
    processedUtteranceIds: [], clarificationCounts: {}, status: 'ready_to_finish', emergency: false,
  } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => realtime.some(item => item.text?.includes('core.final_addition')));
  const emit = content => callbacks.onmessage({ serverContent: content });
  emit({ inputTranscription: { text: 'No', finished: true }, turnComplete: true });
  await waitFor(() => realtime.some(item => item.text?.includes('Say only the canonical completion sentence')));
  const completionPrompts = () => realtime.filter(item => item.text?.includes('Say only the canonical completion sentence'));
  assert.equal(completionPrompts().length, 1);
  const sentBeforeAck = realtime.length;
  ws.send(JSON.stringify({ type: 'audio', data: 'AAAAAA==', sampleRate: 16000 }));
  emit({ inputTranscription: { text: 'Thank you', finished: true }, turnComplete: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(realtime.length, sentBeforeAck);
  assert.equal(completionPrompts().length, 1);
  ws.close();
});

test('shoulder question is authorized before extraction resolves and is not repeated afterward', async t => {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const realtime = []; let callbacks, releaseExtraction, extractionStarted = false;
  const extraction = new Promise(resolve => { releaseExtraction = resolve; });
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], questionPlanStore: store,
    authorizeUpgrade: input => store.consume(input),
    extract: async () => { extractionStarted = true; return extraction; },
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => realtime.push(value), sendClientContent() {}, sendToolResponse() {}, close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.clients) client.terminate(); relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  const issued = await store.create({ ...patient, origin });
  await store.saveQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid, plan: {
    version: 1, revision: 0, path: null, activeQuestionId: 'core.main_concern',
    answers: { 'core.name': { state: 'answered', patientReportedText: 'JL', utteranceId: 1 } },
    asked: ['core.name'], processedUtteranceIds: [], clarificationCounts: {}, status: 'collecting', emergency: false,
  } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => realtime.some(item => item.text?.includes('core.main_concern')));
  callbacks.onmessage({ serverContent: { outputTranscription: { text: 'What are you feeling today?', finished: true }, turnComplete: true } });
  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'My left shoulder hurts.', finished: true }, turnComplete: true } });
  const shoulderQuestions = () => realtime.filter(item => item.text?.includes('Stable question shoulder.'));
  assert.equal(shoulderQuestions().length, 1);
  assert.equal(extractionStarted, false, 'question must not wait for the extraction timer');
  await waitFor(() => extractionStarted);
  assert.equal(shoulderQuestions().length, 1, 'question is already authorized while extraction is pending');
  releaseExtraction({ updates: [] });
  await waitFor(() => messages.some(message => message.type === 'intake-status' && message.status === 'current'));
  assert.equal(shoulderQuestions().length, 1, 'validated extraction must not authorize the question again');
  ws.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { attachLiveRelay } from '../src/live.js';
import { emergencyEscalation, emergencyFacilityMessage, emergencyMessage } from '../src/emergency.js';
import { emptyIntake, redFlagTypes } from '../src/intake/schema.js';
import { createIntakeSession } from '../src/intake/session.js';
import { mergeIntake } from '../src/intake/validate.js';
import { createMemoryCaseStore } from '../src/cases/store.js';

const update = (u, extra) => ({ label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text, ...extra });
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('the exact BP-only report is validated but does not invent a numeric emergency rule', () => {
  const texts = ['Hi, my name is JL.', "I'm feeling dizzy.", 'It started yesterday.', 'No.', 'Yes, my blood pressure is 190/45.'];
  const facts = [{ kind: 'name', value: 'JL' }, { kind: 'symptom', label: 'dizzy', status: 'confirmed' }, { kind: 'onset', value: 'yesterday' }, { kind: 'symptom', label: 'chest pain', status: 'denied' }, { kind: 'bloodPressure', value: 190, secondaryValue: 45 }];
  const utterances = texts.map((text, index) => ({ id: index + 1, role: 'Patient', text, question: index === 3 ? 'Are you having chest pain?' : '' }));
  const intake = mergeIntake(emptyIntake(), { updates: utterances.map((u, i) => update(u, facts[i])) }, utterances);
  assert.deepEqual(intake.vitals.bloodPressure, { systolic: 190, diastolic: 45, source: 'patient_reported' });
  assert.equal(emergencyEscalation(intake), null);
});

test('every existing confirmed-red-flag type remains eligible for the pending-only contract', () => {
  for (const type of redFlagTypes) {
    const intake = emptyIntake();
    intake.redFlags.push({ type, status: 'confirmed', patientReportedText: type });
    intake.evidence[`redFlags.${type}`] = { utteranceId: 1, patientReportedText: type };
    const event = emergencyEscalation(intake);
    assert.equal(event.caseStatus, 'pending_dispatcher');
    assert.equal(event.source, 'intake');
    assert.equal(event.redFlags[0].type, type);
  }
});

test('numeric-only evidence cannot be promoted to a red flag by an extractor candidate', () => {
  const u = { id: 1, role: 'Patient', text: 'Yes, my blood pressure is 190/45.', question: 'Anything else?' };
  assert.throws(() => mergeIntake(emptyIntake(), { updates: [update(u, { kind: 'redFlag', label: 'current chest pain', status: 'confirmed' })] }, [u]));
});

test('workflow notification occurs only after successful atomic validation', async t => {
  const snapshots = [];
  let invalid = true;
  const session = createIntakeSession({ send() {}, log() {}, onValidated: intake => snapshots.push(intake), extract: async ({ utterances }) => ({ updates: [
    update(utterances.at(-1), { kind: 'bloodPressure', value: 190, secondaryValue: 45, status: invalid ? 'confirmed' : null }),
  ] }) });
  t.after(() => session.close());
  session.accept({ inputTranscription: { text: 'My blood pressure is 190/45.', finished: true } });
  await assert.rejects(session.drain());
  assert.deepEqual(snapshots, []);
  invalid = false; session.resume();
  const snapshot = await session.drain();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshot.vitals.bloodPressure.diastolic, 45);
  assert.equal(emergencyEscalation(snapshots[0]), null);
});

test('emergency hospital lookup publishes bounded exact browser-speech phases', async t => {
  const server = createServer(); let callbacks;
  const inputs = [], clientContent = [], messages = [];
  const relay = attachLiveRelay(server, {
    apiKey: 'fake', emergencyTimeoutMs: 1000, emergencyFacilityLookupTimeoutMs: 20,
    facilityCoordinator: { lookupEmergency: async () => new Promise(() => {}) },
    connect: async options => {
      callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => inputs.push(value), sendClientContent: value => clientContent.push(value), close() {} };
    },
    extract: async ({ utterances }) => ({ updates: utterances.map(u => update(u, { kind: 'redFlag', label: 'current chest pain', status: 'confirmed' })) }),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://localhost:5173' });
  t.after(async () => { ws.terminate(); for (const client of relay.clients) client.terminate(); relay.close(); await new Promise(resolve => server.close(resolve)); });
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start' })); await until(() => messages.some(m => m.type === 'ready'));

  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'I have chest pain now.', finished: true } } });
  await until(() => messages.some(m => m.type === 'emergency-escalation'));
  const escalation = messages.find(m => m.type === 'emergency-escalation');
  assert.equal(escalation.message, emergencyMessage);
  assert.equal(inputs.filter(item => item.text?.includes(emergencyMessage)).length, 0);
  await until(() => messages.some(m => m.type === 'emergency-phase-speech' && m.phase === 'warning'));
  assert.equal(messages.find(m => m.type === 'emergency-phase-speech' && m.phase === 'warning').text, emergencyMessage);
  assert.deepEqual(clientContent, [{ turnComplete: true }]);
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'warning' }));
  await until(() => messages.some(m => m.type === 'emergency-phase-speech' && m.phase === 'facility'));
  assert.equal(messages.find(m => m.type === 'emergency-phase-speech' && m.phase === 'facility').text, emergencyFacilityMessage());
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'facility' }));
  await until(() => messages.some(m => m.type === 'emergency-playback-ready'));
  assert.equal(messages.some(m => m.type === 'audio' || m.type === 'transcript' && [emergencyMessage, emergencyFacilityMessage()].includes(m.text)), false);
});

for (const status of ['denied', 'unclear', 'confirmed']) test(`emergency decision requires confirmed evidenced flag: ${status}`, () => {
  const intake = emptyIntake();
  intake.redFlags = [{ type: 'current chest pain', status, patientReportedText: 'I have chest pain now.' }];
  assert.equal(emergencyEscalation(intake), null);
  intake.evidence['redFlags.current chest pain'] = { utteranceId: 1, patientReportedText: 'I have chest pain now.' };
  const event = emergencyEscalation(intake);
  assert.equal(!!event, status === 'confirmed');
  if (event) {
    intake.redFlags[0].status = 'denied';
    assert.equal(event.snapshot.redFlags[0].status, 'confirmed');
    assert.equal(event.caseStatus, 'pending_dispatcher');
  }
});

for (const finalAudio of [true, false]) test(`emergency owns terminal session; final audio available=${finalAudio}`, async t => {
  const caseStore = createMemoryCaseStore(); let patientCase;
  const server = createServer(); let callbacks, closed = 0, issued = 0, requests = 0;
  const inputs = [], clientContent = [], messages = [];
  let release;
  const relay = attachLiveRelay(server, { apiKey: 'fake', emergencyTimeoutMs: finalAudio ? 3000 : 100, emergencyResponseTimeoutMs: 20, emergencyPlaybackTimeoutMs: 100,
    connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput: value => inputs.push(value), sendClientContent: value => clientContent.push(value), close() { closed++; } }; },
    onCompleted() { issued++; },
    onEmergency: async (intake, { caseId }) => { patientCase = await caseStore.createCase({ caseId, intake, emergency: true }); return patientCase; },
    extract: async ({ utterances }) => {
      requests++;
      await new Promise(resolve => { release = resolve; });
      if (requests > 1) throw new Error('Nonessential queued extraction must not run after emergency commits');
      return { updates: utterances.filter(u => u.text === 'I have chest pain now.').map(u => update(u, { kind: 'redFlag', label: 'current chest pain', status: 'confirmed' })) };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://localhost:5173' });
  t.after(async () => { ws.terminate(); for (const client of relay.clients) client.terminate(); relay.close(); await new Promise(resolve => server.close(resolve)); });
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start' }));
  await until(() => messages.some(m => m.type === 'ready'));
  const emit = content => callbacks.onmessage({ serverContent: content });
  emit({ inputTranscription: { text: 'I have chest pain now.', finished: true } });
  await until(() => release);
  emit({ inputTranscription: { text: 'Another nonessential detail.', finished: true } });
  release();
  await until(() => messages.some(m => m.type === 'emergency-escalation'));
  const escalation = messages.find(m => m.type === 'emergency-escalation');
  assert.equal(escalation.snapshot.redFlags[0].status, 'confirmed');
  assert.equal(escalation.caseStatus, 'pending_dispatcher');
  const inputsBefore = inputs.length;
  const controlsBefore = clientContent.length;
  ws.send(JSON.stringify({ type: 'audio', data: 'AAAAAA==', sampleRate: 16000 }));
  for (const text of ['Okay', 'Thank you', 'Goodbye']) emit({ inputTranscription: { text, finished: true } });
  await until(() => messages.some(m => m.type === 'emergency-phase-speech' && m.phase === 'warning'));
  emit({ outputTranscription: { text: 'An unwanted repeated warning.' }, turnComplete: true });
  assert.equal(messages.some(m => m.type === 'audio' || m.type === 'transcript' && m.text === 'An unwanted repeated warning.'), false);
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'warning' }));
  await until(() => messages.some(m => m.type === 'emergency-playback-ready'));
  assert.equal(ws.readyState, WebSocket.OPEN, 'Wait for playback acknowledgement');
  assert.equal(messages.filter(m => m.type === 'audio').length, 0);
  ws.send(JSON.stringify({ type: 'emergency-settled', id: escalation.id }));
  if (ws.readyState !== WebSocket.CLOSED) await once(ws, 'close');
  const count = messages.length;
  emit({ inputTranscription: { text: 'Goodbye', finished: true }, outputTranscription: { text: emergencyMessage }, turnComplete: true });
  assert.equal(messages.length, count);
  assert.equal(closed, 1); assert.equal(issued, 0); assert.equal(requests, 1);
  assert.equal(inputs.length, inputsBefore, 'Patient realtime input is ignored after emergency commits');
  assert.equal(clientContent.length, controlsBefore, 'Emergency acknowledgement never requests a Gemini speech turn');
  assert.equal(messages.filter(m => m.type === 'emergency-escalation').length, 1);
  assert.equal(messages.filter(m => m.type === 'intake-complete').length, 0);
  assert.equal(patientCase.workflowStatus, 'emergency_pending_dispatcher');
  assert.equal(patientCase.emergency.reasonCode, 'chest_pain_red_flag');
  assert.equal((await caseStore.listDispatcherCases()).cases[0].caseId, patientCase.caseId);
  assert.deepEqual((await caseStore.getCase(patientCase.caseId)).reportedFacts, escalation.snapshot);
});

test('emergency playback settlement waits for durable persistence and never advertises a pending local case', async t => {
  const server = createServer(); let callbacks, releasePersistence;
  const messages = [];
  const relay = attachLiveRelay(server, {
    apiKey: 'fake', emergencyTimeoutMs: 3000,
    connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, sendClientContent() {}, close() {} }; },
    extract: async ({ utterances }) => ({ updates: utterances.map(u => update(u, { kind: 'redFlag', label: 'current chest pain', status: 'confirmed' })) }),
    onEmergency: async (_intake, { caseId }) => new Promise(resolve => { releasePersistence = () => resolve({ caseId, workflowStatus: 'emergency_pending_dispatcher', storage: 'firestore', emergency: { status: 'pending_dispatcher' } }); }),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://localhost:5173' });
  t.after(async () => { ws.terminate(); for (const client of relay.clients) client.terminate(); relay.close(); await new Promise(resolve => server.close(resolve)); });
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start' })); await until(() => messages.some(m => m.type === 'ready'));
  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'I have chest pain now.', finished: true } } });
  await until(() => messages.some(m => m.type === 'emergency-escalation') && releasePersistence);
  const escalation = messages.find(m => m.type === 'emergency-escalation');
  assert.equal(escalation.patientCase, undefined);
  await until(() => messages.some(m => m.type === 'emergency-phase-speech' && m.phase === 'warning'));
  ws.send(JSON.stringify({ type: 'emergency-phase-settled', id: escalation.id, phase: 'warning' }));
  await until(() => messages.some(m => m.type === 'emergency-playback-ready'));
  ws.send(JSON.stringify({ type: 'emergency-settled', id: escalation.id }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(messages.some(m => m.type === 'patient-case'), false);
  releasePersistence();
  await until(() => messages.some(m => m.type === 'patient-case'));
  if (ws.readyState !== WebSocket.CLOSED) await once(ws, 'close');
  assert.equal(messages.filter(m => m.type === 'patient-case').length, 1);
  assert.equal(messages.find(m => m.type === 'patient-case').patientCase.storage, 'firestore');
});

test('emergency persistence failure is surfaced without claiming a saved case', async t => {
  const server = createServer(); let callbacks;
  const messages = [];
  const relay = attachLiveRelay(server, {
    apiKey: 'fake', emergencyTimeoutMs: 3000,
    connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, sendClientContent() {}, close() {} }; },
    extract: async ({ utterances }) => ({ updates: utterances.map(u => update(u, { kind: 'redFlag', label: 'current chest pain', status: 'confirmed' })) }),
    onEmergency: async () => { throw new Error('provider detail must stay private'); },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, { origin: 'http://localhost:5173' });
  t.after(async () => { ws.terminate(); for (const client of relay.clients) client.terminate(); relay.close(); await new Promise(resolve => server.close(resolve)); });
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start' })); await until(() => messages.some(m => m.type === 'ready'));
  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'I have chest pain now.', finished: true } } });
  await until(() => messages.some(m => m.type === 'patient-case'));
  const failed = messages.find(m => m.type === 'patient-case').patientCase;
  assert.equal(failed.storage, 'unavailable');
  assert.ok(!JSON.stringify(messages).includes('provider detail'));
  assert.equal(messages.find(m => m.type === 'emergency-escalation').patientCase, undefined);
});

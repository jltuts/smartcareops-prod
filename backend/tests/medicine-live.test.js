import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { attachLiveRelay, medicineLiveTools } from '../src/live.js';
import { createMemoryLiveSessionStore, LIVE_PROTOCOL } from '../src/live-session.js';

const origin = 'http://localhost:5173';
const patient = { uid: 'patient-medicine-live', roles: ['patient'] };
const waitFor = async check => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

async function fixture(t, { clientContentFails = false, extractImpl } = {}) {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const clientContent = [], toolResponses = [], realtime = [];
  let callbacks, identity, closeCount = 0, extractCalls = 0;
  const extractInputs = [];
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], medicationStore: store,
    authorizeUpgrade: async input => { identity = await store.consume(input); return identity; },
    extract: async input => { extractCalls++; extractInputs.push(input); return extractImpl ? extractImpl(input) : { updates: [] }; },
    connect: async options => {
      callbacks = options.callbacks;
      queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return {
        sendRealtimeInput: value => realtime.push(value),
        sendClientContent: value => { if (clientContentFails) throw new Error('mock Live control failure'); clientContent.push(value); },
        sendToolResponse: value => toolResponses.push(value),
        close: () => { closeCount++; },
      };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const issued = await store.create({ ...patient, origin });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => messages.some(message => message.type === 'ready'));
  callbacks.onmessage({ serverContent: { outputTranscription: { text: 'What is your name?', finished: true }, turnComplete: true } });
  t.after(async () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    for (const client of relay.clients) client.terminate();
    relay.close(); store.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { store, issued, ws, messages, clientContent, toolResponses, realtime, extractInputs, identity: () => identity, callbacks: () => callbacks, extractCalls: () => extractCalls, closeCount: () => closeCount };
}

test('validated scan reaches the same audio-only Live session as a tool result and medication answers bypass clinical extraction', async t => {
  const f = await fixture(t);
  const result = await f.store.saveMedicineScanResult({ intakeSessionId: f.issued.intakeSessionId, uid: patient.uid,
    candidate: { status: 'identified', name: 'Fictionalmed', strength: '10 mg' } });
  assert.equal(result.status, 'identified');
  f.ws.send(JSON.stringify({ type: 'medicine-scan-ready' }));
  await waitFor(() => f.clientContent.some(message => JSON.stringify(message).includes('scan result is ready')));
  const applicationEvent = f.clientContent.at(-1);
  assert.equal(applicationEvent.turns[0].role, 'user');
  assert.match(applicationEvent.turns[0].parts[0].text, /NOT PATIENT SPEECH/);
  assert.doesNotMatch(JSON.stringify(applicationEvent), /Fictionalmed|10 mg/);

  f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: 'scan-1', name: 'receive_medicine_scan_result', args: {} }] } });
  await waitFor(() => f.toolResponses.length === 1);
  const delivered = f.toolResponses[0].functionResponses[0];
  assert.equal(delivered.name, 'receive_medicine_scan_result');
  assert.deepEqual(delivered.response, {
    source: 'smartcareops_server_validated_scan', status: 'identified', name: 'Fictionalmed', strength: '10 mg',
    boundary: 'Packaging text only; not patient-reported actual use and not clinically verified.',
  });
  f.callbacks().onmessage({ serverContent: { outputTranscription: { text: 'I read Fictionalmed, 10 milligrams. Is that correct, and how do you take it?', finished: true }, turnComplete: true } });
  f.callbacks().onmessage({ serverContent: { inputTranscription: { text: 'Yes. I take one every morning.', finished: true }, turnComplete: true } });
  await waitFor(() => f.extractCalls() === 1);
  assert.match(f.extractInputs[0].utterances[0].question, /safety check/i);
  assert.equal(f.messages.filter(message => message.type === 'intake-update').length, 1);
  f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: 'draft-1', name: 'record_patient_medication_report', args: {
    name: 'Fictionalmed', strength: '10 mg', howTaken: 'I take one every morning.', confirmedReading: true,
  } }] } });
  await waitFor(() => f.messages.some(message => message.type === 'medicine-draft'));
  assert.deepEqual(f.messages.find(message => message.type === 'medicine-draft').draft, {
    name: 'Fictionalmed', strength: '10 mg', howTaken: 'I take one every morning.', confirmedReading: true,
  });
  f.callbacks().onmessage({ serverContent: { outputTranscription: { text: 'Please review and confirm the entry on screen.', finished: true }, turnComplete: true } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.clientContent.some(message => JSON.stringify(message).includes('medication interaction has ended')), false);
  assert(f.messages.some(message => message.type === 'medicine-live-status' && message.status === 'review_ready'));
  const idempotencyKey = 'f4afdf67-2c3c-4b12-95dc-4c4f9ba0bc52';
  f.ws.send(JSON.stringify({ type: 'medicine-ui-state', state: 'saved' }));
  await waitFor(() => f.messages.some(message => message.type === 'medicine-live-status' && message.status === 'save_unverified'));
  assert.equal(f.clientContent.some(message => JSON.stringify(message).includes('backend save receipt')), false);
  const medication = { name: 'Fictionalmed', strength: '10 mg', howTaken: 'I take one every morning.', source: 'packaging_shown', verification: 'patient_reported' };
  await f.store.saveMedication({ intakeSessionId: f.issued.intakeSessionId, uid: patient.uid, idempotencyKey, medication });
  const savedEvent = JSON.stringify({ type: 'medicine-ui-state', state: 'saved', receiptId: `medicine-${idempotencyKey}` });
  f.ws.send(savedEvent); f.ws.send(savedEvent);
  await waitFor(() => f.clientContent.some(message => JSON.stringify(message).includes('backend save receipt')));
  const resume = f.clientContent.filter(message => JSON.stringify(message).includes('backend save receipt'));
  assert.equal(resume.length, 1);
  const resumeText = resume[0].turns[0].parts[0].text;
  assert.match(resumeText, /medicine entry is saved/i);
  assert.match(resumeText, /Do not ask them to show, capture, scan, reread, or confirm this medicine again/i);
  assert.match(resumeText, /most recent unanswered ordinary intake question/i);
  assert.doesNotMatch(resumeText, /repeat.*Show Evidence.*instruction/i);
  f.ws.send(savedEvent);
  f.ws.send(JSON.stringify({ type: 'medicine-scan-ready' }));
  f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: 'duplicate-draft', name: 'record_patient_medication_report', args: {} }] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.clientContent.filter(message => JSON.stringify(message).includes('scan result is ready')).length, 1);
  assert.equal(f.clientContent.filter(message => JSON.stringify(message).includes('backend save receipt')).length, 1);
  const persisted = await f.store.getMedication({ intakeSessionId: f.issued.intakeSessionId, uid: patient.uid, patientCaseId: f.identity().patientCaseId });
  assert.equal(persisted.idempotencyKey, idempotencyKey);
  assert.deepEqual(Object.fromEntries(Object.keys(medication).map(key => [key, persisted[key]])), medication);
  assert.equal(f.closeCount(), 0);
  assert.equal(f.realtime.filter(value => value.video || value.image).length, 0);
  assert.equal(medicineLiveTools[0].functionDeclarations.length, 2);
});

test('allowlisted camera states provide queued spoken guidance without becoming patient evidence', async t => {
  const f = await fixture(t);
  f.callbacks().onmessage({ serverContent: { outputTranscription: { text: 'I am still speaking.', finished: false } } });
  f.ws.send(JSON.stringify({ type: 'medicine-ui-state', state: 'camera_ready' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.clientContent.some(message => JSON.stringify(message).includes('Capture label')), false);
  f.callbacks().onmessage({ serverContent: { outputTranscription: { text: 'Done.', finished: true }, turnComplete: true } });
  await waitFor(() => f.clientContent.some(message => JSON.stringify(message).includes('Capture label')));
  const camera = f.clientContent.at(-1).turns[0].parts[0].text;
  assert.match(camera, /NOT PATIENT SPEECH/); assert.match(camera, /current conversation language/); assert.match(camera, /not.*clinical evidence/i);
  f.callbacks().onmessage({ serverContent: { outputTranscription: { text: 'Frame the label.', finished: true }, turnComplete: true } });
  f.ws.send(JSON.stringify({ type: 'medicine-ui-state', state: 'image_captured' }));
  await waitFor(() => f.clientContent.some(message => JSON.stringify(message).includes('Retake photo')));
  assert.equal(f.extractCalls(), 0); assert.equal(f.closeCount(), 0);
  f.ws.send(JSON.stringify({ type: 'medicine-ui-state', state: 'unknown_state' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.ws.readyState, WebSocket.OPEN);
});

test('unclear scans are delivered without guessed fields and Live failure leaves the session connected', async t => {
  const f = await fixture(t);
  await f.store.saveMedicineScanResult({ intakeSessionId: f.issued.intakeSessionId, uid: patient.uid, candidate: { status: 'unclear', name: '', strength: '' } });
  f.ws.send(JSON.stringify({ type: 'medicine-scan-ready' }));
  await waitFor(() => f.clientContent.some(message => JSON.stringify(message).includes('scan result is ready')));
  f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: 'scan-unclear', name: 'receive_medicine_scan_result', args: {} }] } });
  await waitFor(() => f.toolResponses.length === 1);
  const response = f.toolResponses[0].functionResponses[0].response;
  assert.equal(response.status, 'unclear');
  assert.equal('name' in response, false); assert.equal('strength' in response, false);
  f.callbacks().onmessage({ serverContent: { outputTranscription: { text: 'I could not read both details. Please retake the photo.', finished: true }, turnComplete: true } });
  await waitFor(() => f.messages.some(message => message.type === 'medicine-live-status' && message.status === 'unclear'));
  assert.equal(f.ws.readyState, WebSocket.OPEN);
  assert.equal(f.closeCount(), 0);
  assert.equal(f.extractCalls(), 0);
});

test('a Live control failure reports medicine unavailable without closing the audio session', async t => {
  const f = await fixture(t, { clientContentFails: true });
  await f.store.saveMedicineScanResult({ intakeSessionId: f.issued.intakeSessionId, uid: patient.uid,
    candidate: { status: 'identified', name: 'Fictionalmed', strength: '10 mg' } });
  f.ws.send(JSON.stringify({ type: 'medicine-scan-ready' }));
  await waitFor(() => f.messages.some(message => message.type === 'medicine-live-status' && message.status === 'unavailable'));
  assert.equal(f.ws.readyState, WebSocket.OPEN);
  assert.equal(f.closeCount(), 0);
  assert.equal(f.extractCalls(), 0);
});

test('an evidenced emergency red flag interrupts medicine review while non-red-flag medication facts stay filtered', async t => {
  const f = await fixture(t, { extractImpl: ({ utterances }) => ({ updates: [{
    kind: 'redFlag', label: 'severe difficulty breathing', value: null, secondaryValue: null, unit: null, qualitative: null, status: 'confirmed',
    evidenceId: utterances[0].id, quote: utterances[0].text,
  }] }) });
  await f.store.saveMedicineScanResult({ intakeSessionId: f.issued.intakeSessionId, uid: patient.uid,
    candidate: { status: 'identified', name: 'Fictionalmed', strength: '10 mg' } });
  f.ws.send(JSON.stringify({ type: 'medicine-scan-ready' }));
  await waitFor(() => f.clientContent.some(message => JSON.stringify(message).includes('scan result is ready')));
  f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: 'scan-emergency', name: 'receive_medicine_scan_result', args: {} }] } });
  await waitFor(() => f.toolResponses.length === 1);
  f.callbacks().onmessage({ serverContent: { outputTranscription: { text: 'Is that reading correct, and how do you take it?', finished: true }, turnComplete: true } });
  f.callbacks().onmessage({ serverContent: { inputTranscription: { text: 'I have severe difficulty breathing.', finished: true }, turnComplete: true } });
  await waitFor(() => f.messages.some(message => message.type === 'emergency-escalation'));
  assert.equal(f.extractCalls(), 1);
  assert.equal(f.messages.some(message => JSON.stringify(message).includes('Fictionalmed') && message.type === 'intake-update'), false);
});

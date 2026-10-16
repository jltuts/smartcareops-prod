import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { attachLiveRelay } from '../src/live.js';
import { createMemoryLiveSessionStore, LIVE_PROTOCOL } from '../src/live-session.js';

const origin = 'http://localhost:5173';
const patient = { uid: 'patient-facility-live', roles: ['patient'] };
const waitFor = async check => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

async function fixture(t, facilityCoordinator) {
  const store = createMemoryLiveSessionStore();
  const server = createServer((request, response) => { response.writeHead(404); response.end(); });
  const toolResponses = [];
  let callbacks;
  const relay = attachLiveRelay(server, {
    apiKey: 'test-only', origins: [origin], medicationStore: store, facilityCoordinator,
    authorizeUpgrade: input => store.consume(input), extract: async () => ({ updates: [] }),
    connect: async options => {
      callbacks = options.callbacks;
      queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput() {}, sendClientContent() {}, sendToolResponse: value => toolResponses.push(value), close() {} };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const issued = await store.create({ ...patient, origin });
  await store.saveQuestionPlan({ intakeSessionId: issued.intakeSessionId, uid: patient.uid, plan: {
    version: 1, revision: 1, path: 'general', activeQuestionId: 'core.onset', status: 'collecting', emergency: false,
    answers: {
      'core.name': { state: 'answered', patientReportedText: 'JL', utteranceId: 1 },
      'core.main_concern': { state: 'answered', patientReportedText: 'A non-emergency general concern', utteranceId: 2 },
    },
    asked: ['core.name', 'core.main_concern', 'core.onset'], processedUtteranceIds: [1, 2], clarificationCounts: {},
  } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/live`, [LIVE_PROTOCOL, `smartcareops.session.${issued.token}`], { origin });
  const messages = []; ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true }));
  await waitFor(() => messages.some(message => message.type === 'ready'));
  t.after(async () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    for (const client of relay.clients) client.terminate();
    relay.close(); store.close(); await new Promise(resolve => server.close(resolve));
  });
  return { ws, issued, messages, toolResponses, callbacks: () => callbacks };
}

test('Live relays bounded facility options and one idempotent simulated request without ending audio', async t => {
  const calls = [], result = { appointmentRequestId: 'appointment-1', state: 'requested', simulation: true, contacted: false, confirmed: false,
    selection: { hospitalId: 'hospital-a', hospitalName: 'Fictional Hospital', date: '2026-10-01', time: '10:30' },
    receipt: { receiptId: 'SIM-APT-12345678', simulation: true } };
  const coordinator = {
    async lookup(input) { calls.push({ type: 'lookup', input }); return { snapshotId: 'snapshot-1', simulation: true, options: [{ hospitalId: 'hospital-a', hospitalName: 'Fictional Hospital' }] }; },
    async requestAppointment(input) { calls.push({ type: 'request', input }); return result; },
  };
  const f = await fixture(t, coordinator);
  f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: 'lookup-1', name: 'find_non_emergency_facility_options', args: { requiredCapabilities: ['general_emergency'], specialty: 'general_medicine' } }] } });
  await waitFor(() => f.toolResponses.length === 1);
  assert.equal(calls[0].input.patientUid, patient.uid); assert.equal(calls[0].input.intakeSessionId, f.issued.intakeSessionId);
  assert.equal(calls[0].input.maxResults, 2);
  assert(f.messages.some(message => message.type === 'facility-options' && message.result.snapshotId === 'snapshot-1'));
  assert.match(f.toolResponses[0].functionResponses[0].response.boundary, /fictional/i);

  const request = { id: 'request-1', name: 'request_fictional_appointment', args: { snapshotId: 'snapshot-1', hospitalId: 'hospital-a', confirmed: true } };
  f.callbacks().onmessage({ toolCall: { functionCalls: [request] } });
  await waitFor(() => f.toolResponses.length === 2);
  f.callbacks().onmessage({ toolCall: { functionCalls: [{ ...request, id: 'request-duplicate' }] } });
  await waitFor(() => f.toolResponses.length === 3);
  assert.equal(calls[1].input.confirmed, true); assert.equal(calls[1].input.idempotencyKey, calls[2].input.idempotencyKey);
  assert.equal(f.messages.filter(message => message.type === 'appointment-request').length, 2);
  assert.match(f.toolResponses[1].functionResponses[0].response.boundary, /no hospital or doctor was contacted/i);
  assert.equal(f.ws.readyState, WebSocket.OPEN);
});

test('Live rejects stale facility requests without inventing fallback data or closing audio', async t => {
  const coordinator = { async requestAppointment() { const error = new Error('internal detail'); error.code = 'FACILITY_SNAPSHOT_STALE'; throw error; } };
  const f = await fixture(t, coordinator);
  f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: 'stale-1', name: 'request_fictional_appointment', args: { snapshotId: 'old', hospitalId: 'hospital-a', confirmed: true } }] } });
  await waitFor(() => f.toolResponses.length === 1);
  const response = f.toolResponses[0].functionResponses[0].response;
  assert.deepEqual(response, { status: 'rejected', code: 'FACILITY_SNAPSHOT_STALE', instruction: 'State that current fictional facility information is unavailable. Do not substitute or guess.' });
  assert.equal(f.messages.some(message => message.type === 'appointment-request'), false);
  assert.equal(f.ws.readyState, WebSocket.OPEN);
});

test('Live bounds repeated facility lookups within one authenticated intake session', async t => {
  let lookups = 0;
  const coordinator = { async lookup() { lookups++; return { snapshotId: `snapshot-${lookups}`, simulation: true, options: [] }; } };
  const f = await fixture(t, coordinator);
  for (let index = 0; index < 5; index++) {
    f.callbacks().onmessage({ toolCall: { functionCalls: [{ id: `lookup-${index}`, name: 'find_non_emergency_facility_options', args: { requiredCapabilities: ['general_emergency'], specialty: 'general_medicine' } }] } });
    await waitFor(() => f.toolResponses.length === index + 1);
  }
  assert.equal(lookups, 4);
  assert.deepEqual(f.toolResponses[4].functionResponses[0].response, {
    status: 'rejected', code: 'FACILITY_RATE_LIMITED', instruction: 'State that facility lookup is temporarily unavailable. Do not substitute or guess.',
  });
  assert.equal(f.ws.readyState, WebSocket.OPEN);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDirectVoiceCompletionService } from '../src/direct-voice-completion.js';
import { createMemoryLiveSessionStore } from '../src/live-session.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';
import { createApiServer } from '../src/server.js';

const update = (kind, utterance, values = {}) => ({
  kind, label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null,
  evidenceId: utterance.id, quote: utterance.text, ...values,
});

async function fixture() {
  const uid = 'patient-direct-voice', origin = 'http://127.0.0.1:5173';
  const liveSessionStore = createMemoryLiveSessionStore(), caseStore = createMemoryCaseStore();
  const issued = await liveSessionStore.create({ uid, roles: ['patient'], origin, preferredLanguage: 'en' });
  await liveSessionStore.consume({ token: issued.token, origin, path: '/api/live' });
  let extractionCalls = 0;
  const extract = async ({ utterances }) => {
    extractionCalls++;
    return { updates: utterances.flatMap(utterance => {
      if (/emergency/i.test(utterance.text) || /can't breathe/i.test(utterance.text)) return [
        update('redFlag', utterance, { label: 'severe difficulty breathing', status: 'confirmed' }),
      ];
      if (/call you/i.test(utterance.question)) return [update('name', utterance, { value: utterance.text })];
      if (/concern/i.test(utterance.question)) return [update('symptom', utterance, { label: 'dizzy', status: 'confirmed' })];
      if (/when did/i.test(utterance.question)) return [update('onset', utterance, { value: utterance.text })];
      if (/how severe/i.test(utterance.question)) return [update('note', utterance, { value: utterance.text })];
      if (/new, recurring/i.test(utterance.question)) return [update('note', utterance, { value: utterance.text })];
      return [];
    }) };
  };
  const persist = (intake, context, emergency) => caseStore.createCase({
    caseId: context.caseId, intake, emergency, patientUid: context.patientUid, fictionalConfirmed: context.fictionalConfirmed,
    submittedForReview: !emergency, intakeSource: 'live_intake', enrichmentStatus: 'succeeded',
  });
  const service = createDirectVoiceCompletionService({ liveSessionStore, caseStore, extract, persist });
  return { uid, issued, liveSessionStore, caseStore, service, extractionCalls: () => extractionCalls };
}

test('completed direct voice intake stores patient evidence once under the preassigned case', async () => {
  const f = await fixture();
  const turns = [
    { role: 'Gemini', text: 'Hello, this is SmartCareOps. What would you like me to call you?' },
    { role: 'Patient', text: 'Louis' },
    { role: 'Gemini', text: 'What is your concern?' },
    { role: 'Patient', text: 'I feel dizzy.' },
    { role: 'Gemini', text: 'When did this start or last change?' },
    { role: 'Patient', text: 'Yesterday.' },
    { role: 'Gemini', text: 'How severe is it from 1 to 10, with 10 being the most severe?' },
    { role: 'Patient', text: 'Five out of ten.' },
    { role: 'Gemini', text: 'Is this new, recurring, or related to a condition you already know about?' },
    { role: 'Patient', text: 'It is new.' },
    { role: 'Gemini', text: 'I got all the information I need for this intake. Is there anything else you want to say?' },
    { role: 'Patient', text: 'No, nothing else.' },
  ];
  const first = await f.service.complete({ uid: f.uid, intakeSessionId: f.issued.intakeSessionId, idempotencyKey: crypto.randomUUID(), turns, outcome: 'completed', resetGeneration: 0 });
  const replay = await f.service.complete({ uid: f.uid, intakeSessionId: f.issued.intakeSessionId, idempotencyKey: crypto.randomUUID(), turns, outcome: 'completed', resetGeneration: 0 });
  assert.equal(first.patientCase.caseId, replay.patientCase.caseId);
  assert.equal(first.patientCase.caseId, (await f.liveSessionStore.resolveActive({ intakeSessionId: f.issued.intakeSessionId, uid: f.uid })).patientCaseId);
  assert.equal(f.extractionCalls(), 1);
  assert.equal(first.patientCase.patient.name, 'Louis');
  assert.equal(first.patientCase.reportedFacts.symptoms[0].patientReportedText, 'I feel dizzy.');
  assert.equal(first.patientCase.reportedFacts.onset.patientReportedText, 'Yesterday.');
  assert.equal(first.patientCase.reportedFacts.additionalNotes.includes('Five out of ten.'), true);
  assert.equal(first.patientCase.reportedFacts.additionalNotes.includes('No, nothing else.'), false);
  assert.equal(Object.hasOwn(first.patientCase.reportedFacts, 'diagnosis'), false);
  assert.equal((await f.caseStore.listPatientCases({ patientUid: f.uid })).cases.length, 1);
});

test('emergency direct voice intake saves only when the transcript validates a supported red flag', async () => {
  const f = await fixture();
  const result = await f.service.complete({
    uid: f.uid, intakeSessionId: f.issued.intakeSessionId, idempotencyKey: crypto.randomUUID(), outcome: 'emergency', resetGeneration: 0,
    turns: [
      { role: 'Gemini', text: 'What is your concern?' },
      { role: 'Patient', text: "I need an emergency. I can't breathe." },
    ],
  });
  assert.equal(result.status, 'EMERGENCY_ESCALATED');
  assert.equal(result.patientCase.workflowStatus, 'emergency_pending_dispatcher');
  assert.equal(result.patientCase.emergency.reasonCode, 'severe_breathing_red_flag');
});

test('emergency save deterministically preserves an explicit red flag when Gemini extraction omits it', async () => {
  const liveSessionStore = createMemoryLiveSessionStore(), caseStore = createMemoryCaseStore();
  const uid = 'patient-emergency-fallback', origin = 'http://127.0.0.1:5173';
  const issued = await liveSessionStore.create({ uid, roles: ['patient'], origin, preferredLanguage: 'en' });
  await liveSessionStore.consume({ token: issued.token, origin, path: '/api/live' });
  const service = createDirectVoiceCompletionService({
    liveSessionStore,
    caseStore,
    extract: async () => ({ updates: [] }),
    persist: (intake, context, emergency) => caseStore.createCase({
      caseId: context.caseId, intake, emergency, patientUid: context.patientUid,
      fictionalConfirmed: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded',
    }),
  });
  const result = await service.complete({
    uid, intakeSessionId: issued.intakeSessionId, idempotencyKey: crypto.randomUUID(), outcome: 'emergency', resetGeneration: 0,
    turns: [
      { role: 'Gemini', text: 'What is your concern?' },
      { role: 'Patient', text: "I need an emergency. I can't breathe." },
    ],
  });
  assert.equal(result.status, 'EMERGENCY_ESCALATED');
  assert.deepEqual(result.patientCase.reportedFacts.redFlags.map(flag => flag.type).sort(), [
    'patient requested emergency assistance',
    'severe difficulty breathing',
  ]);
});

test('emergency save still rejects ordinary symptoms without an explicit supported red flag', async () => {
  const f = await fixture();
  await assert.rejects(f.service.complete({
    uid: f.uid, intakeSessionId: f.issued.intakeSessionId, idempotencyKey: crypto.randomUUID(), outcome: 'emergency', resetGeneration: 0,
    turns: [
      { role: 'Gemini', text: 'What is your concern?' },
      { role: 'Patient', text: 'I feel dizzy.' },
    ],
  }), error => error?.code === 'EMERGENCY_EVIDENCE_UNAVAILABLE');
});

test('local direct Live session can save through the authenticated HTTP completion route', async t => {
  const liveSessionStore = createMemoryLiveSessionStore(), caseStore = createMemoryCaseStore();
  const api = createApiServer({
    liveSessionStore,
    liveSessionEnabled: true,
    liveSessionOptions: { createEphemeralToken: async () => ({ token: 'auth_tokens/test', model: 'gemini-3.8-live', expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    caseStore,
    chatExtractor: async ({ utterances }) => ({ updates: utterances.flatMap(utterance => {
      if (/call you/i.test(utterance.question)) return [update('name', utterance, { value: utterance.text })];
      if (/concern/i.test(utterance.question)) return [update('symptom', utterance, { label: 'dizzy', status: 'confirmed' })];
      if (/when did/i.test(utterance.question)) return [update('onset', utterance, { value: utterance.text })];
      return [];
    }) }),
    authOptions: { env: { NODE_ENV: 'development' }, userProfileStore: createMemoryUserProfileStore() },
  });
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const headers = { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  const started = await fetch(base + '/api/live/session', { method: 'POST', headers, body: '{}' });
  assert.equal(started.status, 201);
  const session = await started.json();
  const completed = await fetch(base + '/api/intake/voice/complete', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ intakeSessionId: session.intakeSessionId, outcome: 'completed', turns: [
      { role: 'Gemini', text: 'Hello, this is SmartCareOps. What would you like me to call you?' },
      { role: 'Patient', text: 'Louis' },
      { role: 'Gemini', text: 'What is your concern?' },
      { role: 'Patient', text: 'I feel dizzy.' },
      { role: 'Gemini', text: 'When did this start or last change?' },
      { role: 'Patient', text: 'Yesterday.' },
      { role: 'Gemini', text: 'I got all the information I need for this intake. Is there anything else you want to say?' },
      { role: 'Patient', text: 'No, nothing else.' },
    ] }),
  });
  assert.equal(completed.status, 200);
  const result = await completed.json();
  assert.match(result.patientCase.caseId, /^SC-[0-9a-f-]{36}$/);
  assert.equal((await caseStore.listPatientCases({ patientUid: 'local-development-patient' })).cases.length, 1);
});

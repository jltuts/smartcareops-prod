import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createMemoryLiveSessionStore } from '../src/live-session.js';
import { createMemoryChatIntakeStore } from '../src/chat-intake/store.js';
import { createChatIntakeService } from '../src/chat-intake/service.js';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';

function patchFor({ utterances }) {
  const [{ id, text, question }] = utterances;
  const blank = { label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: id, quote: text };
  if (/^(?:i don't know|skip)$/i.test(text)) return { updates: [] };
  if (/name would you like/i.test(question)) return { updates: [{ ...blank, kind: 'name', value: text }] };
  if (/feeling today/i.test(question)) {
    const label = /shoulder/i.test(text) ? 'shoulder pain' : 'unwell';
    return { updates: [{ ...blank, kind: 'symptom', label, status: 'confirmed' }] };
  }
  if (/when did/i.test(question)) return { updates: [{ ...blank, kind: 'onset', value: text }] };
  if (/anything else/i.test(question) && !/^no/i.test(text)) return { updates: [{ ...blank, kind: 'note', value: text }] };
  return { updates: [] };
}

function fixture(overrides = {}) {
  const liveSessionStore = createMemoryLiveSessionStore(), store = createMemoryChatIntakeStore();
  let completed = 0, emergencies = 0, emergencyLookups = 0, facilityLookups = 0;
  const service = createChatIntakeService({ store, liveSessionStore, extract: async input => patchFor(input),
    onComplete: async (_intake, context) => { completed++; return { patientCase: { caseId: context.caseId, workflowStatus: 'submitted_for_clinical_review', routing: { specialty: 'family_medicine' } }, finalizationId: '11111111-1111-4111-8111-111111111111' }; },
    onEmergency: async (_intake, context) => { emergencies++; return { patientCase: { caseId: context.caseId, workflowStatus: 'pending_dispatcher' }, finalizationId: '22222222-2222-4222-8222-222222222222' }; },
    facilityCoordinator: {
      async lookup() { facilityLookups++; return { options: [{ hospitalName: 'North Valley Medical Center (fictional)', specialty: 'neurology', specialistAvailable: true, distanceMeters: 2300, nextAvailableMinutes: 30 }] }; },
      async lookupEmergency() { emergencyLookups++; return { options: [{ hospitalName: 'Northstar General', distanceMeters: 2300, capacity: { emergencyBedsAvailable: 38 } }] }; },
    },
    ...overrides });
  const start = () => service.start({ uid: 'patient-1', origin: 'https://example.test', resetGeneration: 0 });
  const send = (session, message, key = crypto.randomUUID()) => service.submit({ sessionId: session.sessionId, uid: 'patient-1', idempotencyKey: key, expectedRevision: session.revision, message });
  return { service, start, send, counts: () => ({ completed, emergencies, emergencyLookups, facilityLookups }) };
}

test('typed intake asks only backend questions, routes a shoulder concern, and resumes by owner', async () => {
  const f = fixture(), opened = await f.start();
  assert.equal(opened.question, 'What name would you like me to use?');
  const named = await f.send(opened, 'Louis');
  assert.equal(named.question, 'What are you feeling today?');
  assert.match(named.messages.at(-1).text, /Thank you, Louis/);
  const concern = await f.send(named, 'I have left shoulder pain');
  assert.equal(concern.progress.path, 'musculoskeletal_shoulder');
  assert.equal(concern.question, 'What visible swelling or change in shape have you noticed?');
  const restored = await f.service.get({ sessionId: concern.sessionId, uid: 'patient-1' });
  assert.equal(restored.revision, concern.revision);
  await assert.rejects(f.service.get({ sessionId: concern.sessionId, uid: 'other-patient' }), error => error.code === 'CHAT_SESSION_NOT_FOUND');
});

test('routine typed answers use the deterministic fast path without waiting for Gemini extraction', async () => {
  let extractionCalls = 0;
  const f = fixture({ extract: async () => { extractionCalls++; throw new Error('Gemini extraction should not run'); } });
  let state = await f.start();
  state = await f.send(state, 'Louis');
  state = await f.send(state, 'I have left shoulder pain');
  state = await f.send(state, 'No visible swelling');
  state = await f.send(state, 'No changes in feeling or strength');
  state = await f.send(state, 'It started after lifting luggage');
  state = await f.send(state, 'I cannot raise my arm');
  state = await f.send(state, 'Three days ago');
  state = await f.send(state, 'Seven out of ten');
  state = await f.send(state, 'This is new');
  assert.equal(state.question, "Is there anything else you'd like to add before we finish?");
  assert.equal(extractionCalls, 0);
  assert.equal(state.intake.patient.name, 'Louis');
  assert.equal(state.intake.symptoms[0].patientReportedText, 'I have left shoulder pain');
  assert.equal(state.intake.onset.value, 'Three days ago');
});

test('typed severity accepts a standalone rating from 1 to 10 and advances once', async () => {
  let extractionCalls = 0;
  const f = fixture({ extract: async () => { extractionCalls++; throw new Error('Gemini extraction should not run'); } });
  let state = await f.start();
  for (const answer of ['Louis', 'I feel dizzy', 'Yesterday']) state = await f.send(state, answer);
  assert.equal(state.question, 'How severe is it from 1 to 10, with 10 being the most severe?');
  state = await f.send(state, '6');
  assert.equal(state.question, 'Is this new, recurring, or related to a condition you already know about?');
  assert.equal(state.messages.at(-2).text, '6');
  assert.equal(extractionCalls, 0);
});

for (const rating of ['0', '11']) {
  test(`typed severity rejects the out-of-range standalone rating ${rating}`, async () => {
    const f = fixture(); let state = await f.start();
    for (const answer of ['Louis', 'I feel dizzy', 'Yesterday']) state = await f.send(state, answer);
    const clarified = await f.send(state, rating);
    assert.equal(clarified.question, state.question);
    assert.match(clarified.messages.at(-1).text, /didn't understand/i);
  });
}

test('typed chat retains Gemini as a bounded fallback for an answer outside deterministic limits', async () => {
  let extractionCalls = 0;
  const f = fixture({ extract: async input => { extractionCalls++; return patchFor(input); } });
  const opened = await f.start();
  const longName = `Louis ${'A'.repeat(80)}`;
  const named = await f.send(opened, longName);
  assert.equal(extractionCalls, 1);
  assert.equal(named.intake.patient.name, longName);
  assert.equal(named.question, 'What are you feeling today?');
});

test('typed emergency stops routine questions, returns demo hospital information, and persists once', async () => {
  const f = fixture(), opened = await f.start();
  const named = await f.send(opened, 'Louis');
  const emergency = await f.send(named, "I can't breathe");
  assert.equal(emergency.status, 'emergency');
  assert.equal(emergency.question, null);
  assert.match(emergency.messages.at(-3).text, /urgent attention/);
  assert.match(emergency.messages.at(-2).text, /Northstar General/);
  assert.match(emergency.messages.at(-2).text, /simulated emergency department shows 38 available beds/);
  assert.equal(emergency.messages.at(-1).text, 'Your emergency case has been sent to the SmartCareOps command center for dispatcher review. No ambulance or hospital referral has been confirmed.');
  assert.deepEqual(f.counts(), { completed: 0, emergencies: 1, emergencyLookups: 1, facilityLookups: 0 });
  await assert.rejects(f.send(emergency, 'Another answer'), error => error.code === 'CHAT_SESSION_COMPLETE');
});

for (const [message, expectedFlag] of [["I can't breath", 'severe difficulty breathing'], ["I need an emergency. I fell on the floor and can't get up.", 'patient requested emergency assistance']]) {
  test(`typed emergency wording is preserved and escalated: ${message}`, async () => {
    let extractionCalls = 0;
    const f = fixture({ extract: async () => { extractionCalls++; throw new Error('Gemini extraction should not run'); } });
    const opened = await f.start(), named = await f.send(opened, 'Louis');
    const emergency = await f.send(named, message);
    assert.equal(emergency.status, 'emergency');
    assert.equal(emergency.question, null);
    assert.equal(extractionCalls, 0);
    assert.equal(emergency.intake.redFlags.some(flag => flag.type === expectedFlag && flag.status === 'confirmed'), true);
    assert.match(emergency.messages.at(-1).text, /dispatcher review/);
    assert.deepEqual(f.counts(), { completed: 0, emergencies: 1, emergencyLookups: 1, facilityLookups: 0 });
  });
}

test('uncertain misspelled breathing wording asks the controlled severe-breathing question', async () => {
  let extractionCalls = 0;
  const f = fixture({ extract: async () => { extractionCalls++; throw new Error('Gemini extraction should not run'); } });
  const opened = await f.start(), named = await f.send(opened, 'Louis');
  const state = await f.send(named, "I think I can't breath");
  assert.equal(state.status, 'collecting');
  assert.equal(state.question, 'Is the breathing difficulty severe right now?');
  assert.equal(state.intake.redFlags.find(flag => flag.type === 'severe difficulty breathing')?.status, 'unclear');
  assert.equal(extractionCalls, 0);
});

test('a focused severe-breathing confirmation reaches emergency without Gemini extraction', async () => {
  let extractionCalls = 0;
  const f = fixture({ extract: async () => { extractionCalls++; throw new Error('Gemini extraction should not run'); } });
  const opened = await f.start();
  const named = await f.send(opened, 'Louis');
  const concern = await f.send(named, 'I have difficulty breathing');
  assert.equal(concern.question, 'Is the breathing difficulty severe right now?');
  const emergency = await f.send(concern, 'Yes');
  assert.equal(emergency.status, 'emergency');
  assert.equal(extractionCalls, 0);
  assert.match(emergency.messages.at(-2).text, /Northstar General/);
  assert.match(emergency.messages.at(-1).text, /sent to the SmartCareOps command center for dispatcher review/);
});

test('typed intake completes exactly once and replays an identical idempotent request', async () => {
  const f = fixture(); let state = await f.start();
  for (const answer of ['Louis', 'I feel unwell', 'Yesterday', 'Moderate', 'It is new']) state = await f.send(state, answer);
  assert.equal(state.question, "Is there anything else you'd like to add before we finish?");
  const key = crypto.randomUUID(), completed = await f.send(state, 'Nothing else', key);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.patientCase.routing.specialty, 'family_medicine');
  assert.equal(f.counts().completed, 1);
  const replayed = await f.service.submit({ sessionId: state.sessionId, uid: 'patient-1', idempotencyKey: key, expectedRevision: state.revision, message: 'Nothing else' });
  assert.deepEqual(replayed, completed);
  assert.equal(f.counts().completed, 1);
});

test('closing doctor-availability request uses confirmed routing facts and keeps final confirmation unanswered', async () => {
  const lookupInputs = [];
  const f = fixture({ facilityCoordinator: {
    async lookup(input) { lookupInputs.push(input); return { options: [{ hospitalName: 'North Valley Medical Center (fictional)', specialty: 'neurology', specialistAvailable: true, distanceMeters: 2300, nextAvailableMinutes: 30 }] }; },
    async lookupEmergency() { throw new Error('Emergency lookup should not run'); },
  } });
  let state = await f.start();
  for (const answer of ['Louis', 'I feel dizzy', 'Yesterday', '6', 'It is new']) state = await f.send(state, answer);
  const closingQuestion = state.question;
  const availability = await f.send(state, "Can you check if there's a doctor available near me?");
  assert.equal(availability.status, 'collecting');
  assert.equal(availability.question, closingQuestion);
  assert.equal(availability.progress.answered, state.progress.answered);
  assert.equal(lookupInputs.length, 1);
  assert.deepEqual({ requiredCapabilities: lookupInputs[0].requiredCapabilities, specialty: lookupInputs[0].specialty, maxResults: lookupInputs[0].maxResults },
    { requiredCapabilities: ['neurology'], specialty: 'neurology', maxResults: 2 });
  assert.match(availability.messages.at(-1).text, /North Valley Medical Center/);
  assert.match(availability.messages.at(-1).text, /2\.3 km/);
  assert.match(availability.messages.at(-1).text, /not live hospital-verified availability or a confirmed referral/);
  assert.match(availability.messages.at(-1).text, /anything else/i);
  const completed = await f.send(availability, "No, that's all.");
  assert.equal(completed.status, 'completed');
  assert.equal(f.counts().completed, 1);
});

test('closing doctor-availability request reports unavailable data without inventing an option', async () => {
  const f = fixture({ facilityCoordinator: {
    async lookup() { throw new Error('Unavailable'); },
    async lookupEmergency() { throw new Error('Emergency lookup should not run'); },
  } });
  let state = await f.start();
  for (const answer of ['Louis', 'I feel dizzy', 'Yesterday', '6', 'It is new']) state = await f.send(state, answer);
  const availability = await f.send(state, 'Can you find a physician available nearby?');
  assert.equal(availability.status, 'collecting');
  assert.equal(availability.question, state.question);
  assert.match(availability.messages.at(-1).text, /fictional facility information is unavailable/i);
  assert.doesNotMatch(availability.messages.at(-1).text, /North Valley|Northstar|Regional Medical/);
});

test('closing medicine-camera request directs the existing evidence flow and keeps final confirmation unanswered', async () => {
  const f = fixture();
  let state = await f.start();
  for (const answer of ['Louis', 'I feel dizzy', 'Yesterday', '6', 'It is new']) state = await f.send(state, answer);
  const closingQuestion = state.question;
  const guidance = await f.send(state, 'I have a medicine to show you.');
  assert.equal(guidance.status, 'collecting');
  assert.equal(guidance.question, closingQuestion);
  assert.equal(guidance.progress.answered, state.progress.answered);
  assert.match(guidance.messages.at(-1).text, /What would you like to submit as clinical photo/i);
  assert.match(guidance.messages.at(-1).text, /select Medicine package/i);
  assert.match(guidance.messages.at(-1).text, /choose Use camera[\s\S]+hold the medicine package in view[\s\S]+choose Capture photo[\s\S]+choose Use this photo[\s\S]+read the printed label automatically/i);
  assert.match(guidance.messages.at(-1).text, /choose Upload photo[\s\S]+select a clear photo[\s\S]+choose Read medicine package/i);
  assert.doesNotMatch(guidance.messages.at(-1).text, /enable your camera|Choose evidence|Show Evidence/i);
  assert.match(guidance.messages.at(-1).text, /Nothing is saved until you confirm it/i);
  assert.doesNotMatch(guidance.messages.at(-1).text, /diagnos|dose change|recommend/i);
  const completed = await f.send(guidance, 'No, nothing else.');
  assert.equal(completed.status, 'completed');
  assert.equal(f.counts().completed, 1);
});

test('a medication fact without a request to show packaging does not enter the camera flow', async () => {
  const f = fixture();
  let state = await f.start();
  for (const answer of ['Louis', 'I feel dizzy', 'Yesterday', '6', 'It is new']) state = await f.send(state, answer);
  const additional = await f.send(state, 'I take a medicine every morning.');
  assert.equal(additional.status, 'collecting');
  assert.doesNotMatch(additional.messages.at(-1).text, /select Medicine package|Show Evidence|enable your camera/i);
});

for (const finalAnswer of ['nothing', 'none', 'No, nothing at all. Thank you.']) {
  test(`typed intake completes after the final answer ${finalAnswer}`, async () => {
    const f = fixture(); let state = await f.start();
    for (const answer of ['Louis', 'I feel unwell', 'Today', 'Moderate', 'It is new']) state = await f.send(state, answer);
    const completed = await f.send(state, finalAnswer);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.question, null);
    assert.equal(completed.messages.filter(item => /anything else/i.test(item.text)).length, 1);
    assert.equal(f.counts().completed, 1);
  });
}

test('typed intake rejects stale revisions and preserves the current question', async () => {
  const f = fixture(), opened = await f.start(), named = await f.send(opened, 'Louis');
  await assert.rejects(f.service.submit({ sessionId: named.sessionId, uid: 'patient-1', idempotencyKey: crypto.randomUUID(), expectedRevision: 0, message: 'I feel unwell' }), error => error.code === 'CHAT_SESSION_STALE');
  const restored = await f.service.get({ sessionId: named.sessionId, uid: 'patient-1' });
  assert.equal(restored.question, 'What are you feeling today?');
});

test('typed intake bounds rapid answer attempts per active session', async () => {
  const store = createMemoryChatIntakeStore({ now: () => 1000 });
  const sessionId = 'b'.repeat(64), base = { sessionId, uid: 'patient-1', revision: 0, status: 'collecting', expiresAt: 10_000 };
  await store.create(base);
  for (let index = 0; index < 30; index++) {
    const idempotencyKey = crypto.randomUUID();
    await store.begin({ sessionId, uid: 'patient-1', idempotencyKey, expectedRevision: 0, message: `Attempt ${index}` });
    await store.abort({ sessionId, uid: 'patient-1', idempotencyKey });
  }
  await assert.rejects(store.begin({ sessionId, uid: 'patient-1', idempotencyKey: crypto.randomUUID(), expectedRevision: 0, message: 'One too many' }), error => error.code === 'CHAT_RATE_LIMITED' && error.status === 429);
});

test('typed intake clarifies confusion and accepts an explicit unknown without inventing a fact', async () => {
  const f = fixture(), opened = await f.start();
  const clarified = await f.send(opened, 'What?');
  assert.equal(clarified.question, opened.question);
  assert.match(clarified.messages.at(-1).text, /didn't understand/i);
  const named = await f.send(clarified, 'Louis');
  const unknown = await f.send(named, "I don't know");
  assert.notEqual(unknown.question, named.question);
  assert.equal(unknown.intake.symptoms.length, 0);
});

test('chat HTTP routes require an authenticated Patient and exact allowed Origin', async t => {
  const liveSessionStore = createMemoryLiveSessionStore(), chatIntakeStore = createMemoryChatIntakeStore();
  const api = createApiServer({ caseStore: createMemoryCaseStore(), liveSessionStore, chatIntakeStore, chatExtractor: async input => patchFor(input),
    authOptions: { env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_PATIENT_UIDS: 'patient-1' },
      userProfileStore: createMemoryUserProfileStore(new Map(), { patientAccessMode: 'open' }), verifyToken: async token => {
        if (token !== 'valid-token') throw new Error('invalid');
        return { uid: 'patient-1', email: 'patient@example.invalid', firebase: { sign_in_provider: 'google.com' } };
      } },
    liveOptions: { apiKey: 'fake', connect: async () => ({ sendRealtimeInput() {}, close() {} }) } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const endpoint = `http://127.0.0.1:${api.server.address().port}/api/intake/chat/session`;
  const headers = { Origin: 'http://localhost:5173', Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
  const opened = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
  assert.equal(opened.status, 201);
  const session = await opened.json(); assert.match(session.sessionId, /^[a-f0-9]{64}$/); assert.equal(session.question, 'What name would you like me to use?');
  const evidence = await fetch(`http://127.0.0.1:${api.server.address().port}/api/intake/evidence/share`, { method: 'POST', headers, body: JSON.stringify({
    intakeSessionId: session.sessionId, evidenceId: '11111111-1111-4111-8111-111111111111', kind: 'body_area',
    patientDescription: 'Pain on the outer part of my left shoulder.', mimeType: 'image/jpeg', imageBase64: '/9j/2Q==',
  }) });
  assert.equal(evidence.status, 201); assert.equal((await evidence.json()).evidence.kind, 'body_area');
  const restored = await fetch(endpoint, { headers: { Origin: 'http://localhost:5173', Authorization: 'Bearer valid-token', 'X-SmartCareOps-Chat-Session-Id': session.sessionId } });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).revision, 0);
});

test('voice-direct orchestration initializes the questionnaire on its authenticated active intake', async t => {
  const liveSessionStore = createMemoryLiveSessionStore(), chatIntakeStore = createMemoryChatIntakeStore();
  const issued = await liveSessionStore.create({ uid: 'patient-1', roles: ['patient'], origin: 'http://localhost:5173' });
  const active = await liveSessionStore.consume({ token: issued.token, origin: 'http://localhost:5173' });
  const api = createApiServer({ caseStore: createMemoryCaseStore(), liveSessionStore, chatIntakeStore, chatExtractor: async input => patchFor(input),
    authOptions: { env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_PATIENT_UIDS: 'patient-1' },
      userProfileStore: createMemoryUserProfileStore(new Map(), { patientAccessMode: 'open' }), verifyToken: async () => ({ uid: 'patient-1', email: 'patient@example.invalid', firebase: { sign_in_provider: 'google.com' } }) },
    liveOptions: { apiKey: 'fake', connect: async () => ({ sendRealtimeInput() {}, close() {} }) } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const response = await fetch(`http://127.0.0.1:${api.server.address().port}/api/intake/chat/session`, { method: 'POST', headers: {
    Origin: 'http://localhost:5173', Authorization: 'Bearer valid-token', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ intakeSessionId: active.intakeSessionId }) });
  assert.equal(response.status, 201);
  const opened = await response.json();
  assert.equal(opened.sessionId, active.intakeSessionId);
  assert.equal(opened.question, 'What name would you like me to use?');
});

test('voice-direct keeps the concern question active when speech transcription has no clinical meaning', async t => {
  const liveSessionStore = createMemoryLiveSessionStore(), chatIntakeStore = createMemoryChatIntakeStore();
  const issued = await liveSessionStore.create({ uid: 'patient-1', roles: ['patient'], origin: 'http://localhost:5173' });
  const active = await liveSessionStore.consume({ token: issued.token, origin: 'http://localhost:5173' });
  const service = createChatIntakeService({ store: chatIntakeStore, liveSessionStore,
    extract: async ({ utterances }) => utterances[0].text === 'dice' ? { updates: [] } : patchFor({ utterances }),
    onComplete: async () => null, onEmergency: async () => null });
  let state = await service.start({ uid: 'patient-1', origin: 'http://localhost:5173', intakeSessionId: active.intakeSessionId });
  state = await service.submit({ sessionId: state.sessionId, uid: 'patient-1', idempotencyKey: crypto.randomUUID(), expectedRevision: state.revision, message: 'Louis' });
  assert.equal(state.question, 'What are you feeling today?');
  state = await service.submit({ sessionId: state.sessionId, uid: 'patient-1', idempotencyKey: crypto.randomUUID(), expectedRevision: state.revision, message: 'dice' });
  assert.equal(state.question, 'What are you feeling today?');
  assert.equal(state.messages.at(-1).text, "Can you please say that again? I didn't catch that.");
  assert.equal(state.intake.symptoms.length, 0);
  const understood = await service.submit({ sessionId: state.sessionId, uid: 'patient-1', idempotencyKey: crypto.randomUUID(), expectedRevision: state.revision, message: 'I feel dizzy' });
  assert.equal(understood.question, 'When did this start, or when did it last change?');
  assert.equal(understood.intake.symptoms[0].patientReportedText, 'I feel dizzy');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createLiveSessionLimiter, createMemoryLiveSessionStore, LIVE_PROTOCOL } from '../src/live-session.js';
import { browserSignalsAccept, createOriginPolicy } from '../src/origin.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';

const origin = 'http://localhost:5173';
const identity = { uid: 'patient-uid', email: 'patient@example.invalid', firebase: { sign_in_provider: 'google.com' } };

async function setup(t, { patient = true, now, livePublicOnly = false, liveSessionOptions = {}, liveOptions = {}, adminResetControl } = {}) {
  const store = createMemoryLiveSessionStore({ ...(now ? { now } : {}) });
  const api = createApiServer({
    caseStore: createMemoryCaseStore(), liveSessionStore: store, liveSessionEnabled: true,
    liveWebSocketUrl: 'wss://live.example.invalid/api/live', livePublicOnly, adminResetControl,
    authOptions: { env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_PATIENT_UIDS: patient ? identity.uid : '' },
      userProfileStore: createMemoryUserProfileStore(new Map(), { patientAccessMode: 'open' }), verifyToken: async token => {
      if (token !== 'firebase-token') throw new Error('invalid'); return identity;
    } },
    liveSessionOptions,
    liveOptions: { apiKey: 'fake', connect: async () => ({ sendRealtimeInput() {}, close() {} }), ...liveOptions },
  });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  return { api, store, base: `http://127.0.0.1:${api.server.address().port}` };
}

const post = (base, headers = {}, body) => fetch(base + '/api/live/session', { method: 'POST', headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('bootstrap requires Firebase authentication and auto-provisions verified Google users as Patients', async t => {
  const allowed = await setup(t);
  assert.equal((await post(allowed.base)).status, 401);
  assert.equal((await post(allowed.base, { Authorization: 'Bearer invalid' })).status, 401);
  const newlyAuthenticated = await setup(t, { patient: false });
  assert.equal((await post(newlyAuthenticated.base, { Authorization: 'Bearer firebase-token' })).status, 201);
});

test('Patient bootstrap returns only a short-lived opaque session and binds exact origin', async t => {
  const { base } = await setup(t);
  const response = await post(base, { Authorization: 'Bearer firebase-token' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.webSocketUrl, 'wss://live.example.invalid/api/live');
  assert(Date.parse(body.expiresAt) > Date.now());
  assert(!JSON.stringify(body).includes('firebase-token'));
  assert.equal((await post(base, { Origin: 'https://evil.invalid', Authorization: 'Bearer firebase-token' })).status, 403);
});

test('direct Patient bootstrap activates one intake and returns only a constrained ephemeral Gemini token', async t => {
  const createEphemeralToken = async () => ({ token: 'auth_tokens/direct-test-token', model: 'gemini-3.8-live', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  const { base, store } = await setup(t, { liveSessionOptions: { createEphemeralToken } });
  const response = await post(base, { Authorization: 'Bearer firebase-token' }, { preferredLanguage: 'en' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.geminiToken, 'auth_tokens/direct-test-token');
  assert.equal(body.model, 'gemini-3.8-live');
  assert.equal(body.webSocketUrl, undefined);
  assert.equal(body.token, undefined);
  assert.equal((await store.resolveActive({ intakeSessionId: body.intakeSessionId, uid: identity.uid })).uid, identity.uid);
});

test('local development gives direct Patient orchestration a scoped local Patient identity', async t => {
  const liveSessionStore = createMemoryLiveSessionStore();
  const api = createApiServer({ caseStore: createMemoryCaseStore(), liveSessionStore, liveSessionEnabled: true,
    liveSessionOptions: { createEphemeralToken: async () => ({ token: 'auth_tokens/local-test-token', model: 'gemini-3.8-live', expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
    authOptions: { env: { NODE_ENV: 'development' } }, liveOptions: { connect: async () => ({ sendRealtimeInput() {}, close() {} }) } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const issued = await fetch(base + '/api/live/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Mode': 'cors' }, body: '{}' });
  assert.equal(issued.status, 201);
  const bootstrap = await issued.json();
  const started = await fetch(base + '/api/intake/chat/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ intakeSessionId: bootstrap.intakeSessionId }) });
  assert.equal(started.status, 201);
  assert.equal((await started.json()).sessionId, bootstrap.intakeSessionId);
});

test('selected supported language is validated, returned and bound to the one-time authenticated session', async t => {
  const { base, store } = await setup(t, { liveSessionOptions: { limiter: createLiveSessionLimiter({ perUid: 20, perOrigin: 20, outstandingPerUid: 20 }) } });
  const headers = { Authorization: 'Bearer firebase-token' };
  const defaultResponse = await post(base, headers);
  assert.equal(defaultResponse.status, 201);
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultBody.preferredLanguage, 'en');
  assert.equal((await store.consume({ token: defaultBody.token, origin })).preferredLanguage, 'en');

  const selectedResponse = await post(base, headers, { preferredLanguage: 'fil' });
  assert.equal(selectedResponse.status, 201);
  const selectedBody = await selectedResponse.json();
  assert.equal(selectedBody.preferredLanguage, 'fil');
  assert.equal((await store.consume({ token: selectedBody.token, origin })).preferredLanguage, 'fil');
  assert.equal((await post(base, headers, { preferredLanguage: 'xx' })).status, 400);
  assert.equal((await post(base, headers, { preferredLanguage: 'fil', patientCaseId: 'client-controlled' })).status, 400);
});

test('Live bootstrap binds the persistent reset generation and rejects sessions while purge is active', async t => {
  let state = { status: 'idle', generation: 7 };
  const control = { async getResetState() { return state; }, async canWrite(generation) { return state.status === 'idle' && generation === state.generation; }, async close() {} };
  const { base, store } = await setup(t, { adminResetControl: control,
    liveSessionOptions: { limiter: createLiveSessionLimiter({ perUid: 20, perOrigin: 20, outstandingPerUid: 20 }) } });
  const response = await post(base, { Authorization: 'Bearer firebase-token' });
  assert.equal(response.status, 201);
  const body = await response.json(), identity = await store.consume({ token: body.token, origin });
  assert.equal(identity.resetGeneration, 7);
  state = { status: 'purging', generation: 8 };
  const blocked = await post(base, { Authorization: 'Bearer firebase-token' });
  assert.equal(blocked.status, 503); assert.equal((await blocked.json()).code, 'PURGE_IN_PROGRESS');
  assert.equal(await control.canWrite(identity.resetGeneration), false);
});
test('origin policy normalizes scheme, hostname and port while rejecting unsafe forms', () => {
  const policy = createOriginPolicy(['https://gen-lang-client-0710663107.web.app', 'http://localhost:5173']);
  assert.equal(policy.validate('https://GEN-LANG-CLIENT-0710663107.web.app:443'), 'https://gen-lang-client-0710663107.web.app');
  assert.equal(policy.validate('http://localhost:5173'), 'http://localhost:5173');
  for (const value of [undefined, 'null', '*', 'https://gen-lang-client-0710663107.web.app.evil.com', 'https://evil-gen-lang-client-0710663107.web.app', 'https://gen-lang-client-0710663107.web.app/path', 'not-an-origin']) {
    assert.equal(policy.validate(value), null);
  }
});

test('session is one-time, rejects wrong origin, malformed token and expiry', async () => {
  let clock = 1_000;
  const store = createMemoryLiveSessionStore({ now: () => clock, ttlMs: 60_000 });
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  assert.equal(await store.consume({ token: session.token, origin: 'https://evil.invalid' }), null);
  assert.equal(await store.consume({ token: 'bad', origin }), null);
  const consumed = await store.consume({ token: session.token, origin });
  assert.equal(consumed.uid, identity.uid); assert.deepEqual(consumed.roles, ['patient']);
  assert.equal(consumed.intakeSessionId, session.intakeSessionId); assert.match(consumed.patientCaseId, /^SC-/);
  assert.equal(await store.consume({ token: session.token, origin }), null);
  const expired = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  clock += 60_001;
  assert.equal(await store.consume({ token: expired.token, origin }), null);
});

test('concurrent double-use atomically permits exactly one connection identity', async () => {
  const store = createMemoryLiveSessionStore();
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  const results = await Promise.all([store.consume({ token: session.token, origin }), store.consume({ token: session.token, origin })]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter(value => value === null).length, 1);
  assert.equal(results.find(Boolean).uid, identity.uid);
});

test('active Live session owns one idempotent simulated appointment request', async () => {
  const store = createMemoryLiveSessionStore();
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  const active = await store.consume({ token: session.token, origin });
  const input = { intakeSessionId: active.intakeSessionId, uid: active.uid, patientCaseId: active.patientCaseId,
    idempotencyKey: 'db4dc70c-7c89-47c8-9f51-3649b274f6b0', resourceVersion: 1,
    selection: { hospitalId: 'hospital-a', hospitalName: 'Fictional Hospital', date: '2026-10-01', time: '10:30', fictionalDemo: true } };
  const first = await store.saveAppointmentRequest(input);
  const duplicate = await store.saveAppointmentRequest(input);
  assert.equal(duplicate.appointmentRequestId, first.appointmentRequestId);
  assert.equal(first.simulation, true); assert.equal(first.contacted, false); assert.equal(first.confirmed, false);
  assert.deepEqual(await store.getAppointmentRequest({ intakeSessionId: active.intakeSessionId, uid: active.uid, patientCaseId: active.patientCaseId }), first);
  assert.equal(await store.getAppointmentRequest({ intakeSessionId: active.intakeSessionId, uid: 'other-patient', patientCaseId: active.patientCaseId }), null);
  assert.equal((await store.saveAppointmentRequest({ ...input, selection: { ...input.selection, hospitalId: 'hospital-b' } })).conflict, true);
  assert.equal(await store.saveAppointmentRequest({ ...input, patientCaseId: 'SC-00000000-0000-4000-8000-000000000001' }), null);
  await store.end({ intakeSessionId: active.intakeSessionId, uid: active.uid });
  assert.equal(await store.saveAppointmentRequest({ ...input, idempotencyKey: '43912754-c0bc-4747-a77a-4edc6bef587c' }), null);
  assert.equal((await store.getAppointmentRequest({ intakeSessionId: active.intakeSessionId, uid: active.uid })).appointmentRequestId, first.appointmentRequestId);
});

test('bootstrap rate and outstanding-session limits fail closed with generic response', async t => {
  const logs = [];
  const limiter = createLiveSessionLimiter({ perUid: 10, perOrigin: 10, outstandingPerUid: 2 });
  const { base } = await setup(t, { liveSessionOptions: { limiter, log: detail => logs.push(detail) } });
  const headers = { Authorization: 'Bearer firebase-token' };
  assert.equal((await post(base, headers)).status, 201);
  assert.equal((await post(base, headers)).status, 201);
  const rejected = await post(base, headers);
  assert.equal(rejected.status, 429);
  assert.deepEqual(await rejected.json(), { code: 'LIVE_SESSION_REJECTED' });
  assert(logs.some(entry => entry.reason === 'rate_limit'));
  assert(!JSON.stringify(logs).includes('firebase-token'));
  assert(!JSON.stringify(logs).includes('smartcareops.session.'));
});

test('bootstrap rejects missing, null, malformed, lookalike origins and invalid browser metadata', async t => {
  const { base } = await setup(t);
  const authorization = { Authorization: 'Bearer firebase-token' };
  assert.equal((await fetch(base + '/api/live/session', { method: 'POST', headers: authorization })).status, 403);
  for (const bad of ['null', 'not-an-origin', 'http://localhost:5173.evil.com']) {
    assert.equal((await post(base, { ...authorization, Origin: bad })).status, 403);
  }
  assert.equal(browserSignalsAccept({ 'sec-fetch-mode': 'navigate' }), false);
  assert.equal(browserSignalsAccept({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), true);
  assert.equal(browserSignalsAccept({ 'sec-fetch-mode': 'websocket' }, { webSocket: true }), true);
});

test('public Live transport exposes no REST API and consumes bootstrap before upgrade', async t => {
  const { api, store, base } = await setup(t, { livePublicOnly: true });
  assert.equal((await fetch(base + '/api/auth/me')).status, 404);
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  const connect = token => new Promise(resolve => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', [LIVE_PROTOCOL, `smartcareops.session.${token}`], { origin });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (request, response) => { response.resume(); request.destroy(); resolve(response.statusCode); });
    ws.on('error', () => {});
  });
  assert.equal(await connect(session.token), 101);
  assert.equal(await connect(session.token), 403);
  assert.equal(await connect('A'.repeat(43)), 403);
  assert.equal(api.server.listenerCount('upgrade') > 0, true);
});

test('upgrade logs outcomes without credential or authorization material', async t => {
  const logs = [];
  const { store, base } = await setup(t, { livePublicOnly: true, liveOptions: { upgradeLog: detail => logs.push(detail) } });
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  const status = await new Promise(resolve => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', [LIVE_PROTOCOL, `smartcareops.session.${session.token}`], { origin: 'https://evil.invalid' });
    ws.on('unexpected-response', (request, response) => { response.resume(); request.destroy(); resolve(response.statusCode); });
    ws.on('error', () => {});
  });
  assert.equal(status, 403);
  const serialized = JSON.stringify(logs);
  assert(!serialized.includes(session.token));
  assert(!serialized.includes('Authorization'));
  assert(logs.some(entry => entry.reason === 'origin'));
});

test('repeated failed upgrade attempts are bounded per transport instance', async t => {
  const { base } = await setup(t, { livePublicOnly: true, liveOptions: { upgradeLimit: 2 } });
  const attempt = () => new Promise(resolve => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', [LIVE_PROTOCOL, `smartcareops.session.${'A'.repeat(43)}`], { origin });
    ws.on('unexpected-response', (request, response) => { response.resume(); request.destroy(); resolve(response.statusCode); });
    ws.on('error', () => {});
  });
  assert.equal(await attempt(), 403);
  assert.equal(await attempt(), 403);
  assert.equal(await attempt(), 429);
});

test('authenticated reconnect restores one active intake, case, language, validated facts, and current question', async () => {
  const store = createMemoryLiveSessionStore();
  const first = await store.create({ uid: identity.uid, roles: ['patient'], origin, preferredLanguage: 'es' });
  const firstIdentity = await store.consume({ token: first.token, origin });
  const plan = { version: 1, revision: 4, path: 'skin', activeQuestionId: 'skin.face_throat', status: 'collecting', emergency: false,
    answers: { 'core.name': { state: 'answered', patientReportedText: 'JL', utteranceId: 1 }, 'core.main_concern': { state: 'answered', patientReportedText: 'A rash', utteranceId: 2 } },
    asked: ['core.name', 'core.main_concern', 'skin.face_throat'], processedUtteranceIds: [1, 2], clarificationCounts: {} };
  const intake = { patient: { name: 'JL', preferredName: null }, symptoms: [], onset: { value: null, patientReportedText: '' }, vitals: {}, redFlags: [], additionalNotes: [], evidence: {} };
  await store.saveQuestionPlan({ intakeSessionId: first.intakeSessionId, uid: identity.uid, plan });
  await store.saveIntakeSnapshot({ intakeSessionId: first.intakeSessionId, uid: identity.uid, intake });
  await store.end({ intakeSessionId: first.intakeSessionId, uid: identity.uid });

  const resumed = await store.create({ uid: identity.uid, roles: ['patient'], origin, preferredLanguage: 'en', resumeIntakeSessionId: first.intakeSessionId });
  const resumedIdentity = await store.consume({ token: resumed.token, origin });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.preferredLanguage, 'es');
  assert.equal(resumedIdentity.patientCaseId, firstIdentity.patientCaseId);
  assert.deepEqual(await store.getQuestionPlan({ intakeSessionId: resumed.intakeSessionId, uid: identity.uid }), plan);
  assert.deepEqual(await store.getIntakeSnapshot({ intakeSessionId: resumed.intakeSessionId, uid: identity.uid }), intake);

  const denied = await store.create({ uid: 'another-patient', roles: ['patient'], origin, preferredLanguage: 'en', resumeIntakeSessionId: first.intakeSessionId });
  assert.equal(denied.resumed, false);
  const deniedIdentity = await store.consume({ token: denied.token, origin });
  assert.notEqual(deniedIdentity.patientCaseId, firstIdentity.patientCaseId);
  store.close();
});

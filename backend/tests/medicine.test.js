import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryLiveSessionStore } from '../src/live-session.js';
import { createMedicineImageAnalyzer } from '../src/medicine/model.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';

const origin = 'http://localhost:5173';
const patient = { uid: 'medicine-patient', email: 'patient@example.invalid', firebase: { sign_in_provider: 'google.com' } };
const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]).toString('base64');

async function setup(t, { analyze = async () => ({ status: 'identified', name: 'Fictionalmed', strength: '10 mg' }), verifyToken } = {}) {
  const sessions = createMemoryLiveSessionStore(), cases = createMemoryCaseStore();
  const userProfileStore = createMemoryUserProfileStore(new Map(), { patientAccessMode: 'open' });
  const medicineLogs = [];
  const api = createApiServer({ caseStore: cases, liveSessionStore: sessions, liveSessionEnabled: true, liveWebSocketUrl: 'wss://live.example.invalid/api/live', medicineAnalyzer: analyze,
    medicineLogger: { warn: (...values) => medicineLogs.push(values.join(' ')) },
    authOptions: { env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_PATIENT_UIDS: patient.uid }, userProfileStore, verifyToken: verifyToken || (async () => patient) },
    liveOptions: { apiKey: 'fake', connect: async () => ({ sendRealtimeInput() {}, close() {} }) } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`, headers = { Origin: origin, Authorization: 'Bearer patient-token', 'Content-Type': 'application/json' };
  const bootstrapResponse = await fetch(base + '/api/live/session', { method: 'POST', headers });
  const bootstrap = await bootstrapResponse.json();
  const identity = await sessions.consume({ token: bootstrap.token, origin });
  return { api, sessions, cases, base, headers, bootstrap, identity, medicineLogs };
}
const post = (fixture, path, body, headers = fixture.headers) => fetch(fixture.base + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('medicine scan is Patient/session bound, strictly structured, bounded and rate limited', async t => {
  const f = await setup(t), scan = { intakeSessionId: f.bootstrap.intakeSessionId, mimeType: 'image/jpeg', imageBase64: jpeg, caseId: 'SC-client-is-not-authority' };
  const first = await post(f, '/api/intake/medicine/scan', scan); assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { candidate: { status: 'identified', name: 'Fictionalmed', strength: '10 mg' } });
  const serverResult = await f.sessions.getMedicineScanResult({ intakeSessionId: f.bootstrap.intakeSessionId, uid: patient.uid });
  assert.equal(serverResult.status, 'identified'); assert.equal(serverResult.name, 'Fictionalmed'); assert.equal(serverResult.strength, '10 mg');
  assert.equal(typeof serverResult.revision, 'string'); assert.equal(JSON.stringify(serverResult).includes(jpeg), false);
  assert.equal((await post(f, '/api/intake/medicine/scan', { ...scan, mimeType: 'image/png' })).status, 400);
  for (let index = 0; index < 2; index++) assert.equal((await post(f, '/api/intake/medicine/scan', scan)).status, 200);
  assert.equal((await post(f, '/api/intake/medicine/scan', scan)).status, 429);
  assert.equal(JSON.stringify(await f.sessions.resolveActive({ intakeSessionId: f.bootstrap.intakeSessionId, uid: patient.uid })).includes(jpeg), false);

  const other = await setup(t, { verifyToken: async () => ({ ...patient, uid: 'other-patient' }) });
  assert.equal((await post(other, '/api/intake/medicine/scan', scan)).status, 409);
});

test('synthetic readable package bytes and MIME reach Gemini unchanged before strict candidate validation', async () => {
  const bytes = readFileSync(new URL('./fixtures/fictional-medicine-label.jpg', import.meta.url));
  let providerRequest;
  const analyzer = createMedicineImageAnalyzer({ request: async request => {
    providerRequest = request;
    return { text: JSON.stringify({ status: 'identified', name: 'Novamed', strength: '25 mg' }) };
  } });
  const candidate = await analyzer({ mimeType: 'image/jpeg', imageBase64: bytes.toString('base64') });
  assert.deepEqual(candidate, { status: 'identified', name: 'Novamed', strength: '25 mg' });
  assert.equal(providerRequest.contents[0].inlineData.mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(providerRequest.contents[0].inlineData.data, 'base64'), bytes);
  assert.match(providerRequest.contents[1].text, /name and printed strength/);
  assert.equal(providerRequest.config.maxOutputTokens, 1024);
  assert.deepEqual(providerRequest.config.thinkingConfig, { thinkingLevel: 'low' });
});

test('medicine confirmation is explicit, idempotent, exactly once, and projected as patient-reported evidence', async t => {
  const f = await setup(t), idempotencyKey = randomUUID();
  const body = { intakeSessionId: f.bootstrap.intakeSessionId, idempotencyKey, name: 'Fictionalmed', strength: '10 mg', howTaken: 'I take one each morning.', confirmed: true };
  assert.equal((await post(f, '/api/intake/medicine/confirm', { ...body, confirmed: false })).status, 400);
  const saved = await post(f, '/api/intake/medicine/confirm', body); assert.equal(saved.status, 201);
  const repeated = await post(f, '/api/intake/medicine/confirm', body); assert.equal(repeated.status, 201);
  assert.equal((await repeated.json()).receiptId, `medicine-${idempotencyKey}`);
  assert.equal((await post(f, '/api/intake/medicine/confirm', { ...body, name: 'Changed with same key' })).status, 409);
  assert.equal((await post(f, '/api/intake/medicine/confirm', { ...body, idempotencyKey: randomUUID(), name: 'Different' })).status, 409);

  const medication = await f.sessions.getMedication({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid, patientCaseId: f.identity.patientCaseId });
  const intake = { patient: { name: 'Fictional Patient', preferredName: null }, symptoms: [{ name: 'dizzy', status: 'confirmed', patientReportedText: 'I feel dizzy.' }], redFlags: [], onset: { value: 'today', patientReportedText: 'Today' }, vitals: { temperature: {}, bloodPressure: {}, heartRate: {}, spo2: {}, bloodGlucose: {} }, additionalNotes: [], evidence: { name: { patientReportedText: 'Fictional Patient' }, 'symptoms.dizzy': { patientReportedText: 'I feel dizzy.' }, onset: { patientReportedText: 'Today' } } };
  const patientCase = await f.cases.createCase({ caseId: f.identity.patientCaseId, intake, patientUid: patient.uid, submittedForReview: true, medication });
  assert.deepEqual(patientCase.medications, [{ name: 'Fictionalmed', strength: '10 mg', howTaken: 'I take one each morning.', source: 'packaging_shown', verification: 'patient_reported', confirmedAt: medication.confirmedAt }]);
  assert.deepEqual((await f.cases.getDoctorCase(patientCase.caseId)).medications, patientCase.medications);
  assert.equal(JSON.stringify(patientCase.reportedFacts).includes('Fictionalmed'), false);
});

test('body-area evidence sharing requires an authenticated active Patient intake and preserves the exact still', async t => {
  const f = await setup(t), evidenceId = randomUUID();
  const body = { intakeSessionId: f.bootstrap.intakeSessionId, evidenceId, kind: 'body_area', patientDescription: 'I feel pain on the outer part of my left shoulder.', mimeType: 'image/jpeg', imageBase64: jpeg };
  const response = await post(f, '/api/intake/evidence/share', body);
  assert.equal(response.status, 201); assert.equal((await response.json()).evidence.evidenceId, evidenceId);
  const repeats = await post(f, '/api/intake/evidence/share', body);
  assert.equal(repeats.status, 201); assert.equal((await repeats.json()).evidence.evidenceId, evidenceId);
  const pending = await f.sessions.getPatientEvidence({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid, patientCaseId: f.identity.patientCaseId });
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'body_area');
  assert.deepEqual(pending[0].bytes, Buffer.from(jpeg, 'base64'));
  assert.equal(JSON.stringify(await f.sessions.resolveActive({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid })).includes(jpeg), false);
  assert.equal((await post(f, '/api/intake/evidence/share', { ...body, patientDescription: 'changed' })).status, 409);
  const wrongPatient = await setup(t, { verifyToken: async () => ({ ...patient, uid: 'another-patient' }) });
  assert.equal((await post(wrongPatient, '/api/intake/evidence/share', body)).status, 409);
  assert.equal((await post(f, '/api/intake/evidence/share', { ...body, kind: 'diagnosis' })).status, 400);
});

test('the exact Patient-approved still is attached only after confirmation and is readable as Doctor evidence', async t => {
  const f = await setup(t), idempotencyKey = randomUUID();
  assert.equal((await post(f, '/api/intake/medicine/scan', { intakeSessionId: f.bootstrap.intakeSessionId, mimeType: 'image/jpeg', imageBase64: jpeg })).status, 200);
  assert.equal(await f.sessions.getMedicineImage({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid, patientCaseId: f.identity.patientCaseId }), null);
  assert.equal((await post(f, '/api/intake/medicine/confirm', { intakeSessionId: f.bootstrap.intakeSessionId, idempotencyKey,
    name: 'Fictionalmed', strength: '10 mg', howTaken: 'One each morning', confirmed: true })).status, 201);
  const medication = await f.sessions.getMedication({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid, patientCaseId: f.identity.patientCaseId });
  const image = await f.sessions.getMedicineImage({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid, patientCaseId: f.identity.patientCaseId });
  assert.deepEqual(image.bytes, Buffer.from(jpeg, 'base64'));
  const intake = { patient: { name: 'Fictional Patient', preferredName: null }, symptoms: [{ name: 'dizzy', status: 'confirmed', patientReportedText: 'I feel dizzy.' }], redFlags: [], onset: { value: 'today', patientReportedText: 'Today' }, vitals: { temperature: {}, bloodPressure: {}, heartRate: {}, spo2: {}, bloodGlucose: {} }, additionalNotes: [], evidence: { name: { patientReportedText: 'Fictional Patient' }, 'symptoms.dizzy': { patientReportedText: 'I feel dizzy.' }, onset: { patientReportedText: 'Today' } } };
  const patientCase = await f.cases.createCase({ caseId: f.identity.patientCaseId, intake, patientUid: patient.uid, submittedForReview: true, medication, medicationImage: image });
  assert.deepEqual(patientCase.medications[0].imageEvidence, { status: 'available' });
  assert.deepEqual((await f.cases.getDoctorMedicineImage(patientCase.caseId)).bytes, Buffer.from(jpeg, 'base64'));
  await f.sessions.discardMedicineImage({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid, patientCaseId: f.identity.patientCaseId });
  assert.equal(await f.sessions.getMedicineImage({ intakeSessionId: f.identity.intakeSessionId, uid: patient.uid, patientCaseId: f.identity.patientCaseId }), null);
});

test('medicine endpoint rejects oversized stills before model analysis', async t => {
  let called = 0; const f = await setup(t, { analyze: async () => { called++; return { status: 'unclear', name: '', strength: '' }; } });
  const bytes = Buffer.alloc(512 * 1024 + 1, 1); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[bytes.length - 2] = 0xff; bytes[bytes.length - 1] = 0xd9;
  const response = await post(f, '/api/intake/medicine/scan', { intakeSessionId: f.bootstrap.intakeSessionId, mimeType: 'image/jpeg', imageBase64: bytes.toString('base64') });
  assert.equal(response.status, 413); assert.equal(called, 0);
});

test('medicine model failure and unclear result preserve safe state without image or provider leakage', async t => {
  const failure = await setup(t, { analyze: async () => { throw Object.assign(new Error('MEDICINE_MODEL_UNAVAILABLE'), { category: 'INVALID_RESPONSE', responseStage: 'invalid_json', providerCode: 'MAX_TOKENS', secret: 'do-not-log' }); } });
  const traceId = 'a'.repeat(32);
  const response = await post(failure, '/api/intake/medicine/scan', { intakeSessionId: failure.bootstrap.intakeSessionId, mimeType: 'image/jpeg', imageBase64: jpeg }, { ...failure.headers, 'X-Cloud-Trace-Context': `${traceId}/1;o=1` });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: 'MEDICINE_SCAN_RESPONSE_INVALID', message: 'Medicine label scanning is temporarily unavailable. Your image was not saved; you can retry without recapturing it.' });
  assert.deepEqual(failure.medicineLogs, [`[medicine-scan] {"outcome":"temporarily_unavailable","category":"INVALID_RESPONSE","code":"MAX_TOKENS","requestId":"${traceId}","revision":"local"}`]);
  assert.equal(failure.medicineLogs[0].includes('do-not-log'), false);
  const unclear = createMedicineImageAnalyzer({ request: async () => ({ text: JSON.stringify({ status: 'unclear', name: '', strength: '' }) }) });
  assert.deepEqual(await unclear({ mimeType: 'image/jpeg', imageBase64: jpeg }), { status: 'unclear', name: '', strength: '' });
  const invalid = createMedicineImageAnalyzer({ request: async () => ({ text: JSON.stringify({ status: 'identified', name: 'Guess', strength: '' }) }) });
  await assert.rejects(invalid({ mimeType: 'image/jpeg', imageBase64: jpeg }), error => error.message === 'MEDICINE_MODEL_UNAVAILABLE' && error.category === 'INVALID_RESPONSE' && error.responseStage === 'schema_invalid');
  const incomplete = createMedicineImageAnalyzer({ request: async () => ({ text: JSON.stringify({ status: 'identified', name: 'Guess' }) }) });
  await assert.rejects(incomplete({ mimeType: 'image/jpeg', imageBase64: jpeg }), error => error.category === 'INVALID_RESPONSE' && error.responseStage === 'missing_required_fields');
  const truncated = createMedicineImageAnalyzer({ request: async () => ({ text: '{"status":"identified","name":"Fictional', candidates: [{ finishReason: 'MAX_TOKENS' }] }) });
  await assert.rejects(truncated({ mimeType: 'image/jpeg', imageBase64: jpeg }), error => error.category === 'INVALID_RESPONSE' && error.responseStage === 'invalid_json' && error.providerCode === 'MAX_TOKENS');
  const disguisedGuess = createMedicineImageAnalyzer({ request: async () => ({ text: JSON.stringify({ status: 'unclear', name: 'Guessed name', strength: '10 mg' }) }) });
  await assert.rejects(disguisedGuess({ mimeType: 'image/jpeg', imageBase64: jpeg }), /MEDICINE_MODEL_UNAVAILABLE/);
  const directions = createMedicineImageAnalyzer({ request: async () => ({ text: JSON.stringify({ status: 'identified', name: 'Fictionalmed', strength: '10 mg', directions: 'Take twice daily' }) }) });
  await assert.rejects(directions({ mimeType: 'image/jpeg', imageBase64: jpeg }), /MEDICINE_MODEL_UNAVAILABLE/);

  const unclearResponse = await setup(t, { analyze: async () => ({ status: 'unclear', name: '', strength: '' }) });
  const unclearHttp = await post(unclearResponse, '/api/intake/medicine/scan', { intakeSessionId: unclearResponse.bootstrap.intakeSessionId, mimeType: 'image/jpeg', imageBase64: jpeg });
  assert.equal(unclearHttp.status, 200);
  assert.deepEqual(await unclearHttp.json(), { candidate: null, code: 'MEDICINE_LABEL_UNCLEAR' });

  const malformedFailure = await setup(t, { analyze: async () => { throw Object.assign(new Error('MEDICINE_MODEL_UNAVAILABLE'), { category: 'INVALID_RESPONSE', responseStage: 'invalid_json', providerCode: 'STOP' }); } });
  const malformedResponse = await post(malformedFailure, '/api/intake/medicine/scan', { intakeSessionId: malformedFailure.bootstrap.intakeSessionId, mimeType: 'image/jpeg', imageBase64: jpeg });
  assert.equal(malformedResponse.status, 503);
  assert.deepEqual(await malformedResponse.json(), { code: 'MEDICINE_SCAN_RESPONSE_INVALID', message: 'Medicine label scanning is temporarily unavailable. Your image was not saved; you can retry without recapturing it.' });
});

test('ending the Live intake invalidates medicine operations without affecting prior confirmed case evidence', async t => {
  const f = await setup(t);
  await f.sessions.end({ intakeSessionId: f.bootstrap.intakeSessionId, uid: patient.uid });
  const response = await post(f, '/api/intake/medicine/confirm', { intakeSessionId: f.bootstrap.intakeSessionId, idempotencyKey: randomUUID(), name: 'A', strength: '1 mg', howTaken: 'As I reported.', confirmed: true });
  assert.equal(response.status, 409);
});

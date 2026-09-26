import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createMemoryCaseStore, newCaseId, Handoff, Workflow } from '../src/cases/store.js';
import { createFirestoreCaseStore, createConfiguredCaseStore } from '../src/cases/firestore.js';
import { withCasePersistence } from '../src/cases/lifecycle.js';
import { caseEndpoint } from '../src/cases/http.js';
import { emptyIntake } from '../src/intake/schema.js';
import { emergencyIntake } from './safety-fixtures.js';

const sample = () => { const intake = emptyIntake(); intake.patient.name = 'Fictional Alex'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Fictional Alex' }; return intake; };
// SDK transaction contract mock: credentials/network are deliberately unnecessary.
function firestoreMock() {
  const docs = new Map(); let queue = Promise.resolve();
  const snapshot = id => ({ exists: docs.has(id), data: () => structuredClone(docs.get(id)) });
  return { docs, collection(name) { assert.equal(name, 'cases'); return { doc: id => ({ id, get: async () => snapshot(id) }) }; },
    runTransaction(work) {
      const next = queue.then(() => work({ get: async ref => snapshot(ref.id), create(ref, value) { assert.ok(!docs.has(ref.id)); docs.set(ref.id, structuredClone(value)); }, set(ref, value) { docs.set(ref.id, structuredClone(value)); } }));
      queue = next.catch(() => {}); return next;
    }, terminate() {} };
}
for (const mode of ['memory', 'firestore']) {
  const make = () => mode === 'memory' ? createMemoryCaseStore() : createFirestoreCaseStore(firestoreMock());
  test(`${mode}: concurrent completion creates one immutable case and reads it back`, async () => {
    const store = make(), caseId = newCaseId(), intake = sample();
    const records = await Promise.all(Array.from({ length: 5 }, () => store.createCase({ caseId, intake })));
    assert.ok(records.every(record => record.caseId === caseId && record.createdAt === records[0].createdAt));
    const read = await store.getCase(caseId);
    assert.equal(read.workflowStatus, Workflow.INTAKE); assert.equal(read.handoffStatus, Handoff.NONE);
    assert.deepEqual(read.reportedFacts, intake); assert.equal(read.storage, mode);
    intake.patient.name = 'Changed';
    await assert.rejects(store.createCase({ caseId, intake }), error => error.code === 'CASE_CONFLICT');
    assert.equal((await store.getCase(caseId)).patient.name, 'Fictional Alex');
  });
  test(`${mode}: lifecycle persists pending, active, receipt and completion without changing unrelated case`, async () => {
    const store = make(), caseId = newCaseId(), other = newCaseId(), events = [];
    const intake = sample(); await store.createCase({ caseId, intake });
    const original = await store.createCase({ caseId: other, intake });
    const run = withCasePersistence(async ({ emit }) => { emit({ status: 'completed', caseId: 'DEMO-1234ABCD' }); return { caseId: 'DEMO-1234ABCD' }; }, store);
    await run({ patientCaseId: caseId, emit: event => events.push(event) });
    assert.deepEqual(events.filter(e => e.patientCase).map(e => e.patientCase.handoffStatus), ['pending', 'in_progress', 'completed']);
    assert.equal(events.at(-1).status, 'completed');
    const doc = await store.getCase(caseId);
    assert.equal(doc.workflowStatus, Workflow.COMPLETE); assert.equal(doc.handoffReceipt.transport, 'generate_content');
    assert.equal(doc.handoffReceipt.caseId, 'DEMO-1234ABCD'); assert.ok(doc.handoffReceipt.completedAt);
    assert.deepEqual(await store.getCase(other), original);
    await assert.rejects(run({ patientCaseId: caseId, emit() {} }), error => error.code === 'INVALID_CASE_TRANSITION');
  });
  test(`${mode}: failed handoff stores only safe metadata and stale attempt cannot overwrite a retry`, async () => {
    const store = make(), caseId = newCaseId(), first = randomUUID(), second = randomUUID();
    await store.createCase({ caseId, intake: sample() });
    await store.updateCaseStatus(caseId, Handoff.PENDING, first);
    await store.updateHandoffResult(caseId, { attemptId: first, diagnostics: { code: 'MODEL_REQUEST_FAILED', stage: 'model_request', safeMessage: 'secret-key', raw: 'secret-key', screenshot: 'secret-key' } });
    const doc = await store.getCase(caseId);
    assert.equal(doc.workflowStatus, Workflow.FAILED); assert.equal(doc.failure.code, 'MODEL_REQUEST_FAILED');
    assert.ok(!JSON.stringify(doc).includes('secret-key'));
    await store.updateCaseStatus(caseId, Handoff.PENDING, second);
    await assert.rejects(store.updateHandoffResult(caseId, { attemptId: first, receipt: { caseId: 'DEMO-1234ABCD' } }), e => e.code === 'STALE_HANDOFF');
    assert.equal((await store.getCase(caseId)).handoffStatus, Handoff.PENDING);
  });
  test(`${mode}: emergency persists pending dispatcher and blocks M3`, async () => {
    const store = make(), caseId = newCaseId();
    const doc = await store.createCase({ caseId, intake: emergencyIntake(), emergency: true });
    assert.equal(doc.workflowStatus, Workflow.EMERGENCY); assert.equal(doc.handoffStatus, Handoff.NONE);
    await assert.rejects(store.updateCaseStatus(caseId, Handoff.PENDING, randomUUID()));
  });
}

test('live minimal case is reviewable before enrichment and terminal enrichment is idempotent', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId(), intake = sample();
  const minimal = await store.createCase({ caseId, intake: { ...intake, symptoms: [] }, patientUid: 'patient-1', submittedForReview: true,
    intakeSource: 'live_intake', enrichmentStatus: 'pending' });
  assert.equal(minimal.workflowStatus, Workflow.REVIEW);
  assert.equal(minimal.enrichmentStatus, 'pending');
  const enriched = await store.updateEnrichment({ caseId, intake, status: 'succeeded', patientUid: 'patient-1' });
  const repeated = await store.updateEnrichment({ caseId, status: 'failed', errorCategory: 'INVALID_RESPONSE', patientUid: 'patient-1' });
  assert.equal(enriched.enrichmentStatus, 'succeeded');
  assert.deepEqual(repeated, enriched);
  await assert.rejects(store.updateEnrichment({ caseId, intake, status: 'succeeded', patientUid: 'other-patient' }), error => error.code === 'CASE_NOT_FOUND');
});

test('Doctor case detail resolves trusted profile identity separately from patient-reported name', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId(), intake = sample();
  intake.patient.name = 'Louis'; intake.patient.preferredName = 'Louis';
  intake.evidence.name = { utteranceId: 1, patientReportedText: 'My name is Louis.' };
  await store.createCase({ caseId, intake, patientUid: 'verified-patient', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  const detail = await store.getDoctorCase(caseId, { resolvePatientIdentity: async uid => {
    assert.equal(uid, 'verified-patient');
    return { firstName: 'John Louis', middleName: 'Cano', lastName: 'Garcia', displayName: 'John Louis Cano Garcia' };
  } });
  assert.deepEqual(detail.patientIdentity, { firstName: 'John Louis', middleName: 'Cano', lastName: 'Garcia', displayName: 'John Louis Cano Garcia' });
  assert.equal(detail.patient.preferredName, 'Louis');
  assert.equal(detail.intakeSummary['Patient Name'], 'Louis');
  assert.equal(detail.reportedFacts.patient.name, 'Louis');
  assert.ok(!Object.hasOwn(detail, 'patientUid'));
});

test('enrichment adds validated facts without overwriting committed patient wording or evidence', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId(), minimal = sample();
  minimal.symptoms.push({ name: 'dizzy', status: 'confirmed', patientReportedText: 'dizzy' });
  minimal.evidence['symptoms.dizzy'] = { utteranceId: 2, patientReportedText: 'dizzy' };
  await store.createCase({ caseId, intake: minimal, patientUid: 'patient-1', submittedForReview: true,
    intakeSource: 'live_intake', enrichmentStatus: 'pending' });
  const enrichment = structuredClone(minimal);
  enrichment.patient.name = 'Provider replacement';
  enrichment.evidence.name = { utteranceId: 99, patientReportedText: 'Provider replacement' };
  enrichment.symptoms.push({ name: 'fever', status: 'confirmed', patientReportedText: 'fever' });
  enrichment.evidence['symptoms.fever'] = { utteranceId: 3, patientReportedText: 'fever' };
  const result = await store.updateEnrichment({ caseId, intake: enrichment, status: 'succeeded', patientUid: 'patient-1' });
  assert.equal(result.patient.name, 'Fictional Alex');
  assert.equal(result.reportedFacts.evidence.name.patientReportedText, 'Fictional Alex');
  assert.deepEqual(result.reportedFacts.symptoms.map(item => item.name), ['dizzy', 'fever']);
  assert.equal(Object.hasOwn(result.reportedFacts, 'diagnosis'), false);
});
test('Firestore read-back survives a new service instance over the same database', async () => {
  const db = firestoreMock(), caseId = newCaseId();
  await createFirestoreCaseStore(db).createCase({ caseId, intake: sample() });
  assert.equal(db.docs.size, 1);
  assert.equal((await createFirestoreCaseStore(db).getCase(caseId)).caseId, caseId);
});
test('explicit memory fallback is identified and missing Firestore config fails closed', async () => {
  const memory = createConfiguredCaseStore({ CASE_STORE: 'memory' });
  assert.equal(memory.storage, 'memory');
  const missing = createConfiguredCaseStore({});
  assert.equal(missing.storage, 'unavailable'); await assert.rejects(missing.getCase(newCaseId()), e => e.code === 'CASE_STORE_UNAVAILABLE');
  assert.equal(createConfiguredCaseStore({ FIREBASE_PROJECT_ID: 'demo-project', FIRESTORE_EMULATOR_HOST: 'attacker.test:8080' }).storage, 'unavailable');
});
test('case API rejects invalid IDs and never returns extra secret or transport fields', async t => {
  const store = createMemoryCaseStore(), caseId = newCaseId(), intake = sample();
  intake.apiKey = 'hidden-secret'; intake.screenshots = ['hidden-secret']; intake.patient.credentials = 'hidden-secret';
  await store.createCase({ caseId, intake });
  const handler = caseEndpoint(store), server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const suffix of ['bad', '%2f', caseId + '?key=secret']) assert.equal((await fetch(`${base}/api/cases/${suffix}`)).status, 400);
  assert.equal((await fetch(`${base}/api/cases/${newCaseId()}`)).status, 404);
  const response = await fetch(`${base}/api/cases/${caseId}`), text = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(!text.includes('hidden-secret')); assert.ok(!text.includes('attemptId'));
  assert.equal(JSON.parse(text).storage, 'memory');
});
test('storage outage after verified submission does not mark failed or permit replay', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId();
  await store.createCase({ caseId, intake: sample() });
  const emitted = [], broken = { ...store, updateHandoffResult: async () => { throw new Error('secret provider error'); } };
  const run = withCasePersistence(async ({ emit }) => { emit({ status: 'completed', caseId: 'DEMO-1234ABCD' }); return { caseId: 'DEMO-1234ABCD' }; }, broken);
  await assert.rejects(run({ patientCaseId: caseId, emit: event => emitted.push(event) }));
  assert.equal((await store.getCase(caseId)).handoffStatus, Handoff.ACTIVE);
  assert.ok(!emitted.some(e => e.status === 'completed'));
  await assert.rejects(store.updateCaseStatus(caseId, Handoff.PENDING, randomUUID()));
});
test('failure and cancellation pass through lifecycle while persistence records safe outcome', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId(), controller = new AbortController();
  await store.createCase({ caseId, intake: sample() }); controller.abort();
  const run = withCasePersistence(async () => { throw new Error('cancelled'); }, store);
  await assert.rejects(run({ patientCaseId: caseId, signal: controller.signal, emit() {} }), /cancelled/);
  assert.equal((await store.getCase(caseId)).failure.code, 'CANCELLED');
});

test('patient-owned case read requires the same verified UID and never exposes the UID', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId();
  await store.createCase({ caseId, intake: sample(), patientUid: 'verified-patient' });
  const record = await store.getPatientCase(caseId, 'verified-patient');
  assert.equal(record.caseId, caseId);
  assert.ok(!Object.hasOwn(record, 'patientUid'));
  await assert.rejects(store.getPatientCase(caseId, 'different-patient'), error => error.code === 'CASE_NOT_FOUND');
});

test('two concurrent handoff attempts cannot both claim the same case', async () => {
  const store = createFirestoreCaseStore(firestoreMock()), caseId = newCaseId();
  await store.createCase({ caseId, intake: sample() });
  const results = await Promise.allSettled([randomUUID(), randomUUID()].map(id => store.updateCaseStatus(caseId, Handoff.PENDING, id)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});
test('a failed attempt cannot later promote itself to verified completion', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId(), attemptId = randomUUID();
  await store.createCase({ caseId, intake: sample() });
  await store.updateCaseStatus(caseId, Handoff.PENDING, attemptId);
  await store.updateHandoffResult(caseId, { attemptId, diagnostics: { code: 'CANCELLED' } });
  await assert.rejects(store.updateHandoffResult(caseId, { attemptId, receipt: { caseId: 'DEMO-1234ABCD' } }));
  assert.equal((await store.getCase(caseId)).handoffStatus, Handoff.FAILED);
});
test('Firestore permission errors become safe metadata without returning provider text', async () => {
  const db = firestoreMock(); db.runTransaction = async () => { throw Object.assign(new Error('secret provider payload'), { code: 7 }); };
  await assert.rejects(createFirestoreCaseStore(db).createCase({ caseId: newCaseId(), intake: sample() }), error => {
    assert.equal(error.providerCode, 7); assert.equal(error.code, 'CASE_STORE_UNAVAILABLE');
    assert.ok(!error.message.includes('secret')); return true;
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { routingIntake, routingFirestoreMock } from './routing-fixtures.js';
import { emergencyIntake } from './safety-fixtures.js';
import { evaluateRouting, validRouting, factsFingerprint } from '../src/cases/routing.js';
import { createFirestoreCaseStore } from '../src/cases/firestore.js';
import { createMemoryCaseStore, newCaseId, Workflow, Handoff } from '../src/cases/store.js';
import { routingEndpoint } from '../src/cases/routing-http.js';

for (const [symptom, specialty] of [['dizziness', 'neurology'], ['chest pain', 'cardiology'], ['difficulty breathing', 'pulmonology'], ['high blood sugar', 'endocrinology'], ['fatigue', 'general_medicine']]) {
  test(`routing demo: ${symptom} → ${specialty}`, () => assert.equal(evaluateRouting(routingIntake([[symptom, 'confirmed']])).specialty, specialty));
}
test('priority selects stronger domain, ignoring denied, uncertain and unsupported facts', () => {
  const facts = routingIntake([['dizziness', 'confirmed'], ['chest pain', 'denied'], ['difficulty breathing', 'unclear']]);
  assert.equal(evaluateRouting(facts).specialty, 'neurology');
  facts.symptoms.push({ name: 'palpitations', status: 'confirmed', patientReportedText: 'unsupported' });
  assert.equal(evaluateRouting(facts).specialty, 'neurology');
  assert.equal(evaluateRouting(routingIntake([['dizziness', 'confirmed'], ['high blood sugar', 'confirmed']])).specialty, 'endocrinology');
  assert.equal(evaluateRouting(routingIntake([['chest pain', 'confirmed'], ['difficulty breathing', 'confirmed']])).specialty, 'cardiology');
});
test('numeric glucose alone is not interpreted; evidenced patient-reported high glucose is a signal', () => {
  const facts = routingIntake([['fatigue', 'confirmed']]);
  facts.vitals.bloodGlucose = { value: 190, unit: 'mg/dL', source: 'patient_reported', qualitative: null };
  assert.equal(evaluateRouting(facts).specialty, 'general_medicine');
  facts.vitals.bloodGlucose.qualitative = 'patient reports high';
  assert.equal(evaluateRouting(facts).specialty, 'general_medicine');
  facts.evidence['vitals.bloodGlucose'] = { utteranceId: 3, patientReportedText: 'My blood sugar is high.' };
  assert.equal(evaluateRouting(facts).specialty, 'endocrinology');
});
test('specialty and safe reason allowlists reject unknown assignments and free-form metadata', () => {
  const valid = { ...evaluateRouting(routingIntake()), status: 'routed', routedAt: new Date().toISOString() };
  assert.ok(validRouting(valid));
  for (const change of [{ specialty: 'surgery' }, { reasonSummary: 'raw provider output' }, { reasonCode: 'diagnosis' }, { routedAt: 'not a date' }]) assert.equal(validRouting({ ...valid, ...change }), false);
});
test('facts fingerprint ignores map order while detecting changed facts', () => {
  assert.equal(factsFingerprint({ a: 1, b: { c: 2, d: 3 } }), factsFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(factsFingerprint({ a: 1 }), factsFingerprint({ a: 2 }));
});

for (const mode of ['memory', 'firestore']) {
  const make = () => mode === 'memory' ? createMemoryCaseStore() : createFirestoreCaseStore(routingFirestoreMock());
  test(`${mode}: route is atomic, concurrent/idempotent and preserves facts, timestamps and unrelated case`, async () => {
    const store = make(), id = newCaseId(), other = newCaseId(), intake = routingIntake();
    const before = await store.createCase({ caseId: id, intake }), unrelated = await store.createCase({ caseId: other, intake });
    const results = await Promise.all(Array.from({ length: 6 }, () => store.routeCase(id)));
    assert.ok(results.every(doc => doc.routing.routedAt === results[0].routing.routedAt));
    const result = await store.getCase(id);
    assert.equal(result.workflowStatus, Workflow.ROUTED); assert.equal(result.routing.specialty, 'neurology');
    assert.equal(result.createdAt, before.createdAt); assert.deepEqual(result.reportedFacts, before.reportedFacts);
    assert.equal(result.handoffStatus, before.handoffStatus); assert.deepEqual(await store.getCase(other), unrelated);
    assert.equal((await store.listDoctorCases()).cases.length, 1);
    await assert.rejects(store.getDoctorCase(other), e => e.code === 'CASE_NOT_FOUND');
    assert.equal((await store.getDoctorCase(id)).caseId, id);
    const changed = routingIntake([['fatigue', 'confirmed']]);
    await assert.rejects(store.createCase({ caseId: id, intake: changed }), e => e.code === 'CASE_CONFLICT');
    assert.equal((await store.routeCase(id)).routing.routedAt, result.routing.routedAt);
  });
  test(`${mode}: emergency is unchanged and never enters doctor queue`, async () => {
    const store = make(), caseId = newCaseId();
    const original = await store.createCase({ caseId, intake: emergencyIntake(), emergency: true });
    assert.deepEqual(await store.routeCase(caseId), original);
    assert.deepEqual(await store.getCase(caseId), original); assert.equal((await store.listDoctorCases()).cases.length, 0);
    await assert.rejects(store.getDoctorCase(caseId), e => e.code === 'CASE_NOT_FOUND');
  });
  test(`${mode}: missing and active handoff cases cannot be routed`, async () => {
    const store = make(), caseId = newCaseId();
    await assert.rejects(store.routeCase(caseId), e => e.code === 'CASE_NOT_FOUND');
    await store.createCase({ caseId, intake: routingIntake() });
    await store.updateCaseStatus(caseId, Handoff.PENDING, randomUUID());
    await assert.rejects(store.routeCase(caseId), e => e.code === 'ROUTING_NOT_ALLOWED');
  });
  test(`${mode}: routing before or after M3 preserves handoff receipt and routing`, async () => {
    for (const first of [true, false]) {
      const store = make(), caseId = newCaseId(), attemptId = randomUUID();
      await store.createCase({ caseId, intake: routingIntake() });
      const originalRoute = first ? (await store.routeCase(caseId)).routing : null;
      await store.updateCaseStatus(caseId, Handoff.PENDING, attemptId); await store.updateCaseStatus(caseId, Handoff.ACTIVE, attemptId);
      await store.updateHandoffResult(caseId, { attemptId, receipt: { caseId: 'DEMO-1234ABCD' } });
      const routed = await store.routeCase(caseId);
      assert.equal(routed.handoffReceipt.caseId, 'DEMO-1234ABCD'); assert.equal(routed.handoffStatus, 'completed');
      assert.equal(routed.workflowStatus, Workflow.ROUTED); if (first) assert.deepEqual(routed.routing, originalRoute);
    }
  });
}
test('Firestore fresh-client read-back, no duplicate writes, incomplete state and changed facts rejected', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), id = newCaseId();
  await store.createCase({ caseId: id, intake: routingIntake() });
  const incomplete = { ...db.docs.get(id), workflowStatus: 'intake_in_progress' }; db.docs.set(id, incomplete);
  await assert.rejects(store.routeCase(id), e => e.code === 'ROUTING_NOT_ALLOWED');
  db.docs.set(id, { ...incomplete, workflowStatus: Workflow.INTAKE });
  const routed = await store.routeCase(id), writes = db.writes;
  assert.deepEqual((await createFirestoreCaseStore(db).getDoctorCase(id)).routing, routed.routing);
  await store.routeCase(id); assert.equal(db.writes, writes); assert.equal(db.docs.size, 1);
  db.docs.get(id).reportedFacts.patient.name = 'Changed outside application';
  await assert.rejects(store.routeCase(id), e => e.code === 'ROUTING_CONFLICT');
  await assert.rejects(store.getDoctorCase(id), e => e.code === 'CASE_NOT_FOUND');
  assert.equal((await store.listDoctorCases()).cases.length, 0);
});
test('confirmed emergency facts block routing even if workflow state is inconsistent', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), intake = routingIntake(), caseId = newCaseId();
  const flag = { type: 'current chest pain', status: 'confirmed', patientReportedText: 'I have chest pain now.' };
  intake.redFlags.push(flag); intake.evidence['redFlags.current chest pain'] = { utteranceId: 3, patientReportedText: flag.patientReportedText };
  await store.createCase({ caseId, intake });
  db.docs.get(caseId).workflowStatus = Workflow.INTAKE;
  await assert.rejects(store.routeCase(caseId), e => e.code === 'EMERGENCY_ROUTING_BLOCKED');
  assert.equal((await store.listDoctorCases()).cases.length, 0);
});
test('Firestore queue is bounded, paginated without duplicates, excludes unrouted cases', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db);
  for (let i = 0; i < 53; i++) { const caseId = newCaseId(); await store.createCase({ caseId, intake: routingIntake() }); if (i < 52) await store.routeCase(caseId); }
  const first = await store.listDoctorCases(), second = await store.listDoctorCases({ after: first.nextCursor });
  assert.equal(first.cases.length, 50); assert.equal(second.cases.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.cases, ...second.cases].map(doc => doc.caseId)).size, 52);
  assert.ok(first.cases.every(doc => !doc.reportedFacts && !doc.routingFactsHash));
});
test('routing HTTP rejects client decisions, foreign origins, invalid paths and safely reports storage failures', async t => {
  const store = createMemoryCaseStore(), id = newCaseId(), origin = 'http://127.0.0.1:4173';
  await store.createCase({ caseId: id, intake: routingIntake(), patientUid: 'verified-patient' });
  const handler = routingEndpoint(store, [origin], { resolvePatientIdentity: async uid => {
    assert.equal(uid, 'verified-patient'); return { firstName: 'Demo', lastName: 'Profile' };
  } }), server = createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, path = `/api/cases/${id}/route`;
  const post = (body = {}, originValue = origin) => fetch(base + path, { method: 'POST', headers: { Origin: originValue, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{ specialty: 'surgery' }, { specialty: 'neurology' }, { status: 'routed' }, { reasonSummary: 'injected' }, { routedAt: '2026-01-01' }, [], null]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({}, 'http://attacker.invalid')).status, 403);
  assert.equal((await fetch(base + '/api/doctor/cases?after=bad')).status, 400);
  assert.equal((await fetch(base + '/api/doctor/cases?specialty=invalid')).status, 400);
  assert.equal((await fetch(base + `/api/doctor/cases/${id}`)).status, 404);
  const response = await post(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).routing.specialty, 'neurology');
  assert.equal((await (await fetch(base + '/api/doctor/cases')).json()).cases.length, 1);
  const detail = await fetch(base + `/api/doctor/cases/${id}`), doctorCase = await detail.json();
  assert.equal(detail.status, 200); assert.deepEqual(doctorCase.patientIdentity, { firstName: 'Demo', lastName: 'Profile' });
  assert.equal(doctorCase.intakeSummary['Patient Name'], 'Demo Alex'); assert.equal(doctorCase.patient.name, 'Demo Alex');
  store.routeCase = async () => { throw new Error('secret provider payload'); };
  const failure = await post(); assert.equal(failure.status, 503); assert.ok(!(await failure.text()).includes('secret'));
});

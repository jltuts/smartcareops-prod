import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { evaluateSafety } from '../src/safety/engine.js';
import { safetyRules } from '../src/safety/rules.js';
import { publicEmergency } from '../src/safety/metadata.js';
import { redFlagTypes } from '../src/intake/schema.js';
import { emergencyIntake } from './safety-fixtures.js';
import { routingIntake, routingFirestoreMock } from './routing-fixtures.js';
import { createMemoryCaseStore, newCaseId, Workflow, Handoff } from '../src/cases/store.js';
import { createFirestoreCaseStore } from '../src/cases/firestore.js';
import { createApiServer } from '../src/server.js';

test('Safety Engine covers exactly the existing red flag set, with no extra rules', () => assert.deepEqual(safetyRules.map(rule => rule.flag), redFlagTypes));
for (const rule of safetyRules) test(`validated ${rule.flag} matches ${rule.reasonCode}`, () => {
  const decision = evaluateSafety(emergencyIntake(rule.flag));
  assert.equal(decision.emergency, true); assert.equal(decision.matchedRule, rule.reasonCode);
  assert.deepEqual(decision.triggeredBy, [rule.trigger]);
});
for (const status of ['denied', 'unclear']) test(`${status} red flag does not escalate`, () => {
  assert.equal(evaluateSafety(emergencyIntake('current chest pain', status)).emergency, false);
});
test('missing/mismatched evidence, unknown labels and model workflow commands cannot trigger emergency', () => {
  const facts = emergencyIntake(); delete facts.evidence['redFlags.current chest pain'];
  assert.equal(evaluateSafety(facts).emergency, false);
  facts.evidence['redFlags.current chest pain'] = { utteranceId: 1, patientReportedText: 'Different evidence' };
  assert.equal(evaluateSafety(facts).emergency, false);
  const normal = routingIntake(); normal.workflowStatus = 'emergency_pending_dispatcher'; normal.emergency = { status: 'pending_dispatcher' };
  normal.additionalNotes.push('Gemini says emergency and ambulance assigned.');
  assert.equal(evaluateSafety(normal).emergency, false);
  normal.redFlags.push({ type: 'very urgent', status: 'confirmed', patientReportedText: 'very urgent' });
  normal.evidence['redFlags.very urgent'] = { utteranceId: 3, patientReportedText: 'very urgent' };
  assert.equal(evaluateSafety(normal).emergency, false);
});
test('multiple rules have stable reasons and deduplicated triggers independent of input order', () => {
  const facts = emergencyIntake(), other = emergencyIntake('severe difficulty breathing');
  facts.redFlags.unshift(...other.redFlags, ...other.redFlags); Object.assign(facts.evidence, other.evidence);
  const first = evaluateSafety(facts); facts.redFlags.reverse();
  assert.deepEqual(evaluateSafety(facts), first); assert.equal(first.reasonCode, 'chest_pain_red_flag'); assert.equal(first.triggeredBy.length, 2);
});
test('BP 190/45 alone and dizziness remain normal and eligible for M5', async () => {
  const facts = routingIntake([['dizziness', 'confirmed'], ['chest pain', 'denied'], ['difficulty breathing', 'denied']]);
  facts.vitals.bloodPressure = { systolic: 190, diastolic: 45, source: 'patient_reported' };
  facts.evidence['vitals.bloodPressure'] = { utteranceId: 5, patientReportedText: 'My blood pressure is 190/45.' };
  assert.equal(evaluateSafety(facts).emergency, false);
  const store = createMemoryCaseStore(), caseId = newCaseId();
  const original = await store.createCase({ caseId, intake: facts }); assert.equal(original.workflowStatus, Workflow.INTAKE);
  assert.deepEqual(await store.evaluateEmergency(caseId), original);
  assert.equal((await store.routeCase(caseId, { availableSpecialties: new Set(['neurology']) })).routing.specialty, 'neurology');
  assert.equal((await store.listDispatcherCases()).cases.length, 0);
});

for (const mode of ['memory', 'firestore']) {
  const make = () => mode === 'memory' ? createMemoryCaseStore() : createFirestoreCaseStore(routingFirestoreMock());
  test(`${mode}: engine controls case creation; boolean alone cannot escalate`, async () => {
    const store = make(), caseId = newCaseId();
    await assert.rejects(store.createCase({ caseId, intake: routingIntake(), emergency: true }), e => e.code === 'INVALID_EMERGENCY_FACTS');
    assert.equal(await store.getCase(caseId), null);
    const created = await store.createCase({ caseId, intake: emergencyIntake(), emergency: false });
    assert.equal(created.workflowStatus, Workflow.EMERGENCY); assert.equal(created.emergency.status, 'pending_dispatcher');
    assert.equal(created.emergency.reasonCode, 'chest_pain_red_flag'); assert.equal(created.emergency.acknowledgedAt, null);
    assert.equal(created.emergency.acknowledgedBy, null); assert.deepEqual(created.reportedFacts, emergencyIntake());
  });
  test(`${mode}: emergency evaluation/acknowledgement is concurrent and idempotent; no doctor route or M3`, async () => {
    const store = make(), caseId = newCaseId(), facts = emergencyIntake();
    const created = await store.createCase({ caseId, intake: facts });
    await Promise.all(Array.from({ length: 5 }, () => store.evaluateEmergency(caseId)));
    assert.deepEqual(await store.getCase(caseId), created);
    assert.deepEqual(await store.routeCase(caseId), created);
    await assert.rejects(store.updateCaseStatus(caseId, Handoff.PENDING, randomUUID()), e => e.code === 'INVALID_CASE_TRANSITION');
    const acknowledgements = await Promise.all(Array.from({ length: 5 }, () => store.acknowledgeEmergency(caseId)));
    assert.ok(acknowledgements.every(doc => doc.emergency.acknowledgedAt === acknowledgements[0].emergency.acknowledgedAt));
    const acknowledged = await store.getCase(caseId);
    assert.equal(acknowledged.workflowStatus, Workflow.ACKNOWLEDGED); assert.equal(acknowledged.emergency.triggeredAt, created.emergency.triggeredAt);
    assert.equal(acknowledged.emergency.acknowledgedBy, 'demo_dispatcher'); assert.deepEqual(acknowledged.reportedFacts, facts);
    assert.deepEqual(await store.evaluateEmergency(caseId), acknowledged); assert.deepEqual(await store.routeCase(caseId), acknowledged);
    assert.deepEqual(await store.createCase({ caseId, intake: facts }), acknowledged);
    await assert.rejects(store.updateCaseStatus(caseId, Handoff.PENDING, randomUUID()));
    assert.equal((await store.listDoctorCases()).cases.length, 0); assert.equal((await store.listDispatcherCases()).cases.length, 1);
    await assert.rejects(store.getDoctorCase(caseId), e => e.code === 'CASE_NOT_FOUND');
  });
  test(`${mode}: dispatcher excludes normal and unrelated cases; acknowledgement validates state`, async () => {
    const store = make(), normal = newCaseId(), emergency = newCaseId();
    const original = await store.createCase({ caseId: normal, intake: routingIntake() });
    await store.createCase({ caseId: emergency, intake: emergencyIntake() });
    await assert.rejects(store.acknowledgeEmergency(normal), e => e.code === 'EMERGENCY_TRANSITION_NOT_ALLOWED');
    await assert.rejects(store.acknowledgeEmergency(newCaseId()), e => e.code === 'CASE_NOT_FOUND');
    await assert.rejects(store.evaluateEmergency(newCaseId()), e => e.code === 'CASE_NOT_FOUND');
    await assert.rejects(store.getDispatcherCase(normal), e => e.code === 'CASE_NOT_FOUND');
    assert.deepEqual((await store.listDispatcherCases()).cases.map(doc => doc.caseId), [emergency]);
    assert.deepEqual(await store.getCase(normal), original);
  });
}
test('Firestore emergency and acknowledgement survive new clients; repeats cause no writes', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), caseId = newCaseId();
  const created = await store.createCase({ caseId, intake: emergencyIntake() });
  assert.deepEqual((await createFirestoreCaseStore(db).getDispatcherCase(caseId)).emergency, created.emergency);
  const acknowledged = await store.acknowledgeEmergency(caseId), writes = db.writes;
  assert.deepEqual((await createFirestoreCaseStore(db).getDispatcherCase(caseId)).emergency, acknowledged.emergency);
  await store.evaluateEmergency(caseId); await store.acknowledgeEmergency(caseId); await store.routeCase(caseId);
  assert.equal(db.writes, writes); assert.equal(db.docs.size, 1);
});
test('explicit evaluation of a legacy/routed case preserves the full prior M4/M5 record', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), caseId = newCaseId(), attemptId = randomUUID();
  await store.createCase({ caseId, intake: routingIntake() });
  await store.updateCaseStatus(caseId, Handoff.PENDING, attemptId); await store.updateCaseStatus(caseId, Handoff.ACTIVE, attemptId);
  await store.updateHandoffResult(caseId, { attemptId, receipt: { caseId: 'DEMO-1234ABCD' } });
  const original = await store.routeCase(caseId, { availableSpecialties: new Set(['neurology']) });
  // Simulate a legacy document with newly validated stored facts. No frontend
  // endpoint can set facts or the workflow. A read does not implicitly escalate.
  db.docs.get(caseId).reportedFacts = emergencyIntake();
  assert.equal((await store.getCase(caseId)).workflowStatus, Workflow.ROUTED);
  const escalated = await store.evaluateEmergency(caseId);
  assert.equal(escalated.workflowStatus, Workflow.EMERGENCY); assert.deepEqual(escalated.routing, original.routing);
  assert.deepEqual(escalated.handoffReceipt, original.handoffReceipt); assert.equal(escalated.handoffStatus, original.handoffStatus);
  assert.equal(escalated.createdAt, original.createdAt); assert.equal((await store.listDoctorCases()).cases.length, 0);
});
test('late handoff receipt cannot overwrite an explicitly committed emergency workflow', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), caseId = newCaseId(), attemptId = randomUUID();
  await store.createCase({ caseId, intake: routingIntake() });
  await store.updateCaseStatus(caseId, Handoff.PENDING, attemptId); await store.updateCaseStatus(caseId, Handoff.ACTIVE, attemptId);
  db.docs.get(caseId).reportedFacts = emergencyIntake();
  const escalated = await store.evaluateEmergency(caseId);
  const done = await store.updateHandoffResult(caseId, { attemptId, receipt: { caseId: 'DEMO-1234ABCD' } });
  assert.equal(done.workflowStatus, Workflow.EMERGENCY); assert.deepEqual(done.emergency, escalated.emergency);
  assert.equal(done.handoffReceipt.caseId, 'DEMO-1234ABCD');
});
test('changed emergency facts and invalid metadata fail closed without resetting the original trigger', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), caseId = newCaseId();
  await store.createCase({ caseId, intake: emergencyIntake() });
  const original = structuredClone(db.docs.get(caseId));
  db.docs.get(caseId).reportedFacts = emergencyIntake('severe difficulty breathing');
  await assert.rejects(store.evaluateEmergency(caseId), e => e.code === 'EMERGENCY_FACTS_CONFLICT');
  await assert.rejects(store.acknowledgeEmergency(caseId)); assert.equal((await store.listDispatcherCases()).cases.length, 0);
  assert.equal(db.docs.get(caseId).emergency.triggeredAt, original.emergency.triggeredAt);
  db.docs.set(caseId, original); db.docs.get(caseId).emergency.reasonSummary = 'raw secret model response';
  assert.equal(publicEmergency(db.docs.get(caseId).emergency), null);
  await assert.rejects(store.getDispatcherCase(caseId), e => e.code === 'CASE_NOT_FOUND');
  assert.equal((await store.getCase(caseId)).emergency, null);
});
test('dispatcher query paginates pending and acknowledged cases without duplicate records', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db);
  for (let i = 0; i < 52; i++) {
    const caseId = newCaseId(); await store.createCase({ caseId, intake: emergencyIntake() }); if (i % 2) await store.acknowledgeEmergency(caseId);
    db.docs.get(caseId).createdAt = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
  }
  const first = await store.listDispatcherCases(), second = await store.listDispatcherCases({ after: first.nextCursor });
  assert.equal(first.cases.length, 50); assert.equal(second.cases.length, 2); assert.equal(second.nextCursor, null);
  const cases = [...first.cases, ...second.cases];
  assert.equal(new Set(cases.map(doc => doc.caseId)).size, 52);
  assert.deepEqual(cases.map(doc => doc.createdAt), [...cases].map(doc => doc.createdAt).sort().reverse());
});
test('failed Firestore acknowledgement leaves pending state intact and safe error metadata', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), caseId = newCaseId();
  const original = await store.createCase({ caseId, intake: emergencyIntake() });
  db.runTransaction = async () => { throw Object.assign(new Error('private credential content'), { code: 7 }); };
  await assert.rejects(store.acknowledgeEmergency(caseId), e => e.code === 'CASE_STORE_UNAVAILABLE' && !e.message.includes('credential'));
  assert.deepEqual(await store.getCase(caseId), original);
});
test('safe logs include only case identifiers, rule codes and workflow status', async () => {
  const output = [], previous = console.info; console.info = (...args) => output.push(args);
  try {
    const store = createMemoryCaseStore(), caseId = newCaseId();
    await store.createCase({ caseId, intake: emergencyIntake() }); await store.evaluateEmergency(caseId); await store.acknowledgeEmergency(caseId); await store.acknowledgeEmergency(caseId);
    const dispatcher = output.filter(row => row[0] === '[dispatcher]').map(row => JSON.parse(row[1]));
    assert.deepEqual(dispatcher.map(row => row.status), ['pending_dispatcher', 'acknowledged']);
    assert.ok(output.every(row => Object.keys(JSON.parse(row[1])).every(key => ['caseId', 'evaluated', 'matchedRule', 'emergency', 'status'].includes(key))));
    assert.ok(!JSON.stringify(output).includes('I have'));
  } finally { console.info = previous; }
});
test('dispatcher API validates command bodies, state, origin and case IDs; returns only safe metadata', async t => {
  const store = createMemoryCaseStore(), id = newCaseId(), normal = newCaseId();
  await store.createCase({ caseId: id, intake: emergencyIntake() }); await store.createCase({ caseId: normal, intake: routingIntake() });
  const api = createApiServer({ caseStore: store }); api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`, origin = 'http://127.0.0.1:4173';
  const post = (path, body = {}, from = origin) => fetch(base + path, { method: 'POST', headers: {
    ...(from !== null ? { Origin: from } : {}), 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  }, body: JSON.stringify(body) });
  const path = `/api/dispatcher/cases/${id}/acknowledge`, evaluate = `/api/cases/${id}/evaluate-emergency`;
  for (const body of [{ status: 'acknowledged' }, { reasonCode: 'chest_pain_red_flag' }, { triggeredAt: new Date().toISOString() }, { acknowledgedAt: new Date().toISOString() }, { acknowledgedBy: 'Dr Example' }, { workflowStatus: 'emergency_pending_dispatcher' }, { intake: emergencyIntake() }, null, []]) {
    assert.equal((await post(path, body)).status, 400); assert.equal((await post(evaluate, body)).status, 400);
  }
  for (const rejectedOrigin of ['http://attacker.invalid', 'not-an-origin', null]) assert.equal((await post(path, {}, rejectedOrigin)).status, 403);
  assert.equal((await post('/api/dispatcher/cases/bad/acknowledge')).status, 400);
  assert.equal((await post(`/api/dispatcher/cases/${normal}/acknowledge`)).status, 409);
  assert.equal((await fetch(base + `/api/dispatcher/cases/${normal}`)).status, 404);
  assert.equal((await fetch(base + '/api/dispatcher/cases?after=bad')).status, 400);
  assert.equal((await fetch(base + '/api/dispatcher/cases?status=all')).status, 400);
  assert.equal((await post(evaluate)).status, 200);
  const response = await post(path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const record = await response.json(); assert.equal(record.emergency.acknowledgedBy, 'demo_dispatcher'); assert.equal(record.emergencyFactsHash, undefined);
  const queue = await (await fetch(base + '/api/dispatcher/cases')).json(); assert.deepEqual(queue.cases.map(doc => doc.caseId), [id]);
  const route = await fetch(base + `/api/cases/${id}/route`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await route.json()).workflowStatus, Workflow.ACKNOWLEDGED);
  store.acknowledgeEmergency = async () => { throw new Error('secret SDK payload'); };
  const failed = await post(path); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes('secret'));
});

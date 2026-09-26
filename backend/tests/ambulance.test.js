import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createMemoryCaseStore, newCaseId, Workflow, Handoff } from '../src/cases/store.js';
import { createFirestoreCaseStore } from '../src/cases/firestore.js';
import { createApiServer } from '../src/server.js';
import { emergencyIntake } from './safety-fixtures.js';
import { routingIntake, routingFirestoreMock } from './routing-fixtures.js';
import { publicAmbulance } from '../src/ambulance/fleet.js';

async function acknowledged(store) {
  const caseId = newCaseId(); await store.createCase({ caseId, intake: emergencyIntake() }); await store.acknowledgeEmergency(caseId); return caseId;
}
for (const mode of ['memory', 'firestore']) {
  const make = () => mode === 'memory' ? createMemoryCaseStore() : createFirestoreCaseStore(routingFirestoreMock());
  test(`${mode}: available fictional fleet is bounded and reading it does not reserve units`, async () => {
    const store = make(), fleet = await store.listAmbulances();
    assert.deepEqual(fleet.units.map(unit => unit.unitId), ['AMB-01', 'AMB-02', 'AMB-03']); assert.ok(fleet.simulation);
    assert.ok(fleet.units.every(unit => unit.status === 'available' && !unit.caseId));
    assert.deepEqual(await store.listAmbulances(), fleet);
  });
  test(`${mode}: acknowledged emergency assignment persists without changing previous milestone data`, async () => {
    const store = make(), id = await acknowledged(store), original = await store.getCase(id);
    const saved = await store.assignAmbulance(id, 'AMB-01');
    assert.equal(saved.workflowStatus, 'ambulance_assigned'); assert.equal(saved.ambulance.unitId, 'AMB-01');
    assert.equal(saved.ambulance.status, 'assigned'); assert.equal(saved.ambulance.dispatchedAt, null);
    for (const key of ['caseId', 'reportedFacts', 'patient', 'emergency', 'routing', 'handoffStatus', 'handoffReceipt', 'failure', 'createdAt']) assert.deepEqual(saved[key], original[key]);
    assert.equal((await store.listAmbulances()).units[0].status, 'assigned');
    assert.equal((await store.getDispatcherCase(id)).ambulance.unitId, 'AMB-01');
    assert.equal((await store.listDispatcherCases()).cases[0].ambulance.unitId, 'AMB-01');
    await assert.rejects(store.getDoctorCase(id)); await assert.rejects(store.updateCaseStatus(id, Handoff.PENDING, randomUUID()));
    assert.deepEqual(await store.routeCase(id), saved);
  });
  test(`${mode}: same case/unit assignment and dispatch retries preserve timestamps and M6 status`, async () => {
    const store = make(), id = await acknowledged(store);
    const assigned = await Promise.all(Array.from({ length: 5 }, () => store.assignAmbulance(id, 'AMB-01')));
    assert.ok(assigned.every(doc => doc.ambulance.assignedAt === assigned[0].ambulance.assignedAt));
    const dispatched = await Promise.all(Array.from({ length: 5 }, () => store.dispatchAmbulance(id)));
    assert.ok(dispatched.every(doc => doc.ambulance.dispatchedAt === dispatched[0].ambulance.dispatchedAt));
    const final = await store.getCase(id); assert.equal(final.workflowStatus, 'ambulance_en_route');
    assert.equal(final.ambulance.status, 'en_route'); assert.equal(final.emergency.status, 'acknowledged');
    assert.equal(final.ambulance.assignedAt, assigned[0].ambulance.assignedAt);
    assert.deepEqual(await store.assignAmbulance(id, 'AMB-01'), final); assert.deepEqual(await store.acknowledgeEmergency(id), final);
    assert.deepEqual(await store.evaluateEmergency(id), final); assert.deepEqual(await store.routeCase(id), final);
    assert.equal((await store.listDispatcherCases()).cases.length, 1);
  });
  test(`${mode}: two cases racing for one unit have exactly one winner`, async () => {
    const store = make(), a = await acknowledged(store), b = await acknowledged(store);
    const results = await Promise.allSettled([a, b].map(id => store.assignAmbulance(id, 'AMB-01')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AMBULANCE_UNAVAILABLE');
    const records = await Promise.all([a, b].map(id => store.getCase(id)));
    assert.equal(records.filter(doc => doc.ambulance).length, 1);
    assert.equal(records.find(doc => !doc.ambulance).workflowStatus, Workflow.ACKNOWLEDGED);
  });
  test(`${mode}: two units racing for one case cannot both be reserved`, async () => {
    const store = make(), id = await acknowledged(store);
    const results = await Promise.allSettled(['AMB-01', 'AMB-02'].map(unit => store.assignAmbulance(id, unit)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AMBULANCE_ALREADY_ASSIGNED');
    assert.equal((await store.listAmbulances()).units.filter(unit => unit.status === 'assigned').length, 1);
  });
  test(`${mode}: normal, routed, handoff-completed and pending emergency cases reject assignment`, async () => {
    const store = make();
    for (const state of ['normal', 'routed', 'handoff', 'emergency']) {
      const id = newCaseId(); await store.createCase({ caseId: id, intake: state === 'emergency' ? emergencyIntake() : routingIntake() });
      if (state === 'routed') await store.routeCase(id);
      if (state === 'handoff') { const attemptId = randomUUID(); await store.updateCaseStatus(id, Handoff.PENDING, attemptId); await store.updateCaseStatus(id, Handoff.ACTIVE, attemptId); await store.updateHandoffResult(id, { attemptId, receipt: { caseId: 'DEMO-1234ABCD' } }); }
      const original = await store.getCase(id);
      await assert.rejects(store.assignAmbulance(id, 'AMB-01'), e => e.code === 'AMBULANCE_ASSIGNMENT_NOT_ALLOWED');
      await assert.rejects(store.dispatchAmbulance(id), e => e.code === 'AMBULANCE_DISPATCH_NOT_ALLOWED');
      assert.deepEqual(await store.getCase(id), original);
    }
    assert.ok((await store.listAmbulances()).units.every(unit => unit.status === 'available'));
  });
  test(`${mode}: missing cases, malformed unit IDs and reassignment are rejected`, async () => {
    const store = make(), id = await acknowledged(store);
    await assert.rejects(store.assignAmbulance(newCaseId(), 'AMB-01'), e => e.code === 'CASE_NOT_FOUND');
    for (const unit of ['AMB-99', '../AMB-01', 'AMB-01?x=1', { unitId: 'AMB-01' }]) await assert.rejects(store.assignAmbulance(id, unit), e => e.code === 'INVALID_AMBULANCE_UNIT');
    await store.assignAmbulance(id, 'AMB-01'); await store.dispatchAmbulance(id);
    await assert.rejects(store.assignAmbulance(id, 'AMB-02'), e => e.code === 'AMBULANCE_ALREADY_ASSIGNED');
  });
}
test('Firestore reserves case and unit together; new client reads both; duplicate operations cause no writes', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), id = await acknowledged(store);
  const assigned = await store.assignAmbulance(id, 'AMB-01'); const afterAssignment = db.writes;
  assert.equal(db.fleet.get('AMB-01').caseId, id); assert.equal(db.fleet.size, 1);
  assert.deepEqual((await createFirestoreCaseStore(db).getCase(id)).ambulance, assigned.ambulance);
  await store.assignAmbulance(id, 'AMB-01'); assert.equal(db.writes, afterAssignment);
  const final = await store.dispatchAmbulance(id), afterDispatch = db.writes;
  assert.equal(afterDispatch, afterAssignment + 1);
  await store.dispatchAmbulance(id); await store.assignAmbulance(id, 'AMB-01'); assert.equal(db.writes, afterDispatch);
  assert.deepEqual((await createFirestoreCaseStore(db).getCase(id)).ambulance, final.ambulance);
});
test('failed multi-document transaction does not partially reserve a unit or mutate case', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), id = await acknowledged(store), original = await store.getCase(id);
  const run = db.runTransaction;
  db.runTransaction = work => run(async transaction => { await work(transaction); throw new Error('private SDK failure'); });
  await assert.rejects(store.assignAmbulance(id, 'AMB-01'), e => e.code === 'CASE_STORE_UNAVAILABLE' && !e.message.includes('private'));
  assert.deepEqual(await store.getCase(id), original); assert.equal(db.fleet.size, 0);
});
test('inconsistent reservation or changed safety facts fail closed', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db), id = await acknowledged(store);
  await store.assignAmbulance(id, 'AMB-01');
  const unit = structuredClone(db.fleet.get('AMB-01'));
  db.fleet.get('AMB-01').caseId = newCaseId();
  await assert.rejects(store.dispatchAmbulance(id), e => e.code === 'AMBULANCE_STATE_CONFLICT');
  await assert.rejects(store.assignAmbulance(id, 'AMB-01'), e => e.code === 'AMBULANCE_STATE_CONFLICT');
  db.fleet.set('AMB-01', unit); db.docs.get(id).reportedFacts.redFlags[0].status = 'unclear';
  await assert.rejects(store.dispatchAmbulance(id)); await assert.rejects(store.assignAmbulance(id, 'AMB-01'));
  assert.equal(db.docs.get(id).workflowStatus, 'ambulance_assigned');
});
test('malformed persisted fleet state is not advertised as available', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db);
  db.fleet.set('AMB-01', { unitId: 'AMB-99', status: 'available', secret: 'hidden' });
  await assert.rejects(store.listAmbulances(), e => e.code === 'AMBULANCE_STATE_CONFLICT');
});
test('safe ambulance projections and logs contain no extra raw data or duplicate events', async () => {
  const output = [], previous = console.info; console.info = (...row) => output.push(row);
  try {
    const store = createMemoryCaseStore(), id = await acknowledged(store);
    await store.assignAmbulance(id, 'AMB-01'); await store.assignAmbulance(id, 'AMB-01');
    await store.dispatchAmbulance(id); await store.dispatchAmbulance(id);
    const rows = output.filter(row => row[0] === '[ambulance]').map(row => JSON.parse(row[1]));
    assert.deepEqual(rows, [{ caseId: id, unitId: 'AMB-01', event: 'assigned' }, { caseId: id, unitId: 'AMB-01', event: 'en_route' }]);
    const ambulance = (await store.getCase(id)).ambulance;
    assert.deepEqual(publicAmbulance({ ...ambulance, raw: 'hidden' }), ambulance);
    assert.equal(publicAmbulance({ ...ambulance, status: 'arrived' }), null);
  } finally { console.info = previous; }
});
test('ambulance HTTP accepts commands only; enforces origin, identifiers, eligibility and safe errors', async t => {
  const store = createMemoryCaseStore(), id = await acknowledged(store), api = createApiServer({ caseStore: store });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`, assign = `/api/cases/${id}/ambulance/AMB-01/assign`, dispatch = `/api/cases/${id}/ambulance/dispatch`;
  const post = (path, value = {}, origin = 'http://127.0.0.1:4173') => fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  for (const body of [{ unitId: 'AMB-01' }, { status: 'assigned' }, { assignedAt: 'now' }, { dispatchedAt: 'now' }, { workflowStatus: 'ambulance_en_route' }, { ambulance: {} }, [], null]) {
    assert.equal((await post(assign, body)).status, 400); assert.equal((await post(dispatch, body)).status, 400);
  }
  assert.equal((await post(assign, {}, 'http://attacker.invalid')).status, 403);
  assert.equal((await post(assign.replace('AMB-01', 'AMB-99'))).status, 400);
  assert.equal((await fetch(base + '/api/ambulances?unit=AMB-01')).status, 400);
  assert.equal((await post(dispatch)).status, 409);
  const response = await post(assign); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).workflowStatus, 'ambulance_assigned');
  const fleet = await (await fetch(base + '/api/ambulances')).json(); assert.equal(fleet.units[0].status, 'assigned'); assert.equal(fleet.units[0].caseId, undefined);
  assert.equal((await post(dispatch)).status, 200);
  store.dispatchAmbulance = async () => { throw new Error('secret provider content'); };
  const failure = await post(dispatch); assert.equal(failure.status, 503); assert.ok(!(await failure.text()).includes('secret'));
});

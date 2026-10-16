import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { createFirestoreCaseStore } from '../src/cases/firestore.js';
import { routingIntake, routingFirestoreMock } from './routing-fixtures.js';
import { emergencyIntake } from './safety-fixtures.js';
import { assessment, observationSet } from './clinical-fixtures.js';
import { memoryClinicalStore } from '../src/clinical/storage.js';
import { createClinicalService } from '../src/clinical/service.js';
import { createHospitalHandoff } from '../src/hospital/service.js';
import { createRestConnector, createComputerUseConnector, demoHospitalEndpoint } from '../src/hospital/connectors.js';
import { hash } from '../src/hospital/contracts.js';
import { firestoreClinicalStore } from '../src/clinical/storage.js';
import { database } from './firestore-contract-fixture.js';

export const handoffAssessment = context => ({ ...assessment(context), recommendedActions: [{ toolName: 'submit_hospital_case', arguments: { hospitalId: 'HOSP-001' }, proposedRisk: 'READ_ONLY', expectedOutcome: 'Submit fictional case for hospital review.' }] });
const receipt = input => ({ ...input, payload: undefined, payloadDigest: hash(input.payload), receiptId: 'DEMO-1234ABCD', verified: true });
async function fixture({ caseStore = createMemoryCaseStore(), connector, legacy, emergency = false, now } = {}) {
  const caseId = newCaseId(), store = memoryClinicalStore();
  await caseStore.createCase({ caseId, intake: emergency ? emergencyIntake() : routingIntake(), fictionalConfirmed: true, submittedForReview: true });
  let calls = 0, lookups = 0;
  const rest = connector || { submitCase: async input => { calls++; return receipt(input); }, lookupReceipt: async () => { lookups++; return null; } };
  const hospitalHandoff = createHospitalHandoff({ store: caseStore, connectors: { rest, computer_use: legacy }, ...(legacy ? { targets: { 'HOSP-001': { connector: 'computer_use', version: 'legacy-v1' } } } : {}) });
  const settings = { caseId, caseStore, store, hospitalHandoff, model: async c => handoffAssessment(c), modelName: 'test-model', ...(now ? { now } : {}) };
  const service = createClinicalService(settings);
  return { ...settings, service, calls: () => calls, lookups: () => lookups };
}
async function propose(f) {
  await f.service.requestRun('doctor_review'); await f.service.tick();
  const view = await f.service.view(); assert.equal(view.runs[0].status, 'completed');
  assert.equal(view.plans[0].recommendedActions[0].effectiveRisk, 'HIGH_IMPACT');
  return view.approvals[0].approvalId;
}

test('intake persistence and reads create review state only, no clinical jobs or approvals', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) { const c = await f.caseStore.getCase(f.caseId); assert.equal(c.workflowStatus, 'submitted_for_clinical_review'); assert.deepEqual(c.hospitalHandoffs, []); }
  const v = await f.service.view(); assert.equal(v.meta, null); assert.deepEqual(v.events, []); assert.deepEqual(v.executions, []); assert.deepEqual(v.approvals, []);
  assert.equal((await f.caseStore.listDoctorCases()).cases.length, 1); assert.equal(f.calls(), 0);
});
test('clinical agent proposes; pending and rejected external handoff cannot execute', async () => {
  const f = await fixture(), id = await propose(f);
  await assert.rejects(f.service.execute(id), { code: 'APPROVAL_REQUIRED' });
  await f.service.decide(id, 'rejected'); await f.service.tick();
  const patientCase = await f.caseStore.getCase(f.caseId);
  assert.equal(patientCase.clinicalReview, null);
  assert.equal(patientCase.workflowStatus, 'submitted_for_clinical_review');
  await assert.rejects(f.service.execute(id), { code: 'APPROVAL_REQUIRED' }); assert.equal(f.calls(), 0);
});
test('action-specific Doctor approval stays separate from case review status and handoff', async () => {
  const f = await fixture(), id = await propose(f);
  await f.service.decide(id, 'approved');
  const patientCase = await f.caseStore.getCase(f.caseId);
  assert.equal(patientCase.clinicalReview, null);
  assert.equal(patientCase.workflowStatus, 'submitted_for_clinical_review');
  assert.deepEqual(patientCase.hospitalHandoffs, []);
});
test('doctor approval executes REST by default exactly once across concurrent calls, restart and replan', async () => {
  const f = await fixture(), id = await propose(f);
  await f.service.decide(id, 'approved');
  await Promise.all([f.service.execute(id), f.service.execute(id)]);
  const restarted = createClinicalService(f); await restarted.execute(id); await restarted.requestRun('review_again'); await restarted.tick();
  assert.equal(f.calls(), 1); const view = await restarted.view(); assert.equal(view.receipts.length, 1);
  const patient = await f.caseStore.getCase(f.caseId); assert.equal(patient.hospitalHandoffs[0].connector, 'rest'); assert.equal(patient.handoffStatus, 'completed'); assert.equal(patient.workflowStatus, 'submitted_for_clinical_review');
});
test('new evidence and expired approvals reject hospital execution', async () => {
  for (const stale of ['evidence', 'expiry']) {
    let clock = Date.now(); const f = await fixture({ now: () => clock }), id = await propose(f);
    await f.service.decide(id, 'approved');
    if (stale === 'evidence') await f.service.append(observationSet()); else clock += 900001;
    await assert.rejects(f.service.execute(id), { code: stale === 'evidence' ? 'STALE_APPROVAL' : 'APPROVAL_EXPIRED' }); assert.equal(f.calls(), 0);
  }
});
test('changed connector configuration invalidates an approved binding', async () => {
  const f = await fixture(), id = await propose(f); await f.service.decide(id, 'approved');
  const hospitalHandoff = createHospitalHandoff({ store: f.caseStore, connectors: { computer_use: {} }, targets: { 'HOSP-001': { connector: 'computer_use', version: 'changed' } } });
  await assert.rejects(createClinicalService({ ...f, hospitalHandoff }).execute(id), { code: 'STALE_APPROVAL' }); assert.equal(f.calls(), 0);
});
test('emergency cannot enter normal handoff or doctor review queue', async () => {
  const f = await fixture({ emergency: true });
  await assert.rejects(f.service.requestRun('normal_review'));
  assert.throws(() => f.hospitalHandoff.binding({ source: 'smartcareops_demo', workflowStatus: 'emergency_pending_dispatcher', reportedFacts: emergencyIntake() }, 'HOSP-001'));
  assert.equal((await f.caseStore.listDoctorCases()).cases.length, 0); assert.equal(f.calls(), 0);
});
test('UNKNOWN_OUTCOME survives restart and stale approval; reconciliation only looks up receipt', async () => {
  let posts = 0, gets = 0, saved, available = false;
  const f = await fixture({ connector: { submitCase: async input => { posts++; saved = receipt(input); throw new Error('response lost'); }, lookupReceipt: async () => { gets++; return available ? saved : null; } } });
  const id = await propose(f); await f.service.decide(id, 'approved');
  assert.equal((await f.service.execute(id)).status, 'unknown_outcome');
  assert.equal((await f.caseStore.getCase(f.caseId)).hospitalHandoffs[0].failureCode, 'UNKNOWN_OUTCOME');
  await f.service.append(observationSet());
  const restarted = createClinicalService(f); await restarted.tick(); assert.equal(posts, 1); assert.equal(gets, 1);
  available = true; await restarted.tick(); assert.equal(posts, 1); assert.equal((await restarted.view()).receipts.length, 1);
});
test('clinical unknown journal without a connector claim never creates a submission on recovery', async () => {
  const f = await fixture(), id = await propose(f); await f.service.decide(id, 'approved');
  const original = f.hospitalHandoff.submitCase;
  f.hospitalHandoff.submitCase = async () => { throw new Error('crash before dispatch'); };
  await f.service.execute(id); f.hospitalHandoff.submitCase = original;
  await createClinicalService(f).tick(); assert.equal(f.calls(), 0); assert.deepEqual((await f.caseStore.getCase(f.caseId)).hospitalHandoffs, []);
});
test('explicit legacy connector preserves engine receipt and requires doctor confirmation', async () => {
  let browserCalls = 0;
  const legacy = createComputerUseConnector({ portalUrl: () => 'http://127.0.0.1:8080/hospital-demo', run: async options => {
    browserCalls++; assert.equal(await options.confirm({ explanation: 'provider details' }), true);
    options.emit({ status: 'completed', caseId: 'DEMO-1234ABCD' }); return { caseId: 'DEMO-1234ABCD' };
  } });
  const f = await fixture({ legacy }), id = await propose(f); await f.service.decide(id, 'approved');
  const work = f.service.execute(id); let execution;
  for (let i = 0; i < 100; i++) { execution = (await f.service.view()).executions.find(e => e.confirmation); if (execution) break; await new Promise(r => setTimeout(r, 5)); }
  assert.equal(execution.confirmation.status, 'pending'); assert(!JSON.stringify(execution).includes('provider details'));
  assert.equal((await createClinicalService(f).execute(id)).status, 'running');
  assert.equal((await f.service.view()).executions.find(e => e.executionId === execution.executionId).confirmation.status, 'pending');
  await f.service.confirmHospitalAction(execution.executionId, execution.confirmation.confirmationId, true);
  assert.equal((await work).status, 'succeeded'); await f.service.execute(id);
  assert.equal(browserCalls, 1); assert.equal(f.calls(), 0);
});
test('REST transport uses authenticated allowlisted HTTP; lost response reconciles with GET, no legacy fallback', async t => {
  const caseStore = createMemoryCaseStore(), credential = 'fictional-test-token';
  const handler = demoHospitalEndpoint({ store: caseStore, credential });
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
  const endpoint = () => `http://127.0.0.1:${server.address().port}/internal/hospital-demo/cases`;
  assert.equal((await fetch(endpoint())).status, 403);
  let posts = 0, gets = 0;
  const connector = createRestConnector({ endpoint, credential, request: async (url, options) => { const response = await fetch(url, options); if (options.method === 'POST') { posts++; await response.text(); throw new Error('lost response'); } gets++; return response; } });
  const f = await fixture({ caseStore, connector }), id = await propose(f); await f.service.decide(id, 'approved');
  assert.equal((await f.service.execute(id)).status, 'unknown_outcome');
  assert.equal((await f.service.execute(id)).status, 'succeeded'); assert.equal(posts, 1); assert.equal(gets, 1);
  await assert.rejects(createRestConnector({ endpoint: () => 'https://example.com/cases', credential }).submitCase({}));
});
test('Firestore claim and receipt survive competing services and restart', async () => {
  const db = routingFirestoreMock(), caseStore = createFirestoreCaseStore(db);
  const f = await fixture({ caseStore }), id = await propose(f); await f.service.decide(id, 'approved');
  await Promise.all([f.service.execute(id), createClinicalService({ ...f, caseStore: createFirestoreCaseStore(db) }).execute(id)]);
  assert.equal(f.calls(), 1); assert.equal((await createFirestoreCaseStore(db).getCase(f.caseId)).hospitalHandoffs[0].status, 'succeeded');
  assert.equal((await caseStore.listDoctorCases()).cases.length, 1);
});

test('Firestore clinical intent commits before connector I/O; fresh client retains receipt', async () => {
  const f = await fixture(), db = database(), store = firestoreClinicalStore(db);
  const service = createClinicalService({ ...f, store }); f.service = service;
  const original = f.hospitalHandoff.submitCase; let calls = 0;
  f.hospitalHandoff.submitCase = async (...args) => {
    calls++; const state = await store.read(f.caseId);
    assert(Object.values(state.toolExecutions).some(e => e.toolName === 'submit_hospital_case' && e.status === 'running'));
    // A second transaction completes during connector I/O, proving the effect
    // is not inside the transaction callback that claims the clinical action.
    await store.transaction(f.caseId, () => {}); return original(...args);
  };
  const id = await propose(f); await service.decide(id, 'approved'); await service.execute(id);
  const restarted = createClinicalService({ ...f, store: firestoreClinicalStore(db) });
  await restarted.execute(id); assert.equal(calls, 1); assert.equal((await restarted.view()).receipts.length, 1);
});

test('historical unresolved and completed M3 cases cannot be resubmitted through new connector', async () => {
  for (const status of ['in_progress', 'failed', 'completed']) {
    const db = routingFirestoreMock(), caseStore = createFirestoreCaseStore(db), f = await fixture({ caseStore });
    const doc = db.docs.get(f.caseId); doc.handoffStatus = status;
    if (status === 'completed') doc.handoffReceipt = { caseId: 'DEMO-1234ABCD' };
    const id = await propose(f); await f.service.decide(id, 'approved'); await f.service.execute(id);
    assert.equal(f.calls(), 0); assert.equal((await caseStore.getCase(f.caseId)).handoffStatus, status);
  }
});

test('REST failure never selects an available legacy connector', async () => {
  const f = await fixture(); let rest = 0, legacy = 0;
  const hospitalHandoff = createHospitalHandoff({ store: f.caseStore, connectors: {
    rest: { submitCase: async () => { rest++; throw new Error('uncertain'); }, lookupReceipt: async () => null },
    computer_use: { submitCase: async () => { legacy++; } },
  } });
  f.service = createClinicalService({ ...f, hospitalHandoff });
  const id = await propose(f); await f.service.decide(id, 'approved'); await f.service.execute(id); await f.service.execute(id);
  assert.equal(rest, 1); assert.equal(legacy, 0);
});

test('emergency transition after approval blocks dispatch at case-level claim', async () => {
  const db = routingFirestoreMock(), caseStore = createFirestoreCaseStore(db), f = await fixture({ caseStore });
  const id = await propose(f); await f.service.decide(id, 'approved');
  db.docs.get(f.caseId).workflowStatus = 'emergency_pending_dispatcher';
  await assert.rejects(f.service.execute(id)); assert.equal(f.calls(), 0);
});

test('new evidence invalidates a pending legacy safety confirmation without external submission', async () => {
  let effects = 0;
  const legacy = createComputerUseConnector({ portalUrl: () => 'http://127.0.0.1:8080/hospital-demo', run: async options => {
    if (await options.confirm({})) effects++;
    throw new Error('Stopped before submit');
  } });
  const f = await fixture({ legacy }), id = await propose(f); await f.service.decide(id, 'approved');
  const work = f.service.execute(id); let execution;
  for (let i = 0; i < 100; i++) { execution = (await f.service.view()).executions.find(e => e.confirmation); if (execution) break; await new Promise(r => setTimeout(r, 5)); }
  await f.service.append(observationSet());
  await assert.rejects(f.service.confirmHospitalAction(execution.executionId, execution.confirmation.confirmationId, true), { code: 'STALE_APPROVAL' });
  await f.service.close(); await work; assert.equal(effects, 0);
});

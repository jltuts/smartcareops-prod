import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './firestore-contract-fixture.js';
import { operationsFixture } from './operations-fixtures.js';
import { firestoreOperationsStore } from '../src/operations/storage.js';
import { createOperationsService } from '../src/operations/service.js';
async function fixture() {
  const f = await operationsFixture(), db = database();
  for (const caseId of f.ids) db.documents.set(`cases/${caseId}`, await f.caseStore.getCase(caseId));
  const state = await f.store.read('OPS-HOSP-001'); db.documents.set('resourceEnvironments/m9-demo', state.resourceEnvironment);
  const store = firestoreOperationsStore(db), service = createOperationsService({ ...f, store });
  for (const member of Object.values(state.members)) await service.enroll({ caseId: member.caseId, status: member.status });
  await service.tick(); return { ...f, db, store, service };
}
test('Firestore fresh clients preserve hospital plans, resource evidence and receipts', async () => {
  const f = await fixture(), first = await f.service.view(); await f.service.decide(first.approvals[0].approvalId, 'approved');
  await f.service.execute(first.plans[0].revisionId, first.approvals[0].actionId);
  const receipts = (await f.service.view()).receipts;
  await f.service.changeCapacity({ requestId: 'zero', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 });
  const fresh = createOperationsService({ ...f, store: firestoreOperationsStore(f.db) }); await fresh.tick(); const final = await fresh.view();
  assert.equal(final.plans.length, 2); assert.deepEqual(final.plans[0], first.plans[0]); assert.equal(final.resourceEvidence.length, 14);
  for (const receipt of receipts) assert.deepEqual(final.receipts.find(item => item.receiptId === receipt.receiptId), receipt);
  assert.equal(final.events.find(item => item.eventId === 'capacity_zero').status, 'completed');
  assert.equal(final.currentSnapshot.ambulance.available, 3);
  assert.equal(final.observations.filter(item => item.snapshotRef === final.currentSnapshot.snapshotId).length, 9);
});
test('Firestore capacity/event rollback is atomic', async () => {
  const f = await fixture(); f.db.failNext();
  await assert.rejects(f.service.changeCapacity({ requestId: 'fail', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 }));
  const state = await f.store.read('OPS-HOSP-001'); assert.equal(state.resourceEnvironment.version, 2); assert.equal(state.events.capacity_fail, undefined);
});
test('Firestore reservation race between intent and effect supersedes the action', async () => {
  const f = await fixture(), view = await f.service.view(), approval = view.approvals[0]; await f.service.decide(approval.approvalId, 'approved');
  let writes = 0;
  const racingStore = { ...f.store, transaction: async (...args) => { if (++writes === 2) f.db.documents.set('ambulances/AMB-02', { caseId: f.ids[2] }); return f.store.transaction(...args); } };
  const raced = createOperationsService({ ...f, store: racingStore });
  const result = await raced.execute(view.plans[0].revisionId, approval.actionId); assert.equal(result.status, 'superseded');
  assert.equal((await raced.view()).receipts.length, 2);
  assert.deepEqual(f.db.documents.get('ambulances/AMB-02'), { caseId: f.ids[2] });
});
test('Firestore changed case projection blocks approval and replans', async () => {
  const f = await fixture(), first = await f.service.view();
  const doc = f.db.documents.get(`cases/${f.ids[0]}`); doc.updatedAt = '2026-09-24T01:00:00.000Z';
  await assert.rejects(f.service.decide(first.approvals[0].approvalId, 'approved'));
  await f.service.tick(); assert.equal((await f.service.view()).plans.length, 2);
});
test('expired lease recovers without replaying an uncertain high impact effect', async () => {
  const f = await fixture();
  await f.store.transaction('OPS-HOSP-001', state => {
    state.meta.lease = { runId: 'lost_run', claimId: 'lost', expiresAt: 0 }; state.agentRuns.lost_run = { status: 'running' };
    state.toolExecutions.unknown = { status: 'running', approvalId: 'unknown', executionId: 'unknown' };
  });
  const fresh = createOperationsService({ ...f, store: firestoreOperationsStore(f.db) }); await fresh.tick(); const view = await fresh.view();
  assert.equal(view.runs.find(item => item.status === 'interrupted')?.status, 'interrupted');
  assert.equal(view.executions.find(item => item.executionId === 'unknown').status, 'unknown_outcome');
  assert.equal(view.receipts.length, 2);
});

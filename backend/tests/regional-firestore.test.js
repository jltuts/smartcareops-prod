import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './firestore-contract-fixture.js';
import { regionalFixture } from './regional-fixtures.js';
import { firestoreRegionalStore } from '../src/regional/storage.js';
import { createRegionalService } from '../src/regional/service.js';
async function fixture() {
  const f = await regionalFixture(), db = database(), hospital = await f.hospital.store.read('OPS-HOSP-001');
  db.documents.set('hospitalWorkspaces/OPS-HOSP-001', hospital.meta); db.documents.set('resourceEnvironments/m9-demo', hospital.resourceEnvironment);
  for (const bucket of ['plans', 'snapshots', 'events']) for (const [id, value] of Object.entries(hospital[bucket])) db.documents.set(`hospitalWorkspaces/OPS-HOSP-001/${bucket}/${id}`, value);
  const store = firestoreRegionalStore(db), service = createRegionalService({ ...f, store }); await service.seed({ requestId: 'demo', windowEnd: new Date().toISOString() }); await service.tick();
  return { ...f, store, service, db };
}
test('regional Firestore fresh clients preserve plans, handoff, evidence and completed receipts', async () => {
  const f = await fixture(), first = await f.service.view(); await f.service.decide(first.approvals[0].approvalId, 'approved'); await f.service.execute(first.plans[0].revisionId, first.approvals[0].actionId);
  const receipts = (await f.service.view()).receipts; await f.service.changeCapacity({ requestId: 'zero', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 2 });
  const fresh = createRegionalService({ ...f, store: firestoreRegionalStore(f.db) }); await fresh.tick(); const after = await fresh.view();
  assert.equal(after.plans.length, 2); assert.deepEqual(after.plans[0], first.plans[0]); assert.equal(after.resourceEvidence.length, 20);
  for (const receipt of receipts) assert.deepEqual(after.receipts.find(item => item.receiptId === receipt.receiptId), receipt);
  assert.equal(after.events.find(item => item.eventId === 'capacity_zero').status, 'completed'); assert.equal(after.events.filter(item => item.type === 'regional.hospital_signal.received').length, 1);
});
test('regional Firestore capacity/event rollback is atomic', async () => {
  const f = await fixture(); f.db.failNext(); await assert.rejects(f.service.changeCapacity({ requestId: 'failed', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 2 }));
  assert.equal(f.db.documents.get('resourceEnvironments/m9-demo').version, 2); assert.equal((await f.service.view()).events.some(item => item.eventId === 'capacity_failed'), false);
});
test('regional execution revalidates fleet after journal intent', async () => {
  const f = await fixture(), first = await f.service.view(), approval = first.approvals[0]; await f.service.decide(approval.approvalId, 'approved');
  let writes = 0; const racing = { ...f.store, transaction: (...args) => { if (++writes === 2) f.db.documents.set('ambulances/AMB-03', { caseId: 'fictional-reservation' }); return f.store.transaction(...args); } };
  const service = createRegionalService({ ...f, store: racing }); assert.equal((await service.execute(first.plans[0].revisionId, approval.actionId)).status, 'superseded');
  assert.equal((await service.view()).receipts.length, 2);
});
test('regional expired claim recovers while uncertain action is never blindly replayed', async () => {
  const f = await fixture(); await f.store.transaction('REGION-DEMO-001', state => {
    state.meta.lease = { runId: 'lost', claimId: 'lost', expiresAt: 0 }; state.agentRuns.lost = { status: 'running' };
    state.toolExecutions.uncertain = { executionId: 'uncertain', approvalId: 'lost', status: 'running' };
  });
  const fresh = createRegionalService({ ...f, store: firestoreRegionalStore(f.db) }); await fresh.tick(); const view = await fresh.view();
  assert.equal(view.executions.find(item => item.executionId === 'uncertain').status, 'unknown_outcome'); assert.equal(view.receipts.length, 2); assert.equal(view.runs.some(item => item.status === 'interrupted'), true);
});

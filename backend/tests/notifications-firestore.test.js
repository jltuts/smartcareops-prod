import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './firestore-contract-fixture.js';
import { operationsFixture, operationsAssessment } from './operations-fixtures.js';
import { firestoreOperationsStore } from '../src/operations/storage.js';
import { createOperationsService } from '../src/operations/service.js';
const model = context => ({ ...operationsAssessment(context), recommendedActions: ['notify_hospital_operations', 'notify_command_center', 'schedule_followup_review'].map(toolName => ({ toolName, expectedOutcome: 'Demo review only.' })) });
async function fixture() {
  const f = await operationsFixture(), db = database();
  for (const caseId of f.ids) db.documents.set(`cases/${caseId}`, await f.caseStore.getCase(caseId));
  const baseline = await f.store.read('OPS-HOSP-001'); db.documents.set('resourceEnvironments/m9-demo', baseline.resourceEnvironment);
  const store = firestoreOperationsStore(db), settings = { ...f, store, notificationsEnabled: true, model }, service = createOperationsService(settings);
  for (const member of Object.values(baseline.members)) await service.enroll({ caseId: member.caseId, status: member.status });
  await service.tick(); return { ...settings, service, db };
}
test('Firestore notifications, delivery receipts and followups survive fresh clients without duplicate delivery', async () => {
  const f = await fixture(), first = await f.service.view();
  const fresh = createOperationsService({ ...f, store: firestoreOperationsStore(f.db) }); await fresh.tick(); const next = await fresh.view();
  assert.deepEqual(next.notifications, first.notifications); assert.deepEqual(next.receipts, first.receipts); assert.deepEqual(next.followups, first.followups);
  const delivered = first.notifications.find(n => n.status === 'sent'); await fresh.execute(delivered.sourceRevisionId, delivered.sourceActionId);
  assert.deepEqual((await fresh.view()).receipts, first.receipts);
});
test('evidence race after notification intent prevents delivery at the Firestore effect boundary', async () => {
  const f = await fixture(), view = await f.service.view(), notice = view.notifications.find(n => n.status === 'pending'), approval = view.approvals.find(a => a.actionId === notice.sourceActionId);
  await f.service.decide(approval.approvalId, 'approved'); let writes = 0;
  const store = { ...f.store, transaction: async (...args) => { if (++writes === 2) f.db.documents.set('ambulances/AMB-02', { caseId: f.ids[2] }); return f.store.transaction(...args); } };
  const fresh = createOperationsService({ ...f, store }); const result = await fresh.execute(notice.sourceRevisionId, notice.sourceActionId);
  assert.equal(result.status, 'superseded'); const next = await fresh.view(); assert.equal(next.notifications.find(n => n.notificationId === notice.notificationId).status, 'superseded');
  assert.equal(next.receipts.filter(r => r.notificationId === notice.notificationId).length, 0);
});
test('failed Firestore delivery commit has no partial sent record and safe retry creates one receipt', async () => {
  const f = await fixture(), first = await f.service.view(), notice = first.notifications.find(n => n.status === 'pending'), approval = first.approvals.find(a => a.actionId === notice.sourceActionId);
  await f.service.decide(approval.approvalId, 'approved'); let writes = 0;
  const store = { ...f.store, transaction: async (...args) => { if (++writes === 2) f.db.failNext(); return f.store.transaction(...args); } };
  await assert.rejects(createOperationsService({ ...f, store }).execute(notice.sourceRevisionId, notice.sourceActionId));
  const failed = await f.service.view(); assert.equal(failed.notifications.find(n => n.notificationId === notice.notificationId).status, 'approved'); assert.equal(failed.receipts.filter(r => r.notificationId === notice.notificationId).length, 0);
  const fresh = createOperationsService({ ...f, store: firestoreOperationsStore(f.db) }); await fresh.execute(notice.sourceRevisionId, notice.sourceActionId); await fresh.execute(notice.sourceRevisionId, notice.sourceActionId);
  assert.equal((await fresh.view()).receipts.filter(r => r.notificationId === notice.notificationId).length, 1);
});

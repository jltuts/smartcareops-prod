import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, assessment, observationSet } from './clinical-fixtures.js';
import { operationsFixture, operationsAssessment } from './operations-fixtures.js';
import { regionalFixture, regionalAssessment } from './regional-fixtures.js';
import { createRegionalService } from '../src/regional/service.js';
import { createClinicalService } from '../src/clinical/service.js';
import { memoryClinicalStore } from '../src/clinical/storage.js';
import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { emergencyIntake } from './safety-fixtures.js';
import { createNotificationCenter } from '../src/notifications/service.js';
import { bindArguments, availableTools, validateBoundArguments, validateMessage, messageFor, channels } from '../src/notifications/contracts.js';
const clinicalModel = context => ({ ...assessment(context), recommendedActions: ['notify_doctor', 'notify_patient_status', 'inspect_notification_history', 'schedule_followup_review'].map(toolName => ({ toolName, arguments: {}, proposedRisk: 'READ_ONLY', expectedOutcome: 'Fictional review only.' })) });
const hospitalModel = context => ({ ...operationsAssessment(context), recommendedActions: ['notify_hospital_operations', 'notify_command_center', 'schedule_followup_review'].map(toolName => ({ toolName, expectedOutcome: 'Fictional review only.' })) });
const regionalModel = context => ({ ...regionalAssessment(context), recommendedActions: ['notify_participating_hospital', 'notify_command_center', 'inspect_notification_history', 'schedule_followup_review'] });
const regional = () => regionalFixture({ notificationsEnabled: true, model: regionalModel });
test('clinical notifications deliver once with immutable original case and receipts', async () => {
  const f = await fixture({ notificationsEnabled: true, model: clinicalModel }), original = await f.caseStore.getCase(f.caseId);
  await f.service.append(observationSet()); await f.service.tick(); const first = await f.service.view();
  assert.equal(first.notifications.length, 2); assert(first.notifications.every(n => n.status === 'sent' && n.simulation));
  assert.equal(first.receipts.filter(r => r.notificationId).length, 2); assert.equal(first.followups.length, 1);
  await f.service.tick(); assert.deepEqual((await f.service.view()).receipts, first.receipts);
  await f.service.append(observationSet('changed', 90)); await f.service.tick();
  const next = await f.service.view(); for (const receipt of first.receipts) assert.deepEqual(next.receipts.find(r => r.receiptId === receipt.receiptId), receipt);
  assert.deepEqual(await f.caseStore.getCase(f.caseId), original);
});
test('hospital low risk notice delivers and command center requires approval', async () => {
  const f = await operationsFixture({ notificationsEnabled: true, model: hospitalModel }); await f.service.tick(); const first = await f.service.view();
  assert.equal(first.notifications.find(n => n.toolName === 'notify_hospital_operations').status, 'sent');
  const notice = first.notifications.find(n => n.toolName === 'notify_command_center'); assert.equal(notice.status, 'pending');
  await assert.rejects(f.service.execute(notice.sourceRevisionId, notice.sourceActionId));
  const approval = first.approvals.find(a => a.actionId === notice.sourceActionId); await f.service.decide(approval.approvalId, 'approved');
  await f.service.execute(notice.sourceRevisionId, notice.sourceActionId); assert.equal((await f.service.view()).notifications.find(n => n.notificationId === notice.notificationId).status, 'sent');
});
test('regional approval, supersession, fresh service and immutable delivered receipts', async () => {
  const f = await regional(); await f.service.tick(); const first = await f.service.view();
  assert.equal(first.notifications.length, 2); assert(first.notifications.every(n => n.status === 'pending'));
  const notice = first.notifications.find(n => n.toolName === 'notify_participating_hospital'), approval = first.approvals.find(a => a.actionId === notice.sourceActionId);
  await f.service.decide(approval.approvalId, 'approved'); await f.service.execute(notice.sourceRevisionId, notice.sourceActionId);
  const delivered = await f.service.view(); const stale = first.notifications.find(n => n.toolName === 'notify_command_center');
  await f.service.changeCapacity({ requestId: 'm12-change', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await assert.rejects(f.service.execute(stale.sourceRevisionId, stale.sourceActionId)); await assert.rejects(f.service.decide(first.approvals.find(a => a.actionId === stale.sourceActionId).approvalId, 'approved'));
  const fresh = createRegionalService(f); await fresh.tick(); await fresh.tick(); const next = await fresh.view();
  assert.equal(next.notifications.find(n => n.notificationId === stale.notificationId).status, 'superseded');
  assert.equal(next.notifications.find(n => n.notificationId === notice.notificationId).status, 'sent');
  for (const receipt of delivered.receipts) assert.deepEqual(next.receipts.find(r => r.receiptId === receipt.receiptId), receipt);
  assert.equal(next.receipts.filter(r => r.notificationId === notice.notificationId).length, 1);
});
test('notification center inspection does not mutate durable state', async () => {
  const f = await regional(); await f.service.tick(); const before = await f.store.read('REGION-DEMO-001');
  const center = createNotificationCenter({ sources: [{ scope: 'regional', subjectId: 'REGION-DEMO-001', store: f.store, service: f.service }] });
  const view = await center.view(); assert.equal(view.notifications.length, 2); assert(view.notifications.every(n => n.canApprove));
  await center.view('participating_hospital'); assert.deepEqual(await f.store.read('REGION-DEMO-001'), before);
  await assert.rejects(center.view('arbitrary-address'));
});
test('scheduled review survives service restart and triggers only once', async () => {
  let clock = Date.now(); const f = await regionalFixture({ notificationsEnabled: true, model: regionalModel, now: () => clock, notificationOptions: { followupMinutes: 1 } });
  await f.service.tick(); const before = await f.service.view(); assert.equal(before.followups[0].status, 'scheduled');
  const fresh = createRegionalService(f); clock += 61000; await fresh.tick(); const after = await fresh.view();
  assert.equal(after.followups.find(item => item.followupId === before.followups[0].followupId).status, 'triggered');
  assert.equal(after.plans.length, 2); await fresh.tick(); assert.equal((await fresh.view()).plans.length, 2);
});
test('recipient scope, acknowledged dispatcher gate, and all simulated channels are bounded', () => {
  for (const channel of channels) assert.equal(bindArguments('notify_doctor', { scope: 'clinical' }, { channel }).deliveryMode, channel);
  assert.throws(() => bindArguments('notify_doctor', { scope: 'regional' }));
  assert.throws(() => validateBoundArguments('notify_doctor', { recipientId: 'UNKNOWN', deliveryMode: 'in_app' }));
  assert.throws(() => bindArguments('notify_doctor', { scope: 'clinical' }, { channel: 'real_sms' }));
  assert(!availableTools({ scope: 'clinical' }, {}).includes('notify_dispatcher'));
  assert(availableTools({ scope: 'clinical' }, { notificationCaseState: { acknowledgedEmergency: true } }).includes('notify_dispatcher'));
});
test('unsafe notification wording and unrestricted model text are rejected', () => {
  const safe = messageFor('notify_participating_hospital'); validateMessage('notify_participating_hospital', safe);
  for (const messageSummary of ['outbreak confirmed', 'Emergency services contacted', '<script>bad()</script>']) assert.throws(() => validateMessage('notify_participating_hospital', { ...safe, messageSummary }));
});
test('uncertain delivery is failed without a fabricated receipt or automatic replay', async () => {
  const f = await regional(); await f.service.tick(); const view = await f.service.view(), notice = view.notifications[0], approval = view.approvals.find(a => a.actionId === notice.sourceActionId);
  await f.service.decide(approval.approvalId, 'approved');
  await f.store.transaction('REGION-DEMO-001', state => { const executionId = `reg_exec_${notice.sourceActionId}`; state.toolExecutions[executionId] = { executionId, planRevisionId: notice.sourceRevisionId, actionId: notice.sourceActionId, toolName: notice.toolName, approvalId: approval.approvalId, status: 'unknown_outcome' }; });
  await f.service.tick(); await f.service.tick(); const next = await f.service.view();
  assert.equal(next.notifications.find(n => n.notificationId === notice.notificationId).status, 'failed');
  assert.equal(next.receipts.filter(r => r.notificationId === notice.notificationId).length, 0);
  assert.equal(next.events.filter(e => e.type === 'notification.failed').length, 1);
});
for (const channel of channels) test(`simulated delivery creates a ${channel} receipt without provider integration`, async () => {
  const f = await fixture({ notificationsEnabled: true, notificationOptions: { channel }, model: context => ({ ...clinicalModel(context), recommendedActions: clinicalModel(context).recommendedActions.slice(0, 1) }) });
  await f.service.append(observationSet()); await f.service.tick(); const view = await f.service.view();
  assert.equal(view.notifications[0].deliveryMode, channel); assert.equal(view.receipts[0].channel, channel); assert.equal(view.receipts[0].status, 'delivered'); assert.equal(view.receipts[0].simulation, true);
});
test('dispatcher notification requires acknowledged emergency plus approval and leaves fleet unchanged', async () => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(); await caseStore.createCase({ caseId, intake: emergencyIntake('severe difficulty breathing') });
  const store = memoryClinicalStore(new Map(), () => caseStore.listAmbulances(), { readCase: id => caseStore.getCase(id) });
  assert(!availableTools({ scope: 'clinical' }, await store.read(caseId)).includes('notify_dispatcher'));
  await caseStore.acknowledgeEmergency(caseId); const fleet = await caseStore.listAmbulances(), original = await caseStore.getCase(caseId);
  const service = createClinicalService({ caseId, caseStore, store, notificationsEnabled: true, model: context => ({ ...assessment(context), recommendedActions: [{ toolName: 'notify_dispatcher', arguments: {}, proposedRisk: 'READ_ONLY', expectedOutcome: 'Fictional dispatcher review only.' }] }) });
  await service.append(observationSet()); await service.tick(); const first = await service.view();
  assert.equal(first.notifications[0].status, 'pending'); await assert.rejects(service.execute(first.approvals[0].approvalId));
  await service.decide(first.approvals[0].approvalId, 'approved'); await service.execute(first.approvals[0].approvalId); await service.execute(first.approvals[0].approvalId);
  const next = await service.view(); assert.equal(next.notifications[0].status, 'sent'); assert.equal(next.receipts.length, 1); assert.deepEqual(await caseStore.listAmbulances(), fleet); assert.deepEqual(await caseStore.getCase(caseId), original);
});

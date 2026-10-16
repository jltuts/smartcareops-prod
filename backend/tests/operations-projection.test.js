import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { durableEvent } from '../src/agent-core/lifecycle.js';
import { createEventEnvelope } from '../src/events/contracts.js';
import { createMemoryOperationsProjectionStore, createFirestoreOperationsProjectionStore } from '../src/events/operations-projection.js';
import { createFirestoreOperationsBoundaryReader } from '../src/events/operations-boundary.js';
import { createOperationsPushHandler } from '../src/events/operations-push.js';
import { createOperationsEventOrchestrator } from '../src/events/operations-orchestrator.js';
import { eventDatabase } from './event-firestore-fixture.js';
import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { memoryOperationsStore } from '../src/operations/storage.js';
import { createOperationsService } from '../src/operations/service.js';
import { operationsAssessment } from './operations-fixtures.js';
import { routingIntake } from './routing-fixtures.js';

const source = (id = 'operations_test') => durableEvent({ eventId: id, type: 'operations.snapshot_recorded',
  subjectType: 'network', subjectId: 'm55-demo', version: 3, now: Date.parse('2026-10-06T03:00:00.000Z'),
  causationId: null, scope: { simulation: true }, pending: true });
const push = async (handler, body) => {
  const request = new EventEmitter();
  Object.assign(request, { method: 'POST', url: '/events/operations', headers: { 'content-type': 'application/json' } });
  let status = null;
  const response = { writeHead(value) { status = value; return this; }, end() {} };
  handler(request, response);
  request.emit('data', Buffer.from(JSON.stringify(body)));
  request.emit('end');
  await new Promise(resolve => setImmediate(resolve));
  return status;
};

test('operations projection records metadata once and rejects non-operations events', async () => {
  const store = createMemoryOperationsProjectionStore(new Map(), { now: () => Date.parse('2026-10-06T03:01:00.000Z') });
  const envelope = createEventEnvelope(source(), 'operations');
  const first = await store.record(envelope, 'message-1'), duplicate = await store.record(envelope, 'message-2');
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.projections.size, 1);
  assert.equal(duplicate.messageId, 'message-1');
  assert.deepEqual(Object.keys(first), ['projectionId', 'outboxId', 'eventId', 'eventType', 'eventFamily', 'subjectType',
    'subjectId', 'subjectVersion', 'occurredAt', 'correlationId', 'messageId', 'envelopeDigest', 'projectedAt', 'duplicate']);
  await assert.rejects(store.record(createEventEnvelope(source('clinical_test'), 'clinical'), 'message-3'), /OPERATIONS_EVENT_FAMILY_REQUIRED/);
});

test('Firestore operations projection is idempotent across duplicate delivery', async () => {
  const db = eventDatabase(), store = createFirestoreOperationsProjectionStore(db, { now: () => Date.parse('2026-10-06T03:01:00.000Z') });
  const envelope = createEventEnvelope(source(), 'operations');
  assert.equal((await store.record(envelope, 'message-1')).duplicate, false);
  assert.equal((await store.record(envelope, 'message-2')).duplicate, true);
  assert.equal([...db.documents.keys()].filter(key => key.startsWith('eventOperations/')).length, 1);
  assert.equal(db.documents.get(`eventOperations/${envelope.outboxId}`).messageId, 'message-1');
});

test('routine intake routing decision is durable, idempotent and sanitized for the Demo Console', async () => {
  const now = () => Date.parse('2026-10-06T03:01:00.000Z');
  const db = eventDatabase(), store = createFirestoreOperationsProjectionStore(db, { now });
  const envelope = createEventEnvelope(durableEvent({ eventId: 'case.created:SC-12345678-1234-4123-8123-123456789abc', type: 'case.created',
    subjectType: 'case', subjectId: 'SC-12345678-1234-4123-8123-123456789abc', version: 1, now: Date.parse('2026-10-06T03:00:00.000Z'), scope: {} }), 'operations');
  await store.record(envelope, 'message-1');
  const first = await store.recordRoutingDecision(envelope, { handled: false });
  const duplicate = await store.recordRoutingDecision(envelope, { handled: false });
  assert.equal(first.routingDisposition, 'normal_care');
  assert.equal(first.hospitalOperationsTriggered, false);
  assert.equal(duplicate.classifiedAt, first.classifiedAt);
  await assert.rejects(store.recordRoutingDecision(envelope, { handled: true }), /OPERATIONS_ROUTING_CONFLICT/);

  db.documents.set(`eventOutbox/${envelope.outboxId}`, { status: 'published' });
  db.documents.set(`eventAudit/${envelope.outboxId}`, { outcome: 'recorded' });
  const emergencyStates = new Map();
  const reader = createFirestoreOperationsBoundaryReader(db, { readCaseState: async caseId => emergencyStates.get(caseId) || null });
  const boundary = await reader();
  assert.equal(boundary.reference, envelope.subjectId);
  assert.equal(boundary.routing, 'Kept in normal care');
  assert.equal(boundary.hospitalOperationsTriggered, false);
  assert.deepEqual(boundary.trace.map(item => item.status), ['Committed', 'Recorded', 'Recorded', 'Recorded', 'Normal care', 'Not requested']);
  assert.deepEqual(await reader(envelope.subjectId), boundary);
  assert.equal(JSON.stringify(boundary).includes(envelope.subjectId), true);
  assert.equal(JSON.stringify(boundary).includes(envelope.outboxId), false);

  const legacyEnvelope = createEventEnvelope(durableEvent({ eventId: 'case.created:SC-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', type: 'case.created',
    subjectType: 'case', subjectId: 'SC-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: 1, now: Date.parse('2026-10-06T02:00:00.000Z'), scope: {} }), 'operations');
  await store.record(legacyEnvelope, 'legacy-message');
  db.documents.set(`eventOutbox/${legacyEnvelope.outboxId}`, { status: 'published' });
  db.documents.set(`eventAudit/${legacyEnvelope.outboxId}`, { outcome: 'recorded' });
  const legacy = await reader(legacyEnvelope.subjectId);
  assert.equal(legacy.classificationStatus, 'legacy_unclassified');
  assert.equal(legacy.hospitalOperationsTriggered, null);
  assert.deepEqual(legacy.trace.slice(-2).map(item => item.status), ['Not recorded', 'Not recorded']);
  assert.equal(JSON.stringify(legacy).includes(legacyEnvelope.subjectId), true);

  emergencyStates.set(envelope.subjectId, { workflowStatus: 'ambulance_en_route', emergency: { status: 'acknowledged' },
    ambulance: { status: 'en_route' }, emergencyDestination: { status: 'accepted' } });
  const emergency = await reader(envelope.subjectId);
  assert.equal(emergency.classificationStatus, 'emergency');
  assert.equal(emergency.routing, 'Dispatcher acknowledged');
  assert.equal(emergency.hospitalOperationsTriggered, false);
  assert.deepEqual(emergency.trace.slice(-3).map(item => item.status), ['Dispatcher acknowledged', 'Ambulance en route', 'Not requested']);
  assert.equal(await reader(), null);
});

test('authenticated operations push accepts only its subscription and event family', async () => {
  const expected = 'projects/smartcareops-local/subscriptions/smartcareops-operations-events';
  const store = createMemoryOperationsProjectionStore(), errors = [];
  const handler = createOperationsPushHandler({ store, expectedSubscription: expected, logger: { error: (...args) => errors.push(args.join(' ')) } });
  const envelope = createEventEnvelope(source(), 'operations');
  const message = { messageId: 'message-1', data: Buffer.from(JSON.stringify(envelope)).toString('base64') };
  assert.equal(await push(handler, { subscription: expected, message }), 204);
  assert.equal(await push(handler, { subscription: expected, message: { ...message, messageId: 'message-2' } }), 204);
  assert.equal(await push(handler, { subscription: 'projects/other/subscriptions/operations', message }), 400);
  const clinical = createEventEnvelope(source('clinical_test'), 'clinical');
  assert.equal(await push(handler, { subscription: expected,
    message: { messageId: 'message-3', data: Buffer.from(JSON.stringify(clinical)).toString('base64') } }), 400);
  assert.equal(store.projections.size, 1);
  assert.equal(errors.length, 2);
  assert.equal(errors.join(' ').includes('m55-demo'), false);
});

test('case.created remains projection-only and never enrolls a routine Patient case', async () => {
  const calls = []; let ready = false;
  const orchestrate = createOperationsEventOrchestrator({
    async enroll(input) { calls.push(['enroll', input]); },
    async requestRun(input) { calls.push(['requestRun', input]); },
    async tick() { calls.push(['tick']); ready = true; },
    async view() { return { meta: { ready, lastError: null } }; },
  });
  const envelope = createEventEnvelope(durableEvent({ eventId: 'case.created:SC-12345678-1234-4123-8123-123456789abc', type: 'case.created',
    subjectType: 'case', subjectId: 'SC-12345678-1234-4123-8123-123456789abc', version: 1,
    now: Date.parse('2026-10-09T01:00:00.000Z'), scope: {} }), 'operations');
  assert.deepEqual(await orchestrate(envelope), { handled: false });
  assert.deepEqual(await orchestrate(envelope), { handled: false });
  assert.deepEqual(calls, []);
});

test('case.created does not create Hospital Operations membership or a plan', async () => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId();
  await caseStore.createCase({ caseId, intake: routingIntake([['dizziness', 'confirmed']]) });
  const service = createOperationsService({ caseStore, store: memoryOperationsStore(caseStore), model: async context => operationsAssessment(context) });
  const orchestrate = createOperationsEventOrchestrator(service);
  const envelope = createEventEnvelope(durableEvent({ eventId: `case.created:${caseId}`, type: 'case.created',
    subjectType: 'case', subjectId: caseId, version: 1, now: Date.parse('2026-10-09T01:00:00.000Z'), scope: {} }), 'operations');
  await orchestrate(envelope);
  const first = await service.view();
  assert.equal(first.members.length, 0);
  assert.equal(first.plans.length, 0);
  assert.equal(first.meta.ready, false);

  await orchestrate(envelope);
  const duplicate = await service.view();
  assert.equal(duplicate.members.length, 0);
  assert.equal(duplicate.plans.length, 0);
  await service.close();
});

test('capacity event records low-risk coordination and keeps command-center notice behind review', async () => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId();
  await caseStore.createCase({ caseId, intake: routingIntake([['dizziness', 'confirmed']]) });
  const store = memoryOperationsStore(caseStore);
  const model = async context => ({ ...operationsAssessment(context), recommendedActions: [
    { toolName: 'notify_hospital_operations', expectedOutcome: 'Record a fictional local review notice.' },
    { toolName: 'notify_command_center', expectedOutcome: 'Offer a fictional command-center notice for human review.' },
    { toolName: 'schedule_followup_review', expectedOutcome: 'Record a fictional follow-up review.' },
  ] });
  const worker = createOperationsService({ caseStore, store, model, notificationsEnabled: true });
  await worker.enroll({ caseId, status: 'incoming' });
  const orchestrate = createOperationsEventOrchestrator(worker);
  const envelope = createEventEnvelope(durableEvent({ eventId: 'hospital.capacity.changed:HOSP-001:1', type: 'hospital.capacity.changed',
    subjectType: 'hospital', subjectId: 'HOSP-001', version: 1, now: Date.parse('2026-10-09T01:00:00.000Z'), scope: {} }), 'operations');

  await orchestrate(envelope);
  const proposed = await worker.view();
  assert.equal(proposed.plans.length, 1);
  assert.equal(proposed.notifications.find(item => item.toolName === 'notify_hospital_operations').status, 'sent');
  assert.equal(proposed.decisionTrace.length, 3);
  assert.deepEqual(proposed.decisionTrace[0].triggers.map(item => item.eventType), ['hospital.capacity.changed']);
  assert.deepEqual(proposed.decisionTrace[0].evidenceRefs, proposed.plans[0].evidenceRefs);
  assert.equal(JSON.stringify(proposed.decisionTrace).includes(caseId), false);
  assert.equal(JSON.stringify(proposed.decisionTrace).includes('assessment'), false);
  const notice = proposed.notifications.find(item => item.toolName === 'notify_command_center');
  const approval = proposed.approvals.find(item => item.actionId === notice.sourceActionId);
  assert.equal(notice.status, 'pending');
  assert.equal(approval.status, 'pending');
  await assert.rejects(worker.execute(notice.sourceRevisionId, notice.sourceActionId), { code: 'OPERATIONS_STALE_ACTION' });

  const reviewer = createOperationsService({ caseStore, store, model, notificationsEnabled: true });
  await reviewer.decide(approval.approvalId, 'approved');
  await reviewer.execute(notice.sourceRevisionId, notice.sourceActionId);
  await reviewer.execute(notice.sourceRevisionId, notice.sourceActionId);
  const completed = await reviewer.view();
  assert.equal(completed.notifications.find(item => item.notificationId === notice.notificationId).status, 'sent');
  assert.equal(completed.receipts.filter(item => item.notificationId === notice.notificationId).length, 1);
  const completedTrace = completed.decisionTrace.find(item => item.action.actionId === notice.sourceActionId);
  assert.equal(completedTrace.approval.status, 'consumed');
  assert.equal(completedTrace.execution.status, 'succeeded');
  assert.equal(completedTrace.receipt.outcome, 'Simulated notification delivered');

  const receiptCount = completed.receipts.length;
  await orchestrate(envelope);
  const duplicate = await worker.view();
  assert.equal(duplicate.plans.length, 1);
  assert.equal(duplicate.notifications.length, proposed.notifications.length);
  assert.equal(duplicate.receipts.length, receiptCount);
  await reviewer.close();
  await worker.close();
});

test('projection-only behavior remains unchanged and unrelated operations events do not wake the agent', async () => {
  const calls = [];
  const orchestrate = createOperationsEventOrchestrator({
    async enroll(input) { calls.push(['enroll', input]); },
    async requestRun(input) { calls.push(['requestRun', input]); },
    async tick() { calls.push(['tick']); },
    async view() { return { meta: { ready: true, lastError: null } }; },
  });
  const envelope = createEventEnvelope(source('snapshot_test'), 'operations');
  assert.deepEqual(await orchestrate(envelope), { handled: false });
  assert.deepEqual(calls, []);

  const expected = 'projects/smartcareops-local/subscriptions/smartcareops-operations-events';
  const store = createMemoryOperationsProjectionStore(), handled = [];
  const handler = createOperationsPushHandler({ store, expectedSubscription: expected, onEvent: async event => { handled.push(event.eventId); return { handled: false }; } });
  const message = { messageId: 'message-4', data: Buffer.from(JSON.stringify(envelope)).toString('base64') };
  assert.equal(await push(handler, { subscription: expected, message }), 204);
  assert.deepEqual(handled, ['snapshot_test']);
  assert.equal(store.projections.size, 1);
  assert.equal(store.projections.get(envelope.outboxId).routingDisposition, 'normal_care');
});

test('failed orchestration is retried even after the durable projection already exists', async () => {
  const expected = 'projects/smartcareops-local/subscriptions/smartcareops-operations-events';
  const store = createMemoryOperationsProjectionStore(), errors = [];
  let attempts = 0;
  const handler = createOperationsPushHandler({ store, expectedSubscription: expected,
    onEvent: async () => { if (++attempts === 1) throw new Error('temporary'); },
    logger: { error: (...args) => errors.push(args.join(' ')) } });
  const envelope = createEventEnvelope(source('retry_test'), 'operations');
  const message = { messageId: 'message-5', data: Buffer.from(JSON.stringify(envelope)).toString('base64') };
  assert.equal(await push(handler, { subscription: expected, message }), 400);
  assert.equal(await push(handler, { subscription: expected, message: { ...message, messageId: 'message-6' } }), 204);
  assert.equal(attempts, 2);
  assert.equal(store.projections.size, 1);
  assert.equal(errors.length, 1);
});

test('a redelivered capacity event requests a fresh bounded run after a recorded model failure', async () => {
  let ready = false, lastError = null, ticks = 0;
  const requested = [];
  const orchestrate = createOperationsEventOrchestrator({
    async enroll() {},
    async requestRun(requestId) { requested.push(requestId); lastError = null; },
    async tick() { ticks++; if (ticks === 1) lastError = { code: 'OPERATIONS_MODEL_UNAVAILABLE' }; else ready = true; },
    async view() { return { meta: { ready, lastError } }; },
  });
  const envelope = createEventEnvelope(durableEvent({ eventId: 'hospital.capacity.changed:HOSP-001:retry', type: 'hospital.capacity.changed',
    subjectType: 'hospital', subjectId: 'HOSP-001', version: 1,
    now: Date.parse('2026-10-09T01:00:00.000Z'), scope: {} }), 'operations');
  await assert.rejects(orchestrate(envelope, { deliveryAttempt: 1 }), /OPERATIONS_ORCHESTRATION_INCOMPLETE/);
  assert.deepEqual(await orchestrate(envelope, { deliveryAttempt: 2 }), { handled: true });
  assert.equal(ticks, 2);
  assert.deepEqual(requested, [`event_${envelope.outboxId.slice(0, 24)}_2`]);
});

test('capacity source publishes metadata once and its delivery creates one superseding plan', async () => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(), backing = new Map(), outbox = new Map();
  await caseStore.createCase({ caseId, intake: routingIntake([['dizziness', 'confirmed']]) });
  const store = memoryOperationsStore(caseStore, backing, { capacityOutboxEnabled: true, outboxBacking: outbox });
  const sourceService = createOperationsService({ caseStore, store, capacityEventsEnabled: true, model: async context => operationsAssessment(context) });
  await sourceService.enroll({ caseId, status: 'incoming' });
  await sourceService.tick();
  assert.equal((await sourceService.view()).plans.length, 1);

  const input = { requestId: 'm57-capacity-zero', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 1 };
  await sourceService.changeCapacity(input);
  await sourceService.changeCapacity(input);
  assert.equal(outbox.size, 1);
  const record = [...outbox.values()][0];
  assert.equal(record.envelope.eventType, 'hospital.capacity.changed');
  assert.equal(record.envelope.eventFamily, 'operations');
  assert.equal(JSON.stringify(record.envelope).includes('monitoredBedsAvailable'), false);

  const consumerService = createOperationsService({ caseStore, store, model: async context => operationsAssessment(context) });
  const orchestrate = createOperationsEventOrchestrator(consumerService);
  assert.deepEqual(await orchestrate(record.envelope), { handled: true });
  const replanned = await consumerService.view();
  assert.equal(replanned.plans.length, 2);
  assert.deepEqual(replanned.decisionTrace.filter(item => item.planRevisionId === 'OPS-PLAN-2')[0].triggers.map(item => item.eventType), ['hospital.capacity.changed']);
  assert.deepEqual(await orchestrate(record.envelope), { handled: true });
  assert.equal((await consumerService.view()).plans.length, 2);
  await consumerService.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreCaseStore, createConfiguredCaseStore } from '../src/cases/firestore.js';
import { newCaseId } from '../src/cases/store.js';
import { emptyIntake } from '../src/intake/schema.js';
import { eventDatabase } from './event-firestore-fixture.js';
import { emergencyIntake } from './safety-fixtures.js';

const intake = () => {
  const value = emptyIntake();
  value.patient.name = 'Private Patient Name';
  value.evidence.name = { utteranceId: 1, patientReportedText: 'Private patient wording' };
  return value;
};
const outboxEntries = db => [...db.documents.entries()].filter(([path]) => path.startsWith('eventOutbox/'));

test('case creation leaves the Operations outbox disabled by default', async () => {
  const db = eventDatabase(), store = createFirestoreCaseStore(db), caseId = newCaseId();
  const created = await store.createCase({ caseId, intake: intake() });
  assert.equal(created.caseId, caseId);
  assert.equal(outboxEntries(db).length, 0);
});

test('existing Chat intake source behavior remains unchanged while case processing is off', async () => {
  const db = eventDatabase(), store = createFirestoreCaseStore(db), caseId = newCaseId();
  const created = await store.createCase({ caseId, intake: intake(), intakeSource: 'chat_intake' });
  assert.equal(created.intakeSource, null);
  assert.equal(outboxEntries(db).length, 0);
});

test('enabled case creation atomically records one metadata-only Operations event', async () => {
  const db = eventDatabase(), store = createFirestoreCaseStore(db, 'firestore', { operationsOutboxEnabled: true }), caseId = newCaseId();
  const created = await store.createCase({ caseId, intake: intake() });
  const repeated = await store.createCase({ caseId, intake: intake() });
  const entries = outboxEntries(db);
  assert.deepEqual(repeated, created);
  assert.equal(entries.length, 1);
  const record = entries[0][1];
  assert.equal(record.status, 'pending');
  assert.equal(record.envelope.eventFamily, 'operations');
  assert.equal(record.envelope.eventType, 'case.created');
  assert.equal(record.envelope.subjectType, 'case');
  assert.equal(record.envelope.subjectId, caseId);
  assert.equal(record.envelope.subjectVersion, 1);
  assert.deepEqual(Object.keys(record.envelope), ['outboxId', 'schemaVersion', 'eventId', 'eventType', 'eventFamily',
    'subjectType', 'subjectId', 'subjectVersion', 'occurredAt', 'correlationId', 'causationId']);
  assert.equal(JSON.stringify(record).includes('Private Patient Name'), false);
  assert.equal(JSON.stringify(record).includes('Private patient wording'), false);
});

test('case and Operations event both roll back when their transaction fails', async () => {
  const db = eventDatabase(), store = createFirestoreCaseStore(db, 'firestore', { operationsOutboxEnabled: true }), caseId = newCaseId();
  db.failNext();
  await assert.rejects(store.createCase({ caseId, intake: intake() }));
  assert.equal(db.documents.has(`cases/${caseId}`), false);
  assert.equal(outboxEntries(db).length, 0);
});

test('memory and unavailable configured stores do not enable the cloud Operations source', () => {
  assert.equal(createConfiguredCaseStore({ CASE_STORE: 'memory', M55_OPERATIONS_SOURCE_ENABLED: 'true' }).storage, 'memory');
  assert.equal(createConfiguredCaseStore({ M55_OPERATIONS_SOURCE_ENABLED: 'true' }).storage, 'unavailable');
});

test('case lifecycle source writes clinical and notification events atomically after routing and Doctor review', async () => {
  const db = eventDatabase();
  const store = createFirestoreCaseStore(db, 'firestore', { clinicalNotificationOutboxEnabled: true });
  const caseId = newCaseId();
  const created = await store.createCase({ caseId, intake: intake(), intakeSource: 'chat_intake',
    submittedForReview: true, fictionalConfirmed: true, patientUid: 'patient-test' });
  assert.equal(created.intakeSource, 'chat_intake');
  assert.equal(outboxEntries(db).length, 0);
  await store.routeCase(caseId, { availableSpecialties: new Set(['general_medicine']) });
  assert.deepEqual(outboxEntries(db).map(([, record]) => record.envelope.eventType).sort(),
    ['case.ready_for_clinical', 'case.routed_to_doctor']);
  await store.decideClinicalReview(caseId, { requestId: '11111111-1111-4111-8111-111111111111', decision: 'approved', reviewerId: 'doctor-test' });
  assert.equal(outboxEntries(db).filter(([, record]) => record.envelope.eventType === 'case.clinical_review_decided').length, 1);
  assert.equal(JSON.stringify(outboxEntries(db)).includes('Private Patient Name'), false);
});

test('emergency creation emits only a Dispatcher notice event for the human-controlled path', async () => {
  const db = eventDatabase(), store = createFirestoreCaseStore(db, 'firestore', { clinicalNotificationOutboxEnabled: true });
  const caseId = newCaseId();
  await store.createCase({ caseId, intake: emergencyIntake(), emergency: true, fictionalConfirmed: true });
  assert.deepEqual(outboxEntries(db).map(([, record]) => record.envelope.eventType), ['case.emergency_pending_dispatcher']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { caseLifecycleOutboxRecords } from '../src/events/case-events.js';
import { createCaseEventProcessor } from '../src/events/case-processors.js';

const caseId = 'SC-78447678-936e-4f90-8fe3-5d4ac541cb07';
const time = '2026-10-15T12:00:00.000Z';
const base = { caseId, source: 'smartcareops_demo', demoConsent: { fictionalConfirmed: true },
  patientUid: 'patient-1', routing: { specialty: 'family_medicine' }, updatedAt: time };
const envelope = (before, after, family) => caseLifecycleOutboxRecords(before, after, () => Date.parse(time))
  .find(record => record.envelope.eventFamily === family).envelope;

test('only committed routing, emergency and Doctor decision transitions create metadata-only events', () => {
  const routed = { ...base, workflowStatus: 'routed_to_doctor' };
  const records = caseLifecycleOutboxRecords({ ...base, workflowStatus: 'submitted_for_clinical_review' }, routed);
  assert.deepEqual(records.map(item => item.envelope.eventType), ['case.ready_for_clinical', 'case.routed_to_doctor']);
  assert.equal(caseLifecycleOutboxRecords(routed, routed).length, 0);
  assert.equal(JSON.stringify(records).includes('patient-1'), false);
  const emergency = { ...base, workflowStatus: 'emergency_pending_dispatcher', emergency: { status: 'pending' } };
  assert.deepEqual(caseLifecycleOutboxRecords(null, emergency).map(item => item.envelope.eventType), ['case.emergency_pending_dispatcher']);
  const reviewed = { ...routed, clinicalReviewDecision: { status: 'approved', decidedAt: time } };
  assert.deepEqual(caseLifecycleOutboxRecords(routed, reviewed).map(item => item.envelope.eventType), ['case.clinical_review_decided']);
});

test('clinical event prepares Doctor-only assessment; emergency never starts it', async () => {
  const routed = { ...base, workflowStatus: 'routed_to_doctor' };
  const calls = [];
  const service = { async view() { calls.push('view'); return { meta: { ready: calls.includes('tick') } }; },
    async requestRun(id) { calls.push(`run:${id}`); }, async tick() { calls.push('tick'); } };
  const process = createCaseEventProcessor({ family: 'clinical', getCase: async () => routed, makeClinical: () => service });
  assert.equal((await process(envelope({ ...base, workflowStatus: 'submitted_for_clinical_review' }, routed, 'clinical'))).status, 'prepared_for_doctor');
  assert.deepEqual(calls.map(item => item.split(':')[0]), ['view', 'run', 'tick', 'view']);
  assert.equal((await process(envelope({ ...base, workflowStatus: 'submitted_for_clinical_review' }, routed, 'clinical'))).status, 'prepared_for_doctor');
  assert.equal(calls.filter(item => item === 'tick').length, 1);
  const emergency = createCaseEventProcessor({ family: 'clinical', getCase: async () => ({ ...routed, emergency: { status: 'pending' } }), makeClinical: () => service });
  assert.equal((await emergency(envelope({ ...base, workflowStatus: 'submitted_for_clinical_review' }, routed, 'clinical'))).status, 'ignored');
});

test('role notices stay status-only and patient notice waits for Doctor decision', async () => {
  const routed = { ...base, workflowStatus: 'routed_to_doctor' };
  const notices = [];
  const process = createCaseEventProcessor({ family: 'notifications', getCase: async () => routed,
    recordNotice: async notice => notices.push(notice) });
  await process(envelope({ ...base, workflowStatus: 'submitted_for_clinical_review' }, routed, 'notifications'));
  assert.equal(notices[0].recipientType, 'doctor');
  assert.equal(notices[0].specialty, 'family_medicine');
  assert.equal(JSON.stringify(notices).includes('patient-1'), false);
  const reviewed = { ...routed, clinicalReviewDecision: { status: 'approved', decidedAt: time } };
  const patientEvent = envelope(routed, reviewed, 'notifications');
  assert.equal((await process(patientEvent)).status, 'ignored');
  const afterReview = createCaseEventProcessor({ family: 'notifications', getCase: async () => reviewed,
    recordNotice: async notice => notices.push(notice) });
  await afterReview(patientEvent);
  assert.equal(notices[1].recipientType, 'patient');
  assert.equal(notices[1].recipientUid, 'patient-1');
  assert.equal(notices[1].messageSummary.includes('diagnos'), false);
});

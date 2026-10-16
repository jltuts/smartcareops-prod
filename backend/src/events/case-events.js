import { durableEvent } from '../agent-core/lifecycle.js';
import { pendingOutboxRecord } from './outbox.js';

export function caseCreatedOutboxRecord(patientCase, now = Date.now) {
  const occurredAt = Date.parse(patientCase?.createdAt);
  if (!patientCase?.caseId || !Number.isFinite(occurredAt)) throw new Error('INVALID_CASE_CREATED_EVENT');
  const event = durableEvent({
    eventId: `case.created:${patientCase.caseId}`,
    type: 'case.created',
    subjectType: 'case',
    subjectId: patientCase.caseId,
    version: 1,
    now: occurredAt,
    scope: {},
  });
  return pendingOutboxRecord(event, 'operations', now);
}

// Only committed case transitions become event sources. Envelopes contain no
// patient details; consumers must re-read the authoritative case and recheck it.
export function caseLifecycleOutboxRecords(previous, patientCase, now = Date.now) {
  if (!patientCase?.caseId) return [];
  const transitions = [];
  if (patientCase.workflowStatus === 'routed_to_doctor' && previous?.workflowStatus !== 'routed_to_doctor') {
    transitions.push(['clinical', 'case.ready_for_clinical', patientCase.updatedAt]);
    transitions.push(['notifications', 'case.routed_to_doctor', patientCase.updatedAt]);
  }
  if (patientCase.workflowStatus === 'emergency_pending_dispatcher' && !previous?.emergency) {
    transitions.push(['notifications', 'case.emergency_pending_dispatcher', patientCase.updatedAt]);
  }
  if (patientCase.clinicalReviewDecision && !previous?.clinicalReviewDecision) {
    transitions.push(['notifications', 'case.clinical_review_decided', patientCase.clinicalReviewDecision.decidedAt]);
  }
  return transitions.map(([family, type, occurredAt]) => pendingOutboxRecord({
    schemaVersion: 1, eventId: `${type}:${patientCase.caseId}`, type,
    subjectType: 'case', subjectId: patientCase.caseId, subjectVersion: 1,
    occurredAt, correlationId: patientCase.caseId, causationId: null,
  }, family, now));
}

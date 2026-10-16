import { validateEventEnvelope } from './contracts.js';

const clinicalEvent = 'case.ready_for_clinical';
const noticeTypes = Object.freeze({
  'case.routed_to_doctor': { recipientType: 'doctor', subject: 'Case awaiting clinical review',
    messageSummary: 'A fictional patient case is ready for Doctor review.' },
  'case.emergency_pending_dispatcher': { recipientType: 'dispatcher', subject: 'Emergency case awaiting dispatcher',
    messageSummary: 'A fictional emergency case is available in the Dispatcher Portal. Human response controls remain required.' },
  'case.clinical_review_decided': { recipientType: 'patient', subject: 'Doctor review updated',
    messageSummary: 'A Doctor recorded a review decision for your fictional case. Open My Cases to see its current status.' },
});

export function createCaseEventProcessor({ family, getCase, makeClinical, recordNotice }) {
  if (!['clinical', 'notifications'].includes(family) || typeof getCase !== 'function') throw new Error('CASE_PROCESSOR_CONFIGURATION_REQUIRED');
  return async envelope => {
    validateEventEnvelope(envelope);
    if (envelope.eventFamily !== family || envelope.subjectType !== 'case') throw new Error('CASE_EVENT_SCOPE_REQUIRED');
    const patientCase = await getCase(envelope.subjectId);
    if (!patientCase || patientCase.source !== 'smartcareops_demo' || patientCase.demoConsent?.fictionalConfirmed !== true) {
      return { status: 'ignored', reason: 'case_not_eligible' };
    }
    if (family === 'clinical') {
      if (envelope.eventType !== clinicalEvent || typeof makeClinical !== 'function') return { status: 'ignored', reason: 'event_not_supported' };
      if (patientCase.workflowStatus !== 'routed_to_doctor' || patientCase.emergency || patientCase.clinicalReviewDecision) return { status: 'ignored', reason: 'not_pending_doctor_review' };
      const service = makeClinical(envelope.subjectId);
      const previous = await service.view();
      if (previous.meta?.ready) return { status: 'prepared_for_doctor' };
      await service.requestRun(`case_${envelope.outboxId.slice(0, 24)}`);
      await service.tick();
      const state = await service.view();
      return { status: state.meta?.ready ? 'prepared_for_doctor' : 'assessment_unavailable' };
    }
    const template = noticeTypes[envelope.eventType];
    if (!template || typeof recordNotice !== 'function') return { status: 'ignored', reason: 'event_not_supported' };
    if (template.recipientType === 'doctor' && (patientCase.workflowStatus !== 'routed_to_doctor' || patientCase.emergency)) return { status: 'ignored', reason: 'not_routed' };
    if (template.recipientType === 'dispatcher' && !patientCase.emergency) return { status: 'ignored', reason: 'not_emergency' };
    if (template.recipientType === 'patient' && (!patientCase.clinicalReviewDecision || !patientCase.patientUid)) return { status: 'ignored', reason: 'review_not_decided' };
    await recordNotice({ notificationId: `CASE-${envelope.outboxId}`, scope: 'case', sourceEventId: envelope.eventId,
      caseId: envelope.subjectId, recipientType: template.recipientType,
      recipientUid: template.recipientType === 'patient' ? patientCase.patientUid : null,
      specialty: template.recipientType === 'doctor' ? patientCase.routing?.specialty || null : null,
      subject: template.subject, messageSummary: template.messageSummary, status: 'sent',
      deliveryMode: 'fictional_in_app', createdAt: envelope.occurredAt,
      sourceRevisionId: null, sourceActionId: null, canApprove: false, receiptId: envelope.outboxId });
    return { status: 'notified', recipientType: template.recipientType };
  };
}

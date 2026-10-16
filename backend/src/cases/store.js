import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { caseFields } from '../agent/cases.js';
import { emptyIntake } from '../intake/schema.js';
import { emergencyEscalation } from '../emergency.js';
import { resolveRouting, factsFingerprint, publicRouting, validRouting, supportedSymptoms } from './routing.js';
import { RoutingStatus, Specialty, specialtyCodes, specialtyLabels } from '../../../shared/routing.js';
import { evaluateSafety } from '../safety/engine.js';
import { emergencyMetadata, publicEmergency } from '../safety/metadata.js';
import { EmergencyStatus, EmergencyWorkflow, isEmergencyWorkflow, isActiveEmergencyWorkflow } from '../../../shared/emergency.js';
import { canonicalizeSymptom } from '../intake/symptom-grounding.js';
import { publicAmbulance, ambulanceWorkflowMatches, demoFleet } from '../ambulance/fleet.js';
import { createAmbulanceService } from '../ambulance/service.js';
import { publicEmergencyDestination } from '../ambulance/destination.js';
import { validatePersistedMedication, publicMedication } from '../medicine/contracts.js';
import { appointmentEligible, appointmentStates, newAppointmentSlot, publicAppointment, validateProposal, validateResponse } from './appointments.js';

export const Workflow = Object.freeze({ INTAKE: 'intake_completed', REVIEW: 'submitted_for_clinical_review', PENDING: 'handoff_pending', ACTIVE: 'handoff_in_progress', COMPLETE: 'handoff_completed', FAILED: 'handoff_failed', EMERGENCY: EmergencyWorkflow.PENDING, ACKNOWLEDGED: EmergencyWorkflow.ACKNOWLEDGED, ROUTED: 'routed_to_doctor' });
export const Handoff = Object.freeze({ NONE: 'not_started', PENDING: 'pending', ACTIVE: 'in_progress', COMPLETE: 'completed', FAILED: 'failed' });
export const newCaseId = () => `SC-${randomUUID()}`;
export const validCaseId = id => typeof id === 'string' && /^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export class CaseStoreError extends Error {
  constructor(code = 'CASE_STORE_UNAVAILABLE', status = 503) { super('Patient case storage is unavailable. Please retry later.'); this.code = code; this.status = status; }
}
const checkId = id => { if (!validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400); };
const dispatcherCursor = {
  encode: doc => Buffer.from(JSON.stringify({ v: 1, createdAt: doc.createdAt, caseId: doc.caseId })).toString('base64url'),
  decode: value => {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (parsed.v !== 1 || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) || !validCaseId(parsed.caseId)) throw new Error();
      return { createdAt: parsed.createdAt, caseId: parsed.caseId };
    } catch { throw new CaseStoreError('INVALID_QUEUE_QUERY', 400); }
  },
};
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));
// Only validated intake fields cross the persistence boundary. Provider payloads,
// transport metadata, audio, screenshots, credentials and extra keys are excluded.
export function snapshotOf(intake, { allowEmpty = false } = {}) {
  const clean = emptyIntake();
  clean.patient = { ...clean.patient, ...pick(intake.patient, ['name', 'preferredName']) };
  for (const key of Object.keys(clean.vitals)) clean.vitals[key] = { ...clean.vitals[key], ...pick(intake.vitals?.[key], Object.keys(clean.vitals[key])) };
  clean.symptoms = (intake.symptoms || []).map(item => {
    const reported = pick(item, ['name', 'status', 'patientReportedText']);
    const canonicalConcept = canonicalizeSymptom(reported.name);
    return { ...reported, ...(canonicalConcept ? { canonicalConcept } : {}) };
  });
  clean.redFlags = (intake.redFlags || []).map(item => pick(item, ['type', 'status', 'patientReportedText']));
  clean.onset = { ...clean.onset, ...pick(intake.onset, ['value', 'patientReportedText']) };
  clean.additionalNotes = (intake.additionalNotes || []).filter(item => typeof item === 'string');
  const evidenceKeys = /^(name|preferredName|onset|note|symptoms\.[^/]{1,100}|redFlags\.[^/]{1,100}|vitals\.(temperature|bloodPressure|heartRate|spo2|bloodGlucose)|notes\.\d+)$/;
  const evidence = value => ({ ...pick(value, ['utteranceId', 'patientReportedText', 'clarificationRequested', 'derivedFrom']), ...(value?.valueEvidence ? { valueEvidence: pick(value.valueEvidence, ['utteranceId', 'patientReportedText', 'clarificationRequested', 'derivedFrom']) } : {}) });
  clean.evidence = Object.fromEntries(Object.entries(intake.evidence || {}).filter(([key]) => evidenceKeys.test(key)).map(([key, value]) => [key, evidence(value)]));
  // Reject non-primitive values hiding in otherwise known fields.
  const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
  const records = [clean.patient, clean.onset, ...Object.values(clean.vitals), ...clean.symptoms, ...clean.redFlags, ...Object.values(clean.evidence).flatMap(e => [pick(e, ['utteranceId', 'patientReportedText', 'clarificationRequested', 'derivedFrom']), ...(e.valueEvidence ? [e.valueEvidence] : [])])];
  if (records.some(record => Object.values(record).some(value => !scalar(value))) || JSON.stringify(clean).length > 100000) throw new CaseStoreError('INVALID_CASE_SNAPSHOT', 400);
  caseFields(clean, { allowEmpty });
  return clean;
}
function mergeReportedFacts(existing, enrichment) {
  const prior = snapshotOf(existing, { allowEmpty: true }), added = snapshotOf(enrichment);
  const present = value => value !== null && value !== undefined && value !== '';
  const mergeRecord = (left, right) => Object.fromEntries(Object.keys(left).map(key => [key, present(left[key]) ? left[key] : right[key]]));
  const mergeList = (left, right, key) => {
    const seen = new Set(left.map(item => item[key]));
    return [...left, ...right.filter(item => !seen.has(item[key]))];
  };
  return {
    ...added,
    patient: mergeRecord(prior.patient, added.patient),
    onset: mergeRecord(prior.onset, added.onset),
    vitals: Object.fromEntries(Object.keys(prior.vitals).map(key => [key, mergeRecord(prior.vitals[key], added.vitals[key])])),
    symptoms: mergeList(prior.symptoms, added.symptoms, 'name'),
    redFlags: mergeList(prior.redFlags, added.redFlags, 'type'),
    additionalNotes: [...new Set([...prior.additionalNotes, ...added.additionalNotes])],
    evidence: { ...added.evidence, ...prior.evidence },
  };
}
const failureCodes = new Set(['BROWSER_LAUNCH_FAILED', 'PORTAL_NAVIGATION_FAILED', 'SCREENSHOT_FAILED', 'MODEL_REQUEST_FAILED', 'MODEL_INVALID_RESPONSE', 'ACTION_NOT_ALLOWED', 'ACTION_EXECUTION_FAILED', 'ACTION_VERIFICATION_FAILED', 'PORTAL_STATE_MISMATCH', 'TIMEOUT', 'RECEIPT_VERIFICATION_FAILED', 'CANCELLED', 'UNKNOWN_AGENT_ERROR']);
const stages = new Set(['prepare', 'browser_launch', 'portal_navigation', 'screenshot', 'post_action_screenshot', 'model_request', 'parse_response', 'validate_action', 'confirm_action', 'execute_action', 'verify_action', 'portal_verification', 'receipt_verification', 'cleanup']);
export function safeFailure(detail = {}) {
  return { code: failureCodes.has(detail.code) ? detail.code : 'UNKNOWN_AGENT_ERROR', stage: stages.has(detail.stage) ? detail.stage : 'handoff', safeMessage: 'The handoff did not complete with a verified receipt.' };
}
export function publicCase(doc, storage) {
  if (!doc) return null;
  // A canonical Live completion may durably precede provider enrichment. Such
  // records remain readable after enrichment fails, but downstream routing and
  // handoff still call the strict snapshot validator.
  const allowEmpty = doc.intakeSource === 'live_intake';
  const facts = snapshotOf(doc.reportedFacts, { allowEmpty });
  const patientEvidence = Array.isArray(doc.patientEvidence) ? doc.patientEvidence : doc.medicationImage?.status === 'available' && doc.medication ? [{
    evidenceId: 'medicine-package', kind: 'medicine_package', label: 'Medicine package',
    patientDescription: `Patient reports: ${doc.medication.howTaken}`, status: 'available', mimeType: doc.medicationImage.mimeType,
    byteLength: doc.medicationImage.byteLength, capturedAt: doc.medication.confirmedAt,
  }] : [];
  return { caseId: doc.caseId, patient: facts.patient, intakeSummary: caseFields(facts, { allowEmpty }), reportedFacts: facts,
    workflowStatus: doc.workflowStatus, handoffStatus: doc.handoffStatus, routing: publicRouting(doc.routing), emergency: publicEmergency(doc.emergency), ambulance: publicAmbulance(doc.ambulance),
    emergencyDestination: publicEmergencyDestination(doc.emergencyDestination),
    handoffReceipt: doc.handoffReceipt ? pick(doc.handoffReceipt, ['caseId', 'completedAt', 'transport']) : null,
    demoConsent: doc.demoConsent ? pick(doc.demoConsent, ['fictionalConfirmed', 'confirmedAt']) : null,
    automaticHandoff: doc.automaticHandoff ? pick(doc.automaticHandoff, ['status', 'queuedAt']) : null,
    appointmentRequest: doc.appointmentRequest ? pick(doc.appointmentRequest, ['appointmentRequestId', 'state', 'simulation', 'contacted', 'confirmed', 'selection', 'requestedAt', 'receipt']) : null,
    appointmentProposal: publicAppointment(doc.appointmentProposal),
    clinicalReview: doc.clinicalReview ? pick(doc.clinicalReview, ['status', 'updatedAt']) : null,
    ...(doc.clinicalReviewDecision ? { doctorAttribution: doc.clinicalReviewDecision.reviewerProfile ? {
      status: 'available', displayName: doc.clinicalReviewDecision.reviewerProfile.displayName,
      specialty: doc.clinicalReviewDecision.reviewerProfile.specialty,
    } : { status: 'unavailable' } } : {}),
    hospitalHandoffs: Object.values(doc.hospitalHandoffs || {}).map(item => pick(item, ['idempotencyKey', 'hospitalId', 'connector', 'status', 'receipt', 'failureCode'])),
    failure: doc.failure ? { ...safeFailure(doc.failure), updatedAt: doc.failure.updatedAt } : null,
    source: 'smartcareops_demo', intakeSource: doc.intakeSource || null,
    enrichmentStatus: ['pending', 'succeeded', 'failed'].includes(doc.enrichmentStatus) ? doc.enrichmentStatus : null,
    enrichmentErrorCategory: typeof doc.enrichmentErrorCategory === 'string' ? doc.enrichmentErrorCategory : null,
    patientEvidence: patientEvidence.map(item => pick(item, ['evidenceId', 'kind', 'label', 'patientDescription', 'status', 'mimeType', 'byteLength', 'capturedAt'])),
    medications: doc.medication ? [{ ...publicMedication(doc.medication),
      ...(doc.medicationImage ? { imageEvidence: doc.medicationImage.status === 'available' ? { status: 'available' } : { status: 'unavailable' } } : {}) }] : [],
    createdAt: doc.createdAt, updatedAt: doc.updatedAt, storage };
}

const patientNextStep = doc => {
  if (doc.workflowStatus === 'emergency_response_completed') return 'The fictional emergency response is complete. No real emergency service was contacted.';
  if (doc.workflowStatus === 'arrived_at_hospital') return 'The fictional ambulance has arrived at the selected demo hospital.';
  if (doc.workflowStatus === 'patient_transporting') return 'The fictional ambulance is transporting the Patient to the selected demo hospital.';
  if (doc.workflowStatus === 'ambulance_at_pickup') return 'The fictional ambulance has arrived at the Patient pickup location.';
  if (doc.workflowStatus === 'ambulance_en_route') return 'The fictional ambulance is en route to the Patient pickup location.';
  if (doc.workflowStatus === 'ambulance_assigned') return 'A fictional ambulance is assigned and awaiting simulated dispatch.';
  if (isEmergencyWorkflow(doc.workflowStatus)) return 'Follow the emergency guidance shown for this case.';
  if (doc.appointmentProposal?.state === appointmentStates.confirmed) return 'Your appointment is confirmed in this fictional demo; no real booking was made.';
  if (doc.appointmentProposal?.state === appointmentStates.alternate) return 'Your Doctor will propose another time.';
  if (doc.appointmentProposal) return 'Choose an appointment time.';
  if (doc.appointmentRequest?.state === 'requested') return 'Your fictional appointment request was recorded for review. It is not a confirmed booking.';
  if (doc.clinicalReview?.status === 'approved') return 'Review complete. No appointment is currently proposed.';
  if (['approved', 'rejected'].includes(doc.clinicalReview?.status)) return 'Your clinical review is complete. Review the recorded decision below.';
  if (doc.clinicalReview?.status === 'deferred') return 'Clinical review is deferred. Wait for an updated review.';
  if (doc.routing?.status === RoutingStatus.UNASSIGNED) return doc.routing.reasonSummary;
  if (doc.routing?.status === RoutingStatus.ROUTED) return `Your case is routed to ${specialtyLabels[doc.routing.specialty]} for review.`;
  if (doc.workflowStatus === Workflow.REVIEW) return 'Waiting for clinical review.';
  return 'Review the latest case status.';
};
export const patientCaseSummary = doc => ({
  caseId: doc.caseId, intakeDate: doc.createdAt, workflowStatus: doc.workflowStatus,
  ...(publicRouting(doc.routing) ? { routing: publicRouting(doc.routing) } : {}),
  clinicalReview: doc.clinicalReview ? pick(doc.clinicalReview, ['status', 'updatedAt']) : null,
  appointmentProposal: publicAppointment(doc.appointmentProposal),
  emergency: publicEmergency(doc.emergency),
  ambulance: publicAmbulance(doc.ambulance),
  emergencyDestination: publicEmergencyDestination(doc.emergencyDestination),
  nextStep: patientNextStep(doc),
  ...(doc.appointmentRequest ? { appointmentRequest: pick(doc.appointmentRequest, ['appointmentRequestId', 'state', 'simulation', 'contacted', 'confirmed', 'selection', 'requestedAt']) } : {}),
  ...(doc.clinicalReviewDecision ? { doctorAttribution: doc.clinicalReviewDecision.reviewerProfile ? {
    status: 'available', displayName: doc.clinicalReviewDecision.reviewerProfile.displayName,
    specialty: doc.clinicalReviewDecision.reviewerProfile.specialty,
  } : { status: 'unavailable' } } : {}),
});

export const currentEmergency = doc => {
  if (!doc || !isEmergencyWorkflow(doc.workflowStatus) || !publicEmergency(doc.emergency)) return false;
  const facts = snapshotOf(doc.reportedFacts), decision = evaluateSafety(facts);
  return decision.emergency && doc.emergencyFactsHash === factsFingerprint(facts) && doc.emergency.reasonCode === decision.reasonCode &&
    isDeepStrictEqual(doc.emergency.triggeredBy, decision.triggeredBy) &&
    (doc.emergency.status === EmergencyStatus.PENDING ? doc.workflowStatus === Workflow.EMERGENCY && !doc.ambulance :
      doc.workflowStatus === Workflow.ACKNOWLEDGED && !doc.ambulance || ambulanceWorkflowMatches(doc) && doc.ambulance.assignedAt >= doc.emergency.acknowledgedAt);
};
const logSafety = (caseId, decision) => console.info('[safety]', JSON.stringify({ caseId, evaluated: true, matchedRule: decision.matchedRule, emergency: decision.emergency }));
const logDispatcher = doc => console.info('[dispatcher]', JSON.stringify({ caseId: doc.caseId, status: doc.emergency.status }));

export function createCaseService(driver, storage, { chatSourceMarkerEnabled = false } = {}) {
  const guarded = async work => { try { return await work(); } catch (error) {
    if (error instanceof CaseStoreError) throw error;
    const safe = new CaseStoreError();
    safe.providerCode = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 ? error.code : null;
    console.warn('[case-store]', JSON.stringify({ code: safe.code, providerCode: safe.providerCode }));
    throw safe;
  } };
  return {
    storage,
    ...createAmbulanceService(driver, storage, guarded),
    async proposeAppointment(caseId, input, doctor) {
      checkId(caseId); const proposal = validateProposal(input);
      if (!doctor?.uid || doctor?.doctorVerification?.status !== 'verified' || !Array.isArray(doctor.specialties) ||
          !doctor.specialties.length || typeof doctor.displayName !== 'string' || !doctor.displayName.trim()) throw new CaseStoreError('DOCTOR_ACCESS_REQUIRED', 403);
      return guarded(async () => publicCase(await driver.transact(caseId, doc => {
        if (!doc || !doctor.specialties.includes(doc.routing?.specialty)) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        const receipt = (doc.appointmentReceipts || []).find(item => item.requestId === proposal.requestId);
        if (receipt) {
          if (receipt.action !== 'propose' || receipt.actorUid !== doctor.uid || receipt.version !== proposal.expectedVersion + 1 ||
              !isDeepStrictEqual(receipt.input, proposal)) throw new CaseStoreError('APPOINTMENT_IDEMPOTENCY_CONFLICT', 409);
          return doc;
        }
        if (!appointmentEligible(doc)) throw new CaseStoreError('APPOINTMENT_NOT_ELIGIBLE', 409);
        const current = doc.appointmentProposal;
        if ((current?.version || 0) !== proposal.expectedVersion) throw new CaseStoreError('STALE_APPOINTMENT_PROPOSAL', 409);
        if (current?.state === appointmentStates.confirmed) throw new CaseStoreError('APPOINTMENT_ALREADY_CONFIRMED', 409);
        const now = new Date().toISOString(), version = proposal.expectedVersion + 1;
        const next = { version, state: appointmentStates.awaiting, slots: proposal.slots.map(newAppointmentSlot),
          timeZone: proposal.timeZone, appointmentType: proposal.appointmentType,
          doctor: { uid: doctor.uid, displayName: doctor.displayName.trim(), specialty: doc.routing.specialty },
          createdAt: now, updatedAt: now, confirmedSlotId: null,
          events: [{ state: appointmentStates.proposed, at: now }, { state: appointmentStates.awaiting, at: now }] };
        const notice = { notificationId: `APPT-${proposal.requestId}`, recipientType: 'patient', recipientUid: doc.patientUid,
          caseId, version, subject: 'Appointment times proposed', messageSummary: 'A verified Doctor proposed fictional appointment times. Review the case to choose or request another time.', createdAt: now };
        return { ...doc, appointmentProposal: next, appointmentDoctorUid: doctor.uid,
          appointmentNoticeDoctorUids: [...new Set([...(doc.appointmentNoticeDoctorUids || []), doctor.uid])].slice(-20),
          appointmentNotifications: [...(doc.appointmentNotifications || []).slice(-19), notice], appointmentReceipts: [...(doc.appointmentReceipts || []).slice(-19),
          { requestId: proposal.requestId, action: 'propose', actorUid: doctor.uid, version, input: proposal }], updatedAt: now };
      }), storage));
    },
    async respondToAppointment(caseId, input, patientUid) {
      checkId(caseId); const answer = validateResponse(input);
      return guarded(async () => publicCase(await driver.transact(caseId, doc => {
        if (!doc || doc.patientUid !== patientUid) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        const receipt = (doc.appointmentReceipts || []).find(item => item.requestId === answer.requestId);
        if (receipt) {
          if (receipt.actorUid !== patientUid || receipt.action !== answer.action || receipt.version !== answer.version || receipt.slotId !== answer.slotId)
            throw new CaseStoreError('APPOINTMENT_IDEMPOTENCY_CONFLICT', 409);
          return doc;
        }
        if (!appointmentEligible(doc)) throw new CaseStoreError('APPOINTMENT_NOT_ELIGIBLE', 409);
        const proposal = doc.appointmentProposal;
        if (!proposal || proposal.version !== answer.version) throw new CaseStoreError('STALE_APPOINTMENT_PROPOSAL', 409);
        if (proposal.state !== appointmentStates.awaiting) throw new CaseStoreError('APPOINTMENT_RESPONSE_CLOSED', 409);
        if (answer.action === 'confirm' && !proposal.slots.some(slot => slot.slotId === answer.slotId)) throw new CaseStoreError('STALE_APPOINTMENT_SLOT', 409);
        if (answer.action === 'confirm' && Date.parse(proposal.slots.find(slot => slot.slotId === answer.slotId).startAt) <= Date.now()) throw new CaseStoreError('APPOINTMENT_SLOT_EXPIRED', 409);
        const now = new Date().toISOString(), state = answer.action === 'confirm' ? appointmentStates.confirmed : appointmentStates.alternate;
        const notice = { notificationId: `APPT-${answer.requestId}`, recipientType: 'doctor', recipientUid: proposal.doctor.uid,
          caseId, version: proposal.version, subject: answer.action === 'confirm' ? 'Patient confirmed a fictional time' : 'Patient requested another time',
          messageSummary: answer.action === 'confirm' ? 'The Patient confirmed one proposed demo time. This is not an external booking.' : 'The Patient asked for another fictional appointment time.', createdAt: now };
        return { ...doc, appointmentProposal: { ...proposal, state, updatedAt: now,
          confirmedSlotId: answer.action === 'confirm' ? answer.slotId : null,
          events: [...proposal.events, { state, at: now }] },
          appointmentNotifications: [...(doc.appointmentNotifications || []).slice(-19), notice],
          appointmentReceipts: [...(doc.appointmentReceipts || []).slice(-19),
            { requestId: answer.requestId, action: answer.action, actorUid: patientUid, version: answer.version, slotId: answer.slotId }], updatedAt: now };
      }), storage));
    },
    async listAppointmentNotifications({ recipientType, recipientUid }) {
      if (!['patient', 'doctor'].includes(recipientType) || typeof recipientUid !== 'string' || !recipientUid) throw new CaseStoreError('APPOINTMENT_ACCESS_DENIED', 403);
      return guarded(async () => {
        const docs = await driver.listAppointmentNoticeCases({ recipientType, recipientUid, limit: 50 });
        return docs.flatMap(doc => doc.appointmentNotifications || []).filter(item => item.recipientType === recipientType && item.recipientUid === recipientUid)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(item => ({
            notificationId: item.notificationId, scope: 'appointment', recipientType, recipientId: recipientUid,
            subject: item.subject, messageSummary: item.messageSummary, createdAt: item.createdAt,
            status: 'sent', deliveryMode: 'in_app', caseId: item.caseId, sourceRevisionId: String(item.version), sourceActionId: 'appointment',
            receiptId: null, canApprove: false, stale: false,
          }));
      });
    },
    async saveAppointmentRequest({ caseId, patientUid, appointmentRequest }) {
      checkId(caseId);
      if (!appointmentRequest || appointmentRequest.caseId !== caseId || appointmentRequest.patientUid !== patientUid || appointmentRequest.simulation !== true || appointmentRequest.state !== 'requested' || appointmentRequest.contacted !== false || appointmentRequest.confirmed !== false) throw new CaseStoreError('INVALID_APPOINTMENT_REQUEST', 400);
      return guarded(async () => publicCase(await driver.transact(caseId, existing => {
        if (!existing || existing.patientUid !== patientUid || isEmergencyWorkflow(existing.workflowStatus)) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        if (existing.appointmentRequest) {
          if (existing.appointmentRequest.appointmentRequestId !== appointmentRequest.appointmentRequestId) throw new CaseStoreError('APPOINTMENT_CONFLICT', 409);
          return existing;
        }
        return { ...existing, appointmentRequest: structuredClone(appointmentRequest), updatedAt: new Date().toISOString() };
      }), storage));
    },
    async createCase({ caseId, intake, emergency = false, patientUid = null, fictionalConfirmed = false, submittedForReview = false,
      intakeSource = null, enrichmentStatus = null, medication = null, medicationImage = null, patientEvidence = [] }) {
      checkId(caseId); const allowEmpty = intakeSource === 'live_intake' && enrichmentStatus === 'pending';
      const facts = snapshotOf(intake, { allowEmpty });
      let confirmedMedication = null;
      try { confirmedMedication = medication ? validatePersistedMedication(medication) : null; } catch { throw new CaseStoreError('INVALID_MEDICATION_ENTRY', 400); }
      if (!Array.isArray(patientEvidence) || patientEvidence.length > 5) throw new CaseStoreError('INVALID_PATIENT_EVIDENCE', 400);
      const evidenceInputs = patientEvidence.map(item => {
        if (!item || !/^[a-z0-9-]{1,48}$/.test(item.evidenceId || '') || !['medicine_package', 'body_area'].includes(item.kind) ||
            typeof item.label !== 'string' || item.label.length > 80 || typeof item.patientDescription !== 'string' || !item.patientDescription.trim() || item.patientDescription.length > 500 ||
            !['image/jpeg', 'image/png', 'image/webp'].includes(item.mimeType) || !Buffer.isBuffer(item.bytes) || !item.bytes.length || item.bytes.length > 512 * 1024) throw new CaseStoreError('INVALID_PATIENT_EVIDENCE', 400);
        return { evidenceId: item.evidenceId, kind: item.kind, label: item.label, patientDescription: item.patientDescription.trim(), mimeType: item.mimeType, byteLength: item.bytes.length, bytes: Buffer.from(item.bytes), capturedAt: item.capturedAt || new Date().toISOString() };
      });
      if (medicationImage && confirmedMedication && !evidenceInputs.some(item => item.evidenceId === 'medicine-package')) evidenceInputs.push({
        evidenceId: 'medicine-package', kind: 'medicine_package', label: 'Medicine package',
        patientDescription: `Patient reports: ${confirmedMedication.howTaken}`, mimeType: medicationImage.mimeType,
        byteLength: medicationImage.byteLength, bytes: Buffer.from(medicationImage.bytes), capturedAt: confirmedMedication.confirmedAt,
      });
      if (patientUid !== null && (typeof patientUid !== 'string' || !patientUid || patientUid.length > 128)) throw new CaseStoreError('INVALID_PATIENT_IDENTITY', 400);
      const decision = evaluateSafety(facts); logSafety(caseId, decision);
      if (emergency && !decision.emergency) throw new CaseStoreError('INVALID_EMERGENCY_FACTS', 409);
      return guarded(async () => {
        let stagedMetadata = null;
        if (evidenceInputs.length && typeof driver.stagePatientEvidence === 'function') {
          stagedMetadata = [];
          for (const item of evidenceInputs) {
            try {
              if (!patientUid) throw new Error('VERIFIED_PATIENT_REQUIRED');
              const reference = await driver.stagePatientEvidence(caseId, patientUid, item);
              stagedMetadata.push({ evidenceId: item.evidenceId, kind: item.kind, label: item.label,
                patientDescription: item.patientDescription, status: 'available', mimeType: item.mimeType,
                byteLength: item.byteLength, capturedAt: item.capturedAt, ...reference });
            } catch {
              console.warn('[case-evidence]', JSON.stringify({ caseId, evidenceId: item.evidenceId, code: 'PATIENT_EVIDENCE_STORAGE_UNAVAILABLE' }));
              stagedMetadata.push({ evidenceId: item.evidenceId, kind: item.kind, label: item.label,
                patientDescription: item.patientDescription, status: 'unavailable', capturedAt: item.capturedAt });
            }
          }
        }
        let created = false;
        const doc = await driver.transact(caseId, existing => {
          created = false;
          if (existing) {
            if (!isDeepStrictEqual(existing.reportedFacts, facts)) throw new CaseStoreError('CASE_CONFLICT', 409);
            if (patientUid && existing.patientUid && patientUid !== existing.patientUid) throw new CaseStoreError('CASE_CONFLICT', 409);
            if (confirmedMedication && !isDeepStrictEqual(existing.medication, confirmedMedication)) throw new CaseStoreError('CASE_CONFLICT', 409);
            return existing;
          }
          const now = new Date().toISOString(); created = true;
          const packageImage = stagedMetadata?.find(item => item.evidenceId === 'medicine-package');
          return { caseId, patient: facts.patient, intakeSummary: caseFields(facts, { allowEmpty }), reportedFacts: facts, ...(patientUid ? { patientUid } : {}),
            workflowStatus: decision.emergency ? Workflow.EMERGENCY : submittedForReview ? Workflow.REVIEW : Workflow.INTAKE, handoffStatus: Handoff.NONE,
            ...(decision.emergency ? { emergency: emergencyMetadata(decision, now), emergencyFactsHash: factsFingerprint(facts) } : {}),
            ...(fictionalConfirmed === true ? { demoConsent: { fictionalConfirmed: true, confirmedAt: now } } : {}),
            handoffReceipt: null, failure: null, source: 'smartcareops_demo',
            ...(intakeSource === 'live_intake' || chatSourceMarkerEnabled && intakeSource === 'chat_intake' ? { intakeSource } : {}),
            ...(confirmedMedication ? { medication: confirmedMedication } : {}),
            ...(stagedMetadata ? { patientEvidence: stagedMetadata } : {}),
            ...(packageImage ? { medicationImage: { status: packageImage.status,
              ...(packageImage.status === 'available' ? { mimeType: packageImage.mimeType, byteLength: packageImage.byteLength } : {}), updatedAt: now } } : {}),
            ...(['pending', 'succeeded', 'failed'].includes(enrichmentStatus) ? { enrichmentStatus, enrichmentErrorCategory: null } : {}),
            createdAt: now, updatedAt: now, attemptId: null };
        });
        if (created && doc.emergency) logDispatcher(doc);
        if (created && stagedMetadata) {
          for (const item of stagedMetadata.filter(value => value.status === 'available')) {
            try { await driver.commitPatientEvidence?.(item); }
            catch { console.warn('[case-evidence]', JSON.stringify({ caseId, evidenceId: item.evidenceId, code: 'PATIENT_EVIDENCE_COMMIT_MARKER_UNAVAILABLE' })); }
          }
          return publicCase(doc, storage);
        }
        if (created && evidenceInputs.length && (typeof driver.putPatientEvidence === 'function' || typeof driver.putMedicineImage === 'function')) {
          const metadata = [];
          for (const item of evidenceInputs) {
            let status = 'unavailable';
            try {
              if (typeof driver.putPatientEvidence === 'function') await driver.putPatientEvidence(caseId, item);
              else if (item.evidenceId === 'medicine-package') await driver.putMedicineImage(caseId, item);
              else throw new Error('EVIDENCE_STORAGE_UNAVAILABLE');
              status = 'available';
            }
            catch { console.warn('[case-evidence]', JSON.stringify({ caseId, evidenceId: item.evidenceId, code: 'PATIENT_EVIDENCE_STORAGE_UNAVAILABLE' })); }
            metadata.push({ evidenceId: item.evidenceId, kind: item.kind, label: item.label, patientDescription: item.patientDescription, status,
              ...(status === 'available' ? { mimeType: item.mimeType, byteLength: item.byteLength } : {}), capturedAt: item.capturedAt });
          }
          const packageImage = metadata.find(item => item.evidenceId === 'medicine-package');
          const updated = await driver.transact(caseId, existing => ({ ...existing, patientEvidence: metadata,
            ...(packageImage ? { medicationImage: { status: packageImage.status, ...(packageImage.status === 'available' ? { mimeType: packageImage.mimeType, byteLength: packageImage.byteLength } : {}), updatedAt: new Date().toISOString() } } : {}) }));
          return publicCase(updated, storage);
        }
        return publicCase(doc, storage);
      });
    },
    async getCase(caseId) { checkId(caseId); return guarded(async () => publicCase(await driver.get(caseId), storage)); },
    async getPatientCase(caseId, patientUid) {
      checkId(caseId);
      if (typeof patientUid !== 'string' || !patientUid) throw new CaseStoreError('CASE_NOT_FOUND', 404);
      return guarded(async () => {
        const doc = await driver.get(caseId);
        if (!doc || doc.patientUid !== patientUid) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        return publicCase(doc, storage);
      });
    },
    async getPatientCaseEvidence(caseId, evidenceId, patientUid) {
      checkId(caseId);
      if (!/^[a-z0-9-]{1,48}$/.test(evidenceId || '') || typeof patientUid !== 'string' || !patientUid) throw new CaseStoreError('CASE_NOT_FOUND', 404);
      return guarded(async () => {
        const doc = await driver.get(caseId), item = doc?.patientEvidence?.find(evidence => evidence.evidenceId === evidenceId) ||
          (evidenceId === 'medicine-package' && doc?.medicationImage?.status === 'available' ? { status: 'available' } : null);
        if (!doc || doc.patientUid !== patientUid || item?.status !== 'available' || typeof driver.getPatientEvidence !== 'function' && !(evidenceId === 'medicine-package' && typeof driver.getMedicineImage === 'function')) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        let image = typeof driver.getPatientEvidence === 'function' ? await driver.getPatientEvidence(caseId, evidenceId, item) : null;
        if (!image && evidenceId === 'medicine-package') image = await driver.getMedicineImage?.(caseId);
        if (!image?.bytes || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        return image;
      });
    },
    async listPatientCases({ patientUid, after, limit = 10 }) {
      if (typeof patientUid !== 'string' || !patientUid) throw new CaseStoreError('CASE_NOT_FOUND', 404);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new CaseStoreError('INVALID_CASE_QUERY', 400);
      return guarded(async () => {
        const docs = await driver.listPatient({ patientUid, after, limit: limit + 1 });
        const page = docs.slice(0, limit);
        return { cases: page.map(patientCaseSummary), nextCursor: docs.length > limit ? {
          createdAt: page[page.length - 1].createdAt, caseId: page[page.length - 1].caseId,
        } : null, storage };
      });
    },
    async updateEnrichment({ caseId, intake, status, errorCategory = null, patientUid = null }) {
      checkId(caseId);
      if (!['succeeded', 'failed'].includes(status)) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
      const enrichedFacts = status === 'succeeded' ? snapshotOf(intake) : null;
      return guarded(async () => {
        let emergencyChanged = false;
        const doc = await driver.transact(caseId, existing => {
          if (!existing) throw new CaseStoreError('CASE_NOT_FOUND', 404);
          if (patientUid && existing.patientUid !== patientUid) throw new CaseStoreError('CASE_NOT_FOUND', 404);
          if (existing.enrichmentStatus === 'succeeded' || existing.enrichmentStatus === 'failed') return existing;
          const now = new Date().toISOString();
          if (status === 'failed') return { ...existing, enrichmentStatus: 'failed',
            enrichmentErrorCategory: typeof errorCategory === 'string' ? errorCategory.slice(0, 80) : 'FINALIZATION_UNKNOWN', updatedAt: now };
          // Enrichment can add validated patient-reported facts, but it cannot
          // rewrite facts or evidence already committed at canonical completion.
          const facts = mergeReportedFacts(existing.reportedFacts, enrichedFacts);
          const decision = evaluateSafety(facts);
          emergencyChanged = decision.emergency && !existing.emergency;
          const routingChanged = Boolean(existing.routing && existing.routingFactsHash !== factsFingerprint(facts));
          const next = { ...existing, patient: facts.patient, intakeSummary: caseFields(facts), reportedFacts: facts,
            enrichmentStatus: 'succeeded', enrichmentErrorCategory: null,
            ...(emergencyChanged ? { workflowStatus: Workflow.EMERGENCY, emergency: emergencyMetadata(decision, now), emergencyFactsHash: factsFingerprint(facts) } :
              routingChanged ? { workflowStatus: Workflow.REVIEW } : {}),
            updatedAt: now };
          if (routingChanged) { delete next.routing; delete next.routingFactsHash; }
          return next;
        });
        if (emergencyChanged) logDispatcher(doc);
        return publicCase(doc, storage);
      });
    },
    async updateClinicalReviewStatus(caseId, status, updatedAt = new Date().toISOString()) {
      checkId(caseId);
      if (!['pending', 'approved', 'rejected', 'deferred'].includes(status) || typeof updatedAt !== 'string') throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
      return guarded(async () => publicCase(await driver.transact(caseId, existing => {
        if (!existing) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        if (![Workflow.REVIEW, Workflow.ROUTED].includes(existing.workflowStatus)) return existing;
        // A Doctor-owned case review is terminal and independent from any
        // later action-specific approval proposed by the clinical planner.
        if (existing.clinicalReviewDecision) return existing;
        const prior = existing.clinicalReview;
        if (prior && Date.parse(prior.updatedAt) > Date.parse(updatedAt)) return existing;
        return { ...existing, clinicalReview: { status, updatedAt }, updatedAt: new Date().toISOString() };
      }), storage));
    },
    async decideClinicalReview(caseId, { requestId, decision, reviewerId, reviewerProfile = null }) {
      checkId(caseId);
      if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId) || !['approved', 'rejected', 'deferred'].includes(decision) ||
          typeof reviewerId !== 'string' || !reviewerId || reviewerId.length > 128) throw new CaseStoreError('INVALID_CLINICAL_REVIEW_DECISION', 400);
      const safeReviewerProfile = reviewerProfile && typeof reviewerProfile.displayName === 'string' && reviewerProfile.displayName.trim() &&
        specialtyCodes.includes(reviewerProfile.specialty) ? {
          displayName: reviewerProfile.displayName.trim().slice(0, 200), specialty: reviewerProfile.specialty,
        } : null;
      return guarded(async () => {
        const doc = await driver.transact(caseId, existing => {
          if (!existing || existing.source !== 'smartcareops_demo') throw new CaseStoreError('CASE_NOT_FOUND', 404);
          const prior = existing.clinicalReviewDecision;
          if (prior) {
            if (prior.requestId === requestId && prior.status === decision && prior.reviewerId === reviewerId) return existing;
            throw new CaseStoreError('CLINICAL_REVIEW_ALREADY_DECIDED', 409);
          }
          if (![Workflow.REVIEW, Workflow.ROUTED].includes(existing.workflowStatus) || isEmergencyWorkflow(existing.workflowStatus) ||
              ['approved', 'rejected', 'deferred'].includes(existing.clinicalReview?.status)) {
            throw new CaseStoreError('CLINICAL_REVIEW_NOT_PENDING', 409);
          }
          const decidedAt = new Date().toISOString();
          return { ...existing, clinicalReview: { status: decision, updatedAt: decidedAt },
            clinicalReviewDecision: { requestId, status: decision, reviewerId, decidedAt,
              ...(safeReviewerProfile ? { reviewerProfile: safeReviewerProfile } : {}) }, updatedAt: decidedAt };
        });
        return { requestId: doc.clinicalReviewDecision.requestId, status: doc.clinicalReviewDecision.status,
          decidedAt: doc.clinicalReviewDecision.decidedAt };
      });
    },
    async getDoctorMedicineImage(caseId, options = {}) {
      return this.getDoctorCaseEvidence(caseId, 'medicine-package', options);
    },
    async getDoctorCaseEvidence(caseId, evidenceId, { specialty } = {}) {
      checkId(caseId);
      if (!/^[a-z0-9-]{1,48}$/.test(evidenceId || '')) throw new CaseStoreError('CASE_NOT_FOUND', 404);
      return guarded(async () => {
        const doc = await driver.get(caseId);
        const assigned = doc?.workflowStatus === Workflow.ROUTED && validRouting(doc.routing) && doc.routing.status === RoutingStatus.ROUTED && doc.routingFactsHash === factsFingerprint(snapshotOf(doc.reportedFacts));
        const inScope = specialty ? assigned && doc?.routing?.specialty === specialty : doc && [Workflow.REVIEW, Workflow.ROUTED].includes(doc.workflowStatus) && (doc.workflowStatus !== Workflow.ROUTED || assigned);
        if (!doc || !inScope || emergencyEscalation(doc.reportedFacts)) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        const item = doc.patientEvidence?.find(evidence => evidence.evidenceId === evidenceId) ||
          (evidenceId === 'medicine-package' && doc.medicationImage?.status === 'available' ? { status: 'available' } : null);
        if (!item || item.status !== 'available' || typeof driver.getPatientEvidence !== 'function' && !(evidenceId === 'medicine-package' && typeof driver.getMedicineImage === 'function')) throw new CaseStoreError('CASE_EVIDENCE_UNAVAILABLE', 404);
        let image = typeof driver.getPatientEvidence === 'function' ? await driver.getPatientEvidence(caseId, evidenceId, item) : null;
        if (!image && evidenceId === 'medicine-package') image = await driver.getMedicineImage?.(caseId);
        if (!image?.bytes || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) throw new CaseStoreError('MEDICINE_IMAGE_UNAVAILABLE', 404);
        return image;
      });
    },
    async claimHospitalHandoff(caseId, request) {
      checkId(caseId);
      return guarded(async () => {
        let claimed = false;
        const doc = await driver.transact(caseId, doc => {
          claimed = false;
          if (!doc || doc.source !== 'smartcareops_demo' || doc.demoConsent?.fictionalConfirmed !== true) throw new CaseStoreError('FICTIONAL_CASE_REQUIRED', 409);
          if (isEmergencyWorkflow(doc.workflowStatus) || evaluateSafety(doc.reportedFacts).emergency) throw new CaseStoreError('EMERGENCY_HANDOFF_BLOCKED', 409);
          if (!isDeepStrictEqual(snapshotOf(request.payload), doc.reportedFacts)) throw new CaseStoreError('STALE_HANDOFF_PAYLOAD', 409);
          if (doc.automaticHandoff && !doc.handoffReceipt) throw new CaseStoreError('HANDOFF_RECONCILIATION_REQUIRED', 409);
          const prior = doc.hospitalHandoffs?.[request.idempotencyKey];
          if (!prior && !Object.keys(doc.hospitalHandoffs || {}).length && doc.handoffStatus !== Handoff.NONE) throw new CaseStoreError('HANDOFF_RECONCILIATION_REQUIRED', 409);
          if (prior) {
            if (prior.requestDigest !== request.requestDigest) throw new CaseStoreError('IDEMPOTENCY_CONFLICT', 409);
            return doc;
          }
          if (Object.keys(doc.hospitalHandoffs || {}).length >= 20) throw new CaseStoreError('HANDOFF_LIMIT', 409);
          claimed = true;
          return { ...doc, handoffStatus: Handoff.ACTIVE, hospitalHandoffs: { ...doc.hospitalHandoffs, [request.idempotencyKey]: {
            idempotencyKey: request.idempotencyKey, hospitalId: request.hospitalId, connector: request.connector, requestDigest: request.requestDigest,
            payloadDigest: request.payloadDigest, status: 'running', startedAt: new Date().toISOString(), receipt: null,
          } }, updatedAt: new Date().toISOString() };
        });
        return { claimed, entry: structuredClone(doc.hospitalHandoffs[request.idempotencyKey]) };
      });
    },
    async finishHospitalHandoff(caseId, idempotencyKey, receipt = null) {
      checkId(caseId);
      return guarded(async () => {
        const doc = await driver.transact(caseId, doc => {
          const entry = doc?.hospitalHandoffs?.[idempotencyKey];
          if (!entry) throw new CaseStoreError('STALE_HANDOFF', 409);
          if (entry.status === 'succeeded') return doc;
          if (receipt && (!/^DEMO-[A-F0-9]{8}$/.test(receipt.receiptId) || receipt.caseId !== caseId || receipt.idempotencyKey !== idempotencyKey || receipt.hospitalId !== entry.hospitalId || receipt.payloadDigest !== entry.payloadDigest)) throw new CaseStoreError('INVALID_RECEIPT', 409);
          const now = new Date().toISOString();
          return { ...doc, handoffStatus: receipt ? Handoff.COMPLETE : Handoff.ACTIVE,
            handoffReceipt: receipt ? { caseId: receipt.receiptId, completedAt: now, transport: entry.connector } : doc.handoffReceipt,
            hospitalHandoffs: { ...doc.hospitalHandoffs, [idempotencyKey]: { ...entry, status: receipt ? 'succeeded' : 'unknown_outcome', receipt, failureCode: receipt ? null : 'UNKNOWN_OUTCOME', updatedAt: now } }, updatedAt: now };
        });
        return structuredClone(doc.hospitalHandoffs[idempotencyKey]);
      });
    },
    async recordDemoHospitalReceipt(caseId, request) {
      checkId(caseId);
      return guarded(async () => {
        const doc = await driver.transact(caseId, doc => {
          const entry = doc?.hospitalHandoffs?.[request.idempotencyKey];
          if (!entry || entry.status !== 'running' || entry.hospitalId !== request.hospitalId || entry.payloadDigest !== request.payloadDigest || isEmergencyWorkflow(doc.workflowStatus)) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
          if (doc.demoHospitalReceipts?.[request.idempotencyKey]) return doc;
          const receipt = { caseId, hospitalId: request.hospitalId, idempotencyKey: request.idempotencyKey, payloadDigest: request.payloadDigest,
            receiptId: 'DEMO-' + createHash('sha256').update(caseId + request.idempotencyKey).digest('hex').slice(0, 8).toUpperCase(), verified: true };
          return { ...doc, demoHospitalReceipts: { ...doc.demoHospitalReceipts, [request.idempotencyKey]: receipt } };
        });
        return structuredClone(doc.demoHospitalReceipts[request.idempotencyKey]);
      });
    },
    async getDemoHospitalReceipt(caseId, key) { checkId(caseId); return guarded(async () => structuredClone((await driver.get(caseId))?.demoHospitalReceipts?.[key] || null)); },
    async evaluateEmergency(caseId) {
      checkId(caseId);
      return guarded(async () => {
        let changed = false, decision;
        const result = await driver.transact(caseId, doc => {
          changed = false;
          if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
          const facts = snapshotOf(doc.reportedFacts); decision = evaluateSafety(facts);
          if (doc.emergency) {
            if (!currentEmergency(doc)) throw new CaseStoreError('EMERGENCY_FACTS_CONFLICT', 409);
            return doc;
          }
          if (!decision.emergency) {
            if (isEmergencyWorkflow(doc.workflowStatus)) throw new CaseStoreError('INVALID_EMERGENCY_FACTS', 409);
            return doc;
          }
          if (!Object.values(Workflow).includes(doc.workflowStatus) || doc.workflowStatus === Workflow.ACKNOWLEDGED) throw new CaseStoreError('EMERGENCY_TRANSITION_NOT_ALLOWED', 409);
          const now = new Date().toISOString(); changed = true;
          return { ...doc, workflowStatus: Workflow.EMERGENCY, emergency: emergencyMetadata(decision, now), emergencyFactsHash: factsFingerprint(facts), updatedAt: now };
        });
        logSafety(caseId, decision); if (changed) logDispatcher(result);
        return publicCase(result, storage);
      });
    },
    async acknowledgeEmergency(caseId) {
      checkId(caseId);
      return guarded(async () => {
        let changed = false;
        const result = await driver.transact(caseId, doc => {
          changed = false;
          if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
          if (!currentEmergency(doc)) throw new CaseStoreError('EMERGENCY_TRANSITION_NOT_ALLOWED', 409);
          if (doc.emergency.status === EmergencyStatus.ACKNOWLEDGED) return doc;
          const now = new Date(Math.max(Date.now(), Date.parse(doc.emergency.triggeredAt))).toISOString(); changed = true;
          return { ...doc, workflowStatus: Workflow.ACKNOWLEDGED, updatedAt: now,
            emergency: { ...doc.emergency, status: EmergencyStatus.ACKNOWLEDGED, acknowledgedAt: now, acknowledgedBy: 'demo_dispatcher' } };
        });
        if (changed) logDispatcher(result);
        return publicCase(result, storage);
      });
    },
    async listDispatcherCases({ after } = {}) {
      const cursor = after === undefined ? null : dispatcherCursor.decode(after);
      return guarded(async () => {
        const docs = await driver.listEmergency({ after: cursor, limit: 51 });
        const cases = docs.slice(0, 50).filter(currentEmergency).map(doc => {
          const record = publicCase(doc, storage);
          return { caseId: record.caseId, patient: record.patient, emergency: record.emergency, ambulance: record.ambulance,
            emergencyDestination: record.emergencyDestination, intakeSummary: record.intakeSummary, workflowStatus: record.workflowStatus, createdAt: record.createdAt, storage };
        });
        return { cases, nextCursor: docs.length > 50 ? dispatcherCursor.encode(docs[49]) : null, storage };
      });
    },
    async getDispatcherCase(caseId) {
      checkId(caseId);
      return guarded(async () => {
        const doc = await driver.get(caseId);
        if (!currentEmergency(doc)) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        return publicCase(doc, storage);
      });
    },
    async routeCase(caseId, { availableSpecialties } = {}) {
      checkId(caseId);
      return guarded(async () => publicCase(await driver.transact(caseId, doc => {
        if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        // Existing terminal emergency state is authoritative; never write to it.
        if (isEmergencyWorkflow(doc.workflowStatus)) return doc;
        const facts = snapshotOf(doc.reportedFacts);
        if (emergencyEscalation(facts)) throw new CaseStoreError('EMERGENCY_ROUTING_BLOCKED', 409);
        if (doc.routing) {
          if (!validRouting(doc.routing) || doc.routingFactsHash !== factsFingerprint(facts)) throw new CaseStoreError('ROUTING_CONFLICT', 409);
          if (doc.routing.status !== RoutingStatus.UNASSIGNED || !(availableSpecialties instanceof Set) || !availableSpecialties.has(doc.routing.specialty) && !availableSpecialties.has(Specialty.GENERAL)) return doc;
        }
        if (![Workflow.INTAKE, Workflow.REVIEW, Workflow.COMPLETE].includes(doc.workflowStatus) || ![Handoff.NONE, Handoff.COMPLETE].includes(doc.handoffStatus)) throw new CaseStoreError('ROUTING_NOT_ALLOWED', 409);
        const decision = resolveRouting(facts, availableSpecialties), now = new Date().toISOString();
        const routing = { ...decision, routedAt: now };
        if (!validRouting(routing)) throw new CaseStoreError('INVALID_SPECIALTY', 400);
        return { ...doc, routing, routingFactsHash: factsFingerprint(facts), workflowStatus: routing.status === RoutingStatus.ROUTED ? Workflow.ROUTED : doc.workflowStatus, updatedAt: now };
      }), storage));
    },
    async getEmergencyResponseSummary() {
      return guarded(async () => {
        const [docs, fleet] = await Promise.all([driver.listEmergencyResponses({ limit: 500 }), driver.getFleet()]);
        const records = docs.filter(currentEmergency), activeRecords = records.filter(doc => isActiveEmergencyWorkflow(doc.workflowStatus));
        const counts = Object.fromEntries(['pending_dispatcher', 'acknowledged', 'assigned', 'en_route', 'at_pickup', 'transporting', 'arrived_hospital'].map(key => [key, 0]));
        let destinationsAccepted = 0;
        for (const doc of activeRecords) {
          if (doc.emergency.status === EmergencyStatus.PENDING) counts.pending_dispatcher++;
          else if (!doc.ambulance) counts.acknowledged++;
          else counts[doc.ambulance.status]++;
          if (publicEmergencyDestination(doc.emergencyDestination)) destinationsAccepted++;
        }
        const hospitalCapacity = [];
        for (const hospitalId of [...new Set(records.map(doc => doc.emergencyDestination?.hospitalId).filter(Boolean))].sort()) {
          const hospitalRecords = records.filter(doc => doc.emergencyDestination?.hospitalId === hospitalId);
          const reference = hospitalRecords.find(doc => Number.isInteger(doc.emergencyDestination?.emergencyBedsAvailable));
          const arrivedPatients = hospitalRecords.filter(doc => ['arrived_hospital', 'completed'].includes(doc.ambulance?.status)).length;
          if (reference) hospitalCapacity.push({ hospitalId, hospitalName: reference.emergencyDestination.hospitalName, arrivedPatients,
            emergencyBedsAvailable: Math.max(0, reference.emergencyDestination.emergencyBedsAvailable - arrivedPatients) });
        }
        const reservedAmbulances = fleet.filter(Boolean).length;
        return { counts: { ...counts, destinationsAccepted, activeResponses: activeRecords.length,
          availableAmbulances: demoFleet.length - reservedAmbulances, reservedAmbulances }, hospitalCapacity, simulation: true, storage };
      });
    },
    async listDoctorCases({ after, resolvePatientIdentity, specialty, specialties } = {}) {
      if (after !== undefined) checkId(after);
      const permitted = new Set((Array.isArray(specialties) ? specialties : specialty ? [specialty] : []).filter(value => specialtyCodes.includes(value)));
      return guarded(async () => {
        const docs = await driver.listRouted({ after, limit: 51 });
        const eligible = docs.slice(0, 50).filter(doc => {
          const safe = !emergencyEscalation(doc.reportedFacts);
          const assigned = doc.workflowStatus === Workflow.ROUTED && validRouting(doc.routing) && doc.routing.status === RoutingStatus.ROUTED && doc.routingFactsHash === factsFingerprint(snapshotOf(doc.reportedFacts));
          return safe && (permitted.size ? assigned && permitted.has(doc.routing.specialty) : doc.workflowStatus === Workflow.REVIEW || assigned);
        });
        const cases = await Promise.all(eligible.map(async doc => {
          const record = publicCase(doc, storage);
          let patientIdentity = null;
          if (typeof resolvePatientIdentity === 'function' && typeof doc.patientUid === 'string') {
            try { patientIdentity = await resolvePatientIdentity(doc.patientUid); } catch {}
          }
          return { caseId: record.caseId, patient: record.patient, mainReportedSymptom: supportedSymptoms(record.reportedFacts)[0]?.name || 'Not reported',
            ...(patientIdentity ? { patientIdentity } : {}), routing: record.routing, workflowStatus: record.workflowStatus, createdAt: record.createdAt, storage };
        }));
        return { cases, nextCursor: docs.length > 50 ? docs[49].caseId : null, storage };
      });
    },
    async getDoctorCase(caseId, { resolvePatientIdentity, specialty, specialties } = {}) {
      checkId(caseId);
      const permitted = new Set((Array.isArray(specialties) ? specialties : specialty ? [specialty] : []).filter(value => specialtyCodes.includes(value)));
      return guarded(async () => {
        const doc = await driver.get(caseId);
        const assigned = doc?.workflowStatus === Workflow.ROUTED && validRouting(doc.routing) && doc.routing.status === RoutingStatus.ROUTED && doc.routingFactsHash === factsFingerprint(snapshotOf(doc.reportedFacts));
        const inScope = permitted.size ? assigned && permitted.has(doc?.routing?.specialty) : doc && [Workflow.REVIEW, Workflow.ROUTED].includes(doc.workflowStatus) && (doc.workflowStatus !== Workflow.ROUTED || assigned);
        if (!doc || emergencyEscalation(doc.reportedFacts) || !inScope) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        const record = publicCase(doc, storage);
        let patientIdentity = null;
        if (typeof resolvePatientIdentity === 'function' && typeof doc.patientUid === 'string') {
          try { patientIdentity = await resolvePatientIdentity(doc.patientUid); } catch {}
        }
        return { ...record, ...(patientIdentity ? { patientIdentity } : {}) };
      });
    },
    async isDoctorCaseAllowed(caseId, specialtyOrSpecialties) {
      checkId(caseId);
      const permitted = new Set((Array.isArray(specialtyOrSpecialties) ? specialtyOrSpecialties : typeof specialtyOrSpecialties === 'string' ? [specialtyOrSpecialties] : []).filter(value => specialtyCodes.includes(value)));
      if (!permitted.size) return false;
      return guarded(async () => {
        const doc = await driver.get(caseId);
        return Boolean(doc && doc.workflowStatus === Workflow.ROUTED && validRouting(doc.routing) && doc.routing.status === RoutingStatus.ROUTED &&
          permitted.has(doc.routing.specialty) && doc.routingFactsHash === factsFingerprint(snapshotOf(doc.reportedFacts)) && !emergencyEscalation(doc.reportedFacts));
      });
    },
    async updateCaseStatus(caseId, status, attemptId) {
      checkId(caseId);
      if (![Handoff.PENDING, Handoff.ACTIVE].includes(status) || typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/.test(attemptId)) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
      return guarded(async () => publicCase(await driver.transact(caseId, doc => {
        if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        if (isEmergencyWorkflow(doc.workflowStatus)) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
        if (status === Handoff.PENDING && doc.automaticHandoff) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
        if (doc.handoffStatus === status && doc.attemptId === attemptId) return doc;
        const permitted = status === Handoff.PENDING ? [Handoff.NONE, Handoff.FAILED].includes(doc.handoffStatus) && doc.workflowStatus !== Workflow.EMERGENCY : doc.handoffStatus === Handoff.PENDING && doc.attemptId === attemptId;
        if (!permitted) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
        return { ...doc, handoffStatus: status, workflowStatus: doc.routing ? Workflow.ROUTED : status === Handoff.PENDING ? Workflow.PENDING : Workflow.ACTIVE, attemptId, failure: null, updatedAt: new Date().toISOString() };
      }), storage));
    },
    async updateHandoffResult(caseId, { attemptId, receipt, diagnostics }) {
      checkId(caseId);
      if (receipt && !/^DEMO-[A-F0-9]{8}$/.test(receipt.caseId)) throw new CaseStoreError('INVALID_RECEIPT', 400);
      return guarded(async () => publicCase(await driver.transact(caseId, doc => {
        if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        if (doc.attemptId !== attemptId) throw new CaseStoreError('STALE_HANDOFF', 409);
        if (doc.handoffStatus === Handoff.COMPLETE) return doc;
        if (receipt && doc.handoffStatus !== Handoff.ACTIVE) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
        if (![Handoff.PENDING, Handoff.ACTIVE, Handoff.FAILED].includes(doc.handoffStatus)) throw new CaseStoreError('INVALID_CASE_TRANSITION', 409);
        const now = new Date().toISOString();
        return { ...doc, handoffStatus: receipt ? Handoff.COMPLETE : Handoff.FAILED, workflowStatus: isEmergencyWorkflow(doc.workflowStatus) ? doc.workflowStatus : doc.routing ? Workflow.ROUTED : receipt ? Workflow.COMPLETE : Workflow.FAILED,
          handoffReceipt: receipt ? { caseId: receipt.caseId, completedAt: now, transport: 'generate_content' } : null,
          failure: receipt ? null : { ...safeFailure(diagnostics), updatedAt: now }, updatedAt: now };
      }), storage));
    },
    async cleanupPatientEvidence(options) {
      if (typeof driver.cleanupPatientEvidence !== 'function') return { inspected: 0, deleted: 0, preserved: 0, errors: 0 };
      return guarded(() => driver.cleanupPatientEvidence(options));
    },
    async deletePatientEvidenceForCase(caseId) {
      checkId(caseId);
      return guarded(async () => {
        const doc = await driver.get(caseId);
        if (!doc) return 0;
        return typeof driver.deletePatientEvidenceForCase === 'function' ? driver.deletePatientEvidenceForCase(doc) : 0;
      });
    },
    close: () => driver.close?.(),
  };
}

export function createMemoryCaseStore({ chatSourceMarkerEnabled = false } = {}) {
  const docs = new Map(), fleet = new Map(), evidence = new Map();
  return createCaseService({
    async getFleet() { return demoFleet.map(unit => structuredClone(fleet.get(unit.unitId) || null)); },
    async transactAssignment(id, unitId, change) {
      const next = change(structuredClone(docs.get(id) || null), structuredClone(fleet.get(unitId) || null));
      docs.set(id, structuredClone(next.case)); if (next.unit === null) fleet.delete(unitId); else fleet.set(unitId, structuredClone(next.unit)); return structuredClone(next);
    },
    async get(id) { return structuredClone(docs.get(id) || null); },
    async listPatient({ patientUid, after, limit }) {
      return [...docs.values()].filter(doc => doc.patientUid === patientUid && (!after ||
        doc.createdAt < after.createdAt || doc.createdAt === after.createdAt && doc.caseId < after.caseId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.caseId.localeCompare(a.caseId))
        .slice(0, limit).map(doc => structuredClone(doc));
    },
    async listAppointmentNoticeCases({ recipientType, recipientUid, limit }) {
      return [...docs.values()].filter(doc => recipientType === 'patient' ? doc.patientUid === recipientUid :
        (doc.appointmentNoticeDoctorUids || []).includes(recipientUid)).slice(0, limit).map(doc => structuredClone(doc));
    },
    async putPatientEvidence(id, image) { evidence.set(`${id}:${image.evidenceId}`, { ...structuredClone(image), bytes: Buffer.from(image.bytes) }); },
    async getPatientEvidence(id, evidenceId) { const image = evidence.get(`${id}:${evidenceId}`); return image ? { ...structuredClone(image), bytes: Buffer.from(image.bytes) } : null; },
    async putMedicineImage(id, image) { return this.putPatientEvidence(id, { ...image, evidenceId: 'medicine-package', kind: 'medicine_package' }); },
    async getMedicineImage(id) { return this.getPatientEvidence(id, 'medicine-package'); },
    async listEmergency({ after, limit }) { return [...docs.values()].filter(doc => isActiveEmergencyWorkflow(doc.workflowStatus) && (!after ||
      doc.createdAt < after.createdAt || doc.createdAt === after.createdAt && doc.caseId < after.caseId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.caseId.localeCompare(a.caseId)).slice(0, limit).map(doc => structuredClone(doc)); },
    async listEmergencyResponses({ limit }) { return [...docs.values()].filter(doc => isEmergencyWorkflow(doc.workflowStatus)).sort((a, b) => a.caseId.localeCompare(b.caseId)).slice(0, limit).map(doc => structuredClone(doc)); },
    async listRouted({ after, limit }) { return [...docs.values()].filter(doc => (doc.workflowStatus === Workflow.REVIEW || doc.routing?.status === RoutingStatus.ROUTED) && (!after || doc.caseId > after)).sort((a, b) => a.caseId.localeCompare(b.caseId)).slice(0, limit).map(doc => structuredClone(doc)); },
    async transact(id, change) { const next = change(structuredClone(docs.get(id) || null)); docs.set(id, structuredClone(next)); return structuredClone(next); },
  }, 'memory', { chatSourceMarkerEnabled });
}

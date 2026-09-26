import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { caseFields } from '../agent/cases.js';
import { emptyIntake } from '../intake/schema.js';
import { emergencyEscalation } from '../emergency.js';
import { evaluateRouting, factsFingerprint, publicRouting, validRouting, supportedSymptoms } from './routing.js';
import { RoutingStatus } from '../../../shared/routing.js';
import { evaluateSafety } from '../safety/engine.js';
import { emergencyMetadata, publicEmergency } from '../safety/metadata.js';
import { EmergencyStatus, EmergencyWorkflow, isEmergencyWorkflow } from '../../../shared/emergency.js';
import { canonicalizeSymptom } from '../intake/symptom-grounding.js';
import { publicAmbulance, ambulanceWorkflowMatches, demoFleet } from '../ambulance/fleet.js';
import { createAmbulanceService } from '../ambulance/service.js';

export const Workflow = Object.freeze({ INTAKE: 'intake_completed', REVIEW: 'submitted_for_clinical_review', PENDING: 'handoff_pending', ACTIVE: 'handoff_in_progress', COMPLETE: 'handoff_completed', FAILED: 'handoff_failed', EMERGENCY: EmergencyWorkflow.PENDING, ACKNOWLEDGED: EmergencyWorkflow.ACKNOWLEDGED, ROUTED: 'routed_to_doctor' });
export const Handoff = Object.freeze({ NONE: 'not_started', PENDING: 'pending', ACTIVE: 'in_progress', COMPLETE: 'completed', FAILED: 'failed' });
export const newCaseId = () => `SC-${randomUUID()}`;
export const validCaseId = id => typeof id === 'string' && /^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export class CaseStoreError extends Error {
  constructor(code = 'CASE_STORE_UNAVAILABLE', status = 503) { super('Patient case storage is unavailable. Please retry later.'); this.code = code; this.status = status; }
}
const checkId = id => { if (!validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400); };
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
  return { caseId: doc.caseId, patient: facts.patient, intakeSummary: caseFields(facts, { allowEmpty }), reportedFacts: facts,
    workflowStatus: doc.workflowStatus, handoffStatus: doc.handoffStatus, routing: publicRouting(doc.routing), emergency: publicEmergency(doc.emergency), ambulance: publicAmbulance(doc.ambulance),
    handoffReceipt: doc.handoffReceipt ? pick(doc.handoffReceipt, ['caseId', 'completedAt', 'transport']) : null,
    demoConsent: doc.demoConsent ? pick(doc.demoConsent, ['fictionalConfirmed', 'confirmedAt']) : null,
    automaticHandoff: doc.automaticHandoff ? pick(doc.automaticHandoff, ['status', 'queuedAt']) : null,
    hospitalHandoffs: Object.values(doc.hospitalHandoffs || {}).map(item => pick(item, ['idempotencyKey', 'hospitalId', 'connector', 'status', 'receipt', 'failureCode'])),
    failure: doc.failure ? { ...safeFailure(doc.failure), updatedAt: doc.failure.updatedAt } : null,
    source: 'smartcareops_demo', intakeSource: doc.intakeSource || null,
    enrichmentStatus: ['pending', 'succeeded', 'failed'].includes(doc.enrichmentStatus) ? doc.enrichmentStatus : null,
    enrichmentErrorCategory: typeof doc.enrichmentErrorCategory === 'string' ? doc.enrichmentErrorCategory : null,
    createdAt: doc.createdAt, updatedAt: doc.updatedAt, storage };
}

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

export function createCaseService(driver, storage) {
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
    async createCase({ caseId, intake, emergency = false, patientUid = null, fictionalConfirmed = false, submittedForReview = false,
      intakeSource = null, enrichmentStatus = null }) {
      checkId(caseId); const allowEmpty = intakeSource === 'live_intake' && enrichmentStatus === 'pending';
      const facts = snapshotOf(intake, { allowEmpty });
      if (patientUid !== null && (typeof patientUid !== 'string' || !patientUid || patientUid.length > 128)) throw new CaseStoreError('INVALID_PATIENT_IDENTITY', 400);
      const decision = evaluateSafety(facts); logSafety(caseId, decision);
      if (emergency && !decision.emergency) throw new CaseStoreError('INVALID_EMERGENCY_FACTS', 409);
      return guarded(async () => {
        let created = false;
        const doc = await driver.transact(caseId, existing => {
          created = false;
          if (existing) {
            if (!isDeepStrictEqual(existing.reportedFacts, facts)) throw new CaseStoreError('CASE_CONFLICT', 409);
            if (patientUid && existing.patientUid && patientUid !== existing.patientUid) throw new CaseStoreError('CASE_CONFLICT', 409);
            return existing;
          }
          const now = new Date().toISOString(); created = true;
          return { caseId, patient: facts.patient, intakeSummary: caseFields(facts, { allowEmpty }), reportedFacts: facts, ...(patientUid ? { patientUid } : {}),
            workflowStatus: decision.emergency ? Workflow.EMERGENCY : submittedForReview ? Workflow.REVIEW : Workflow.INTAKE, handoffStatus: Handoff.NONE,
            ...(decision.emergency ? { emergency: emergencyMetadata(decision, now), emergencyFactsHash: factsFingerprint(facts) } : {}),
            ...(fictionalConfirmed === true ? { demoConsent: { fictionalConfirmed: true, confirmedAt: now } } : {}),
            handoffReceipt: null, failure: null, source: 'smartcareops_demo',
            ...(intakeSource === 'live_intake' ? { intakeSource } : {}),
            ...(['pending', 'succeeded', 'failed'].includes(enrichmentStatus) ? { enrichmentStatus, enrichmentErrorCategory: null } : {}),
            createdAt: now, updatedAt: now, attemptId: null };
        });
        if (created && doc.emergency) logDispatcher(doc);
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
          return { ...existing, patient: facts.patient, intakeSummary: caseFields(facts), reportedFacts: facts,
            enrichmentStatus: 'succeeded', enrichmentErrorCategory: null,
            ...(emergencyChanged ? { workflowStatus: Workflow.EMERGENCY, emergency: emergencyMetadata(decision, now), emergencyFactsHash: factsFingerprint(facts) } : {}),
            updatedAt: now };
        });
        if (emergencyChanged) logDispatcher(doc);
        return publicCase(doc, storage);
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
      if (after !== undefined) checkId(after);
      return guarded(async () => {
        const docs = await driver.listEmergency({ after, limit: 51 });
        const cases = docs.slice(0, 50).filter(currentEmergency).map(doc => {
          const record = publicCase(doc, storage);
          return { caseId: record.caseId, patient: record.patient, emergency: record.emergency, ambulance: record.ambulance, intakeSummary: record.intakeSummary, workflowStatus: record.workflowStatus, createdAt: record.createdAt, storage };
        });
        return { cases, nextCursor: docs.length > 50 ? docs[49].caseId : null, storage };
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
    async routeCase(caseId) {
      checkId(caseId);
      return guarded(async () => publicCase(await driver.transact(caseId, doc => {
        if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        // Existing terminal emergency state is authoritative; never write to it.
        if (isEmergencyWorkflow(doc.workflowStatus)) return doc;
        const facts = snapshotOf(doc.reportedFacts);
        if (emergencyEscalation(facts)) throw new CaseStoreError('EMERGENCY_ROUTING_BLOCKED', 409);
        if (doc.routing) {
          if (!validRouting(doc.routing) || doc.routingFactsHash !== factsFingerprint(facts)) throw new CaseStoreError('ROUTING_CONFLICT', 409);
          return doc;
        }
        if (![Workflow.INTAKE, Workflow.REVIEW, Workflow.COMPLETE].includes(doc.workflowStatus) || ![Handoff.NONE, Handoff.COMPLETE].includes(doc.handoffStatus)) throw new CaseStoreError('ROUTING_NOT_ALLOWED', 409);
        const decision = evaluateRouting(facts), now = new Date().toISOString();
        const routing = { status: RoutingStatus.ROUTED, ...decision, routedAt: now };
        if (!validRouting(routing)) throw new CaseStoreError('INVALID_SPECIALTY', 400);
        return { ...doc, routing, routingFactsHash: factsFingerprint(facts), workflowStatus: Workflow.ROUTED, updatedAt: now };
      }), storage));
    },
    async listDoctorCases({ after, resolvePatientIdentity } = {}) {
      if (after !== undefined) checkId(after);
      return guarded(async () => {
        const docs = await driver.listRouted({ after, limit: 51 });
        const eligible = docs.slice(0, 50).filter(doc => (doc.workflowStatus === Workflow.REVIEW || doc.workflowStatus === Workflow.ROUTED && validRouting(doc.routing) && doc.routingFactsHash === factsFingerprint(snapshotOf(doc.reportedFacts))) && !emergencyEscalation(doc.reportedFacts));
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
    async getDoctorCase(caseId, { resolvePatientIdentity } = {}) {
      checkId(caseId);
      return guarded(async () => {
        const doc = await driver.get(caseId);
        if (!doc || ![Workflow.REVIEW, Workflow.ROUTED].includes(doc.workflowStatus) || doc.workflowStatus === Workflow.ROUTED && (!validRouting(doc.routing) || doc.routingFactsHash !== factsFingerprint(snapshotOf(doc.reportedFacts))) || emergencyEscalation(doc.reportedFacts)) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        const record = publicCase(doc, storage);
        let patientIdentity = null;
        if (typeof resolvePatientIdentity === 'function' && typeof doc.patientUid === 'string') {
          try { patientIdentity = await resolvePatientIdentity(doc.patientUid); } catch {}
        }
        return { ...record, ...(patientIdentity ? { patientIdentity } : {}) };
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
    close: () => driver.close?.(),
  };
}

export function createMemoryCaseStore() {
  const docs = new Map(), fleet = new Map();
  return createCaseService({
    async getFleet() { return demoFleet.map(unit => structuredClone(fleet.get(unit.unitId) || null)); },
    async transactAssignment(id, unitId, change) {
      const next = change(structuredClone(docs.get(id) || null), structuredClone(fleet.get(unitId) || null));
      docs.set(id, structuredClone(next.case)); fleet.set(unitId, structuredClone(next.unit)); return structuredClone(next);
    },
    async get(id) { return structuredClone(docs.get(id) || null); },
    async listEmergency({ after, limit }) { return [...docs.values()].filter(doc => isEmergencyWorkflow(doc.workflowStatus) && (!after || doc.caseId > after)).sort((a, b) => a.caseId.localeCompare(b.caseId)).slice(0, limit).map(doc => structuredClone(doc)); },
    async listRouted({ after, limit }) { return [...docs.values()].filter(doc => (doc.workflowStatus === Workflow.REVIEW || doc.routing?.status === RoutingStatus.ROUTED) && (!after || doc.caseId > after)).sort((a, b) => a.caseId.localeCompare(b.caseId)).slice(0, limit).map(doc => structuredClone(doc)); },
    async transact(id, change) { const next = change(structuredClone(docs.get(id) || null)); docs.set(id, structuredClone(next)); return structuredClone(next); },
  }, 'memory');
}

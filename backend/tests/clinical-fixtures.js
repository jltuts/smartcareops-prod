import { newCaseId, createMemoryCaseStore } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';
import { memoryClinicalStore } from '../src/clinical/storage.js';
import { createClinicalService } from '../src/clinical/service.js';
export const observationSet = (requestId = 'setA', value = 94, observedAt = '2026-09-22T01:00:00.000Z') => ({ requestId, observations: [{ type: 'spo2', value, unit: '%', source: 'fictional_device', observedAt, status: 'reported', correctionOf: null }] });
export const assessment = context => ({ caseSummary: 'Patient-reported information and available observations require doctor review.',
  importantFindings: [{ summary: 'A patient-reported concern is available for review.', evidenceRefs: ['case'] }],
  observations: [{ summary: 'Fictional oxygen observations changed.', evidenceRefs: [context.evidenceRefs.at(-1)] }],
  hypotheses: [{ summary: 'Possible respiratory deterioration; clinician review needed, not a diagnosis.', evidenceRefs: ['history'] }],
  risks: [{ summary: 'Reported trend warrants review.', evidenceRefs: [context.evidenceRefs.at(-1)] }],
  differentialConsiderations: [{ summary: 'A respiratory explanation is possible but unconfirmed.', evidenceRefs: ['case'] }],
  uncertainty: ['Fictional data does not establish a diagnosis.'], recommendedNextStep: 'Request doctor assessment before any consequential action.',
  whyRecommended: [{ summary: 'The reported concern warrants human assessment.', evidenceRefs: ['case'] }],
  alternatives: [{ step: 'Continue observation only', whyNot: 'Current information may require a timely clinician review.', evidenceRefs: ['case'] }],
  whatWouldChangeRecommendation: ['New verified observations or a doctor assessment could change the plan.'],
  uncertainties: ['Fictional data does not establish a diagnosis.'], conflictingEvidence: [], missingInformation: ['No verified laboratory results.'],
  changeSummary: 'New fictional observations are available for review.', recommendedActions: [
    { toolName: 'read_fictional_patient_history', expectedOutcome: 'Review fictional history.', proposedRisk: 'HIGH_IMPACT' },
    { toolName: 'simulate_clinical_review', expectedOutcome: 'Create only a fictional review receipt.', proposedRisk: 'READ_ONLY' },
  ], monitoringConditions: ['Evaluate when new validated observations arrive.'],
});
export async function fixture(options = {}) {
  const caseId = newCaseId(), caseStore = createMemoryCaseStore(), store = memoryClinicalStore(new Map(), () => caseStore.listAmbulances());
  await caseStore.createCase({ caseId, intake: routingIntake() });
  const settings = { caseId, caseStore, store, model: async context => assessment(context), modelName: 'test-model', ...options };
  return { ...settings, service: createClinicalService(settings) };
}

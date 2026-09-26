import { evaluateSafety } from '../safety/engine.js';
import { requireThat, policy } from './contracts.js';
import { resourceToolNames } from '../resources/contracts.js';

export const fictionalHistory = Object.freeze({ source: 'explicit_m8_fictional_fixture', version: 1, conditions: ['asthma', 'previous pneumonia'], disclaimer: 'Scenario history only; not extracted or inferred from the original intake.' });
export async function queryTool(name, { caseStore, caseId, state, resources, args = {} }) {
  requireThat(!policy(name, args).approvalRequired, 'QUERY_ONLY');
  if (resourceToolNames.includes(name)) { requireThat(resources, 'RESOURCE_TOOLS_DISABLED', 409); return resources.execute(name, args, { state, caseStore }); }
  if (name === 'read_observation_history') return Object.values(state.observations).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  if (name === 'read_fictional_patient_history') return fictionalHistory;
  if (name === 'read_ambulance_availability') return caseStore.listAmbulances();
  const patientCase = await caseStore.getCase(caseId); requireThat(patientCase, 'CASE_NOT_FOUND', 404);
  if (name === 'read_case') return patientCase;
  if (name === 'read_doctor_routing') return patientCase.routing;
  if (name === 'evaluate_safety') return { ...evaluateSafety(patientCase.reportedFacts), disclaimer: 'Five original intake red-flag rules only. No match is not clinical clearance. Follow-up observations do not rewrite intake.' };
  throw new Error('Unknown tool');
}
// A domain simulator, not a medical order/notification. Called only after the
// execution journal exists. Receipt and completion commit atomically in Firestore.
export function simulateClinicalReview(state, execution, now) {
  requireThat(execution.status === 'running' && execution.toolName === 'simulate_clinical_review', 'INVALID_EXECUTION');
  const receiptId = `receipt_${execution.executionId}`;
  if (!state.receipts[receiptId]) state.receipts[receiptId] = {
    receiptId, caseId: execution.caseId, executionId: execution.executionId, simulation: true,
    hospitalId: 'fictional-hospital-m8', createdAt: now,
    outcome: 'Fictional clinical review recorded. No medical order, notification, hospital contact or dispatch occurred.',
  };
  return state.receipts[receiptId];
}

import { exact, requireThat, textValue } from '../clinical/contracts.js';
import { notificationRisks } from '../notifications/contracts.js';
export const scope = Object.freeze({ scope: 'hospital', hospitalId: 'HOSP-001', workspaceId: 'OPS-HOSP-001', agentType: 'hospital_operations', simulation: true });
export const tools = Object.freeze({ read_operations_snapshot: 'READ_ONLY', publish_operations_summary: 'LOW_RISK_OPERATION', simulate_capacity_response: 'HIGH_IMPACT', simulate_staffing_response: 'HIGH_IMPACT', ...notificationRisks });
const string = { type: 'string' }, strings = { type: 'array', items: string };
const statement = { type: 'object', additionalProperties: false, properties: { summary: string, evidenceRefs: strings }, required: ['summary', 'evidenceRefs'] };
export const assessmentSchema = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', enum: ['NORMAL', 'WATCH', 'CONSTRAINED'] }, changeSummary: string,
  observations: { type: 'array', items: statement }, operationalRisks: { type: 'array', items: statement }, bottlenecks: { type: 'array', items: statement },
  uncertainties: strings, monitoringConditions: strings,
  recommendedActions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { toolName: { type: 'string', enum: Object.keys(tools) }, expectedOutcome: string }, required: ['toolName', 'expectedOutcome'] } },
}, required: ['status', 'changeSummary', 'observations', 'operationalRisks', 'bottlenecks', 'uncertainties', 'monitoringConditions', 'recommendedActions'] };
export function validateAssessment(value, refs) {
  exact(value, assessmentSchema.required);
  requireThat(['NORMAL', 'WATCH', 'CONSTRAINED'].includes(value.status) && textValue(value.changeSummary));
  for (const key of ['observations', 'operationalRisks', 'bottlenecks']) {
    requireThat(Array.isArray(value[key]) && value[key].length <= 8);
    for (const item of value[key]) { exact(item, ['summary', 'evidenceRefs']); requireThat(textValue(item.summary) && Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 && item.evidenceRefs.length <= 12 && item.evidenceRefs.every(ref => refs.includes(ref))); }
  }
  for (const key of ['uncertainties', 'monitoringConditions']) requireThat(Array.isArray(value[key]) && value[key].length <= 8 && value[key].every(item => textValue(item)));
  requireThat(Array.isArray(value.recommendedActions) && value.recommendedActions.length <= 4);
  const seen = new Set();
  for (const action of value.recommendedActions) { exact(action, ['toolName', 'expectedOutcome']); requireThat(Object.hasOwn(tools, action.toolName) && !seen.has(action.toolName) && textValue(action.expectedOutcome)); seen.add(action.toolName); }
  return structuredClone(value);
}
export function validateOperationalAssessment(value, context) {
  const assessment = validateAssessment(value, context.evidenceRefs);
  const alternative = context.resourceInvestigation?.find(item => item.toolName === 'get_hospital_capacity' && item.result.hospitalId === 'HOSP-003' && item.result.monitoredBedsAvailable > 0);
  if (context.snapshot.capacity.monitoredBedsAvailable === 0 && alternative) {
    requireThat([...assessment.observations, ...assessment.operationalRisks, ...assessment.bottlenecks].some(item => item.summary.includes('HOSP-003') && item.evidenceRefs.includes(alternative.evidenceId)), 'OPERATIONS_ALTERNATIVE_EVIDENCE_REQUIRED');
  }
  return assessment;
}

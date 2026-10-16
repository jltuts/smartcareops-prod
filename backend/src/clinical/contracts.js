import { createHash } from 'node:crypto';
import { notificationToolNames, isActionTool, actionTools, validateBoundArguments } from '../notifications/contracts.js';
import { resourceToolNames, validateArguments } from '../resources/contracts.js';
import { resourceArgumentsSchema } from '../resources/investigator.js';
import { handoffTool, validateHospitalArguments } from '../hospital/contracts.js';
export class ClinicalError extends Error {
  constructor(code = 'CLINICAL_UNAVAILABLE', status = 409) { super('Clinical demo request could not be completed. Refresh to review current state.'); this.code = code; this.status = status; }
}
export const requireThat = (condition, code = 'INVALID_CLINICAL_REQUEST', status = 400) => { if (!condition) throw new ClinicalError(code, status); };
export const exact = (value, keys) => requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key)));
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonicalValue(value[key])]));
  return value;
};
export const canonicalDigest = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
export const textValue = (value, max = 600) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export const scope = Object.freeze({ simulation: true, hospitalId: 'fictional-hospital-m8' });
export function validateObservations(input, now) {
  exact(input, ['requestId', 'observations']); requireThat(token(input.requestId));
  requireThat(Array.isArray(input.observations) && input.observations.length > 0 && input.observations.length <= 10);
  return input.observations.map(item => {
    exact(item, ['type', 'value', 'unit', 'source', 'observedAt', 'status', 'correctionOf']);
    requireThat(['temperature', 'heart_rate', 'blood_pressure', 'spo2', 'symptom_update'].includes(item.type));
    requireThat(['fictional_device', 'fictional_patient', 'fictional_clinician'].includes(item.source));
    requireThat(item.status === 'reported' && (item.correctionOf === null || token(item.correctionOf)));
    const date = Date.parse(item.observedAt);
    requireThat(typeof item.observedAt === 'string' && Number.isFinite(date) && date <= now + 60000);
    const units = { temperature: '°C', heart_rate: 'bpm', blood_pressure: 'mmHg', spo2: '%', symptom_update: '' };
    requireThat(item.unit === units[item.type]);
    if (item.type === 'symptom_update') requireThat(textValue(item.value, 300));
    else if (item.type === 'blood_pressure') {
      exact(item.value, ['systolic', 'diastolic']); requireThat(Object.values(item.value).every(n => Number.isFinite(n) && n > 0 && n <= 500));
    } else requireThat(Number.isFinite(item.value) && item.value > 0 && item.value <= (item.type === 'spo2' ? 100 : item.type === 'temperature' ? 60 : 500));
    // Bounds are data-format plausibility limits, never emergency thresholds.
    return { ...item, observedAt: new Date(date).toISOString() };
  });
}
export const toolNames = ['read_case', 'read_observation_history', 'read_fictional_patient_history', 'evaluate_safety', 'read_doctor_routing', 'read_ambulance_availability', 'simulate_clinical_review', handoffTool, ...resourceToolNames, ...notificationToolNames];
export function policy(toolName, args) {
  requireThat(toolNames.includes(toolName), 'TOOL_NOT_ALLOWED');
  if (toolName === handoffTool) { validateHospitalArguments(args); return { effectiveRisk: 'HIGH_IMPACT', approvalRequired: true }; }
  if (isActionTool(toolName)) { if (Object.keys(args).length) validateBoundArguments(toolName, args); const risk = actionTools[toolName].risk; return { effectiveRisk: risk, approvalRequired: risk === 'HIGH_IMPACT' }; }
  if (resourceToolNames.includes(toolName)) validateArguments(toolName, args); else exact(args, []);
  const high = toolName === 'simulate_clinical_review';
  return { effectiveRisk: high ? 'HIGH_IMPACT' : 'READ_ONLY', approvalRequired: high };
}
const stringSchema = { type: 'string' }, strings = { type: 'array', items: stringSchema };
const statement = { type: 'object', properties: { summary: stringSchema, evidenceRefs: strings }, required: ['summary', 'evidenceRefs'], additionalProperties: false };
const alternative = { type: 'object', properties: { step: stringSchema, whyNot: stringSchema, evidenceRefs: strings }, required: ['step', 'whyNot', 'evidenceRefs'], additionalProperties: false };
export const assessmentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    caseSummary: stringSchema, importantFindings: { type: 'array', items: statement },
    observations: { type: 'array', items: statement }, hypotheses: { type: 'array', items: statement }, risks: { type: 'array', items: statement },
    differentialConsiderations: { type: 'array', items: statement }, uncertainty: strings,
    recommendedNextStep: stringSchema, whyRecommended: { type: 'array', items: statement }, alternatives: { type: 'array', items: alternative }, whatWouldChangeRecommendation: strings,
    uncertainties: strings, conflictingEvidence: strings, missingInformation: strings, changeSummary: stringSchema,
    recommendedActions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      toolName: { type: 'string', enum: toolNames }, arguments: resourceArgumentsSchema, expectedOutcome: stringSchema, proposedRisk: { type: 'string', enum: ['READ_ONLY', 'LOW_RISK_OPERATION', 'HIGH_IMPACT'] },
    }, required: ['toolName', 'expectedOutcome', 'proposedRisk'] } },
    monitoringConditions: strings,
  },
  required: ['caseSummary', 'importantFindings', 'observations', 'hypotheses', 'risks', 'differentialConsiderations', 'uncertainty', 'recommendedNextStep', 'whyRecommended', 'alternatives', 'whatWouldChangeRecommendation', 'uncertainties', 'conflictingEvidence', 'missingInformation', 'changeSummary', 'recommendedActions', 'monitoringConditions'],
};
export function validateAssessment(value, evidenceRefs) {
  exact(value, assessmentSchema.required);
  const list = (v, max = 8) => requireThat(Array.isArray(v) && v.length <= max);
  requireThat(textValue(value.caseSummary) && textValue(value.recommendedNextStep));
  for (const key of ['importantFindings', 'observations', 'hypotheses', 'risks', 'differentialConsiderations', 'whyRecommended']) {
    list(value[key]);
    for (const entry of value[key]) {
      exact(entry, ['summary', 'evidenceRefs']); requireThat(textValue(entry.summary)); list(entry.evidenceRefs, 20);
      requireThat(entry.evidenceRefs.length > 0 && entry.evidenceRefs.every(ref => evidenceRefs.includes(ref)));
    }
  }
  list(value.alternatives, 4);
  for (const item of value.alternatives) { exact(item, ['step', 'whyNot', 'evidenceRefs']); requireThat(textValue(item.step) && textValue(item.whyNot)); list(item.evidenceRefs, 20); requireThat(item.evidenceRefs.every(ref => evidenceRefs.includes(ref))); }
  requireThat(value.observations.length > 0 && textValue(value.changeSummary));
  for (const key of ['uncertainty', 'whatWouldChangeRecommendation', 'uncertainties', 'conflictingEvidence', 'missingInformation', 'monitoringConditions']) { list(value[key]); requireThat(value[key].every(v => textValue(v))); }
  requireThat(value.uncertainties.length > 0 && value.monitoringConditions.length > 0);
  list(value.recommendedActions, 4); requireThat(value.recommendedActions.length > 0);
  const seen = new Set();
  for (const action of value.recommendedActions) {
    if (isActionTool(action.toolName)) exact(action.arguments || {}, []);
    exact(action, ['toolName', 'expectedOutcome', 'proposedRisk', ...(Object.hasOwn(action, 'arguments') ? ['arguments'] : [])]); policy(action.toolName, action.arguments || {});
    requireThat(!seen.has(action.toolName) && textValue(action.expectedOutcome) && ['READ_ONLY', 'LOW_RISK_OPERATION', 'HIGH_IMPACT'].includes(action.proposedRisk)); seen.add(action.toolName);
  }
  return structuredClone(value);
}

import { exact, requireThat } from '../clinical/contracts.js';
import { notificationRisks } from '../notifications/contracts.js';
export { scope } from './snapshot.js';
export const tools = Object.freeze({ inspect_regional_snapshot: 'READ_ONLY', prepare_regional_summary: 'LOW_RISK_OPERATION', simulate_transfer_coordination: 'HIGH_IMPACT', simulate_regional_capacity: 'HIGH_IMPACT', ...notificationRisks });
export function evidenceChoices(context) {
  const s = context.snapshot, snapshotRefs = [s.snapshotId], trendRefs = [s.trendId], geoRefs = [s.geography.evidenceId];
  const choices = {
    limited_evidence: { summary: 'Evidence is limited to fictional aggregate census samples; further human review is required.', evidenceRefs: snapshotRefs },
    census_comparison: { summary: `Respiratory census count changed from ${s.aggregate.previousWindowRespiratoryCases} to ${s.aggregate.respiratoryCases} across two adjacent ${s.windowHours}-hour windows. These are census samples, not new infection counts.`, evidenceRefs: trendRefs },
    capacity_pressure: { summary: `${s.aggregate.zeroMonitoredHospitals} participating hospitals have zero available monitored beds in the simulated resource catalog.`, evidenceRefs: snapshotRefs },
    geography: { summary: `The three fictional hospital locations are ${s.geography.concentrated ? 'within' : 'not all within'} the documented 10 km proximity distance. Proximity does not establish transmission.`, evidenceRefs: geoRefs },
    fleet_state: { summary: s.fleet ? `The shared simulated fleet has ${s.fleet.available} available and ${s.fleet.reserved} reserved units; a demand trend is not established.` : 'Current fleet evidence is unavailable.', evidenceRefs: snapshotRefs },
    no_pathogen_evidence: { summary: 'No pathogen testing or causal linkage is represented in these aggregate inputs.', evidenceRefs: snapshotRefs },
    sampling_limits: { summary: 'Sampling and reporting differences could explain part of the observed pattern; fever coverage is incomplete and oxygen trends are not represented.', evidenceRefs: snapshotRefs },
  };
  if (s.signals.includes('multi_hospital_respiratory_increase')) choices.possible_cluster = { summary: `Possible emerging respiratory cluster across ${s.aggregate.hospitalsAffected} participating facilities; this signal requires human review and does not establish an epidemiological diagnosis.`, evidenceRefs: trendRefs };
  if (s.pressureSignal) choices.hospital_pressure = { summary: `HOSP-001 supplied a durable hospital pressure signal from ${s.pressureSignal.planRevisionId}.`, evidenceRefs: [s.pressureSignal.eventId] };
  const overflow = s.hospitals.filter(item => item.capacity.monitoredBedsAvailable > 0).map(item => item.hospitalId);
  choices.overflow_options = { summary: overflow.length ? `Simulated monitored-bed options for human review: ${overflow.join(', ')}. Availability is not an admission or transfer guarantee.` : 'No participating hospital reports available monitored beds; human capacity review is warranted.', evidenceRefs: snapshotRefs };
  return choices;
}
const kinds = ['limited_evidence', 'census_comparison', 'capacity_pressure', 'geography', 'fleet_state', 'no_pathogen_evidence', 'sampling_limits', 'possible_cluster', 'hospital_pressure', 'overflow_options'];
const list = { type: 'array', items: { type: 'string', enum: kinds } };
export const assessmentSchema = { type: 'object', additionalProperties: false, properties: {
  observations: list, suspectedSignals: list, supportingEvidence: list, conflictingEvidence: list, uncertainties: list, operationalRisks: list,
  recommendedActions: { type: 'array', items: { type: 'string', enum: Object.keys(tools) } },
  monitoringConditions: { type: 'array', items: { type: 'string', enum: ['census_change', 'capacity_change', 'fleet_change', 'hospital_signal_change'] } },
}, required: ['observations', 'suspectedSignals', 'supportingEvidence', 'conflictingEvidence', 'uncertainties', 'operationalRisks', 'recommendedActions', 'monitoringConditions'] };
const monitors = { census_change: 'Review when a new validated census sample arrives.', capacity_change: 'Review when participating hospital capacity changes.', fleet_change: 'Review when fleet reservations change.', hospital_signal_change: 'Review when a new hospital pressure signal arrives.' };
export function validateAssessment(value, context) {
  exact(value, assessmentSchema.required); const choices = evidenceChoices(context), output = {};
  for (const key of assessmentSchema.required) {
    const allowed = key === 'recommendedActions' ? tools : key === 'monitoringConditions' ? monitors : choices;
    requireThat(Array.isArray(value[key]) && value[key].length <= 8 && new Set(value[key]).size === value[key].length && value[key].every(item => typeof item === 'string' && Object.hasOwn(allowed, item)), 'UNSAFE_REGIONAL_ASSESSMENT');
    output[key] = value[key].map(kind => key === 'recommendedActions' ? { toolName: kind, expectedOutcome: tools[kind] === 'HIGH_IMPACT' ? 'Record a human-approved fictional regional rehearsal only.' : 'Record a local regional review receipt.' } : key === 'monitoringConditions' ? monitors[kind] : { kind, ...choices[kind] });
  }
  requireThat(value.uncertainties.includes('limited_evidence') && value.conflictingEvidence.includes('no_pathogen_evidence') && value.observations.includes('census_comparison') && value.operationalRisks.includes('capacity_pressure'), 'REGIONAL_EVIDENCE_REQUIRED');
  requireThat(!choices.possible_cluster || value.suspectedSignals.includes('possible_cluster'), 'REGIONAL_SIGNAL_REQUIRED');
  requireThat(!choices.hospital_pressure || value.supportingEvidence.includes('hospital_pressure'), 'REGIONAL_HANDOFF_REQUIRED');
  requireThat(value.supportingEvidence.includes('geography') && value.supportingEvidence.includes('overflow_options'), 'REGIONAL_INVESTIGATION_REQUIRED');
  return { ...output, changeSummary: `Regional snapshot ${context.snapshot.snapshotVersion}: respiratory census ${context.snapshot.aggregate.previousWindowRespiratoryCases} → ${context.snapshot.aggregate.respiratoryCases}; hospitals with zero monitored beds: ${context.snapshot.aggregate.zeroMonitoredHospitals}.`,
    signal: choices.possible_cluster ? 'Possible emerging respiratory cluster' : 'Operational pattern requiring review', safeLanguageVersion: 'regional-v1-controlled-statements' };
}

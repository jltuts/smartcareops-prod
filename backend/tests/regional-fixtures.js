import { operationsFixture } from './operations-fixtures.js';
import { memoryRegionalStore } from '../src/regional/storage.js';
import { createRegionalService } from '../src/regional/service.js';
export function regionalAssessment(context) {
  return { observations: ['census_comparison', 'fleet_state'], suspectedSignals: context.snapshot.signals.includes('multi_hospital_respiratory_increase') ? ['possible_cluster'] : [],
    supportingEvidence: ['geography', 'overflow_options', ...(context.snapshot.pressureSignal ? ['hospital_pressure'] : [])], conflictingEvidence: ['no_pathogen_evidence'],
    uncertainties: ['limited_evidence', 'sampling_limits'], operationalRisks: ['capacity_pressure'],
    recommendedActions: ['inspect_regional_snapshot', 'prepare_regional_summary', 'simulate_transfer_coordination', 'simulate_regional_capacity'], monitoringConditions: ['census_change', 'capacity_change', 'fleet_change'] };
}
export async function regionalFixture(options = {}) {
  const hospital = await operationsFixture(); await hospital.service.tick();
  const store = memoryRegionalStore(hospital.caseStore, () => hospital.store.read('OPS-HOSP-001'));
  const settings = { store, caseStore: hospital.caseStore, model: async context => regionalAssessment(context), ...options };
  const service = createRegionalService(settings); await service.seed({ requestId: 'demo', windowEnd: new Date().toISOString() });
  return { ...settings, service, hospital };
}

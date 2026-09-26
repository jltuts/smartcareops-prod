import { fixture, assessment } from './clinical-fixtures.js';
import { createResourceService } from '../src/resources/service.js';
export function resourceRequests() {
  const requests = [
    { toolName: 'get_patient_location_context', arguments: {} },
    { toolName: 'find_nearby_hospitals', arguments: { requiredCapabilities: ['pulmonology', 'monitored_care'], maxResults: 3 } },
    { toolName: 'get_ambulance_availability', arguments: {} },
  ];
  for (const hospitalId of ['HOSP-001', 'HOSP-003']) {
    requests.push({ toolName: 'get_hospital_capabilities', arguments: { hospitalId } },
      { toolName: 'get_hospital_capacity', arguments: { hospitalId } },
      { toolName: 'find_available_specialists', arguments: { hospitalId, specialty: 'pulmonology' } },
      { toolName: 'calculate_ambulance_route', arguments: { ambulanceUnitId: 'AMB-02', origin: 'patient', destination: hospitalId } });
  }
  return requests;
}
export function resourceAssessment(context) {
  const result = assessment(context), resource = context.resourceInvestigation.find(r => r.toolName === 'get_hospital_capacity' && r.result.hospitalId === 'HOSP-001');
  result.observations.push({ summary: 'HOSP-001 monitored beds: ' + resource.result.monitoredBedsAvailable + '. Simulation.', evidenceRefs: [resource.snapshotId] });
  result.changeSummary = resource.result.monitoredBedsAvailable === 0 ? 'HOSP-001 has zero monitored beds; investigate HOSP-003 as a fictional alternative.' : 'HOSP-001 has two monitored beds in the fictional resource snapshot.';
  result.recommendedActions[0] = { toolName: 'get_hospital_capacity', arguments: { hospitalId: 'HOSP-001' }, expectedOutcome: 'Inspect current simulated capacity.', proposedRisk: 'HIGH_IMPACT' };
  return result;
}
export async function resourceFixture(options = {}) {
  return fixture({ resources: createResourceService(), investigator: async () => resourceRequests(), model: async context => resourceAssessment(context), ...options });
}

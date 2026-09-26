import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';
import { emergencyIntake } from './safety-fixtures.js';
import { memoryOperationsStore } from '../src/operations/storage.js';
import { createOperationsService } from '../src/operations/service.js';
export const operationsAssessment = context => ({ status: context.snapshot.capacity.monitoredBedsAvailable ? 'WATCH' : 'CONSTRAINED',
  changeSummary: `Monitored beds ${context.previousSnapshot?.capacity.monitoredBedsAvailable ?? 'initial'} to ${context.snapshot.capacity.monitoredBedsAvailable}.`,
  observations: [{ summary: 'Fictional aggregate respiratory load is present.', evidenceRefs: [context.snapshot.snapshotId] },
    ...(context.resourceInvestigation?.filter(item => item.toolName === 'get_hospital_capacity' && item.result.hospitalId === 'HOSP-003').map(item => ({ summary: 'HOSP-003 has fictional monitored capacity for human review.', evidenceRefs: [item.evidenceId] })) || [])],
  operationalRisks: [{ summary: 'Capacity needs human review.', evidenceRefs: [context.evidenceRefs[1]] }],
  bottlenecks: [{ summary: 'Monitored capacity may limit incoming demand.', evidenceRefs: [context.snapshot.snapshotId] }],
  uncertainties: ['Simulation only; no admission guarantee.'], monitoringConditions: ['Reassess when capacity or case membership changes.'],
  recommendedActions: ['read_operations_snapshot', 'publish_operations_summary', 'simulate_capacity_response', 'simulate_staffing_response'].map(toolName => ({ toolName, expectedOutcome: 'Record a local fictional review only.' })),
});
export async function operationsFixture(options = {}) {
  const caseStore = createMemoryCaseStore(), ids = [];
  for (const intake of [routingIntake([['wheezing', 'confirmed']]), routingIntake([['cough', 'confirmed']]), emergencyIntake('severe difficulty breathing'), routingIntake()]) {
    const caseId = newCaseId(); await caseStore.createCase({ caseId, intake }); ids.push(caseId);
  }
  const store = memoryOperationsStore(caseStore), settings = { caseStore, store, model: async context => operationsAssessment(context), ...options };
  const service = createOperationsService(settings);
  for (const [index, caseId] of ids.entries()) await service.enroll({ caseId, status: index === 2 ? 'incoming' : 'active' });
  await service.changeCapacity({ requestId: 'baseline', hospitalId: 'HOSP-001', monitoredBedsAvailable: 1, expectedVersion: 1 });
  return { ...settings, service, ids };
}

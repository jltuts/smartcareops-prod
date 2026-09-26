import { evaluateRouting } from '../cases/routing.js';
import { evaluateSafety } from '../safety/engine.js';
import { digest, requireThat } from '../clinical/contracts.js';
import { scope } from './contracts.js';
// Raw case documents are read locally but never stored in the operations workspace
// or sent to its model. Projection is the only cross-domain boundary.
export function projectCase(doc, member) {
  requireThat(doc?.source === 'smartcareops_demo' && doc.caseId === member.caseId, 'OPERATIONS_CASE_UNAVAILABLE', 409);
  const routing = evaluateRouting(doc.reportedFacts), safety = evaluateSafety(doc.reportedFacts);
  return { caseId: doc.caseId, membership: member.status, specialty: routing.specialty,
    respiratory: routing.reasonCode === 'respiratory_complaint' || safety.reasonCode === 'severe_breathing_red_flag',
    emergency: safety.emergency, workflowStatus: doc.workflowStatus, updatedAt: doc.updatedAt };
}
export function evidenceFingerprint(state) {
  return digest({ cases: state.caseEvidence, resourceVersion: state.resourceEnvironment?.version || 0, fleet: state.fleetEvidenceVersion });
}
export function snapshot(state, now) {
  const cases = state.caseEvidence.filter(item => item.membership !== 'closed');
  const hospital = state.resourceEnvironment.hospitals.find(item => item.hospitalId === scope.hospitalId);
  const specialtyLoad = {};
  for (const item of cases) specialtyLoad[item.specialty] = (specialtyLoad[item.specialty] || 0) + 1;
  return { ...scope, snapshotId: `OPS-SNAPSHOT-${state.meta.snapshotVersion + 1}`, snapshotVersion: state.meta.snapshotVersion + 1,
    observedAt: new Date(now).toISOString(), source: 'fictional_domain_projection', sourceRefs: cases.map(item => item.caseId),
    evidenceFingerprint: evidenceFingerprint(state), resourceVersion: state.resourceEnvironment.resourceVersion, fleetEvidenceVersion: state.fleetEvidenceVersion,
    counts: { active: cases.length, emergency: cases.filter(item => item.emergency).length, respiratory: cases.filter(item => item.respiratory).length, incoming: cases.filter(item => item.membership === 'incoming').length },
    specialtyLoad, capacity: structuredClone(hospital.capacity), specialists: structuredClone(hospital.specialists),
    ambulance: state.fleetEvidence ? { available: state.fleetEvidence.filter(item => item.status === 'available').length, reserved: state.fleetEvidence.filter(item => item.status !== 'available').length } : null,
    caseSetVersion: digest(state.caseEvidence),
  };
}

import { CaseStoreError, validCaseId, currentEmergency, publicCase, Workflow } from '../cases/store.js';
import { demoFleet, validUnitId, validTimestamp, publicAmbulance, ambulanceWorkflowMatches } from './fleet.js';
import { AmbulanceStatus, AmbulanceWorkflow } from '../../../shared/ambulance.js';

const checkCase = id => { if (!validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400); };
const checkUnit = id => { if (!validUnitId(id)) throw new CaseStoreError('INVALID_AMBULANCE_UNIT', 400); };
const validReservation = (unit, id) => unit?.unitId === id && unit.status === 'assigned' && validCaseId(unit.caseId) && validTimestamp(unit.assignedAt);
const sameReservation = (doc, unit) => validReservation(unit, doc.ambulance.unitId) && unit.caseId === doc.caseId && unit.assignedAt === doc.ambulance.assignedAt;
const log = (caseId, unitId, event) => console.info('[ambulance]', JSON.stringify({ caseId, unitId, event }));

export function createAmbulanceService(driver, storage, guarded) {
  return {
    async listAmbulances() {
      return guarded(async () => {
        const reservations = await driver.getFleet();
        return { units: demoFleet.map((unit, index) => {
          const reserved = reservations[index];
          if (reserved && !validReservation(reserved, unit.unitId)) throw new CaseStoreError('AMBULANCE_STATE_CONFLICT', 409);
          return { ...unit, status: reserved ? 'assigned' : 'available' };
        }), storage, simulation: true };
      });
    },
    async assignAmbulance(caseId, unitId) {
      checkCase(caseId); checkUnit(unitId);
      return guarded(async () => {
        let changed = false;
        const result = await driver.transactAssignment(caseId, unitId, (doc, unit) => {
          changed = false;
          if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
          if (!currentEmergency(doc) || doc.emergency.status !== 'acknowledged') throw new CaseStoreError('AMBULANCE_ASSIGNMENT_NOT_ALLOWED', 409);
          if (doc.ambulance) {
            if (doc.ambulance.unitId !== unitId) throw new CaseStoreError('AMBULANCE_ALREADY_ASSIGNED', 409);
            if (!ambulanceWorkflowMatches(doc) || !sameReservation(doc, unit)) throw new CaseStoreError('AMBULANCE_STATE_CONFLICT', 409);
            return { case: doc, unit };
          }
          if (doc.workflowStatus !== Workflow.ACKNOWLEDGED) throw new CaseStoreError('AMBULANCE_ASSIGNMENT_NOT_ALLOWED', 409);
          if (unit) throw new CaseStoreError('AMBULANCE_UNAVAILABLE', 409);
          const now = new Date(Math.max(Date.now(), Date.parse(doc.emergency.acknowledgedAt))).toISOString(); changed = true;
          return { case: { ...doc, workflowStatus: AmbulanceWorkflow.ASSIGNED, ambulance: { unitId, status: AmbulanceStatus.ASSIGNED, assignedAt: now, dispatchedAt: null }, updatedAt: now },
            unit: { unitId, status: 'assigned', caseId, assignedAt: now } };
        });
        if (changed) log(caseId, unitId, 'assigned');
        return publicCase(result.case, storage);
      });
    },
    async dispatchAmbulance(caseId) {
      checkCase(caseId);
      return guarded(async () => {
        const initial = await driver.get(caseId);
        if (!initial) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        if (!publicAmbulance(initial.ambulance)) throw new CaseStoreError('AMBULANCE_DISPATCH_NOT_ALLOWED', 409);
        const unitId = initial.ambulance.unitId;
        let changed = false;
        const result = await driver.transactAssignment(caseId, unitId, (doc, unit) => {
          changed = false;
          if (!doc || !currentEmergency(doc) || !ambulanceWorkflowMatches(doc) || doc.ambulance.unitId !== unitId || !sameReservation(doc, unit)) throw new CaseStoreError('AMBULANCE_STATE_CONFLICT', 409);
          if (doc.ambulance.status === AmbulanceStatus.EN_ROUTE) return { case: doc, unit };
          const now = new Date(Math.max(Date.now(), Date.parse(doc.ambulance.assignedAt))).toISOString(); changed = true;
          return { case: { ...doc, workflowStatus: AmbulanceWorkflow.EN_ROUTE, ambulance: { ...doc.ambulance, status: AmbulanceStatus.EN_ROUTE, dispatchedAt: now }, updatedAt: now }, unit };
        });
        if (changed) log(caseId, unitId, 'en_route');
        return publicCase(result.case, storage);
      });
    },
  };
}

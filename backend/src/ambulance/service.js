import { CaseStoreError, validCaseId, currentEmergency, publicCase, Workflow } from '../cases/store.js';
import { demoFleet, validUnitId, validTimestamp, publicAmbulance, ambulanceWorkflowMatches } from './fleet.js';
import { AmbulanceStatus, AmbulanceWorkflow } from '../../../shared/ambulance.js';
import { emergencyHospitalOptions, publicEmergencyDestination } from './destination.js';

const checkCase = id => { if (!validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400); };
const checkUnit = id => { if (!validUnitId(id)) throw new CaseStoreError('INVALID_AMBULANCE_UNIT', 400); };
const validReservation = (unit, id) => unit?.unitId === id && unit.status === 'assigned' && validCaseId(unit.caseId) && validTimestamp(unit.assignedAt);
const sameReservation = (doc, unit) => validReservation(unit, doc.ambulance.unitId) && unit.caseId === doc.caseId && unit.assignedAt === doc.ambulance.assignedAt;
const log = (caseId, unitId, event) => console.info('[ambulance]', JSON.stringify({ caseId, unitId, event }));
const transition = Object.freeze({
  dispatch: { from: AmbulanceStatus.ASSIGNED, to: AmbulanceStatus.EN_ROUTE, workflow: AmbulanceWorkflow.EN_ROUTE, priorAt: 'assignedAt', at: 'dispatchedAt', event: 'en_route' },
  'arrive-pickup': { from: AmbulanceStatus.EN_ROUTE, to: AmbulanceStatus.AT_PICKUP, workflow: AmbulanceWorkflow.AT_PICKUP, priorAt: 'dispatchedAt', at: 'arrivedPickupAt', event: 'at_pickup' },
  'start-transport': { from: AmbulanceStatus.AT_PICKUP, to: AmbulanceStatus.TRANSPORTING, workflow: AmbulanceWorkflow.TRANSPORTING, priorAt: 'arrivedPickupAt', at: 'transportingAt', event: 'transporting' },
  'arrive-hospital': { from: AmbulanceStatus.TRANSPORTING, to: AmbulanceStatus.ARRIVED_HOSPITAL, workflow: AmbulanceWorkflow.ARRIVED_HOSPITAL, priorAt: 'transportingAt', at: 'arrivedHospitalAt', event: 'arrived_hospital' },
  complete: { from: AmbulanceStatus.ARRIVED_HOSPITAL, to: AmbulanceStatus.COMPLETED, workflow: AmbulanceWorkflow.COMPLETED, priorAt: 'arrivedHospitalAt', at: 'completedAt', event: 'completed' },
});
const statusOrder = Object.freeze(Object.values(AmbulanceStatus));

export function createAmbulanceService(driver, storage, guarded) {
  return {
    async listEmergencyHospitals(caseId) {
      checkCase(caseId);
      return guarded(async () => {
        const doc = await driver.get(caseId);
        if (!doc || !currentEmergency(doc) || doc.emergency.status !== 'acknowledged') throw new CaseStoreError('EMERGENCY_DESTINATION_NOT_ALLOWED', 409);
        return { options: emergencyHospitalOptions(), simulation: true };
      });
    },
    async selectEmergencyHospital(caseId, hospitalId) {
      checkCase(caseId);
      const selected = emergencyHospitalOptions().find(option => option.hospitalId === hospitalId);
      if (!selected) throw new CaseStoreError('INVALID_EMERGENCY_DESTINATION', 400);
      return guarded(async () => publicCase(await driver.transact(caseId, doc => {
        if (!doc) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        if (!currentEmergency(doc) || doc.emergency.status !== 'acknowledged' || doc.ambulance?.dispatchedAt) throw new CaseStoreError('EMERGENCY_DESTINATION_NOT_ALLOWED', 409);
        if (doc.emergencyDestination) {
          if (!publicEmergencyDestination(doc.emergencyDestination) || doc.emergencyDestination.hospitalId !== hospitalId) throw new CaseStoreError('EMERGENCY_DESTINATION_CONFLICT', 409);
          return doc;
        }
        const now = new Date().toISOString();
        return { ...doc, emergencyDestination: { ...selected, status: 'accepted', selectedAt: now, acceptedAt: now }, updatedAt: now };
      }), storage));
    },
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
          return { case: { ...doc, workflowStatus: AmbulanceWorkflow.ASSIGNED, ambulance: { unitId, status: AmbulanceStatus.ASSIGNED, assignedAt: now,
            dispatchedAt: null, arrivedPickupAt: null, transportingAt: null, arrivedHospitalAt: null, completedAt: null }, updatedAt: now },
            unit: { unitId, status: 'assigned', caseId, assignedAt: now } };
        });
        if (changed) log(caseId, unitId, 'assigned');
        return publicCase(result.case, storage);
      });
    },
    async dispatchAmbulance(caseId) {
      return this.advanceAmbulance(caseId, 'dispatch');
    },
    async advanceAmbulance(caseId, action) {
      checkCase(caseId);
      const step = transition[action];
      if (!step) throw new CaseStoreError('INVALID_AMBULANCE_TRANSITION', 400);
      return guarded(async () => {
        const initial = await driver.get(caseId);
        if (!initial) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        if (!publicAmbulance(initial.ambulance)) throw new CaseStoreError('AMBULANCE_TRANSITION_NOT_ALLOWED', 409);
        const unitId = initial.ambulance.unitId;
        let changed = false;
        const result = await driver.transactAssignment(caseId, unitId, (doc, unit) => {
          changed = false;
          if (!doc || !currentEmergency(doc) || !ambulanceWorkflowMatches(doc) || doc.ambulance.unitId !== unitId) throw new CaseStoreError('AMBULANCE_STATE_CONFLICT', 409);
          if (statusOrder.indexOf(doc.ambulance.status) >= statusOrder.indexOf(step.to)) return { case: doc, unit };
          if (!sameReservation(doc, unit)) throw new CaseStoreError('AMBULANCE_STATE_CONFLICT', 409);
          if (doc.ambulance.status !== step.from) throw new CaseStoreError('AMBULANCE_TRANSITION_NOT_ALLOWED', 409);
          if (action === 'dispatch' && !publicEmergencyDestination(doc.emergencyDestination)) throw new CaseStoreError('EMERGENCY_DESTINATION_REQUIRED', 409);
          const priorAt = doc.ambulance[step.priorAt];
          const now = new Date(Math.max(Date.now(), Date.parse(priorAt))).toISOString(); changed = true;
          return { case: { ...doc, workflowStatus: step.workflow, ambulance: { ...doc.ambulance, status: step.to, [step.at]: now }, updatedAt: now },
            unit: action === 'complete' ? null : unit };
        });
        if (changed) log(caseId, unitId, step.event);
        return publicCase(result.case, storage);
      });
    },
  };
}

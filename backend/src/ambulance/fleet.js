import { AmbulanceStatus, AmbulanceWorkflow } from '../../../shared/ambulance.js';

export const demoFleet = Object.freeze([
  { unitId: 'AMB-01', displayName: 'Ambulance 01', baseLabel: 'Demo Station A' },
  { unitId: 'AMB-02', displayName: 'Ambulance 02', baseLabel: 'Demo Station A' },
  { unitId: 'AMB-03', displayName: 'Ambulance 03', baseLabel: 'Demo Station B' },
].map(unit => Object.freeze(unit)));
export const validUnitId = id => demoFleet.some(unit => unit.unitId === id);
export const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
export function publicAmbulance(value) {
  if (!value || !validUnitId(value.unitId) || !Object.values(AmbulanceStatus).includes(value.status) || !validTimestamp(value.assignedAt)) return null;
  const timeline = ['dispatchedAt', 'arrivedPickupAt', 'transportingAt', 'arrivedHospitalAt', 'completedAt'];
  const required = Object.freeze({ assigned: 0, en_route: 1, at_pickup: 2, transporting: 3, arrived_hospital: 4, completed: 5 })[value.status];
  let prior = value.assignedAt;
  for (let index = 0; index < timeline.length; index++) {
    const timestamp = value[timeline[index]];
    if (index < required && (!validTimestamp(timestamp) || timestamp < prior)) return null;
    if (index >= required && timestamp !== null) return null;
    if (index < required) prior = timestamp;
  }
  return Object.fromEntries(['unitId', 'status', 'assignedAt', ...timeline].map(key => [key, value[key]]));
}
const workflowByStatus = Object.freeze({
  assigned: AmbulanceWorkflow.ASSIGNED, en_route: AmbulanceWorkflow.EN_ROUTE, at_pickup: AmbulanceWorkflow.AT_PICKUP,
  transporting: AmbulanceWorkflow.TRANSPORTING, arrived_hospital: AmbulanceWorkflow.ARRIVED_HOSPITAL, completed: AmbulanceWorkflow.COMPLETED,
});
export const ambulanceWorkflowMatches = doc => Boolean(publicAmbulance(doc.ambulance) && doc.workflowStatus === workflowByStatus[doc.ambulance.status]);

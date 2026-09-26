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
  if (value.status === AmbulanceStatus.ASSIGNED ? value.dispatchedAt !== null : !validTimestamp(value.dispatchedAt) || value.dispatchedAt < value.assignedAt) return null;
  return Object.fromEntries(['unitId', 'status', 'assignedAt', 'dispatchedAt'].map(key => [key, value[key]]));
}
export const ambulanceWorkflowMatches = doc => Boolean(publicAmbulance(doc.ambulance) && doc.workflowStatus === (doc.ambulance.status === AmbulanceStatus.ASSIGNED ? AmbulanceWorkflow.ASSIGNED : AmbulanceWorkflow.EN_ROUTE));

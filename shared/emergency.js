import { AmbulanceWorkflow } from './ambulance.js';
export const EmergencyStatus = Object.freeze({ PENDING: 'pending_dispatcher', ACKNOWLEDGED: 'acknowledged' });
export const EmergencyWorkflow = Object.freeze({ PENDING: 'emergency_pending_dispatcher', ACKNOWLEDGED: 'emergency_acknowledged' });
export const emergencyStatusLabels = Object.freeze({ pending_dispatcher: 'Pending dispatcher', acknowledged: 'Dispatcher acknowledged' });
export const activeEmergencyWorkflows = Object.freeze([...Object.values(EmergencyWorkflow), ...Object.values(AmbulanceWorkflow)]);
export const isEmergencyWorkflow = value => activeEmergencyWorkflows.includes(value);

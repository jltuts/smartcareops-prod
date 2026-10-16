export const AmbulanceStatus = Object.freeze({
  ASSIGNED: 'assigned', EN_ROUTE: 'en_route', AT_PICKUP: 'at_pickup', TRANSPORTING: 'transporting',
  ARRIVED_HOSPITAL: 'arrived_hospital', COMPLETED: 'completed',
});
export const AmbulanceWorkflow = Object.freeze({
  ASSIGNED: 'ambulance_assigned', EN_ROUTE: 'ambulance_en_route', AT_PICKUP: 'ambulance_at_pickup',
  TRANSPORTING: 'patient_transporting', ARRIVED_HOSPITAL: 'arrived_at_hospital', COMPLETED: 'emergency_response_completed',
});
export const activeAmbulanceWorkflows = Object.freeze(Object.values(AmbulanceWorkflow).filter(value => value !== AmbulanceWorkflow.COMPLETED));
export const ambulanceStatusLabels = Object.freeze({
  assigned: 'Assigned', en_route: 'En route to patient', at_pickup: 'Arrived at pickup', transporting: 'Patient transporting',
  arrived_hospital: 'Arrived at hospital', completed: 'Response completed',
});

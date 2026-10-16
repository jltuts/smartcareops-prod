import { seedResources } from '../resources/fixtures.js';
import { distanceMeters } from '../resources/maps/simulation.js';

const displayNames = Object.freeze({
  'HOSP-001': 'Northstar General', 'HOSP-002': 'Riverside Medical', 'HOSP-003': 'Harbor Community Hospital',
});

const routeEstimate = (origin, destination) => {
  const distance = Math.round(distanceMeters(origin, destination) * 1.3);
  return { distanceMeters: distance, durationSeconds: Math.ceil(distance / (35000 / 3600)) + 60 };
};

export function emergencyHospitalOptions(now = Date.now()) {
  const catalog = seedResources(now);
  return catalog.hospitals.filter(hospital => hospital.capabilities.includes('emergency') && hospital.capacity.emergencyBedsAvailable > 0)
    .map(hospital => ({
      hospitalId: hospital.hospitalId, hospitalName: displayNames[hospital.hospitalId] || hospital.name,
      ...routeEstimate(catalog.patientLocation, hospital.location), emergencyBedsAvailable: hospital.capacity.emergencyBedsAvailable,
      pickup: { label: 'Seeded patient pickup', latitude: catalog.patientLocation.latitude, longitude: catalog.patientLocation.longitude },
      hospitalLocation: { latitude: hospital.location.latitude, longitude: hospital.location.longitude },
      resourceVersion: catalog.resourceVersion, simulation: true,
    }))
    .sort((left, right) => left.distanceMeters - right.distanceMeters || left.hospitalId.localeCompare(right.hospitalId));
}

export function publicEmergencyDestination(value) {
  const validLocation = location => location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  if (!value || value.status !== 'accepted' || value.simulation !== true || typeof value.hospitalId !== 'string' ||
      typeof value.hospitalName !== 'string' || !Number.isInteger(value.distanceMeters) || value.distanceMeters < 1 ||
      !Number.isInteger(value.durationSeconds) || value.durationSeconds < 1 || typeof value.resourceVersion !== 'string' ||
      !validLocation(value.pickup) || typeof value.pickup.label !== 'string' || !validLocation(value.hospitalLocation) ||
      typeof value.selectedAt !== 'string' || !Number.isFinite(Date.parse(value.selectedAt)) || value.acceptedAt !== value.selectedAt) return null;
  return Object.fromEntries(['hospitalId', 'hospitalName', 'status', 'distanceMeters', 'durationSeconds', 'pickup', 'hospitalLocation', 'resourceVersion', 'selectedAt', 'acceptedAt', 'simulation']
    .map(key => [key, value[key]]));
}

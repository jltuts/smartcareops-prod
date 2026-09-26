import { check, ResourceError } from '../contracts.js';
export function distanceMeters(a, b) {
  const rad = n => n * Math.PI / 180;
  const latitude = rad(b.latitude - a.latitude), longitude = rad(b.longitude - a.longitude);
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(longitude / 2) ** 2;
  return Math.round(6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h))));
}
export function createMapsAdapter(mode = 'simulation') {
  // No network fallback: Google mode is deliberately unavailable without an implemented/configured adapter.
  if (mode !== 'simulation') throw new ResourceError('MAPS_MODE_UNAVAILABLE');
  return Object.freeze({
    mode,
    async findNearbyHospitals({ location, hospitals, requiredCapabilities, maxResults }) {
      return hospitals.filter(h => requiredCapabilities.every(c => h.capabilities.includes(c)))
        .map(h => ({ hospitalId: h.hospitalId, name: h.name, distanceMeters: distanceMeters(location, h.location), requiredCapabilityMatch: true, simulation: true }))
        .sort((a, b) => a.distanceMeters - b.distanceMeters || a.hospitalId.localeCompare(b.hospitalId)).slice(0, maxResults);
    },
    async calculateRoute({ origin, destination }) {
      const distance = Math.round(distanceMeters(origin, destination) * 1.3);
      return { distanceMeters: distance, durationSeconds: Math.ceil(distance / (35000 / 3600)) + 60,
        routeSummary: 'Fictional estimate: direct distance × 1.3 at 35 km/h plus 60 seconds. No road or traffic lookup.', source: 'simulation', simulation: true };
    },
    async geocodeLocation({ locationId, catalog }) {
      check(locationId === 'patient' || catalog.hospitals.some(h => h.hospitalId === locationId));
      return locationId === 'patient' ? catalog.patientLocation : catalog.hospitals.find(h => h.hospitalId === locationId).location;
    },
  });
}

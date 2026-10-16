import { specialties } from './contracts.js';
export function seedResources(now = Date.now()) {
  const updatedAt = new Date(now).toISOString();
  const location = (latitude, longitude) => ({ latitude, longitude, source: 'seeded_demo', accuracyClass: 'approximate', recordedAt: updatedAt, simulation: true });
  const hospital = (hospitalId, name, latitude, longitude, capabilities, monitored, icu, available) => ({
    hospitalId, name, location: location(latitude, longitude), capabilities, simulation: true,
    capacity: { emergencyBedsAvailable: 3, monitoredBedsAvailable: monitored, icuBedsAvailable: icu, updatedAt },
    specialists: specialties.map(specialty => ({ specialty, available: available.includes(specialty), nextAvailableMinutes: available.includes(specialty) ? 10 : 120, updatedAt })),
  });
  return { environmentId: 'm9-demo', version: 1, resourceVersion: 'm9-demo:1', updatedAt, simulation: true,
    patientLocation: location(14.600, 121.000),
    hospitals: [
      hospital('HOSP-001', 'SmartCare General Hospital (fictional)', 14.615, 121.015, ['emergency', 'general_medicine', 'pulmonology', 'cardiology', 'monitored_care', 'icu'], 2, 1, ['general_medicine', 'pulmonology', 'cardiology']),
      hospital('HOSP-002', 'North Valley Medical Center (fictional)', 14.625, 121.005, ['emergency', 'general_medicine', 'neurology', 'orthopedics', 'imaging', 'monitored_care'], 4, 0, ['general_medicine', 'neurology', 'orthopedics']),
      hospital('HOSP-003', 'Regional Medical Center (fictional)', 14.655, 121.040, ['emergency', 'general_medicine', 'pulmonology', 'icu', 'monitored_care'], 1, 2, ['general_medicine', 'pulmonology']),
    ],
  };
}

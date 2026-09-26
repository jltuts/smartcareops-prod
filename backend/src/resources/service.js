import { resourceTools, validateArguments, validateCatalog, validateResult, check, ResourceError } from './contracts.js';
import { createMapsAdapter } from './maps/simulation.js';
import { seedResources } from './fixtures.js';
export function initializeResources(state, now) {
  if (!state.resourceEnvironment) state.resourceEnvironment = seedResources(now);
  validateCatalog(state.resourceEnvironment);
}
export function updateCapacity(state, input, now) {
  const { requestId, hospitalId, monitoredBedsAvailable, expectedVersion } = input;
  check(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(requestId));
  check(Object.keys(input).length === 4 && Number.isInteger(monitoredBedsAvailable) && monitoredBedsAvailable >= 0 && monitoredBedsAvailable <= 100 && Number.isInteger(expectedVersion));
  const catalog = validateCatalog(state.resourceEnvironment), hospital = catalog.hospitals.find(h => h.hospitalId === hospitalId);
  check(hospital && catalog.version === expectedVersion, 'RESOURCE_VERSION_CONFLICT');
  hospital.capacity.monitoredBedsAvailable = monitoredBedsAvailable;
  hospital.capacity.updatedAt = new Date(now).toISOString(); catalog.updatedAt = hospital.capacity.updatedAt;
  catalog.version++; catalog.resourceVersion = 'm9-demo:' + catalog.version;
  return validateCatalog(catalog);
}
export function createResourceService({ mode = 'simulation', mapsMode = 'simulation', adapter } = {}) {
  if (mode !== 'simulation') throw new ResourceError('RESOURCE_MODE_UNAVAILABLE');
  const maps = adapter || createMapsAdapter(mapsMode);
  return {
    registry: resourceTools,
    async execute(name, args, { state, caseStore }) {
      validateArguments(name, args);
      const catalog = validateCatalog(state.resourceEnvironment);
      const metadata = { resourceVersion: catalog.resourceVersion, fleetEvidenceVersion: state.fleetEvidenceVersion || null, updatedAt: catalog.updatedAt, source: 'simulation', simulation: true };
      const hospital = catalog.hospitals.find(h => h.hospitalId === args.hospitalId);
      const work = async () => {
        let result;
        if (name === 'get_patient_location_context') result = { location: catalog.patientLocation };
        if (name === 'find_nearby_hospitals') result = { hospitals: await maps.findNearbyHospitals({ location: catalog.patientLocation, hospitals: catalog.hospitals, ...args }) };
        if (name === 'get_hospital_capabilities') result = { hospitalId: hospital.hospitalId, capabilities: hospital.capabilities };
        if (name === 'get_hospital_capacity') result = { hospitalId: hospital.hospitalId, ...hospital.capacity };
        if (name === 'find_available_specialists') result = { hospitalId: hospital.hospitalId, ...hospital.specialists.find(s => s.specialty === args.specialty) };
        if (name === 'get_ambulance_availability') result = { units: (await caseStore.listAmbulances()).units.map(u => ({ unitId: u.unitId, status: u.status })) };
        if (name === 'calculate_ambulance_route') {
          const origin = await maps.geocodeLocation({ locationId: args.origin, catalog });
          const destination = await maps.geocodeLocation({ locationId: args.destination, catalog });
          result = { ...args, ...await maps.calculateRoute({ origin, destination }) };
        }
        return validateResult(name, { ...result, ...metadata });
      };
      let timer;
      try { return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new ResourceError('RESOURCE_TIMEOUT')), resourceTools[name].timeoutMs); })]); }
      catch (error) { throw new ResourceError(error instanceof ResourceError ? error.code : 'RESOURCE_UNAVAILABLE'); }
      finally { clearTimeout(timer); }
    },
  };
}

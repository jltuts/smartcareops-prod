export class ResourceError extends Error {
  constructor(code = 'RESOURCE_UNAVAILABLE') {
    super('Operational resource lookup unavailable. No live result was substituted.'); this.code = code;
    this.status = code === 'RESOURCE_VERSION_CONFLICT' ? 409 : code === 'INVALID_RESOURCE_ARGUMENTS' ? 400 : 503;
  }
}
export const check = (condition, code = 'INVALID_RESOURCE_ARGUMENTS') => { if (!condition) throw new ResourceError(code); };
export const exact = (value, keys, optional = []) => check(value && typeof value === 'object' && !Array.isArray(value) && keys.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...keys, ...optional].includes(k)));
export const hospitalIds = ['HOSP-001', 'HOSP-002', 'HOSP-003'];
export const specialties = ['general_medicine', 'cardiology', 'pulmonology', 'neurology', 'endocrinology', 'orthopedics'];
export const capabilities = ['emergency', ...specialties, 'icu', 'imaging', 'monitored_care'];
export const ambulanceIds = ['AMB-01', 'AMB-02', 'AMB-03'];
const str = values => ({ type: 'string', enum: values });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const hospital = object({ hospitalId: str(hospitalIds) });
const resultFields = {
  get_patient_location_context: ['location'],
  find_nearby_hospitals: ['hospitals'],
  get_hospital_capabilities: ['hospitalId', 'capabilities'],
  get_hospital_capacity: ['hospitalId', 'emergencyBedsAvailable', 'monitoredBedsAvailable', 'icuBedsAvailable'],
  find_available_specialists: ['hospitalId', 'specialty', 'available', 'nextAvailableMinutes'],
  get_ambulance_availability: ['units'],
  calculate_ambulance_route: ['ambulanceUnitId', 'origin', 'destination', 'distanceMeters', 'durationSeconds', 'routeSummary'],
};
const schemas = {
  get_patient_location_context: object({}),
  find_nearby_hospitals: object({ requiredCapabilities: { type: 'array', items: str(capabilities), maxItems: 4 }, maxResults: { type: 'integer', minimum: 1, maximum: 3 } }),
  get_hospital_capabilities: hospital,
  get_hospital_capacity: hospital,
  find_available_specialists: object({ hospitalId: str(hospitalIds), specialty: str(specialties) }),
  get_ambulance_availability: object({}),
  calculate_ambulance_route: object({ ambulanceUnitId: str(ambulanceIds), origin: str(['patient', ...hospitalIds]), destination: str(hospitalIds) }),
};
const integer = maximum => ({ type: 'integer', minimum: 0, maximum });
const timestamp = { type: 'string', format: 'date-time' };
const locationSchema = object({ latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, source: { const: 'seeded_demo' }, accuracyClass: { const: 'approximate' }, recordedAt: timestamp, simulation: { const: true } });
const resultProperties = {
  get_patient_location_context: { location: locationSchema },
  find_nearby_hospitals: { hospitals: { type: 'array', maxItems: 3, items: object({ hospitalId: str(hospitalIds), name: { type: 'string', maxLength: 99 }, distanceMeters: integer(100000), requiredCapabilityMatch: { const: true }, simulation: { const: true } }) } },
  get_hospital_capabilities: { hospitalId: str(hospitalIds), capabilities: { type: 'array', maxItems: capabilities.length, items: str(capabilities) } },
  get_hospital_capacity: { hospitalId: str(hospitalIds), emergencyBedsAvailable: integer(100), monitoredBedsAvailable: integer(100), icuBedsAvailable: integer(100) },
  find_available_specialists: { hospitalId: str(hospitalIds), specialty: str(specialties), available: { type: 'boolean' }, nextAvailableMinutes: integer(1440) },
  get_ambulance_availability: { units: { type: 'array', minItems: 3, maxItems: 3, items: object({ unitId: str(ambulanceIds), status: str(['available', 'assigned']) }) } },
  calculate_ambulance_route: { ambulanceUnitId: str(ambulanceIds), origin: str(['patient', ...hospitalIds]), destination: str(hospitalIds), distanceMeters: integer(100000), durationSeconds: integer(86400), routeSummary: { type: 'string', maxLength: 300 } },
};
export const resourceTools = Object.freeze(Object.fromEntries(Object.entries(schemas).map(([name, inputSchema]) => [name, Object.freeze({
  name, inputSchema, permissionClass: 'READ_ONLY', timeoutMs: 1500, maxRetries: 0, modes: ['simulation'],
  resultSchema: object({ ...resultProperties[name], resourceVersion: { type: 'string', pattern: '^m9-demo:[1-9][0-9]*$' }, fleetEvidenceVersion: { type: ['string', 'null'] }, updatedAt: timestamp, source: { const: 'simulation' }, simulation: { const: true } }),
})])));
export const resourceToolNames = Object.keys(resourceTools);
export function validateArguments(name, args) {
  check(Object.hasOwn(resourceTools, name), 'RESOURCE_TOOL_NOT_ALLOWED');
  const schema = resourceTools[name].inputSchema; exact(args, schema.required);
  for (const [key, field] of Object.entries(schema.properties)) {
    const value = args[key];
    if (field.enum) check(field.enum.includes(value));
    else if (field.type === 'integer') check(Number.isInteger(value) && value >= field.minimum && value <= field.maximum);
    else if (field.type === 'array') check(Array.isArray(value) && value.length <= field.maxItems && new Set(value).size === value.length && value.every(v => field.items.enum.includes(v)));
  }
  if (name === 'calculate_ambulance_route') check(args.origin !== args.destination);
  return structuredClone(args);
}
export function validateLocation(location) {
  exact(location, ['latitude', 'longitude', 'source', 'accuracyClass', 'recordedAt', 'simulation']);
  check(Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90 && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180);
  check(location.simulation === true && location.source === 'seeded_demo' && location.accuracyClass === 'approximate' && Number.isFinite(Date.parse(location.recordedAt)));
  return location;
}
export function validateCatalog(catalog) {
  exact(catalog, ['environmentId', 'version', 'resourceVersion', 'updatedAt', 'simulation', 'patientLocation', 'hospitals']);
  check(catalog.environmentId === 'm9-demo' && catalog.simulation === true && Number.isInteger(catalog.version) && catalog.version > 0 && catalog.resourceVersion === 'm9-demo:' + catalog.version && Number.isFinite(Date.parse(catalog.updatedAt)), 'INVALID_RESOURCE_DATA');
  validateLocation(catalog.patientLocation);
  check(Array.isArray(catalog.hospitals) && catalog.hospitals.length === 3);
  check(new Set(catalog.hospitals.map(h => h.hospitalId)).size === 3);
  for (const h of catalog.hospitals) {
    exact(h, ['hospitalId', 'name', 'location', 'capabilities', 'capacity', 'specialists', 'simulation']);
    check(hospitalIds.includes(h.hospitalId) && typeof h.name === 'string' && h.name.length < 100 && h.simulation === true);
    validateLocation(h.location);
    check(Array.isArray(h.capabilities) && h.capabilities.length <= capabilities.length && h.capabilities.every(v => capabilities.includes(v)));
    exact(h.capacity, ['emergencyBedsAvailable', 'monitoredBedsAvailable', 'icuBedsAvailable', 'updatedAt']);
    check(['emergencyBedsAvailable', 'monitoredBedsAvailable', 'icuBedsAvailable'].every(k => Number.isInteger(h.capacity[k]) && h.capacity[k] >= 0 && h.capacity[k] <= 100));
    check(Number.isFinite(Date.parse(h.capacity.updatedAt)));
    check(Array.isArray(h.specialists) && h.specialists.length === specialties.length && new Set(h.specialists.map(s => s.specialty)).size === specialties.length);
    for (const s of h.specialists) {
      exact(s, ['specialty', 'available', 'nextAvailableMinutes', 'updatedAt']);
      check(specialties.includes(s.specialty) && typeof s.available === 'boolean' && Number.isInteger(s.nextAvailableMinutes) && s.nextAvailableMinutes >= 0 && s.nextAvailableMinutes <= 1440 && Number.isFinite(Date.parse(s.updatedAt)));
    }
  }
  return catalog;
}
export function validateResult(name, result) {
  check(Object.hasOwn(resultFields, name), 'RESOURCE_TOOL_NOT_ALLOWED');
  exact(result, [...resultFields[name], 'resourceVersion', 'fleetEvidenceVersion', 'updatedAt', 'source', 'simulation']);
  check(result.fleetEvidenceVersion === null || /^fleet:[a-f0-9]{64}$/.test(result.fleetEvidenceVersion), 'INVALID_RESOURCE_RESULT');
  check(/^m9-demo:[1-9][0-9]*$/.test(result.resourceVersion) && Number.isFinite(Date.parse(result.updatedAt)) && result.source === 'simulation' && result.simulation === true, 'INVALID_RESOURCE_RESULT');
  if (resultFields[name].includes('hospitalId')) check(hospitalIds.includes(result.hospitalId));
  if (name === 'get_patient_location_context') validateLocation(result.location);
  if (name === 'get_hospital_capabilities') check(Array.isArray(result.capabilities) && result.capabilities.length <= capabilities.length && result.capabilities.every(v => capabilities.includes(v)));
  if (name === 'get_hospital_capacity') check(['emergencyBedsAvailable', 'monitoredBedsAvailable', 'icuBedsAvailable'].every(k => Number.isInteger(result[k]) && result[k] >= 0 && result[k] <= 100));
  if (name === 'find_available_specialists') check(specialties.includes(result.specialty) && typeof result.available === 'boolean' && Number.isInteger(result.nextAvailableMinutes) && result.nextAvailableMinutes >= 0 && result.nextAvailableMinutes <= 1440);
  if (name === 'find_nearby_hospitals') {
    check(Array.isArray(result.hospitals) && result.hospitals.length <= 3 && new Set(result.hospitals.map(h => h.hospitalId)).size === result.hospitals.length);
    for (const h of result.hospitals) { exact(h, ['hospitalId', 'name', 'distanceMeters', 'requiredCapabilityMatch', 'simulation']); check(hospitalIds.includes(h.hospitalId) && typeof h.name === 'string' && h.name.length < 100 && Number.isFinite(h.distanceMeters) && h.distanceMeters >= 0 && h.distanceMeters <= 100000 && h.requiredCapabilityMatch === true && h.simulation === true); }
  }
  if (name === 'get_ambulance_availability') {
    check(Array.isArray(result.units) && result.units.length === 3 && new Set(result.units.map(u => u.unitId)).size === 3);
    for (const u of result.units) { exact(u, ['unitId', 'status']); check(ambulanceIds.includes(u.unitId) && ['available', 'assigned'].includes(u.status)); }
  }
  if (name === 'calculate_ambulance_route') {
    check(ambulanceIds.includes(result.ambulanceUnitId) && ['patient', ...hospitalIds].includes(result.origin) && hospitalIds.includes(result.destination));
    check(Number.isInteger(result.distanceMeters) && result.distanceMeters >= 0 && result.distanceMeters <= 100000 && Number.isInteger(result.durationSeconds) && result.durationSeconds >= 0 && result.durationSeconds <= 86400 && typeof result.routeSummary === 'string' && result.routeSummary.length <= 300);
  }
  check(JSON.stringify(result).length < 10000);
  return structuredClone(result);
}

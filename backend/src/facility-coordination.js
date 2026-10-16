import { randomUUID } from 'node:crypto';
import { createResourceService, initializeResources } from './resources/service.js';
import { seedResources } from './resources/fixtures.js';
import { specialties, capabilities, validateCatalog, validateResult, ResourceError } from './resources/contracts.js';
import { emergencyEscalation } from './emergency.js';

const requestIdPattern = /^[0-9a-f-]{36}$/i;
const allowedCapability = new Set(capabilities);
const allowedSpecialty = new Set(specialties);
const clone = value => structuredClone(value);
const specialtyAliases = Object.freeze({
  general_medicine: ['family medicine', 'emergency medicine'], cardiology: ['cardiology'], pulmonology: ['pulmonology'],
  neurology: ['neurology'], endocrinology: ['endocrinology'], orthopedics: ['orthopedics'],
});

export function commandCenterResourceEnvironment(network, timestamp = Date.now()) {
  if (!network || !Array.isArray(network.hospitals) || network.hospitals.length !== 3 || !Number.isInteger(network.tick) || network.tick < 0) throw new FacilityCoordinationError('RESOURCE_UNAVAILABLE', 503);
  const catalog = seedResources(timestamp), byId = new Map(network.hospitals.map(hospital => [hospital.id, hospital]));
  const updatedAt = new Date(timestamp).toISOString();
  catalog.version = network.tick + 1; catalog.resourceVersion = `m9-demo:${catalog.version}`; catalog.updatedAt = updatedAt;
  for (const hospital of catalog.hospitals) {
    const current = byId.get(hospital.hospitalId);
    if (!current || typeof current.name !== 'string' || !Array.isArray(current.specialties) || !Array.isArray(current.equipment)) throw new FacilityCoordinationError('RESOURCE_UNAVAILABLE', 503);
    const listed = new Set(current.specialties.map(value => String(value).toLowerCase()));
    // The fictional Riverside catalog includes Family Medicine and Orthopedics.
    // Include them for existing persisted scenarios created before that catalog update.
    if (hospital.hospitalId === 'HOSP-002') { listed.add('family medicine'); listed.add('orthopedics'); }
    const supports = specialty => specialtyAliases[specialty].some(value => listed.has(value));
    const edAvailable = Math.max(0, current.edEffectiveCapacity - current.edOccupied);
    const icuAvailable = Math.max(0, current.icuEffectiveCapacity - current.icuOccupied);
    hospital.name = current.name;
    hospital.capabilities = [...new Set([
      ...(listed.has('emergency medicine') ? ['emergency'] : []),
      ...specialties.filter(supports),
      ...(current.equipment.includes('imaging') ? ['imaging'] : []),
      ...(current.equipment.includes('monitors') ? ['monitored_care'] : []),
      ...(current.icuEffectiveCapacity > 0 ? ['icu'] : []),
    ])];
    hospital.capacity = { emergencyBedsAvailable: edAvailable, monitoredBedsAvailable: edAvailable, icuBedsAvailable: icuAvailable, updatedAt };
    hospital.specialists = specialties.map(specialty => ({ specialty,
      available: supports(specialty) && edAvailable > 0 && current.operationalState !== 'critical',
      nextAvailableMinutes: supports(specialty) ? current.operationalState === 'normal' ? 10 : current.operationalState === 'pressured' ? 30 : 60 : 120,
      updatedAt }));
  }
  return validateCatalog(catalog);
}

export class FacilityCoordinationError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

function requireEligible({ intake, patientUid, intakeSessionId }) {
  if (!patientUid || !intakeSessionId) throw new FacilityCoordinationError('FACILITY_AUTH_REQUIRED', 403);
  if (emergencyEscalation(intake)) throw new FacilityCoordinationError('FACILITY_EMERGENCY_BLOCKED');
}

function requireEmergencyEligible({ intake, patientUid, intakeSessionId }) {
  if (!patientUid || !intakeSessionId) throw new FacilityCoordinationError('FACILITY_AUTH_REQUIRED', 403);
  if (!emergencyEscalation(intake)) throw new FacilityCoordinationError('FACILITY_EMERGENCY_REQUIRED', 400);
}

export function createMemoryAppointmentStore({ now = () => Date.now() } = {}) {
  const bySession = new Map();
  return {
    async get({ intakeSessionId, patientUid }) {
      const value = bySession.get(intakeSessionId);
      return value?.patientUid === patientUid ? clone(value) : null;
    },
    async submit({ intakeSessionId, patientUid, caseId, idempotencyKey, selection, resourceVersion }) {
      if (!requestIdPattern.test(idempotencyKey || '')) throw new FacilityCoordinationError('INVALID_APPOINTMENT_REQUEST', 400);
      const prior = bySession.get(intakeSessionId);
      if (prior) {
        if (prior.patientUid !== patientUid) throw new FacilityCoordinationError('APPOINTMENT_NOT_FOUND', 404);
        if (prior.idempotencyKey !== idempotencyKey || JSON.stringify(prior.selection) !== JSON.stringify(selection)) throw new FacilityCoordinationError('APPOINTMENT_CONFLICT');
        return clone(prior);
      }
      const requestedAt = new Date(now()).toISOString();
      const value = { appointmentRequestId: randomUUID(), intakeSessionId, patientUid, caseId, idempotencyKey,
        state: 'requested', simulation: true, contacted: false, confirmed: false, resourceVersion,
        selection: clone(selection), requestedAt, receipt: { receiptId: `SIM-APT-${idempotencyKey.slice(0, 8).toUpperCase()}`, requestedAt, simulation: true } };
      bySession.set(intakeSessionId, value); return clone(value);
    },
    close() { bySession.clear(); },
  };
}

export function createFacilityCoordinator({ resourceService = createResourceService(), appointmentStore = createMemoryAppointmentStore(), now = () => Date.now(), caseStore = { listAmbulances: async () => ({ units: [] }) }, networkState } = {}) {
  const state = {}; initializeResources(state, now());
  const snapshots = new Map();
  const lookup = async ({ intake, patientUid, intakeSessionId, caseId, requiredCapabilities, specialty, maxResults = 2 }) => {
    requireEligible({ intake, patientUid, intakeSessionId });
    if (!Array.isArray(requiredCapabilities) || !requiredCapabilities.length || requiredCapabilities.some(value => !allowedCapability.has(value)) || !allowedSpecialty.has(specialty)) throw new FacilityCoordinationError('INVALID_FACILITY_REQUEST', 400);
    let network;
    if (networkState) {
      try { network = await networkState(); state.resourceEnvironment = commandCenterResourceEnvironment(network, now()); }
      catch (error) { throw error instanceof FacilityCoordinationError ? error : new FacilityCoordinationError('RESOURCE_UNAVAILABLE', 503); }
    }
    let nearby;
    try { nearby = validateResult('find_nearby_hospitals', await resourceService.execute('find_nearby_hospitals', { requiredCapabilities, maxResults: Math.min(maxResults, 3) }, { state, caseStore })); }
    catch (error) { throw new FacilityCoordinationError(error instanceof ResourceError ? error.code : 'RESOURCE_UNAVAILABLE', 503); }
    const options = [];
    for (const hospital of nearby.hospitals) {
      const [capacity, specialist, hospitalCapabilities] = await Promise.all([
        resourceService.execute('get_hospital_capacity', { hospitalId: hospital.hospitalId }, { state, caseStore }),
        resourceService.execute('find_available_specialists', { hospitalId: hospital.hospitalId, specialty }, { state, caseStore }),
        resourceService.execute('get_hospital_capabilities', { hospitalId: hospital.hospitalId }, { state, caseStore }),
      ]);
      if (!requiredCapabilities.every(value => hospitalCapabilities.capabilities.includes(value)) || !specialist.available) continue;
      const department = network?.hospitals.find(item => item.id === hospital.hospitalId);
      options.push({ hospitalId: hospital.hospitalId, hospitalName: hospital.name, distanceMeters: hospital.distanceMeters,
        specialty, specialistAvailable: true, nextAvailableMinutes: specialist.nextAvailableMinutes,
        capacity: { emergencyBedsAvailable: capacity.emergencyBedsAvailable, monitoredBedsAvailable: capacity.monitoredBedsAvailable, icuBedsAvailable: capacity.icuBedsAvailable },
        ...(department ? { departmentCapacity: { emergencyOccupied: department.edOccupied, emergencyCapacity: department.edEffectiveCapacity,
          emergencyAvailable: Math.max(0, department.edEffectiveCapacity - department.edOccupied), icuOccupied: department.icuOccupied,
          icuCapacity: department.icuEffectiveCapacity, icuAvailable: Math.max(0, department.icuEffectiveCapacity - department.icuOccupied), operationalState: department.operationalState } } : {}), simulation: true });
    }
    options.sort((a, b) => a.nextAvailableMinutes - b.nextAvailableMinutes || a.distanceMeters - b.distanceMeters || a.hospitalId.localeCompare(b.hospitalId));
    const snapshot = { snapshotId: randomUUID(), caseId, intakeSessionId, patientUid, requiredCapabilities: [...requiredCapabilities], specialty,
      options: options.slice(0, maxResults), observedAt: nearby.updatedAt, resourceVersion: nearby.resourceVersion, simulation: true };
    snapshots.set(intakeSessionId, snapshot); return clone(snapshot);
  };
  return {
    lookup,
    async lookupEmergency({ intake, patientUid, intakeSessionId, caseId }) {
      requireEmergencyEligible({ intake, patientUid, intakeSessionId });
      let network;
      if (networkState) {
        try { network = await networkState(); state.resourceEnvironment = commandCenterResourceEnvironment(network, now()); }
        catch (error) { throw error instanceof FacilityCoordinationError ? error : new FacilityCoordinationError('RESOURCE_UNAVAILABLE', 503); }
      }
      let nearby;
      try { nearby = validateResult('find_nearby_hospitals', await resourceService.execute('find_nearby_hospitals', { requiredCapabilities: ['emergency'], maxResults: 3 }, { state, caseStore })); }
      catch (error) { throw new FacilityCoordinationError(error instanceof ResourceError ? error.code : 'RESOURCE_UNAVAILABLE', 503); }
      const options = [];
      for (const hospital of nearby.hospitals) {
        const [capacity, hospitalCapabilities] = await Promise.all([
          resourceService.execute('get_hospital_capacity', { hospitalId: hospital.hospitalId }, { state, caseStore }),
          resourceService.execute('get_hospital_capabilities', { hospitalId: hospital.hospitalId }, { state, caseStore }),
        ]);
        if (!hospitalCapabilities.capabilities.includes('emergency')) continue;
        const department = network?.hospitals.find(item => item.id === hospital.hospitalId);
        const emergencyAvailable = department
          ? Math.max(0, department.edEffectiveCapacity - department.edOccupied)
          : capacity.emergencyBedsAvailable;
        if (emergencyAvailable < 1) continue;
        options.push({ hospitalId: hospital.hospitalId, hospitalName: hospital.name, distanceMeters: hospital.distanceMeters,
          capabilities: ['emergency'], capacity: { emergencyBedsAvailable: capacity.emergencyBedsAvailable, monitoredBedsAvailable: capacity.monitoredBedsAvailable, icuBedsAvailable: capacity.icuBedsAvailable },
          ...(department ? { departmentCapacity: { emergencyOccupied: department.edOccupied, emergencyCapacity: department.edEffectiveCapacity,
            emergencyAvailable, icuOccupied: department.icuOccupied, icuCapacity: department.icuEffectiveCapacity,
            icuAvailable: Math.max(0, department.icuEffectiveCapacity - department.icuOccupied), operationalState: department.operationalState } } : {}), simulation: true });
      }
      options.sort((a, b) => a.distanceMeters - b.distanceMeters || a.hospitalId.localeCompare(b.hospitalId));
      return { snapshotId: randomUUID(), caseId, intakeSessionId, patientUid, requiredCapabilities: ['emergency'],
        options: options.slice(0, 1), observedAt: nearby.updatedAt, resourceVersion: nearby.resourceVersion, simulation: true };
    },
    async requestAppointment({ intake, patientUid, intakeSessionId, caseId, snapshotId, hospitalId, idempotencyKey, confirmed }) {
      requireEligible({ intake, patientUid, intakeSessionId });
      if (confirmed !== true) throw new FacilityCoordinationError('APPOINTMENT_CONFIRMATION_REQUIRED', 400);
      const prior = await appointmentStore.get({ intakeSessionId, patientUid });
      if (prior) {
        if (prior.selection.hospitalId !== hospitalId) throw new FacilityCoordinationError('APPOINTMENT_CONFLICT');
        return appointmentStore.submit({ intakeSessionId, patientUid, caseId, idempotencyKey, selection: prior.selection, resourceVersion: prior.resourceVersion });
      }
      const snapshot = snapshots.get(intakeSessionId);
      if (!snapshot || snapshot.patientUid !== patientUid || snapshot.caseId !== caseId || snapshot.snapshotId !== snapshotId) throw new FacilityCoordinationError('FACILITY_SNAPSHOT_STALE');
      const selected = snapshot.options.find(option => option.hospitalId === hospitalId);
      if (!selected) throw new FacilityCoordinationError('APPOINTMENT_OPTION_INVALID', 400);
      const refreshed = await lookup({ intake, patientUid, intakeSessionId, caseId, requiredCapabilities: snapshot.requiredCapabilities, specialty: snapshot.specialty, maxResults: 3 });
      snapshots.set(intakeSessionId, snapshot);
      const available = refreshed.options.find(option => option.hospitalId === hospitalId);
      if (!available) throw new FacilityCoordinationError('APPOINTMENT_AVAILABILITY_CHANGED');
      const date = new Date(now() + available.nextAvailableMinutes * 60_000);
      const selection = { ...available, date: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 16), fictionalDemo: true };
      return appointmentStore.submit({ intakeSessionId, patientUid, caseId, idempotencyKey, selection, resourceVersion: refreshed.resourceVersion });
    },
    getAppointment: input => appointmentStore.get(input),
    close: () => appointmentStore.close?.(),
  };
}

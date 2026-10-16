import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyIntake } from '../src/intake/schema.js';
import { createFacilityCoordinator, FacilityCoordinationError } from '../src/facility-coordination.js';
import { emergencyIntake } from './safety-fixtures.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { facilityLiveTools, systemInstruction } from '../src/live.js';
import { createInitialSimulationState } from '../src/simulation/engine.js';

const context = () => ({ intake: emptyIntake(), patientUid: 'patient-a', intakeSessionId: 'a'.repeat(64), caseId: 'SC-00000000-0000-4000-8000-000000000001' });
const request = extra => ({ ...context(), requiredCapabilities: ['general_medicine'], specialty: 'general_medicine', ...extra });

test('facility lookup returns bounded validated fictional options in deterministic order', async () => {
  const coordinator = createFacilityCoordinator({ now: () => Date.parse('2026-10-01T00:00:00Z') });
  const result = await coordinator.lookup(request());
  assert.equal(result.simulation, true); assert.ok(result.options.length <= 2); assert.ok(result.options.length > 0);
  assert.ok(result.options.every(option => option.simulation && option.specialistAvailable && option.specialty === 'general_medicine'));
  assert.deepEqual(result.options, [...result.options].sort((a, b) => a.nextAvailableMinutes - b.nextAvailableMinutes || a.distanceMeters - b.distanceMeters || a.hospitalId.localeCompare(b.hospitalId)));
});

test('facility lookup uses current Command Center capacity and returns an Orthopedics option for shoulder concerns', async () => {
  const network = createInitialSimulationState();
  const coordinator = createFacilityCoordinator({ now: () => Date.parse('2026-10-01T00:00:00Z'), networkState: async () => network });
  const result = await coordinator.lookup(request({ requiredCapabilities: ['orthopedics'], specialty: 'orthopedics' }));
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].hospitalId, 'HOSP-002');
  assert.equal(result.options[0].hospitalName, 'Riverside Medical');
  assert.deepEqual(result.options[0].departmentCapacity, {
    emergencyOccupied: 44, emergencyCapacity: 80, emergencyAvailable: 36,
    icuOccupied: 9, icuCapacity: 16, icuAvailable: 7, operationalState: 'normal',
  });
});

test('Live exposes only bounded facility and simulated appointment tools with explicit safety wording', () => {
  const names = facilityLiveTools[0].functionDeclarations.map(tool => tool.name);
  assert.deepEqual(names, ['find_non_emergency_facility_options', 'request_fictional_appointment']);
  assert.match(systemInstruction, /emergency handling always comes first/i);
  assert.match(systemInstruction, /Speak each supplied message exactly once/i);
  assert.match(systemInstruction, /speak that second message exactly as supplied/i);
  assert.match(systemInstruction, /not a confirmed referral/i);
  assert.match(systemInstruction, /hospital or doctor was contacted/i);
});

test('emergency facts block facility lookup and appointment submission', async () => {
  const coordinator = createFacilityCoordinator(); const input = { ...context(), intake: emergencyIntake() };
  await assert.rejects(coordinator.lookup({ ...input, requiredCapabilities: ['emergency'], specialty: 'cardiology' }), error => error instanceof FacilityCoordinationError && error.code === 'FACILITY_EMERGENCY_BLOCKED');
});

test('emergency lookup returns the nearest emergency-capable demo hospital with capacity', async () => {
  const coordinator = createFacilityCoordinator({ now: () => Date.parse('2026-10-01T00:00:00Z') });
  const result = await coordinator.lookupEmergency({ ...context(), intake: emergencyIntake() });
  assert.equal(result.simulation, true);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].hospitalId, 'HOSP-001');
  assert.equal(result.options[0].hospitalName, 'SmartCare General Hospital (fictional)');
  assert.equal(result.options[0].capacity.emergencyBedsAvailable, 3);
});

test('appointment requires explicit confirmation, rechecks availability, and is exactly-once', async () => {
  const coordinator = createFacilityCoordinator({ now: () => Date.parse('2026-10-01T00:00:00Z') });
  const base = context(), snapshot = await coordinator.lookup(request()); const hospitalId = snapshot.options[0].hospitalId;
  await assert.rejects(coordinator.requestAppointment({ ...base, snapshotId: snapshot.snapshotId, hospitalId, confirmed: false, idempotencyKey: crypto.randomUUID() }), /APPOINTMENT_CONFIRMATION_REQUIRED/);
  const key = crypto.randomUUID();
  const first = await coordinator.requestAppointment({ ...base, snapshotId: snapshot.snapshotId, hospitalId, confirmed: true, idempotencyKey: key });
  const second = await coordinator.requestAppointment({ ...base, snapshotId: snapshot.snapshotId, hospitalId, confirmed: true, idempotencyKey: key });
  assert.deepEqual(second, first); assert.equal(first.state, 'requested'); assert.equal(first.confirmed, false); assert.equal(first.contacted, false); assert.equal(first.simulation, true);
});

test('cross-patient, stale snapshot, malformed capability, and duplicate conflict are rejected', async () => {
  const coordinator = createFacilityCoordinator(); const base = context(), snapshot = await coordinator.lookup(request());
  await assert.rejects(coordinator.requestAppointment({ ...base, patientUid: 'patient-b', snapshotId: snapshot.snapshotId, hospitalId: snapshot.options[0].hospitalId, confirmed: true, idempotencyKey: crypto.randomUUID() }), /FACILITY_SNAPSHOT_STALE/);
  await assert.rejects(coordinator.lookup(request({ requiredCapabilities: ['invented'] })), /INVALID_FACILITY_REQUEST/);
  const key = crypto.randomUUID(); await coordinator.requestAppointment({ ...base, snapshotId: snapshot.snapshotId, hospitalId: snapshot.options[0].hospitalId, confirmed: true, idempotencyKey: key });
  await assert.rejects(coordinator.requestAppointment({ ...base, snapshotId: snapshot.snapshotId, hospitalId: snapshot.options.at(-1).hospitalId, confirmed: true, idempotencyKey: key }), /APPOINTMENT_CONFLICT|APPOINTMENT_OPTION_INVALID/);
});

test('one simulated appointment request is attached to the owning non-emergency case and exposed safely', async () => {
  const store = createMemoryCaseStore(), base = context();
  await store.createCase({ caseId: base.caseId, intake: base.intake, patientUid: base.patientUid, fictionalConfirmed: true, intakeSource: 'live_intake', enrichmentStatus: 'pending' });
  const coordinator = createFacilityCoordinator(); const snapshot = await coordinator.lookup(request());
  const appointmentRequest = await coordinator.requestAppointment({ ...base, snapshotId: snapshot.snapshotId, hospitalId: snapshot.options[0].hospitalId, confirmed: true, idempotencyKey: crypto.randomUUID() });
  const saved = await store.saveAppointmentRequest({ caseId: base.caseId, patientUid: base.patientUid, appointmentRequest });
  assert.equal(saved.appointmentRequest.state, 'requested'); assert.equal(saved.appointmentRequest.simulation, true); assert.equal(saved.appointmentRequest.confirmed, false);
  await assert.rejects(store.saveAppointmentRequest({ caseId: base.caseId, patientUid: 'patient-b', appointmentRequest }), error => ['INVALID_APPOINTMENT_REQUEST', 'CASE_NOT_FOUND'].includes(error.code));
});

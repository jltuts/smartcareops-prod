import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { advanceSimulationState, createInitialSimulationState, resetSimulationState } from '../src/simulation/engine.js';
import { createFirestoreSimulationStore, createMemorySimulationStore } from '../src/simulation/store.js';
import { createSimulationService } from '../src/simulation/service.js';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';

test('same seed and scenario produce the same initial and advancing state', () => {
  const a = createInitialSimulationState({ seed: 71 }), b = createInitialSimulationState({ seed: 71 });
  assert.deepEqual(a, b); assert.deepEqual(advanceSimulationState(a, 4), advanceSimulationState(b, 4));
  assert.notDeepEqual(advanceSimulationState(a, 4), advanceSimulationState(createInitialSimulationState({ seed: 72 }), 4));
});

test('reset restores the selected scenario initial state and the clock advances in five-minute ticks', () => {
  const initial = createInitialSimulationState({ scenario: 'ed_surge', seed: 20 }), later = advanceSimulationState(initial, 3);
  assert.equal(later.tick, 3); assert.equal(later.simulationTime, '10:45'); assert.deepEqual(resetSimulationState(later), initial);
});

test('hospital and ICU occupancy stay within effective capacity in every scenario', () => {
  for (const scenario of ['normal_operations', 'ed_surge', 'respiratory_outbreak', 'capacity_failure']) {
    const state = advanceSimulationState(createInitialSimulationState({ scenario }), 12);
    for (const hospital of state.hospitals) {
      assert.ok(hospital.edOccupied >= 0 && hospital.edOccupied <= hospital.edEffectiveCapacity);
      assert.ok(hospital.icuOccupied >= 0 && hospital.icuOccupied <= hospital.icuEffectiveCapacity);
      assert.ok(hospital.edEffectiveCapacity <= hospital.edCapacity && hospital.icuEffectiveCapacity <= hospital.icuCapacity);
      assert.ok(hospital.edUtilization >= 0 && hospital.edUtilization <= 1);
    }
  }
});

test('Normal Operations has bounded stable occupancy while ED Surge increases ED pressure', () => {
  const normal = createInitialSimulationState(), stable = advanceSimulationState(normal, 6);
  assert.ok(Math.abs(stable.hospitals[0].edOccupied - normal.hospitals[0].edOccupied) <= 2);
  const surge = advanceSimulationState(createInitialSimulationState({ scenario: 'ed_surge' }), 3);
  assert.ok(surge.hospitals[0].edOccupied > 62); assert.ok(surge.network.pressure >= normal.network.pressure);
});

test('Respiratory Outbreak Simulation increases respiratory and resource pressure without a real outbreak claim', () => {
  const state = advanceSimulationState(createInitialSimulationState({ scenario: 'respiratory_outbreak' }), 3);
  assert.ok(state.hospitals.some(h => h.respiratoryDemand > 0));
  assert.ok(state.hospitals.some(h => h.respiratoryResourcePressure > 0.25));
  assert.equal(state.scenarioName, 'Respiratory Outbreak Simulation');
});

test('Capacity Failure reduces HOSP-002 capacity and redistributes projected demand', () => {
  const normal = advanceSimulationState(createInitialSimulationState(), 1);
  const failed = advanceSimulationState(createInitialSimulationState({ scenario: 'capacity_failure' }), 1);
  const affected = failed.hospitals.find(h => h.id === 'HOSP-002'), adjacent = failed.hospitals.find(h => h.id === 'HOSP-001');
  assert.ok(affected.edEffectiveCapacity < affected.edCapacity); assert.equal(affected.operationalState, 'degraded');
  assert.ok(adjacent.projectedDemand > normal.hospitals.find(h => h.id === 'HOSP-001').projectedDemand);
});

test('deterministic demand pressure moves one ambulance through a bounded assignment lifecycle', () => {
  const initial = createInitialSimulationState({ scenario: 'ed_surge' }), assigned = advanceSimulationState(initial);
  assert.equal(assigned.network.availableAmbulances, 2);
  assert.equal(assigned.ambulances.filter(unit => unit.assignment).length, 1);
  const later = advanceSimulationState(assigned, 3);
  assert.equal(later.network.availableAmbulances, 3);
  assert.ok(later.ambulances.every(unit => unit.assignment === null || unit.status !== 'available'));
  assert.ok(later.ambulances.length <= 3);
});

test('transport adds exactly one arrival to the assigned destination only at its deterministic arrival tick', () => {
  const initial = createInitialSimulationState({ scenario: 'ed_surge', seed: 71 });
  const assigned = advanceSimulationState(initial);
  const unit = assigned.ambulances.find(item => item.assignment);
  assert.equal(unit.status, 'dispatched');
  assert.equal(unit.assignment.arrivesAtTick, 3);
  assert.equal(resetSimulationState(assigned).ambulances.some(item => item.assignment), false);
  const destinationId = unit.assignment.destination;
  const baseline = assigned.hospitals.find(h => h.id === destinationId);
  const before = advanceSimulationState(assigned);
  assert.equal(before.ambulances.find(item => item.id === unit.id).status, 'transporting');
  assert.equal(before.hospitals.find(h => h.id === destinationId).incomingDemand, baseline.incomingDemand);
  const completed = advanceSimulationState(before);
  const destination = completed.hospitals.find(h => h.id === destinationId);
  const other = completed.hospitals.find(h => h.id !== destinationId);
  const beforeDestination = before.hospitals.find(h => h.id === destinationId);
  const beforeOther = before.hospitals.find(h => h.id === other.id);
  assert.equal(destination.incomingDemand, beforeDestination.incomingDemand + 1);
  assert.equal(destination.edOccupied, beforeDestination.edOccupied + beforeDestination.incomingDemand - 3 + 1);
  assert.equal(other.incomingDemand, beforeOther.incomingDemand);
  assert.equal(completed.ambulances.find(item => item.id === unit.id).status, 'at_hospital');
  const released = advanceSimulationState(completed);
  assert.equal(released.ambulances.find(item => item.id === unit.id).status, 'available');
  assert.equal(released.ambulances.find(item => item.id === unit.id).assignment, null);
  const repeatedTick = advanceSimulationState(completed).hospitals.find(h => h.id === destinationId);
  assert.equal(repeatedTick.incomingDemand, beforeDestination.incomingDemand);
});

test('network pressure and scenario switching are deterministic and bounded', () => {
  const a = advanceSimulationState(createInitialSimulationState({ scenario: 'respiratory_outbreak', seed: 5 }), 5);
  const b = advanceSimulationState(createInitialSimulationState({ scenario: 'respiratory_outbreak', seed: 5 }), 5);
  assert.deepEqual(a.network, b.network); assert.ok(a.network.pressure >= 0 && a.network.pressure <= 1);
});

test('Firestore simulation state survives store/service recreation', async () => {
  const docs = new Map();
  const db = {
    collection(name) { assert.equal(name, 'simulationStates'); return { doc(id) { return { key: `${name}/${id}` }; } }; },
    async runTransaction(callback) { return callback({ async get(ref) { const data = docs.get(ref.key); return { exists: !!data, data: () => structuredClone(data) }; }, create(ref, value) { docs.set(ref.key, structuredClone(value)); }, set(ref, value) { docs.set(ref.key, structuredClone(value)); } }); },
    async terminate() {},
  };
  const first = createSimulationService(createFirestoreSimulationStore(db)); await first.view(); await first.advance();
  const resumed = createSimulationService(createFirestoreSimulationStore(db)); const state = await resumed.view();
  assert.equal(state.tick, 1); assert.equal(state.simulationTime, '10:35'); assert.equal(docs.size, 1);
});

test('Command Center role can read and control simulation while Patient-only remains denied', async t => {
  const profiles = new Map([
    ['verified-user', { uid: 'verified-user', roles: ['patient', 'command_center'], status: 'active' }],
    ['patient-user', { uid: 'patient-user', roles: ['patient'], status: 'active' }],
  ]);
  const api = createApiServer({ caseStore: createMemoryCaseStore(), simulationEnabled: true, simulationStore: createMemorySimulationStore(), authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: '', DEV_PATIENT_UIDS: '' },
    userProfileStore: createMemoryUserProfileStore(profiles),
    verifyToken: async token => ({ uid: token, firebase: { sign_in_provider: 'google.com' } }),
  } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const headers = { Authorization: 'Bearer verified-user' };
  assert.equal((await fetch(`${base}/api/simulation`, { headers })).status, 200);
  const change = await fetch(`${base}/api/simulation/scenario`, { method: 'POST', headers: { ...headers, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'ed_surge' }) });
  assert.equal(change.status, 200); assert.equal((await change.json()).scenario, 'ed_surge');
  const patientHeaders = { Authorization: 'Bearer patient-user' };
  assert.equal((await fetch(`${base}/api/simulation`, { headers: patientHeaders })).status, 403);
  const deniedControl = await fetch(`${base}/api/simulation/advance`, { method: 'POST', headers: { ...patientHeaders, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: 1 }) });
  assert.equal(deniedControl.status, 403);
});

test('hosted cross-origin Advance 5 min returns the persisted simulation snapshot shape', async t => {
  const store = createMemorySimulationStore();
  const api = createApiServer({ caseStore: createMemoryCaseStore(), simulationEnabled: true, simulationStore: store, authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: '', DEV_PATIENT_UIDS: '' },
    userProfileStore: createMemoryUserProfileStore(new Map([['command-user', { uid: 'command-user', roles: ['command_center'], status: 'active' }]])),
    verifyToken: async () => ({ uid: 'command-user', firebase: { sign_in_provider: 'google.com' } }),
  } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const response = await fetch(`${base}/api/simulation/advance`, { method: 'POST', headers: {
    Authorization: 'Bearer valid', Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ steps: 1 }) });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.scenario, 'normal_operations'); assert.equal(snapshot.tick, 1); assert.equal(snapshot.simulationTime, '10:35');
  assert.ok(Array.isArray(snapshot.hospitals)); assert.ok(Array.isArray(snapshot.ambulances)); assert.equal(typeof snapshot.network.pressure, 'number');
  assert.deepEqual(await store.get(), snapshot);
  const rejected = await fetch(`${base}/api/simulation/advance`, { method: 'POST', headers: {
    Authorization: 'Bearer valid', Origin: 'https://untrusted.invalid', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ steps: 1 }) });
  assert.equal(rejected.status, 403); assert.equal((await store.get()).tick, 1);
});

test('simulation API rejects unbounded or client-authored state changes', async t => {
  const api = createApiServer({ caseStore: createMemoryCaseStore(), simulationEnabled: true, simulationStore: createMemorySimulationStore(), authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development' }, userProfileStore: createMemoryUserProfileStore(new Map([['verified-user', { uid: 'verified-user', roles: ['command_center'], status: 'active' }]])),
    verifyToken: async () => ({ uid: 'verified-user', firebase: { sign_in_provider: 'google.com' } }),
  } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`, headers = { Authorization: 'Bearer valid', Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
  for (const input of [{ steps: 99 }, { steps: 1, hospitals: [] }]) {
    const response = await fetch(`${base}/api/simulation/advance`, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`${base}/api/simulation/advance`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' }, body: JSON.stringify({ steps: 1 }) })).status, 403);
});

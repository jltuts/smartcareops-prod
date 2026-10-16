import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialSimulationState } from '../src/simulation/engine.js';
import { createPredictiveForecast, FORECAST_HORIZONS } from '../src/simulation/predictive-forecast.js';
import { createPredictiveModel, validatePredictiveInterpretation } from '../src/simulation/predictive-model.js';
import { createPredictiveService } from '../src/simulation/predictive-service.js';
import { createFirestorePredictiveStore, createMemoryPredictiveStore } from '../src/simulation/predictive-store.js';
import { createMemorySimulationStore } from '../src/simulation/store.js';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';
import { once } from 'node:events';

const interpretation = resource => ({ topBottleneck: resource || 'No significant bottleneck identified', recommendation: 'Consider monitoring the modeled pressure and reviewing a CareTwin comparison.',
  why: ['The supplied deterministic forecast shows this pressure trajectory.'], whyNot: ['No facility-specific transport or admission evidence is modeled.'],
  uncertainty: ['These are synthetic projections, not real hospital conditions.'], whatWouldChange: ['A new M15 simulation state could change the projected pressure.'] });

function assertNoUndefined(value) {
  if (value === undefined) throw new Error('Cannot encode value undefined');
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertNoUndefined(child);
}

function createFirestoreHarness() {
  const docs = new Map();
  const db = { collection(name) { assert.equal(name, 'simulationStates'); return { doc(id) { const key = `${name}/${id}`; return { key, async get() { const value = docs.get(key); return { exists: !!value, data: () => structuredClone(value) }; } }; } }; }, async terminate() {},
    async runTransaction(callback) { return callback({ async get(ref) { const value = docs.get(ref.key); return { exists: !!value, data: () => structuredClone(value) }; }, set(ref, value) { assertNoUndefined(value); docs.set(ref.key, structuredClone(value)); } }); } };
  return { db, docs };
}

test('M17 horizons independently project deterministic M15 state without mutating baseline', () => {
  const baseline = createInitialSimulationState({ scenario: 'ed_surge', seed: 41 }); const before = structuredClone(baseline);
  const result = createPredictiveForecast(baseline);
  assert.deepEqual(FORECAST_HORIZONS, [30, 60, 120]); assert.deepEqual(result.horizons.map(h => h.minutes), [30, 60, 120]);
  assert.deepEqual(result, createPredictiveForecast(baseline)); assert.deepEqual(baseline, before);
  assert.deepEqual(result.horizons.map(h => h.tick), [6, 12, 24]);
  assert.ok(result.horizons.every(h => h.metrics.hospitals.every(site => site.edOccupied >= 0 && site.edOccupied <= site.edEffectiveCapacity && site.icuOccupied >= 0 && site.icuOccupied <= site.icuEffectiveCapacity)));
  assert.ok(result.horizons.every(h => h.metrics.hospitals.every(site => ['normal', 'pressured', 'critical', 'degraded'].includes(site.operationalState))));
});

test('M17 ED Surge forecast reflects scenario-aware M15 ICU flow', () => {
  const surge = createPredictiveForecast(createInitialSimulationState({ scenario: 'ed_surge', seed: 41 }));
  const respiratory = createPredictiveForecast(createInitialSimulationState({ scenario: 'respiratory_outbreak', seed: 41 }));
  assert.deepEqual(surge.horizons.map(horizon => horizon.metrics.icu.occupied), [28, 30, 34]);
  assert.ok(respiratory.horizons.every((horizon, index) => horizon.metrics.icu.occupied > surge.horizons[index].metrics.icu.occupied));
  assert.ok(surge.horizons.every(horizon => horizon.metrics.icu.occupied <= horizon.metrics.icu.effectiveCapacity));
});

test('M17 bottlenecks come only from forecast transitions and carry supporting metrics', () => {
  const result = createPredictiveForecast(createInitialSimulationState({ scenario: 'ed_surge', seed: 7 }));
  assert.ok(result.bottlenecks.length > 0);
  for (const item of result.bottlenecks) {
    assert.deepEqual(Object.keys(item).sort(), ['evidence', 'facilityId', 'horizonMinutes', 'resource', 'severity']);
    assert.ok([30, 60, 120].includes(item.horizonMinutes)); assert.ok(Object.keys(item.evidence).length > 0);
  }
  assert.deepEqual(result.baseline.metrics.hospitals.map(h => h.hospitalId), ['HOSP-001', 'HOSP-002', 'HOSP-003']);
  assert.equal(Object.hasOwn(result.horizons[0].metrics, 'estimatedTimeToCapacity'), false);
});

test('M17 bottlenecks use M15 hospital IDs and produce Firestore-serializable forecast fields', () => {
  const result = createPredictiveForecast(createInitialSimulationState({ scenario: 'ed_surge', seed: 7 }));
  const hospitalIds = new Set(result.baseline.metrics.hospitals.map(hospital => hospital.hospitalId));
  const facilityRisks = result.bottlenecks.filter(item => item.resource !== 'Ambulance fleet');
  assert.ok(facilityRisks.length > 0);
  assert.ok(facilityRisks.every(item => hospitalIds.has(item.facilityId)));
  assert.doesNotThrow(() => assertNoUndefined(result));
});

test('Gemini receives generated trajectory metrics and cannot introduce an unmodeled bottleneck', async () => {
  let captured;
  const forecast = createPredictiveForecast(createInitialSimulationState({ scenario: 'ed_surge', seed: 12 }));
  const model = createPredictiveModel({ request: async input => { captured = input; return { status: 'completed', output_text: JSON.stringify(interpretation(forecast.bottlenecks[0].resource)) }; } });
  const result = await model({ baseline: forecast.baseline, horizons: forecast.horizons, bottlenecks: forecast.bottlenecks, assumptions: forecast.assumptions });
  assert.equal(captured.store, false); assert.deepEqual(JSON.parse(captured.input).horizons, forecast.horizons);
  assert.match(captured.system_instruction, /Do not invent or alter forecast numbers/); assert.match(captured.system_instruction, /Never mutate the simulator/);
  assert.equal(result.topBottleneck, forecast.bottlenecks[0].resource);
  assert.throws(() => validatePredictiveInterpretation(interpretation('Made-up Hospital'), forecast.bottlenecks));
  assert.ok(result.why.length && result.whyNot.length && result.uncertainty.length && result.whatWouldChange.length);
});

test('M17 persists forecast and interpretation across store recreation; provider failure preserves forecast', async () => {
  const { db } = createFirestoreHarness();
  const store = createFirestorePredictiveStore(db), initial = createInitialSimulationState({ scenario: 'ed_surge', seed: 19 });
  const service = createPredictiveService({ simulationStore: createMemorySimulationStore({ initial: () => initial }), store, interpret: async ({ bottlenecks }) => interpretation(bottlenecks[0]?.resource), now: () => 1700000000000 });
  const created = await service.generate(); assert.equal(created.interpretationStatus, 'succeeded');
  assert.deepEqual(await createPredictiveService({ simulationStore: createMemorySimulationStore(), store: createFirestorePredictiveStore(db) }).view(), created);
  const degraded = createPredictiveService({ simulationStore: createMemorySimulationStore({ initial: () => initial }), store: createMemoryPredictiveStore(), interpret: async () => { throw new Error('provider failure'); } });
  const result = await degraded.generate(); assert.equal(result.interpretationStatus, 'unavailable'); assert.equal(result.horizons.length, 3); assert.equal(result.interpretation, null);
});

test('Command Center role can generate and restore M17; Patient is denied and simulator/CareTwin state is not executed', async t => {
  const profiles = new Map([['cc', { uid: 'cc', roles: ['patient', 'command_center'], status: 'active' }], ['patient', { uid: 'patient', roles: ['patient'], status: 'active' }]]);
  const simulationStore = createMemorySimulationStore({ initial: () => createInitialSimulationState({ scenario: 'ed_surge', seed: 3 }) });
  const { db } = createFirestoreHarness(); const store = createFirestorePredictiveStore(db);
  const service = createPredictiveService({ simulationStore, store, interpret: async ({ bottlenecks }) => interpretation(bottlenecks[0]?.resource) });
  const api = createApiServer({ caseStore: createMemoryCaseStore(), predictiveEnabled: true, predictiveStore: store, predictiveService: service,
    authOptions: { env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: '', DEV_PATIENT_UIDS: '' }, userProfileStore: createMemoryUserProfileStore(profiles), verifyToken: async token => { if (token === 'invalid') throw new Error('bad token'); return { uid: token, firebase: { sign_in_provider: 'google.com' } }; } } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown()); const base = `http://127.0.0.1:${api.server.address().port}`;
  assert.equal((await fetch(`${base}/api/predictive`)).status, 401);
  assert.equal((await fetch(`${base}/api/predictive`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await fetch(`${base}/api/predictive`, { headers: { Authorization: 'Bearer patient' } })).status, 403);
  assert.equal((await fetch(`${base}/api/predictive/generate`, { method: 'POST', headers: { Authorization: 'Bearer cc', Origin: 'https://bad.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const response = await fetch(`${base}/api/predictive/generate`, { method: 'POST', headers: { Authorization: 'Bearer cc', Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); const generated = (await response.json()).result; assert.deepEqual(generated.horizons.map(h => h.minutes), [30, 60, 120]);
  assert.equal((await simulationStore.get()).tick, 0); assert.deepEqual((await fetch(`${base}/api/predictive`, { headers: { Authorization: 'Bearer cc' } }).then(r => r.json())).result, generated);
});

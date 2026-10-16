import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createInitialSimulationState, advanceSimulationState } from '../src/simulation/engine.js';
import { CARETWIN_HORIZON_TICKS, simulateCandidatePlans, simulationMetrics } from '../src/simulation/caretwin-plans.js';
import { createCareTwinModel, validateCareTwinComparison } from '../src/simulation/caretwin-model.js';
import { createCareTwinService } from '../src/simulation/caretwin-service.js';
import { createFirestoreCareTwinStore, createMemoryCareTwinStore } from '../src/simulation/caretwin-store.js';
import { createMemorySimulationStore } from '../src/simulation/store.js';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';

const comparison = recommendedPlan => ({ comparisonSummary: `Plan ${recommendedPlan} has the best modeled trade-off.`, recommendedPlan,
  whyRecommended: ['The supplied hospital outcomes show lower pressure at the most constrained site.'],
  whyNotOthers: ['A', 'B', 'C'].filter(id => id !== recommendedPlan).map(planId => ({ planId, tradeoff: `Plan ${planId} leaves a different hospital-level pressure distribution.` })),
  uncertainty: ['Redistributed synthetic arrivals do not model patient-specific suitability.'],
  whatWouldChangeRecommendation: ['A change in the observed hospital pressure distribution could change the recommendation.'] });

test('CareTwin simulates exactly three independent futures from the same immutable baseline', () => {
  const baseline = createInitialSimulationState({ scenario: 'ed_surge', seed: 314159 });
  const before = structuredClone(baseline), forecast = simulateCandidatePlans(baseline);
  assert.equal(CARETWIN_HORIZON_TICKS, 6); assert.equal(forecast.horizonMinutes, 30);
  assert.deepEqual(baseline, before); assert.equal(forecast.plans.length, 3);
  assert.deepEqual(forecast.plans.map(plan => plan.id), ['A', 'B', 'C']);
  assert.ok(forecast.plans.every(plan => plan.baselineId === forecast.baselineId));
  assert.deepEqual(forecast.plans[0].outcome, simulationMetrics(advanceSimulationState(before, 6)));
  assert.notDeepEqual(forecast.plans[0].outcome.hospitals, forecast.plans[1].outcome.hospitals);
  assert.notDeepEqual(forecast.plans[1].outcome.hospitals, forecast.plans[2].outcome.hospitals);
  forecast.plans[0].outcome.hospitals[0].edOccupied = -100;
  assert.deepEqual(simulateCandidatePlans(before).plans[0].outcome, simulationMetrics(advanceSimulationState(before, 6)));
});

test('CareTwin forecasts are deterministic and expose only M15-produced operational metrics', () => {
  for (const scenario of ['normal_operations', 'ed_surge', 'respiratory_outbreak', 'capacity_failure']) {
    const baseline = createInitialSimulationState({ scenario, seed: 2026 });
    const a = simulateCandidatePlans(baseline), b = simulateCandidatePlans(baseline);
    assert.deepEqual(a, b);
    for (const plan of a.plans) {
      assert.deepEqual(Object.keys(plan.outcome).sort(), ['availableAmbulances', 'ed', 'hospitals', 'icu', 'networkPressure', 'networkPressureLevel', 'pressuredHospitals', 'projectedDemand', 'simulationTime', 'tick'].sort());
      assert.ok(plan.outcome.hospitals.every(hospital => ['hospitalId', 'edOccupied', 'edEffectiveCapacity', 'edUtilization', 'icuOccupied', 'icuEffectiveCapacity', 'projectedDemand', 'operationalState'].every(key => Object.hasOwn(hospital, key))));
      assert.equal(Object.hasOwn(plan.outcome, 'travelTime'), false);
    }
  }
});

test('M16 CareTwin continues to consume the corrected scenario-aware M15 ICU trajectory', () => {
  const surge = simulateCandidatePlans(createInitialSimulationState({ scenario: 'ed_surge', seed: 41 }));
  const respiratory = simulateCandidatePlans(createInitialSimulationState({ scenario: 'respiratory_outbreak', seed: 41 }));
  const expectedSurge = simulationMetrics(advanceSimulationState(createInitialSimulationState({ scenario: 'ed_surge', seed: 41 }), CARETWIN_HORIZON_TICKS));
  assert.deepEqual(surge.plans[0].outcome, expectedSurge);
  assert.ok(respiratory.plans[0].outcome.icu.occupied > surge.plans[0].outcome.icu.occupied);
  assert.ok([...surge.plans, ...respiratory.plans].every(plan => plan.outcome.hospitals.every(hospital =>
    hospital.icuOccupied >= 0 && hospital.icuOccupied <= hospital.icuEffectiveCapacity)));
});

test('Gemini comparison receives generated futures and returns validated Why, Why Not, and uncertainty only', async () => {
  let requestBody;
  const model = createCareTwinModel({ model: 'test-model', request: async input => {
    requestBody = input;
    return { status: 'completed', output_text: JSON.stringify(comparison('B')) };
  } });
  const forecast = simulateCandidatePlans(createInitialSimulationState({ scenario: 'ed_surge', seed: 4 }));
  const result = await model({ baseline: forecast.baseline, plans: forecast.plans, assumptions: forecast.assumptions, horizonMinutes: forecast.horizonMinutes });
  assert.equal(requestBody.model, 'test-model'); assert.equal(requestBody.store, false);
  assert.match(requestBody.system_instruction, /only source of future metrics/);
  assert.match(requestBody.system_instruction, /Do not execute plans/);
  assert.deepEqual(JSON.parse(requestBody.input).plans, forecast.plans);
  assert.equal(result.recommendedPlan, 'B'); assert.equal(result.whyNotOthers.length, 2); assert.ok(result.uncertainty.length);
  assert.throws(() => validateCareTwinComparison({ ...comparison('A'), chainOfThought: 'private' }));
});

test('CareTwin persistence survives store recreation and decisions remain advisory', async () => {
  const docs = new Map();
  const db = {
    collection(name) { assert.equal(name, 'simulationStates'); return { doc(id) { const key = `${name}/${id}`; return { key, async get() { const value = docs.get(key); return { exists: !!value, data: () => structuredClone(value) }; } }; } }; },
    async runTransaction(callback) { return callback({ async get(ref) { const value = docs.get(ref.key); return { exists: !!value, data: () => structuredClone(value) }; }, set(ref, value) { docs.set(ref.key, structuredClone(value)); } }); },
  };
  const state = createInitialSimulationState({ scenario: 'ed_surge', seed: 7 });
  const simulationStore = createMemorySimulationStore({ initial: () => state });
  const store = createFirestoreCareTwinStore(db);
  let counter = 0;
  const service = createCareTwinService({ simulationStore, store, compare: async () => comparison('C'), now: () => 1700000000000 + counter++ });
  const generated = await service.generate();
  assert.equal(generated.approval.required, true); assert.equal(generated.approval.status, 'pending');
  assert.equal(generated.approval.reviewerUid, undefined); assert.deepEqual(await simulationStore.get(), state);
  const restored = createCareTwinService({ simulationStore, store: createFirestoreCareTwinStore(db), compare: async () => comparison('A') });
  assert.deepEqual(await restored.view(), generated);
  const decision = await restored.decide(generated.generationId, 'deferred', 'verified-command-user');
  assert.equal(decision.approval.status, 'deferred'); assert.equal(decision.approval.reviewerUid, undefined);
  assert.equal((await createCareTwinService({ simulationStore, store: createFirestoreCareTwinStore(db), compare: async () => comparison('A') }).view()).approval.status, 'deferred');
  assert.deepEqual(await simulationStore.get(), state);
});

test('CareTwin persists Approve, Reject, and Defer without executing any plan', async () => {
  for (const [decision, status] of [['approved', 'approved'], ['rejected', 'rejected'], ['deferred', 'deferred']]) {
    const simulationStore = createMemorySimulationStore({ initial: () => createInitialSimulationState({ seed: 88 }) });
    const service = createCareTwinService({ simulationStore, store: createMemoryCareTwinStore(), compare: async () => comparison('A') });
    const generated = await service.generate();
    const result = await service.decide(generated.generationId, decision, 'command-user');
    assert.equal(result.approval.status, status); assert.equal(result.comparison.recommendedPlan, 'A');
    assert.equal((await simulationStore.get()).tick, 0);
  }
});

test('CareTwin keeps simulated futures available but blocks approval when Gemini comparison fails', async () => {
  const service = createCareTwinService({ simulationStore: createMemorySimulationStore(), store: createMemoryCareTwinStore(), compare: async () => { throw new Error('provider text is not surfaced'); } });
  const result = await service.generate();
  assert.equal(result.plans.length, 3); assert.equal(result.comparisonStatus, 'unavailable'); assert.equal(result.comparison, null);
  assert.equal(result.comparisonError, 'MODEL_UNAVAILABLE'); assert.equal(result.approval.status, 'pending');
  await assert.rejects(() => service.decide(result.generationId, 'approved', 'command-user'), error => error.code === 'CARETWIN_RECOMMENDATION_REQUIRED');
  assert.equal((await service.view()).approval.status, 'pending');
});

test('Command Center role can use CareTwin, Patient-only is denied, and refreshing reads saved output', async t => {
  const profiles = new Map([
    ['command-user', { uid: 'command-user', roles: ['patient', 'command_center'], status: 'active' }],
    ['patient-user', { uid: 'patient-user', roles: ['patient'], status: 'active' }],
  ]);
  const simulationStore = createMemorySimulationStore({ initial: () => createInitialSimulationState({ scenario: 'ed_surge', seed: 9 }) });
  const careTwinStore = createMemoryCareTwinStore();
  const careTwinService = createCareTwinService({ simulationStore, store: careTwinStore, compare: async () => comparison('B') });
  const api = createApiServer({ caseStore: createMemoryCaseStore(), simulationEnabled: true, simulationStore, careTwinEnabled: true, careTwinStore, careTwinService, authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: '', DEV_PATIENT_UIDS: '' }, userProfileStore: createMemoryUserProfileStore(profiles),
    verifyToken: async token => ({ uid: token, firebase: { sign_in_provider: 'google.com' } }),
  } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const cc = { Authorization: 'Bearer command-user' }, patient = { Authorization: 'Bearer patient-user' };
  assert.equal((await fetch(`${base}/api/caretwin`, { headers: cc })).status, 200);
  assert.equal((await fetch(`${base}/api/caretwin`, { headers: patient })).status, 403);
  const generated = await fetch(`${base}/api/caretwin/generate`, { method: 'POST', headers: { ...cc, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(generated.status, 200); const result = (await generated.json()).result;
  assert.equal(result.plans.length, 3); assert.equal(result.comparison.recommendedPlan, 'B');
  const denied = await fetch(`${base}/api/caretwin/decision`, { method: 'POST', headers: { ...patient, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ generationId: result.generationId, decision: 'approved' }) });
  assert.equal(denied.status, 403);
  const approved = await fetch(`${base}/api/caretwin/decision`, { method: 'POST', headers: { ...cc, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ generationId: result.generationId, decision: 'approved' }) });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).result.approval.status, 'approved');
  const refresh = await fetch(`${base}/api/caretwin`, { headers: cc }); assert.equal((await refresh.json()).result.approval.status, 'approved');
  assert.equal((await simulationStore.get()).tick, 0);
  const wrongOrigin = await fetch(`${base}/api/caretwin/generate`, { method: 'POST', headers: { ...cc, Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(wrongOrigin.status, 403); assert.equal((await simulationStore.get()).tick, 0);
});

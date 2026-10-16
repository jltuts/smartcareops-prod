import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';
import { createInitialSimulationState } from '../src/simulation/engine.js';
import { createSyntheticRespiratorySignals, detectRespiratoryPattern } from '../src/simulation/pattern-detector.js';
import { createPatternService } from '../src/simulation/pattern-service.js';
import { createFirestorePatternStore, createMemoryPatternStore } from '../src/simulation/pattern-store.js';
import { validatePatternInterpretation } from '../src/simulation/pattern-model.js';
import { createNotificationCenter } from '../src/notifications/service.js';
import { once } from 'node:events';

const signals = count => Array.from({ length: count }, (_, i) => ({ category: 'respiratory', regionId: 'REGION-DEMO-001', minutesAgo: i * 5 }));
const advisory = { operationalImplications: 'Increasing synthetic respiratory activity may increase short-term triage workload.',
  monitoring: 'Review aggregate demand and available staffing at the next simulated interval.',
  uncertainty: 'The signal is synthetic and does not establish a real-world event.' };

test('M18 below-threshold, threshold, concentration, and same-input detector behavior are deterministic', () => {
  const below = detectRespiratoryPattern(signals(4));
  assert.equal(below.detected, false);
  const detected = detectRespiratoryPattern(signals(8));
  assert.equal(detected.detected, true); assert.equal(detected.severity, 'warning');
  assert.equal(detected.observedCount, 8); assert.equal(detected.baselineCount, 2); assert.equal(detected.regionId, 'REGION-DEMO-001');
  assert.deepEqual(detected, detectRespiratoryPattern(signals(8)));
  const dispersed = [...signals(4), ...Array.from({ length: 4 }, (_, i) => ({ category: 'respiratory', regionId: 'REGION-DEMO-002', minutesAgo: i * 5 }))];
  assert.equal(detectRespiratoryPattern(dispersed).detected, false);
});

test('M18 ignores out-of-window and non-respiratory signals and exposes aggregate fields only', () => {
  const result = detectRespiratoryPattern([...signals(8), { category: 'other', regionId: 'REGION-DEMO-001', minutesAgo: 5 },
    { category: 'respiratory', regionId: 'REGION-DEMO-001', minutesAgo: 90 }]);
  assert.equal(result.observedCount, 8); assert.equal(result.detected, true);
  assert.deepEqual(Object.keys(result).sort(), ['baselineCount', 'concentrationCount', 'detected', 'observedCount', 'projectedEdDemandIncreasePercent', 'regionId', 'severity', 'trend', 'type', 'windowMinutes'].sort());
  assert.equal(JSON.stringify(result).match(/patient|transcript|name|uid/i), null);
  assert.deepEqual(Object.keys(createSyntheticRespiratorySignals({ tick: 18 })[0]).sort(), ['category', 'minutesAgo', 'regionId']);
});

test('M18 severity and synthetic ED demand proxy follow explicit deterministic thresholds', () => {
  assert.equal(detectRespiratoryPattern(signals(5)).severity, 'watch');
  assert.equal(detectRespiratoryPattern(signals(8)).severity, 'warning');
  assert.equal(detectRespiratoryPattern(signals(12)).severity, 'critical');
  assert.equal(detectRespiratoryPattern(signals(8)).projectedEdDemandIncreasePercent, 32);
});

test('M18 aggregate grows with M15 simulated time and returns to baseline after reset', () => {
  const initial = createInitialSimulationState({ scenario: 'normal_operations', seed: 12 });
  assert.equal(detectRespiratoryPattern(createSyntheticRespiratorySignals(initial)).observedCount, 2);
  initial.tick = 18;
  assert.equal(detectRespiratoryPattern(createSyntheticRespiratorySignals(initial)).observedCount, 8);
  initial.tick = 0;
  assert.equal(detectRespiratoryPattern(createSyntheticRespiratorySignals(initial)).detected, false);
});

test('M18 persists one alert across refresh, records acknowledgement, and clears after resolution', async () => {
  const simulation = createInitialSimulationState({ scenario: 'normal_operations', seed: 5 }); simulation.tick = 18;
  const simulationStore = { async get() { return structuredClone(simulation); } }, store = createMemoryPatternStore();
  const service = createPatternService({ simulationStore, store, interpret: async () => advisory, now: () => 1700000000000 });
  const first = await service.refresh(); assert.equal(first.alert.observedCount, 8); assert.equal(first.alert.acknowledged, false);
  const firstNotices = Object.values((await store.get()).notifications); assert.equal(firstNotices.length, 3);
  assert.deepEqual(firstNotices.map(item => item.recipientType).sort(), ['command_center', 'dispatcher', 'doctor']);
  assert(firstNotices.every(item => item.status === 'active' && item.canApprove === undefined && /possible synthetic respiratory cluster/i.test(item.messageSummary)));
  assert(firstNotices.every(item => /not a diagnosis|not a confirmed outbreak/i.test(item.messageSummary)));
  const notificationIds = firstNotices.map(item => item.notificationId).sort();
  const second = await service.refresh(); assert.equal(second.alert.alertId, first.alert.alertId);
  assert.deepEqual(Object.keys((await store.get()).notifications).sort(), notificationIds);
  simulation.tick = 30;
  const escalated = await service.refresh(); assert.equal(escalated.alert.alertId, first.alert.alertId); assert.equal(escalated.alert.severity, 'critical');
  const escalatedNotices = Object.values((await store.get()).notifications); assert.deepEqual(escalatedNotices.map(item => item.notificationId).sort(), notificationIds); assert(escalatedNotices.every(item => item.severity === 'critical'));
  assert.equal((await service.acknowledge(first.alert.alertId, 'verified-command-center-uid')).alert.acknowledged, true);
  const saved = await store.get(); assert.equal(saved.alert.acknowledgedBy, 'verified-command-center-uid'); assert.ok(saved.alert.acknowledgedAt);
  assert.equal(Object.values(saved.notifications).find(item => item.recipientType === 'command_center').status, 'acknowledged');
  assert(Object.values(saved.notifications).filter(item => item.recipientType !== 'command_center').every(item => item.status === 'active'));
  assert.equal((await service.refresh()).alert.alertId, first.alert.alertId);
  simulation.tick = 0;
  const resolved = await service.refresh(); assert.equal(resolved.alert, null); assert.equal(resolved.scan.detected, false);
  const cleared = await store.get(); assert.equal(Object.keys(cleared.notifications).length, 3); assert(Object.values(cleared.notifications).every(item => item.status === 'cleared' && item.resolvedAt));
  const center = createNotificationCenter({ sources: [{ scope: 'pattern', subjectId: 'm18-pattern-intelligence', store: { read: () => store.get() }, service: null }] });
  for (const recipientType of ['command_center', 'doctor', 'dispatcher']) {
    const view = await center.view(recipientType); assert.equal(view.notifications.length, 1); assert.equal(view.notifications[0].recipientType, recipientType); assert.equal(view.notifications[0].status, 'cleared'); assert.equal(view.notifications[0].canApprove, false);
  }
});

test('M18 alert and acknowledgement survive Firestore store recreation as aggregate-only data', async () => {
  const docs = new Map();
  const db = { collection(name) { assert.equal(name, 'simulationStates'); return { doc(id) { const key = `${name}/${id}`; return { key, async get() { const value = docs.get(key); return { exists: !!value, data: () => structuredClone(value) }; } }; } }; },
    async runTransaction(callback) { return callback({ set(ref, value) { docs.set(ref.key, structuredClone(value)); } }); }, async terminate() {} };
  const simulation = createInitialSimulationState({ scenario: 'normal_operations', seed: 9 }); simulation.tick = 18;
  const simulationStore = { async get() { return structuredClone(simulation); } };
  const store = createFirestorePatternStore(db), firstService = createPatternService({ simulationStore, store, interpret: async () => advisory, now: () => 1700000000000 });
  const first = await firstService.refresh();
  const initialPersisted = docs.get('simulationStates/m18-pattern-intelligence');
  assert.equal(Object.keys(initialPersisted.notifications).length, 3);
  assert.deepEqual(Object.values(initialPersisted.notifications).map(item => item.recipientType).sort(), ['command_center', 'dispatcher', 'doctor']);
  const restored = createPatternService({ simulationStore, store: createFirestorePatternStore(db), interpret: async () => advisory }).view;
  assert.equal((await restored()).alert.alertId, first.alert.alertId);
  await firstService.acknowledge(first.alert.alertId, 'verified-command-center-uid');
  const persisted = docs.get('simulationStates/m18-pattern-intelligence');
  assert.equal(persisted.alert.acknowledgedBy, 'verified-command-center-uid');
  assert.equal(Object.hasOwn(persisted.alert, 'transcript'), false);
  assert.equal(Object.hasOwn(persisted.alert, 'patientName'), false);
  assert.equal(JSON.stringify(persisted).match(/transcript|patientName|displayName/i), null);
});

test('M18 Gemini advisory cannot modify detection or introduce count/region/outbreak claims', async () => {
  const simulation = createInitialSimulationState({ scenario: 'normal_operations', seed: 1 }); simulation.tick = 18;
  const store = createMemoryPatternStore();
  const service = createPatternService({ simulationStore: { async get() { return structuredClone(simulation); } }, store,
    interpret: async () => ({ ...advisory, observedCount: 900, severity: 'critical' }), now: () => 1700000000000 });
  const result = await service.refresh();
  assert.equal(result.alert.observedCount, 8); assert.equal(result.alert.severity, 'warning');
  assert.equal(result.alert.interpretationStatus, 'unavailable'); assert.equal(result.alert.interpretation, null);
  assert.throws(() => validatePatternInterpretation({ ...advisory, operationalImplications: 'A confirmed outbreak is present.' }));
  assert.throws(() => validatePatternInterpretation({ ...advisory, monitoring: 'Monitor 999 sites.' }));
});

test('M18 APIs require Firebase Command Center role and exact Origin; Patient remains denied', async t => {
  const profiles = new Map([['cc', { uid: 'cc', roles: ['patient', 'command_center'], status: 'active' }], ['patient', { uid: 'patient', roles: ['patient'], status: 'active' }]]);
  const simulation = createInitialSimulationState({ scenario: 'normal_operations', seed: 4 }); simulation.tick = 18;
  const simulationStore = { async get() { return structuredClone(simulation); } }, store = createMemoryPatternStore();
  const patternService = createPatternService({ simulationStore, store, interpret: async () => advisory, now: () => 1700000000000 });
  const api = createApiServer({ caseStore: createMemoryCaseStore(), patternEnabled: true, patternStore: store, patternService,
    authOptions: { env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: '', DEV_PATIENT_UIDS: '' },
      userProfileStore: createMemoryUserProfileStore(profiles), verifyToken: async token => { if (token === 'invalid') throw new Error('bad token'); return { uid: token, firebase: { sign_in_provider: 'google.com' } }; } } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`, origin = 'http://localhost:5173';
  assert.equal((await fetch(`${base}/api/patterns`)).status, 401);
  assert.equal((await fetch(`${base}/api/patterns`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await fetch(`${base}/api/patterns`, { headers: { Authorization: 'Bearer patient' } })).status, 403);
  const deniedOrigin = await fetch(`${base}/api/patterns/refresh`, { method: 'POST', headers: { Authorization: 'Bearer cc', Origin: 'https://bad.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(deniedOrigin.status, 403);
  const headers = { Authorization: 'Bearer cc', Origin: origin, 'Content-Type': 'application/json' };
  const response = await fetch(`${base}/api/patterns/refresh`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200); const generated = await response.json(); assert.equal(generated.alert.observedCount, 8);
  assert.equal(JSON.stringify(generated).match(/patient|transcript|name|uid/i), null);
  assert.equal((await fetch(`${base}/api/patterns`, { headers: { Authorization: 'Bearer cc' } })).status, 200);
  const ack = await fetch(`${base}/api/patterns/acknowledge`, { method: 'POST', headers, body: JSON.stringify({ alertId: generated.alert.alertId }) });
  assert.equal(ack.status, 200); assert.equal((await ack.json()).alert.acknowledged, true);
  assert.equal((await fetch(`${base}/api/patterns/acknowledge`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer patient' }, body: JSON.stringify({ alertId: generated.alert.alertId }) })).status, 403);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceFixture, resourceRequests, resourceAssessment } from './resources-fixtures.js';
import { observationSet } from './clinical-fixtures.js';
import { createResourceService } from '../src/resources/service.js';
import { seedResources } from '../src/resources/fixtures.js';
import { createMapsAdapter } from '../src/resources/maps/simulation.js';
import { validateArguments, validateCatalog, validateResult, resourceTools } from '../src/resources/contracts.js';
import { validateInvestigation, createResourceInvestigator, normalizeInvestigation } from '../src/resources/investigator.js';
import { createClinicalService } from '../src/clinical/service.js';
import { policy } from '../src/clinical/contracts.js';
import { queryTool } from '../src/clinical/tools.js';
const prepared = async options => { const f = await resourceFixture(options); await f.service.append(observationSet()); await f.service.tick(); return f; };
const update = (f, requestId = 'capacityA') => f.service.changeCapacity({ requestId, hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 1 });
test('three fictional hospitals have narrow capacity, specialty and approximate location contracts', () => {
  const catalog = seedResources(); assert.equal(validateCatalog(catalog).hospitals.length, 3);
  assert.equal(catalog.patientLocation.accuracyClass, 'approximate'); assert.equal(catalog.hospitals[0].capacity.monitoredBedsAvailable, 2);
  const bad = structuredClone(catalog); bad.hospitals[0].capacity.monitoredBedsAvailable = -1; assert.throws(() => validateCatalog(bad));
});
test('capability, capacity and specialist tools return bounded facts and simulation versions', async () => {
  const f = await resourceFixture(); await f.service.enroll(); const state = await f.store.read(f.caseId);
  const call = (name, args) => queryTool(name, { ...f, state, args });
  assert.equal((await call('get_hospital_capacity', { hospitalId: 'HOSP-001' })).monitoredBedsAvailable, 2);
  assert((await call('get_hospital_capabilities', { hospitalId: 'HOSP-003' })).capabilities.includes('icu'));
  assert.equal((await call('find_available_specialists', { hospitalId: 'HOSP-001', specialty: 'pulmonology' })).available, true);
  assert.equal((await call('find_available_specialists', { hospitalId: 'HOSP-002', specialty: 'pulmonology' })).available, false);
  assert.equal((await call('get_patient_location_context', {})).source, 'simulation');
});
test('nearby hospitals filter capabilities, bound results and sort by deterministic distance', async () => {
  const f = await resourceFixture(); await f.service.enroll();
  const data = await f.resources.execute('find_nearby_hospitals', { requiredCapabilities: ['pulmonology', 'monitored_care'], maxResults: 3 }, { state: await f.store.read(f.caseId), caseStore: f.caseStore });
  assert.deepEqual(data.hospitals.map(h => h.hospitalId), ['HOSP-001', 'HOSP-003']);
  assert(data.hospitals[0].distanceMeters < data.hospitals[1].distanceMeters);
});
test('simulated routes are normalized, repeatable, source-labelled, and never reserve ambulances', async () => {
  const f = await resourceFixture(); await f.service.enroll(); const state = await f.store.read(f.caseId), before = await f.caseStore.listAmbulances();
  const args = { ambulanceUnitId: 'AMB-02', origin: 'patient', destination: 'HOSP-001' };
  const first = await f.resources.execute('calculate_ambulance_route', args, { state, caseStore: f.caseStore });
  assert.equal(first.source, 'simulation'); assert.equal(first.simulation, true); assert(first.durationSeconds > 0); assert(first.distanceMeters > 0);
  assert.deepEqual(first, await f.resources.execute('calculate_ambulance_route', args, { state, caseStore: f.caseStore }));
  assert.deepEqual(await f.caseStore.listAmbulances(), before);
});
test('typed registry rejects arbitrary coordinates, URLs, identifiers, specialties and broad query parameters', () => {
  assert.throws(() => validateArguments('get_hospital_capacity', { hospitalId: '../../cases' }));
  assert.throws(() => validateArguments('get_hospital_capacity', { hospitalId: 'HOSP-001', url: 'https://evil.test' }));
  assert.throws(() => validateArguments('find_nearby_hospitals', { requiredCapabilities: [], maxResults: 99 }));
  assert.throws(() => validateArguments('find_available_specialists', { hospitalId: 'HOSP-001', specialty: 'invented' }));
  assert.throws(() => validateArguments('calculate_ambulance_route', { ambulanceUnitId: 'AMB-99', origin: { latitude: 1 }, destination: 'HOSP-001' }));
  for (const tool of Object.values(resourceTools)) { assert.equal(tool.permissionClass, 'READ_ONLY'); assert.equal(tool.maxRetries, 0); assert(tool.timeoutMs <= 1500); }
});
test('unconfigured Google mode fails explicitly and never silently substitutes a simulated result', () => {
  assert.throws(() => createMapsAdapter('google'), { code: 'MAPS_MODE_UNAVAILABLE' });
  assert.throws(() => createResourceService({ mode: 'live' }), { code: 'RESOURCE_MODE_UNAVAILABLE' });
});
test('adapter error and malformed response never expose raw URLs, credentials or result bodies', async () => {
  const adapter = { ...createMapsAdapter(), async findNearbyHospitals() { throw new Error('SECRET https://provider.test?key=secret'); } };
  const service = createResourceService({ adapter });
  await assert.rejects(service.execute('find_nearby_hospitals', { requiredCapabilities: [], maxResults: 1 }, { state: { resourceEnvironment: seedResources() } }), error => { assert.equal(error.code, 'RESOURCE_UNAVAILABLE'); assert(!error.message.includes('SECRET')); return true; });
  assert.throws(() => validateResult('get_hospital_capacity', { hospitalId: 'HOSP-001', source: 'google_routes', simulation: false }));
});
test('investigation selection validates unknown tools, duplicate calls, bounded count and argument schema', () => {
  assert.equal(validateInvestigation({ requests: resourceRequests() }).length, 11);
  assert.throws(() => validateInvestigation({ requests: [...resourceRequests(), ...resourceRequests()] }));
  assert.throws(() => validateInvestigation({ requests: [{ toolName: 'call_any_url', arguments: {} }] }));
  assert.throws(() => validateInvestigation({ requests: [resourceRequests()[0], resourceRequests()[0]] }));
});
test('Gemini investigation errors preserve safe classifications without retries or secret persistence', async () => {
  let calls = 0;
  const investigator = createResourceInvestigator({ request: async () => { calls++; throw Object.assign(new Error('SECRET provider data'), { status: 429 }); } });
  await assert.rejects(investigator({}), error => { assert.equal(error.safeModelError.code, 'RATE_LIMIT'); assert(!JSON.stringify(error).includes('SECRET')); return true; });
  assert.equal(calls, 1);
});
test('Clinical Agent requests resources before assessment, persists normalized TOOL evidence, and auto-executes read actions', async () => {
  const f = await prepared(), data = await f.service.view(), plan = data.plans[0];
  assert.equal(data.resourceSnapshots.length, 11); assert.equal(data.runs[0].toolExecutionIds.length, 15);
  assert(plan.evidenceRefs.some(ref => ref.startsWith('TOOL-'))); assert(plan.evidenceRefs.some(ref => ref.startsWith('RESOURCE-SNAPSHOT-')));
  assert.equal(plan.resourceEvidenceVersion, 1); assert.equal(plan.recommendedActions[0].status, 'succeeded');
  assert.equal(plan.recommendedActions[0].effectiveRisk, 'READ_ONLY'); assert.equal(plan.recommendedActions[1].approvalRequired, true);
  assert.equal(data.receipts.length, 0);
});
test('capacity change is transactional/idempotent, triggers monitor, invalidates approval and preserves immutable plan', async () => {
  const f = await prepared(), before = await f.store.read(f.caseId), id = Object.keys(before.approvals)[0];
  await f.service.decide(id, 'approved'); await update(f);
  await assert.rejects(f.service.execute(id), { code: 'STALE_APPROVAL' });
  await update(f); assert.equal((await f.service.view()).resourceEnvironment.version, 2);
  await f.service.tick(); const after = await f.service.view();
  assert.equal(after.plans.length, 2); assert.equal(after.plans[0].status, 'superseded');
  assert.deepEqual((await f.store.read(f.caseId)).plans.revision_1, before.plans.revision_1);
  assert.equal(after.approvals[0].status, 'superseded'); assert.equal(after.monitoring.lastProcessedResourceVersion, 2);
  assert(after.plans[1].changeSummary.includes('zero')); assert(after.plans[1].changeSummary.includes('HOSP-003'));
  assert.equal(after.resourceSnapshots.find(s => s.runId === after.runs[1].runId && s.toolName === 'get_hospital_capacity' && s.result.hospitalId === 'HOSP-001').result.monitoredBedsAvailable, 0);
});
test('stale resource write and changed duplicate update rejected without capacity corruption', async () => {
  const f = await prepared(); await update(f);
  await assert.rejects(update(f, 'other'), { code: 'RESOURCE_VERSION_CONFLICT' });
  await assert.rejects(f.service.changeCapacity({ requestId: 'capacityA', hospitalId: 'HOSP-001', monitoredBedsAvailable: 9, expectedVersion: 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.service.view()).resourceEnvironment.hospitals[0].capacity.monitoredBedsAvailable, 0);
});
test('completed M8-style receipt does not repeat on resource-only replan or restart', async () => {
  const f = await prepared(), first = await f.service.view(), id = first.approvals[0].approvalId;
  await f.service.decide(id, 'approved'); await f.service.execute(id); await update(f);
  const restarted = createClinicalService(f); await restarted.tick(); await restarted.tick();
  const after = await restarted.view(); assert.equal(after.receipts.length, 1); assert.equal(after.plans[1].recommendedActions[1].status, 'succeeded');
});
test('capacity change during model response fences stale plan and processes latest resources', async () => {
  let release, started; const ready = new Promise(r => { started = r; });
  const f = await resourceFixture({ model: context => new Promise(resolve => { release = () => resolve(resourceAssessment(context)); started(); }) });
  await f.service.append(observationSet()); const running = f.service.tick(); await ready; await update(f); release(); await running;
  assert.equal((await f.service.view()).plans.length, 0);
  const restarted = createClinicalService({ ...f, model: async c => resourceAssessment(c) }); await restarted.tick();
  assert.equal((await restarted.view()).plans[0].resourceEvidenceVersion, 2);
});
test('current resource version is checked directly even before update event is processed', async () => {
  const f = await prepared(), data = await f.service.view(), id = data.approvals[0].approvalId; await f.service.decide(id, 'approved');
  await f.store.transaction(f.caseId, s => { s.resourceEnvironment.version = 2; s.resourceEnvironment.resourceVersion = 'm9-demo:2'; s.resourceEnvironment.hospitals[0].capacity.monitoredBedsAvailable = 0; });
  await assert.rejects(f.service.execute(id), { code: 'STALE_APPROVAL' });
  await f.service.tick(); assert.equal((await f.service.view()).plans.length, 2);
});
test('resource-tool failure leaves previous plan visible but does not authorize stale execution', async () => {
  const f = await prepared(); await f.service.requestRun('badResource');
  const broken = createClinicalService({ ...f, resources: { async execute() { throw new Error('unavailable'); } } });
  await broken.tick(); const data = await broken.view(); assert.equal(data.plans.length, 1); assert.equal(data.meta.ready, false); assert.equal(data.receipts.length, 0);
});
test('risk policy cannot be lowered or trigger writes through resource tools', () => {
  assert.deepEqual(policy('get_hospital_capacity', { hospitalId: 'HOSP-001' }), { effectiveRisk: 'READ_ONLY', approvalRequired: false });
  assert.equal(policy('simulate_clinical_review', {}).approvalRequired, true);
  assert.throws(() => policy('update_capacity', { hospitalId: 'HOSP-001' }));
});

test('resource changes between execution intent and effect block the already-approved action', async () => {
  const f = await prepared(), id = (await f.service.view()).approvals[0].approvalId;
  await f.service.decide(id, 'approved');
  const original = f.store.transaction.bind(f.store); let intercepted = false;
  f.store.transaction = async (...args) => {
    const result = await original(...args);
    if (!intercepted && typeof result === 'string' && result.startsWith('exec_')) {
      intercepted = true; await update(f);
    }
    return result;
  };
  await assert.rejects(f.service.execute(id), { code: 'STALE_APPROVAL' });
  const data = await f.service.view(); assert.equal(data.receipts.length, 0);
  assert.equal(data.executions.find(e => e.approvalId === id).status, 'pending');
});

test('normalized output rejects empty hospital IDs and duplicate fleet records', () => {
  const metadata = { resourceVersion: 'm9-demo:1', fleetEvidenceVersion: null, updatedAt: new Date().toISOString(), source: 'simulation', simulation: true };
  assert.throws(() => validateResult('get_hospital_capacity', { ...metadata, hospitalId: '', monitoredBedsAvailable: 2, emergencyBedsAvailable: 3, icuBedsAvailable: 1 }));
  assert.throws(() => validateResult('get_ambulance_availability', { ...metadata, units: Array.from({ length: 3 }, () => ({ unitId: 'AMB-01', status: 'available' })) }));
});

test('named investigation arrays normalize typed calls and reject mixed or missing tool arguments', async () => {
  const value = Object.fromEntries(Object.keys(resourceTools).map(name => [name, resourceRequests().filter(r => r.toolName === name).map(r => r.arguments)]));
  assert.equal(normalizeInvestigation(value).length, 11);
  const investigator = createResourceInvestigator({ request: async () => ({ output_text: JSON.stringify(value) }) });
  assert.equal((await investigator({})).length, 11);
  value.find_nearby_hospitals = [{ requiredCapabilities: ['pulmonology'], specialty: 'pulmonology' }];
  assert.throws(() => normalizeInvestigation(value));
  await assert.rejects(investigator({}), error => error.safeModelError.code === 'INVALID_RESPONSE');
});

test('assessment receives persisted before/after resource change and completed action observation versions', async () => {
  const contexts = [];
  const f = await prepared({ model: async context => { contexts.push(context); return resourceAssessment(context); } });
  const approval = (await f.service.view()).approvals[0]; await f.service.decide(approval.approvalId, 'approved'); await f.service.execute(approval.approvalId);
  await update(f); await f.service.tick(); const context = contexts.at(-1);
  assert.equal(context.observationVersion, 1);
  assert.equal(context.resourceChanges.length, 1);
  assert.equal(context.resourceChanges[0].hospitalId, 'HOSP-001');
  assert.equal(context.resourceChanges[0].previousMonitoredBedsAvailable, 2);
  assert.equal(context.resourceChanges[0].monitoredBedsAvailable, 0);
  assert.equal(context.completedActions.find(a => a.toolName === 'simulate_clinical_review').observationVersion, 1);
});

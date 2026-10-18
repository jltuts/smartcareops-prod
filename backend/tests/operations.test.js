import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsFixture, operationsAssessment } from './operations-fixtures.js';
import { createOperationsService } from '../src/operations/service.js';
import { createOperationsModel } from '../src/operations/model.js';
import { assessmentSchema, validateAssessment, validateOperationalAssessment } from '../src/operations/contracts.js';
import { configuredOperationsStore } from '../src/operations/storage.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
const capacity = requestId => ({ requestId, hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 });
test('hospital snapshot aggregates four cases without raw patient facts', async () => {
  const f = await operationsFixture(); await f.service.tick(); const view = await f.service.view();
  assert.deepEqual(view.currentSnapshot.counts, { active: 4, emergency: 1, respiratory: 3, incoming: 1 });
  assert.equal(view.plans.length, 1); assert.equal(view.resourceEvidence.length, 7); assert.equal(view.approvals.length, 2);
  assert.equal(view.receipts.length, 2); assert.equal(JSON.stringify(view).includes('Demo Alex'), false);
  assert.equal(view.meta.agentType, 'hospital_operations');
});
test('operations view exposes the sanitized demo boundary without making it a dependency', async () => {
  const boundary = { event: 'Routine intake recorded', projection: 'Operations projection recorded', routing: 'Kept in normal care', hospitalOperationsTriggered: false, classifiedAt: '2026-10-11T01:00:00.000Z' };
  const first = await operationsFixture({ readDemoBoundary: async () => boundary });
  assert.deepEqual((await first.service.view()).demoBoundary, boundary);
  await first.service.close();
  const second = await operationsFixture({ readDemoBoundary: async () => { throw new Error('projection unavailable'); } });
  const view = await second.service.view();
  assert.equal(view.demoBoundary, null);
  assert.equal(view.members.length, 4);
  await second.service.close();
});
test('capacity event replans, preserves immutable plan and receipts, supersedes approval', async () => {
  const f = await operationsFixture(); await f.service.tick(); const before = await f.service.view();
  await f.service.decide(before.approvals[0].approvalId, 'approved'); await f.service.execute(before.plans[0].revisionId, before.approvals[0].actionId);
  const receipts = (await f.service.view()).receipts;
  await f.service.decide(before.approvals[1].approvalId, 'approved'); await f.service.changeCapacity(capacity('zero'));
  await assert.rejects(f.service.decide(before.approvals[1].approvalId, 'approved'), { code: 'OPERATIONS_STALE_APPROVAL' });
  await assert.rejects(f.service.execute(before.plans[0].revisionId, before.approvals[1].actionId), { code: 'OPERATIONS_STALE_ACTION' });
  await f.service.tick(); const after = await f.service.view();
  assert.equal(after.plans.length, 2); assert.equal(after.plans[1].assessment.status, 'CONSTRAINED'); assert.deepEqual(after.plans[0], before.plans[0]);
  for (const receipt of receipts) assert.deepEqual(after.receipts.find(item => item.receiptId === receipt.receiptId), receipt);
  assert.equal(after.resourceEvidence.some(item => item.result.hospitalId === 'HOSP-003'), true);
});
test('fresh service and duplicate ticks never execute a completed action twice', async () => {
  const f = await operationsFixture(); await f.service.tick(); const first = await f.service.view();
  await f.service.decide(first.approvals[0].approvalId, 'approved');
  await Promise.all([f.service.execute(first.plans[0].revisionId, first.approvals[0].actionId), f.service.execute(first.plans[0].revisionId, first.approvals[0].actionId)]);
  const before = await f.service.view(), fresh = createOperationsService(f); await fresh.tick(); await fresh.tick(); const after = await fresh.view();
  assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.plans, before.plans); assert.ok(after.executions.every(item => item.attempt === 1));
});
test('high impact actions require explicit human approval', async () => {
  const f = await operationsFixture(); await f.service.tick(); const view = await f.service.view();
  await assert.rejects(f.service.execute(view.plans[0].revisionId, view.approvals[0].actionId));
  assert.equal((await f.service.view()).receipts.length, 2);
});
test('rejection cannot be revived by duplicate decision', async () => {
  const f = await operationsFixture(); await f.service.tick(); const view = await f.service.view();
  await f.service.decide(view.approvals[0].approvalId, 'rejected');
  await assert.rejects(f.service.decide(view.approvals[0].approvalId, 'approved')); await f.service.tick();
  assert.equal((await f.service.view()).receipts.length, 2);
});
test('expired approval is blocked', async () => {
  let clock = Date.now(); const f = await operationsFixture({ now: () => clock }); await f.service.tick(); const view = await f.service.view(); clock += 600001;
  await assert.rejects(f.service.decide(view.approvals[0].approvalId, 'approved')); assert.equal((await f.service.view()).receipts.length, 2);
});
test('case membership changes trigger aggregate snapshot and stale gate', async () => {
  const f = await operationsFixture(); await f.service.tick(); const first = await f.service.view();
  await f.service.enroll({ caseId: f.ids[0], status: 'closed' }); await f.service.tick(); const next = await f.service.view();
  assert.equal(next.currentSnapshot.counts.active, 3); assert.equal(next.currentSnapshot.counts.respiratory, 2); assert.equal(next.plans.length, 2); assert.deepEqual(next.plans[0], first.plans[0]);
});
test('capacity commands are idempotent, bound to hospital and reject conflicts', async () => {
  const f = await operationsFixture(); await f.service.changeCapacity(capacity('zero')); await f.service.changeCapacity(capacity('zero'));
  await assert.rejects(f.service.changeCapacity({ ...capacity('zero'), monitoredBedsAvailable: 1 }));
  await assert.rejects(f.service.changeCapacity({ ...capacity('wrong'), hospitalId: 'HOSP-003' }));
  await assert.rejects(f.service.changeCapacity(capacity('wrongVersion')));
  assert.equal((await f.service.view()).currentSnapshot.resourceVersion, 'm9-demo:3');
});
test('model failure retains prior plan and receipts but disables actions', async () => {
  let fail = false; const f = await operationsFixture({ model: async context => { if (fail) throw new Error('raw secret provider error'); return operationsAssessment(context); } });
  await f.service.tick(); const first = await f.service.view(); fail = true;
  await f.service.changeCapacity(capacity('zero')); await f.service.tick(); const after = await f.service.view();
  assert.equal(after.meta.ready, false); assert.deepEqual(after.plans, first.plans); assert.deepEqual(after.receipts, first.receipts);
  assert.equal(JSON.stringify(after).includes('raw secret'), false);
});
test('in-flight capacity change fences the obsolete assessment', async () => {
  let changed = false; const f = await operationsFixture({ model: async context => { if (!changed) { changed = true; await f.service.changeCapacity(capacity('duringModel')); } return operationsAssessment(context); } });
  await f.service.tick(); assert.equal((await f.service.view()).plans.length, 0); await f.service.tick(); assert.equal((await f.service.view()).plans.length, 1);
});
test('concurrent workers claim one model run', async () => {
  const f = await operationsFixture(), second = createOperationsService(f); await Promise.all([f.service.tick(), second.tick()]); const view = await f.service.view();
  assert.equal(view.runs.length, 1); assert.equal(view.plans.length, 1);
});
test('untrusted structured output rejects unknown fields, tools and evidence', async () => {
  const context = { snapshot: { snapshotId: 's', capacity: { monitoredBedsAvailable: 1 } }, evidenceRefs: ['s', 'r'] }, valid = operationsAssessment(context);
  assert.throws(() => validateAssessment({ ...valid, chainOfThought: 'secret' }, context.evidenceRefs));
  assert.throws(() => validateAssessment({ ...valid, recommendedActions: [{ toolName: 'dispatch_ambulance', expectedOutcome: 'send' }] }, context.evidenceRefs));
  assert.throws(() => validateAssessment({ ...valid, observations: [{ summary: 'invented', evidenceRefs: ['unknown'] }] }, context.evidenceRefs));
});
test('Gemini boundary disables storage and retries and validates output', async () => {
  const context = { snapshot: { snapshotId: 's', capacity: { monitoredBedsAvailable: 1 } }, evidenceRefs: ['s', 'r'] }; let calls = 0;
  const model = createOperationsModel({ request: async (input, options) => { calls++; assert.equal(input.store, false); assert.equal(options.maxRetries, 0); assert.equal(input.generation_config.thinking_summaries, 'none'); return { status: 'completed', output_text: JSON.stringify(operationsAssessment(context)) }; } });
  assert.equal((await model(context)).status, 'WATCH'); assert.equal(calls, 1);
});
test('Gemini boundary makes one fresh recovery attempt after an invalid assessment', async () => {
  const context = { snapshot: { snapshotId: 's', capacity: { monitoredBedsAvailable: 1 } }, evidenceRefs: ['s', 'r'] }; const requests = [];
  const model = createOperationsModel({ request: async input => {
    requests.push(input); return requests.length === 1
      ? { status: 'completed', output_text: '{"status":"WATCH"}' }
      : { status: 'completed', output_text: JSON.stringify(operationsAssessment(context)) };
  } });
  assert.equal((await model(context)).status, 'WATCH'); assert.equal(requests.length, 2);
  assert.doesNotMatch(requests[0].system_instruction, /bounded recovery attempt/);
  assert.match(requests[0].system_instruction, /no more than four recommendedActions/);
  assert.match(requests[0].system_instruction, /use each toolName at most once/);
  assert.match(requests[1].system_instruction, /bounded recovery attempt/);
  assert.match(requests[1].system_instruction, /SCHEMA_VALIDATION_FAILED/);
  assert.deepEqual(JSON.parse(requests[1].input), context);
  assert.deepEqual(requests[1].response_format.schema, requests[0].response_format.schema);
  assert.deepEqual(requests[1].response_format.schema, assessmentSchema);
});
test('Gemini request names the exact trusted alternative evidence required by validation', async () => {
  const context = { snapshot: { snapshotId: 's', capacity: { monitoredBedsAvailable: 0 } }, evidenceRefs: ['s', 'hosp3'],
    resourceInvestigation: [{ toolName: 'get_hospital_capacity', evidenceId: 'hosp3', result: { hospitalId: 'HOSP-003', monitoredBedsAvailable: 2 } }] };
  let requestInput;
  const model = createOperationsModel({ request: async input => { requestInput = input; return { status: 'completed', output_text: JSON.stringify(operationsAssessment(context)) }; } });
  await model(context);
  assert.match(requestInput.system_instruction, /exact evidence reference hosp3/);
});
test('Gemini boundary stops after one invalid-response recovery and preserves safe failure details', async () => {
  let calls = 0; const request = async () => { calls++; return { status: 'completed', output_text: '{"secret":"do-not-expose"}' }; };
  await assert.rejects(createOperationsModel({ request })({ snapshot: { capacity: { monitoredBedsAvailable: 1 } }, evidenceRefs: [] }), error =>
    error.code === 'OPERATIONS_MODEL_UNAVAILABLE' && error.safeModelError?.code === 'INVALID_RESPONSE' && error.safeModelError?.validationReason === 'SCHEMA_VALIDATION_FAILED' && !JSON.stringify(error).includes('do-not-expose'));
  assert.equal(calls, 2);
});
test('Gemini truncated output and provider failure are classified safely', async () => {
  for (const request of [async () => ({ status: 'incomplete', output_text: '{}' }), async () => { throw Object.assign(new Error('raw secret'), { status: 429 }); }]) {
    await assert.rejects(createOperationsModel({ request })({ evidenceRefs: [] }), error => error.code === 'OPERATIONS_MODEL_UNAVAILABLE' && !JSON.stringify(error).includes('raw secret'));
  }
});
test('same-evidence replan creates revision-bound approvals without duplicating completed effects', async () => {
  const f = await operationsFixture(); await f.service.tick(); const first = await f.service.view();
  await f.service.requestRun('manual_reassessment'); await f.service.tick(); const next = await f.service.view();
  assert.equal(next.plans.length, 2); assert.equal(next.currentSnapshot.snapshotVersion, first.currentSnapshot.snapshotVersion);
  const approval = next.approvals.find(item => item.planRevisionId === 'OPS-PLAN-2'); assert.equal(approval.status, 'pending');
  await f.service.decide(approval.approvalId, 'approved'); await f.service.tick(); const final = await f.service.view();
  assert.equal(final.receipts.length, first.receipts.length + 1); assert.equal(final.approvals.find(item => item.approvalId === first.approvals[0].approvalId).status, 'superseded');
});
test('finite run budget blocks further model calls and preserves the last plan', async () => {
  const f = await operationsFixture(); await f.service.tick(); const before = await f.service.view();
  await f.store.transaction('OPS-HOSP-001', state => { state.meta.runCount = 8; }); await f.service.requestRun('budget'); await f.service.tick();
  const after = await f.service.view(); assert.deepEqual(after.plans, before.plans); assert.equal(after.meta.modelCalls, before.meta.modelCalls);
  assert.equal(after.meta.ready, false); assert.equal(after.meta.lastError.code, 'OPERATIONS_BUDGET_EXHAUSTED');
});
test('explicit demo reset restores baseline and a fresh bounded budget without deleting history', async () => {
  const f = await operationsFixture(); await f.service.tick();
  await f.service.changeCapacity(capacity('zero-before-reset')); await f.service.tick();
  const before = await f.service.view();
  await f.store.transaction('OPS-HOSP-001', state => { state.meta.runCount = 8; state.meta.modelCalls = 8; state.meta.lastError = { code: 'OPERATIONS_BUDGET_EXHAUSTED' }; });
  assert.deepEqual(await f.service.resetDemo({ requestId: 'reset-demo' }), { reset: true, monitoredBedsAvailable: 2 });
  const reset = await f.service.view();
  assert.equal(reset.currentSnapshot.capacity.monitoredBedsAvailable, 2);
  assert.equal(reset.meta.runBudgetStart, 8); assert.equal(reset.meta.modelCallBudgetStart, 8); assert.equal(reset.meta.lastError, null);
  assert.equal(reset.plans.length, before.plans.length); assert.equal(reset.receipts.length, before.receipts.length);
  assert.ok(reset.approvals.filter(item => ['pending', 'approved'].includes(item.status)).length === 0);
  await f.service.changeCapacity({ requestId: 'zero-after-reset', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: Number(reset.currentSnapshot.resourceVersion.split(':')[1]) });
  await f.service.tick(); const after = await f.service.view();
  assert.equal(after.plans.length, before.plans.length + 1); assert.equal(after.currentSnapshot.capacity.monitoredBedsAvailable, 0);
});
test('explicit demo reset starts a fresh event allowance while preserving full history', async () => {
  const f = await operationsFixture({ automaticMonitoringEnabled: false });
  await f.service.tick();
  await f.store.transaction('OPS-HOSP-001', state => {
    while (Object.keys(state.events).length < 180) {
      state.meta.eventVersion = (state.meta.eventVersion || 0) + 1;
      const eventId = `legacy_${state.meta.eventVersion}`;
      state.events[eventId] = { eventId, type: 'legacy.demo.event', status: 'recorded', eventVersion: state.meta.eventVersion,
        occurredAt: new Date(0).toISOString(), subjectId: 'OPS-HOSP-001', subjectType: 'hospital', simulation: true };
    }
    state.meta.lastError = { code: 'OPERATIONS_EVENT_LIMIT' };
  });
  const before = await f.store.read('OPS-HOSP-001');
  await f.service.resetDemo({ requestId: 'event-limit-reset' });
  const reset = await f.service.view();
  assert.ok(reset.events.length > 180); assert.ok(reset.events.some(item => item.type === 'legacy.demo.event'));
  assert.equal(reset.meta.lastError, null); assert.equal(reset.meta.eventBudgetStart, before.meta.eventVersion);
  const expectedVersion = Number(reset.currentSnapshot.resourceVersion.split(':')[1]);
  await f.service.changeCapacity({ requestId: 'after-event-limit-reset', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion });
  await f.service.tick(); const after = await f.service.view();
  assert.equal(after.meta.ready, true); assert.equal(after.currentSnapshot.capacity.monitoredBedsAvailable, 0);
});
test('legacy and reset demo state receive a fresh bounded snapshot allowance', async () => {
  const f = await operationsFixture({ automaticMonitoringEnabled: false }); await f.service.tick();
  await f.store.transaction('OPS-HOSP-001', state => {
    state.meta.snapshotVersion = 20;
    delete state.meta.snapshotBudgetStart;
  });
  const migrated = await f.service.view();
  assert.equal(migrated.meta.snapshotBudgetStart, 20); assert.equal(migrated.currentSnapshot.snapshotVersion, 21);
  await f.service.changeCapacity({ requestId: 'snapshot-budget-zero', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 });
  await f.service.tick();
  await f.store.transaction('OPS-HOSP-001', state => { state.meta.snapshotBudgetStart = state.meta.snapshotVersion - 20; });
  const beforeReset = await f.store.read('OPS-HOSP-001');
  await f.service.resetDemo({ requestId: 'snapshot-limit-reset' });
  const reset = await f.service.view();
  assert.equal(reset.meta.snapshotBudgetStart, beforeReset.meta.snapshotVersion);
  assert.equal(reset.currentSnapshot.snapshotVersion, beforeReset.meta.snapshotVersion + 1);
  assert.equal(reset.currentSnapshot.capacity.monitoredBedsAvailable, 2);
  assert.ok(reset.snapshots.some(item => item.snapshotVersion === 1));
});
test('snapshot allowance rolls over automatically without clearing history', async () => {
  const f = await operationsFixture({ automaticMonitoringEnabled: false }); await f.service.tick();
  await f.store.transaction('OPS-HOSP-001', state => {
    state.meta.snapshotVersion = 20;
    state.meta.snapshotBudgetStart = 0;
  });
  const refreshed = await f.service.view();
  assert.equal(refreshed.meta.snapshotBudgetStart, 20);
  assert.equal(refreshed.currentSnapshot.snapshotVersion, 21);
  assert.ok(refreshed.snapshots.some(item => item.snapshotVersion === 1));
});
test('hosted demo can disable automatic monitoring without blocking explicit reassessment', async () => {
  let clock = Date.now();
  const f = await operationsFixture({ now: () => clock, automaticMonitoringEnabled: false });
  await f.service.tick(); const first = await f.service.view();
  clock += 600000; await f.service.tick(); const idle = await f.service.view();
  assert.equal(idle.runs.length, first.runs.length); assert.equal(idle.plans.length, first.plans.length);
  assert.equal(idle.meta.ready, true); assert.equal(idle.meta.currentRevisionId, first.meta.currentRevisionId);
  await f.service.requestRun('explicit-after-idle'); await f.service.tick(); const refreshed = await f.service.view();
  assert.equal(refreshed.runs.length, first.runs.length + 1); assert.equal(refreshed.plans.length, first.plans.length + 1);
  assert.equal(refreshed.meta.ready, true);
});
test('automatic monitoring remains available when explicitly enabled', async () => {
  let clock = Date.now(); const f = await operationsFixture({ now: () => clock, automaticMonitoringEnabled: true });
  await f.service.tick(); const first = await f.service.view();
  clock += 300001; await f.service.tick(); const monitored = await f.service.view();
  assert.equal(monitored.runs.length, first.runs.length + 1); assert.equal(monitored.plans.length, first.plans.length + 1);
});
test('zero beds requires an explicitly cited supported alternative, not retrieval alone', () => {
  const context = { snapshot: { snapshotId: 's', capacity: { monitoredBedsAvailable: 0 } }, evidenceRefs: ['s', 'r'],
    resourceInvestigation: [{ toolName: 'get_hospital_capacity', evidenceId: 'r', result: { hospitalId: 'HOSP-003', monitoredBedsAvailable: 1 } }] };
  const assessment = operationsAssessment(context); assert.doesNotThrow(() => validateOperationalAssessment(assessment, context));
  assessment.observations = assessment.observations.slice(0, 1); assert.throws(() => validateOperationalAssessment(assessment, context), { code: 'OPERATIONS_ALTERNATIVE_EVIDENCE_REQUIRED' });
});
test('production runtime opens the Operations store only through the reviewed M57 gate', async () => {
  const caseStore = createMemoryCaseStore();
  const base = { APP_ENV: 'development', NODE_ENV: 'production', CASE_STORE: 'memory' };
  assert.throws(() => configuredOperationsStore(base, caseStore), /M10 is DEV only/);
  const store = configuredOperationsStore({ ...base, M57_REVIEWED_COORDINATION_ENABLED: 'true' }, caseStore);
  assert.equal(store.storage, 'memory');
  await store.close();
});

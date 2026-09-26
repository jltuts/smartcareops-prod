import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsFixture, operationsAssessment } from './operations-fixtures.js';
import { createOperationsService } from '../src/operations/service.js';
import { createOperationsModel } from '../src/operations/model.js';
import { validateAssessment, validateOperationalAssessment } from '../src/operations/contracts.js';
const capacity = requestId => ({ requestId, hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 2 });
test('hospital snapshot aggregates four cases without raw patient facts', async () => {
  const f = await operationsFixture(); await f.service.tick(); const view = await f.service.view();
  assert.deepEqual(view.currentSnapshot.counts, { active: 4, emergency: 1, respiratory: 3, incoming: 1 });
  assert.equal(view.plans.length, 1); assert.equal(view.resourceEvidence.length, 7); assert.equal(view.approvals.length, 2);
  assert.equal(view.receipts.length, 2); assert.equal(JSON.stringify(view).includes('Demo Alex'), false);
  assert.equal(view.meta.agentType, 'hospital_operations');
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
test('zero beds requires an explicitly cited supported alternative, not retrieval alone', () => {
  const context = { snapshot: { snapshotId: 's', capacity: { monitoredBedsAvailable: 0 } }, evidenceRefs: ['s', 'r'],
    resourceInvestigation: [{ toolName: 'get_hospital_capacity', evidenceId: 'r', result: { hospitalId: 'HOSP-003', monitoredBedsAvailable: 1 } }] };
  const assessment = operationsAssessment(context); assert.doesNotThrow(() => validateOperationalAssessment(assessment, context));
  assessment.observations = assessment.observations.slice(0, 1); assert.throws(() => validateOperationalAssessment(assessment, context), { code: 'OPERATIONS_ALTERNATIVE_EVIDENCE_REQUIRED' });
});

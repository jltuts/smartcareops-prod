import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, observationSet, assessment } from './clinical-fixtures.js';
import { createClinicalService } from '../src/clinical/service.js';
import { validateAssessment, policy } from '../src/clinical/contracts.js';
import { createClinicalModel } from '../src/clinical/model.js';
import { simulateClinicalReview } from '../src/clinical/tools.js';
import { emergencyIntake } from './safety-fixtures.js';
import { newCaseId } from '../src/cases/store.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { memoryClinicalStore } from '../src/clinical/storage.js';
import { routingIntake } from './routing-fixtures.js';
import { specialtyCodes } from '../../shared/routing.js';
import { createManagedClinicalModel, managedClinicalIntegrationVersion } from '../src/agent-platform/clinical-managed-client.js';
import { createClinicalModelCutover } from '../src/agent-platform/clinical-cutover.js';

const proposal = async f => { await f.service.append(observationSet()); await f.service.tick(); return f.service.view(); };
test('event-driven intake requires a recorded Doctor case review before action approval', async () => {
  const caseId = newCaseId(), caseStore = createMemoryCaseStore({ chatSourceMarkerEnabled: true }), store = memoryClinicalStore();
  await caseStore.createCase({ caseId, intake: routingIntake(), intakeSource: 'chat_intake',
    submittedForReview: true, fictionalConfirmed: true });
  await caseStore.routeCase(caseId, { availableSpecialties: new Set(specialtyCodes) });
  const service = createClinicalService({ caseId, caseStore, store, model: async context => {
    const value = assessment(context);
    value.hypotheses[0].evidenceRefs = ['case'];
    value.recommendedActions = value.recommendedActions.filter(item => item.toolName !== 'read_fictional_patient_history');
    return value;
  },
    requireCaseReviewForActions: true });
  await service.append(observationSet()); await service.tick();
  const plan = await service.view(), approvalId = plan.approvals[0].approvalId;
  assert.equal(plan.reviewGateEnabled, true);
  await assert.rejects(service.decide(approvalId, 'approved'), { code: 'CLINICAL_REVIEW_REQUIRED' });
  await assert.rejects(service.execute(approvalId), { code: 'CLINICAL_REVIEW_REQUIRED' });
  assert.equal((await service.view()).receipts.length, 0);
  await caseStore.decideClinicalReview(caseId, { requestId: '11111111-1111-4111-8111-111111111111',
    decision: 'approved', reviewerId: 'doctor-test' });
  assert.equal((await service.decide(approvalId, 'approved')).status, 'approved');
});
test('observations and event persist together, provenance is explicit, original M2 snapshot unchanged', async () => {
  const f = await fixture(), before = await f.caseStore.getCase(f.caseId);
  await f.service.append(observationSet()); const data = await f.service.view();
  assert.equal(data.observations.length, 1); assert.equal(data.observations[0].source, 'fictional_device');
  assert.equal(data.observations[0].simulation, true); assert.equal(data.events[0].status, 'pending');
  assert.deepEqual(await f.caseStore.getCase(f.caseId), before);
});
test('same observation key is idempotent; conflicting duplicate and malformed provenance rejected', async () => {
  const f = await fixture(); await f.service.append(observationSet()); await f.service.append(observationSet());
  assert.equal((await f.service.view()).observations.length, 1);
  await assert.rejects(f.service.append(observationSet('setA', 88)), { code: 'IDEMPOTENCY_CONFLICT' });
  const input = observationSet('bad'); input.observations[0].source = 'inferred'; await assert.rejects(f.service.append(input));
  input.observations[0].source = 'fictional_device'; input.observations[0].value = null; await assert.rejects(f.service.append(input));
});
test('corrections append and preserve original, invalid cross-type correction rejected', async () => {
  const f = await fixture(); await f.service.append(observationSet());
  const input = observationSet('correction', 93); input.observations[0].correctionOf = 'obs_setA_0';
  await f.service.append(input); const state = await f.service.view(); assert.equal(state.observations.length, 2); assert.equal(state.observations[0].value, 94);
  await assert.rejects(f.service.append({ ...input, requestId: 'secondCorrection' }), { code: 'INVALID_CORRECTION' });
});
test('bounded run investigates, validates structured plan, backend overrides model risk, journals automatic reads', async () => {
  const f = await fixture(), data = await proposal(f);
  assert.equal(data.runs[0].status, 'completed'); assert.equal(data.runs[0].toolExecutionIds.length, 4);
  assert.equal(data.runs[0].model, 'gemini-api'); assert.equal(data.plans[0].assessmentSource, 'gemini-api');
  const actions = data.plans[0].recommendedActions;
  assert.equal(actions[0].effectiveRisk, 'READ_ONLY'); assert.equal(actions[0].status, 'succeeded');
  assert.equal(actions[1].effectiveRisk, 'HIGH_IMPACT'); assert.equal(actions[1].status, 'pending');
  assert.equal(data.receipts.length, 0); assert.equal(data.monitoring.status, 'active');
});
test('managed review preserves validated policy evidence through application plan validation', async () => {
  const f = await fixture(), policyRef = 'POLICY-SCO-DEMO-BOUNDARY-04-03';
  const managedModel = createManagedClinicalModel({ policyVersion: 'm60-fictional-v1', policyManifestDigest: 'a'.repeat(64),
    invokeRuntime: async input => {
      const value = assessment({ evidenceRefs: input.evidence.evidenceRefs });
      value.hypotheses[0].evidenceRefs = [policyRef];
      return { integrationVersion: managedClinicalIntegrationVersion, requestId: input.binding.requestId,
        evidenceDigest: input.binding.evidenceDigest, publishable: false, status: 'shadow_validated',
        evidenceRefs: [...input.evidence.evidenceRefs, policyRef], toolCalls: ['get_case_evidence', 'retrieve_approved_policy'], assessment: value };
    } });
  const model = createClinicalModelCutover({ currentModel: async context => assessment(context), managedModel,
    env: { M60_CLINICAL_AGENT_MODE: 'review', M60_GATE_C_ACCEPTED: 'true', M60_GATE_D_ACCEPTED: 'true', M60_REVIEW_CUTOVER_APPROVED: 'true',
      M60_SHADOW_CASE_IDS: f.caseId, M60_SHADOW_START_AT: '2026-10-16T07:00:00Z', M60_SHADOW_END_AT: '2026-10-16T08:00:00Z' },
    now: () => Date.parse('2026-10-16T07:30:00Z') });
  const service = createClinicalService({ ...f, model });
  await service.append(observationSet()); await service.tick();
  const data = await service.view();
  assert.equal(data.runs[0].status, 'completed');
  assert.equal(data.runs[0].model, 'gemini-enterprise-agent-platform');
  assert.equal(data.plans[0].assessmentSource, 'gemini-enterprise-agent-platform');
  assert.equal(data.plans[0].evidenceRefs.includes(policyRef), true);
});
test('structured assessment rejects raw reasoning, unsupported evidence, unknown tools and oversized output', () => {
  const context = { evidenceRefs: ['case', 'history', 'obs'] }, output = assessment(context);
  assert.throws(() => validateAssessment({ ...output, chainOfThought: 'private' }, context.evidenceRefs));
  output.observations[0].evidenceRefs = ['invented']; assert.throws(() => validateAssessment(output, context.evidenceRefs));
  assert.throws(() => policy('write_firestore', {})); assert.throws(() => policy('read_case', { caseId: 'other' }));
});
test('approval is bound to exact revision, action, arguments, scope and expiry; client cannot pick reviewer', async () => {
  const f = await fixture(), data = await proposal(f), approval = data.approvals[0];
  assert.equal(approval.revisionId, data.plans[0].revisionId); assert.equal(approval.caseId, f.caseId); assert.equal(approval.evidenceVersion, 1);
  await f.store.transaction(f.caseId, s => { s.approvals[approval.approvalId].argumentsDigest = 'tampered'; });
  await assert.rejects(f.service.decide(approval.approvalId, 'approved'), { code: 'STALE_APPROVAL' });
  assert.equal((await f.service.view()).receipts.length, 0);
});
test('high impact waits for approval; rejected approval never executes', async () => {
  const f = await fixture(), data = await proposal(f), id = data.approvals[0].approvalId;
  await assert.rejects(f.service.execute(id), { code: 'APPROVAL_REQUIRED' });
  await f.service.decide(id, 'rejected'); await f.service.tick();
  await assert.rejects(f.service.execute(id), { code: 'APPROVAL_REQUIRED' }); assert.equal((await f.service.view()).receipts.length, 0);
});
test('journal exists durably before effect, approved simulation executes once across restart and duplicate events', async () => {
  let f, calls = 0;
  f = await fixture({ simulate: (state, execution, now) => {
    const persisted = f.store.backing.get(f.caseId).toolExecutions[execution.executionId]; assert.equal(persisted.status, 'pending');
    calls++; return simulateClinicalReview(state, execution, now);
  } });
  const data = await proposal(f), id = data.approvals[0].approvalId;
  await f.service.decide(id, 'approved'); const result = await f.service.execute(id); assert.equal(result.status, 'succeeded');
  const restarted = createClinicalService(f); await restarted.append(observationSet()); await restarted.tick(); await restarted.execute(id);
  assert.equal(calls, 1); const after = await restarted.view(); assert.equal(after.receipts.length, 1); assert.equal(after.monitoring.status, 'active');
});
test('unknown outcome is reconciled without replay, including restart', async () => {
  let calls = 0; const f = await fixture({ simulate: () => { calls++; throw new Error('uncertain'); } });
  const data = await proposal(f), id = data.approvals[0].approvalId;
  await f.service.decide(id, 'approved'); assert.equal((await f.service.execute(id)).status, 'unknown_outcome');
  await f.service.execute(id); const restarted = createClinicalService({ ...f, simulate: () => { calls++; throw new Error(); } }); await restarted.tick();
  assert.equal(calls, 1); assert.equal((await restarted.view()).receipts.length, 0);
});
test('receipt reconciliation confirms committed result without invoking action again', async () => {
  const f = await fixture(), data = await proposal(f), id = data.approvals[0].approvalId;
  await f.service.decide(id, 'approved'); const result = await f.service.execute(id);
  await f.store.transaction(f.caseId, s => { s.toolExecutions[result.executionId].status = 'unknown_outcome'; });
  await f.service.tick(); assert.equal((await f.service.view()).executions.find(e => e.executionId === result.executionId).status, 'succeeded');
});
test('observation -> persisted event -> restart -> run safely completes', async () => {
  const f = await fixture(); await f.service.append(observationSet());
  const restarted = createClinicalService(f); await restarted.tick(); await restarted.tick();
  const data = await restarted.view(); assert.equal(data.plans.length, 1); assert.equal(data.events.find(e => e.type === 'observation.recorded').status, 'completed');
});
test('new evidence immediately blocks approved action, replan supersedes pending approvals and retains immutable revision', async () => {
  const f = await fixture(), data = await proposal(f), id = data.approvals[0].approvalId;
  const original = (await f.store.read(f.caseId)).plans.revision_1;
  await f.service.decide(id, 'approved'); await f.service.append(observationSet('setB', 88));
  await assert.rejects(f.service.execute(id), { code: 'STALE_APPROVAL' }); await f.service.tick();
  const after = await f.service.view(); assert.equal(after.plans.length, 2); assert.equal(after.plans[0].status, 'superseded');
  assert.equal(after.approvals[0].status, 'superseded'); assert.deepEqual((await f.store.read(f.caseId)).plans.revision_1, original);
});
test('completed action remains historical after v2 and is never undone', async () => {
  const f = await fixture(), data = await proposal(f), id = data.approvals[0].approvalId;
  await f.service.decide(id, 'approved'); await f.service.execute(id); await f.service.append(observationSet('setB', 88)); await f.service.tick();
  const after = await f.service.view(); assert.equal(after.receipts.length, 1); assert.equal(after.plans[0].recommendedActions[1].status, 'succeeded');
});
test('late model result cannot overwrite new observation version and the next event is processed', async () => {
  let resolve, started; const ready = new Promise(r => { started = r; });
  const f = await fixture({ model: context => new Promise(r => { resolve = () => r(assessment(context)); started(); }) });
  await f.service.append(observationSet()); const work = f.service.tick(); await ready;
  await f.service.append(observationSet('setB', 88)); resolve(); await work;
  assert.equal((await f.service.view()).plans.length, 0);
  const restarted = createClinicalService({ ...f, model: async context => assessment(context) }); await restarted.tick();
  assert.equal((await restarted.view()).plans[0].inputVersion, 2);
});
test('concurrent workers cannot claim the same event twice', async () => {
  let calls = 0; const f = await fixture({ model: async context => { calls++; return assessment(context); } });
  await f.service.append(observationSet()); await Promise.all([f.service.tick(), createClinicalService(f).tick()]);
  assert.equal(calls, 1); assert.equal((await f.service.view()).plans.length, 1);
});
test('expired run lease recovers with bounded retry; stale events cannot replace current version', async () => {
  const f = await fixture(); await f.service.append(observationSet());
  await f.store.transaction(f.caseId, s => {
    s.meta.active = { runId: 'old', claimId: 'old', leaseUntil: '2000-01-01T00:00:00.000Z' };
    s.agentRuns.old = { runId: 'old', triggerEventId: 'obs_setA', attempt: 1 }; s.events.obs_setA.status = 'processing';
  });
  await f.service.tick(); assert.equal((await f.service.view()).plans.length, 1);
  await f.service.append(observationSet('setB', 88)); await f.store.transaction(f.caseId, s => { s.events.obs_setA.status = 'pending'; });
  await f.service.tick(); assert.equal((await f.service.view()).events.find(e => e.eventId === 'obs_setA').status, 'stale');
});
test('scheduled monitoring survives restart and budgets stop unbounded replanning', async () => {
  let clock = Date.now(); const f = await fixture({ now: () => clock }); await proposal(f);
  const restarted = createClinicalService(f);
  for (let i = 0; i < 10; i++) { clock += 301000; await restarted.tick(); }
  const data = await restarted.view(); assert.equal(data.plans.length, 8); assert.equal(data.monitoring.status, 'bounded');
});
test('timer/manual replan with unchanged evidence cannot repeat a completed simulation', async () => {
  const f = await fixture(), data = await proposal(f), id = data.approvals[0].approvalId;
  await f.service.decide(id, 'approved'); await f.service.execute(id);
  await f.service.requestRun('sameEvidence'); await f.service.tick();
  const after = await f.service.view(); assert.equal(after.plans.length, 2); assert.equal(after.receipts.length, 1);
  assert.equal(after.plans[1].recommendedActions[1].status, 'succeeded'); assert.equal(after.approvals.length, 1);
});
test('expiry and revoked approval cannot execute', async () => {
  let clock = Date.now(); const f = await fixture({ now: () => clock }), data = await proposal(f), id = data.approvals[0].approvalId;
  await f.service.decide(id, 'approved'); await f.service.decide(id, 'revoked'); await assert.rejects(f.service.execute(id), { code: 'APPROVAL_REQUIRED' });
  clock += 901000; await assert.rejects(f.service.decide(id, 'approved'), { code: 'APPROVAL_EXPIRED' });
});
test('failed/malformed assessment retains last plan and gates its actions', async () => {
  const f = await fixture(); await proposal(f); await f.service.requestRun('manualRetry');
  const broken = createClinicalService({ ...f, model: async () => ({ rawThoughts: 'never persist' }) }); await broken.tick();
  const data = await broken.view(); assert.equal(data.plans.length, 1); assert.equal(data.meta.ready, false);
  assert.equal(JSON.stringify(data).includes('never persist'), false);
  await assert.rejects(broken.decide(data.approvals[0].approvalId, 'approved'), { code: 'STALE_APPROVAL' });
});
test('Gemini boundary classifies safely without raw error disclosure or fabricated output', async () => {
  for (const [status, expected] of [[429, 'RATE_LIMIT'], [503, 'SERVICE_UNAVAILABLE'], [401, 'AUTH_ERROR']]) {
    let calls = 0; const model = createClinicalModel({ request: async () => { calls++; throw Object.assign(new Error('SECRET patient payload'), { status }); } });
    await assert.rejects(model({ evidenceRefs: [] }), error => { assert.equal(error.safeModelError.code, expected); assert.equal(JSON.stringify(error).includes('SECRET'), false); return true; });
    assert.equal(calls, 1);
  }
});

test('incomplete Gemini assessment gets one bounded structured recovery; M9 thinking stays within the existing cap', async () => {
  const context = { evidenceRefs: ['case', 'history'], resourceInvestigation: [] }, output = assessment(context);
  let calls = 0;
  const model = createClinicalModel({ request: async request => {
    calls++;
    assert.deepEqual(request.generation_config, calls === 1
      ? { max_output_tokens: 4096, thinking_level: 'low', thinking_summaries: 'none' }
      : { max_output_tokens: 8192, thinking_level: 'low', thinking_summaries: 'none' });
    assert.equal(request.store, false);
    return { status: calls === 1 ? 'incomplete' : 'completed', output_text: JSON.stringify(output) };
  } });
  assert.deepEqual(await model(context), output); assert.equal(calls, 2);
  let invalidCalls = 0;
  const incomplete = createClinicalModel({ request: async () => { invalidCalls++; return { status: 'incomplete', output_text: JSON.stringify(output) }; } });
  await assert.rejects(incomplete(context), error => error.safeModelError.code === 'INVALID_RESPONSE'); assert.equal(invalidCalls, 2);
  const complete = createClinicalModel({ request: async request => {
    assert.deepEqual(request.generation_config, { max_output_tokens: 4096 });
    return { status: 'completed', output_text: JSON.stringify(output) };
  } });
  assert.deepEqual(await complete({ evidenceRefs: context.evidenceRefs }), output);
});
test('M6 emergency and M7 reservations remain authoritative and unmodified', async () => {
  const f = await fixture(), id = newCaseId(); await f.caseStore.createCase({ caseId: id, intake: emergencyIntake(), emergency: true });
  await f.caseStore.acknowledgeEmergency(id); await f.caseStore.assignAmbulance(id, 'AMB-01');
  const before = await f.caseStore.getCase(id), fleet = await f.caseStore.listAmbulances();
  const service = createClinicalService({ ...f, caseId: id }); await service.append(observationSet()); await service.tick();
  const view = await service.view(); await service.decide(view.approvals[0].approvalId, 'approved'); await service.execute(view.approvals[0].approvalId);
  assert.deepEqual(await f.caseStore.getCase(id), before); assert.deepEqual(await f.caseStore.listAmbulances(), fleet);
  assert.equal((await f.caseStore.routeCase(id)).workflowStatus, 'ambulance_assigned');
});

test('persisted Live Patient case auto-runs separate reasoning and preserves reported facts through defer and restart', async () => {
  const caseId = newCaseId(), caseStore = createMemoryCaseStore(), backing = new Map();
  await caseStore.createCase({ caseId, intake: routingIntake(), patientUid: 'patient-1', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  const before = await caseStore.getCase(caseId); let contexts = [];
  const settings = { caseId, caseStore, store: memoryClinicalStore(backing), modelName: 'test-model', model: async context => {
    contexts.push(context); const result = assessment(context);
    result.hypotheses = [{ summary: 'Dizziness could have several explanations; none is confirmed.', evidenceRefs: ['case'] }];
    return result;
  } };
  const service = createClinicalService(settings);
  const initial = await service.view(); assert.equal(initial.plans.length, 0); assert.equal(initial.patientCase.intakeSource, 'live_intake');
  await service.tick(); const analyzed = await service.view();
  assert.equal(contexts.length, 1); assert.deepEqual(contexts[0].evidenceRefs, ['case']); assert.equal(contexts[0].investigation.read_fictional_patient_history, undefined);
  assert.equal(analyzed.plans.length, 1); assert.equal(analyzed.plans[0].caseSummary.includes('Patient-reported'), true);
  assert.deepEqual((await caseStore.getCase(caseId)).reportedFacts, before.reportedFacts);
  const approval = analyzed.approvals.find(item => item.status === 'pending'); await service.decide(approval.approvalId, 'deferred');
  const restarted = createClinicalService({ ...settings, store: memoryClinicalStore(backing) }); const restored = await restarted.view();
  assert.equal(restored.approvals.find(item => item.approvalId === approval.approvalId).status, 'deferred');
  assert.equal(restored.receipts.length, 0); assert.equal((await caseStore.getCase(caseId)).handoffStatus, 'not_started');
});

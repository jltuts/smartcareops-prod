import test from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalShadowAdapter, clinicalShadowToolNames } from '../src/agent-platform/clinical-shadow.js';
import { assessment } from './clinical-fixtures.js';
import { newCaseId } from '../src/cases/store.js';

const reportId = '0db12bf8-1853-4c29-aa5a-926566f14e01';
const digest = 'a'.repeat(64);
const binding = ({ lab = false } = {}) => ({ requestId: 'm60-shadow-1', caseId: newCaseId(), evidenceVersion: 1,
  labBinding: lab ? { reportId, revision: 1, evidenceDigest: digest } : null });
const caseEvidence = input => ({ caseId: input.caseId, evidenceVersion: input.evidenceVersion, evidenceRefs: ['case', 'obs-1'],
  reportedFacts: { symptoms: [{ label: 'fictional headache', status: 'confirmed' }] }, safety: { emergency: false } });
const labEvidence = () => ({ reportId, revision: 1, evidenceDigest: digest, evidenceRef: `LAB_${reportId.replaceAll('-', '_')}_R1`,
  rows: [{ sourceIndex: 0, testName: 'Sodium', resultText: '140', numericValue: 140, unit: 'mmol/L', referenceRange: '135-145', sourceLocation: 'page 1' }] });
const validAssessment = refs => {
  const value = assessment({ evidenceRefs: refs });
  value.hypotheses[0].evidenceRefs = ['case'];
  value.recommendedActions = [{ toolName: 'read_case', expectedOutcome: 'Retain a read-only case review.', proposedRisk: 'READ_ONLY' }];
  return value;
};

test('shadow adapter exposes only the three bounded M60 tools and never publishes its result', async () => {
  const input = binding();
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence,
    invokeAgent: async ({ allowedTools, callTool }) => {
      assert.deepEqual(allowedTools, clinicalShadowToolNames);
      const evidence = await callTool('get_case_evidence', {});
      assert.equal(evidence.caseId, input.caseId);
      assert.deepEqual(await callTool('retrieve_approved_policy', { query: 'fictional review policy' }), []);
      return validAssessment(evidence.evidenceRefs);
    } });
  const result = await adapter.run(input);
  assert.equal(result.status, 'shadow_validated');
  assert.equal(result.publishable, false);
  assert.deepEqual(result.toolCalls, ['get_case_evidence', 'retrieve_approved_policy']);
});

test('verified lab is exact-bound, added to evidence, and checked again after agent completion', async () => {
  const input = binding({ lab: true }); let reads = 0;
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence,
    readVerifiedLab: async () => { reads++; return labEvidence(); },
    invokeAgent: async ({ callTool }) => {
      const evidence = await callTool('get_case_evidence');
      const lab = await callTool('get_verified_lab_revision');
      const value = validAssessment([...evidence.evidenceRefs, lab.evidenceRef]);
      value.importantFindings = [{ summary: 'Doctor-verified sodium is 140 mmol/L.', evidenceRefs: [lab.evidenceRef] }];
      return value;
    } });
  const result = await adapter.run(input);
  assert.equal(reads, 2);
  assert(result.evidenceRefs.includes(labEvidence().evidenceRef));
  assert.equal(result.assessment.recommendedActions.length, 1);
});

test('changed verified-lab binding rejects the late shadow result', async () => {
  const input = binding({ lab: true }); let reads = 0;
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence,
    readVerifiedLab: async () => reads++ ? { ...labEvidence(), revision: 2, evidenceDigest: 'b'.repeat(64) } : labEvidence(),
    invokeAgent: async ({ callTool }) => {
      const evidence = await callTool('get_case_evidence'); const lab = await callTool('get_verified_lab_revision');
      return validAssessment([...evidence.evidenceRefs, lab.evidenceRef]);
    } });
  await assert.rejects(adapter.run(input), error => error.code === 'CLINICAL_SHADOW_LAB_STALE');
});

test('cross-case arguments, unknown tools, and missing required evidence calls fail closed', async () => {
  const input = binding();
  for (const invokeAgent of [
    async ({ callTool }) => callTool('get_case_evidence', { caseId: newCaseId() }),
    async ({ callTool }) => callTool('notify_doctor', {}),
    async () => validAssessment(['case']),
  ]) {
    const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence, invokeAgent });
    await assert.rejects(adapter.run(input));
  }
});

test('shadow output rejects effect proposals and tool-call loops', async () => {
  const input = binding();
  const effectAdapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence,
    invokeAgent: async ({ callTool }) => {
      const evidence = await callTool('get_case_evidence');
      const value = validAssessment(evidence.evidenceRefs);
      value.recommendedActions = [{ toolName: 'simulate_clinical_review', expectedOutcome: 'Create a receipt.', proposedRisk: 'HIGH_IMPACT' }];
      return value;
    } });
  await assert.rejects(effectAdapter.run(input), error => error.code === 'CLINICAL_SHADOW_ACTION_NOT_ALLOWED');

  const loopAdapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence,
    invokeAgent: async ({ callTool }) => { await callTool('get_case_evidence'); return callTool('get_case_evidence'); } });
  await assert.rejects(loopAdapter.run(input), error => error.code === 'CLINICAL_SHADOW_TOOL_LIMIT');
});

test('invented evidence and private reasoning are rejected by the existing clinical validator', async () => {
  const input = binding();
  for (const mutate of [
    value => { value.observations[0].evidenceRefs = ['invented']; },
    value => { value.chainOfThought = 'private'; },
  ]) {
    const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence,
      invokeAgent: async ({ callTool }) => { const evidence = await callTool('get_case_evidence'); const value = validAssessment(evidence.evidenceRefs); mutate(value); return value; } });
    await assert.rejects(adapter.run(input));
  }
});

test('timeout returns a safe category without exposing the provider message', async () => {
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence, timeoutMs: 5,
    invokeAgent: async () => new Promise(() => {}) });
  await assert.rejects(adapter.run(binding()), error => {
    assert.equal(error.code, 'CLINICAL_SHADOW_TIMEOUT');
    assert.equal(JSON.stringify(error).includes('SECRET'), false);
    return true;
  });
});

test('duplicate request IDs reuse one validated shadow result and reject a changed binding', async () => {
  const input = binding(); let invocations = 0;
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence,
    invokeAgent: async ({ callTool }) => { invocations++; const evidence = await callTool('get_case_evidence'); return validAssessment(evidence.evidenceRefs); } });
  const [first, duplicate] = await Promise.all([adapter.run(input), adapter.run(input)]);
  assert.deepEqual(duplicate, first); assert.equal(invocations, 1);
  await assert.rejects(adapter.run({ ...input, evidenceVersion: 2 }), error => error.code === 'CLINICAL_SHADOW_IDEMPOTENCY_CONFLICT');
  assert.equal(invocations, 1);
});

test('policy passages must match the active bound corpus version', async () => {
  const input = { ...binding(), policyVersion: 'fictional-policy-v1' };
  const passage = { evidenceRef: 'POLICY-fictional-1', documentId: 'fictional-procedure', version: 'fictional-policy-v2', section: '1',
    contentDigest: 'b'.repeat(64), passage: 'Fictional procedural guidance for evaluation only.' };
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: caseEvidence, readVerifiedLab: labEvidence,
    retrievePolicy: async () => [passage],
    invokeAgent: async ({ callTool }) => { await callTool('get_case_evidence'); await callTool('retrieve_approved_policy', { query: 'fictional procedure' }); } });
  await assert.rejects(adapter.run(input), error => error.code === 'CLINICAL_SHADOW_POLICY_STALE');
});

test('shadow telemetry contains only bounded metadata and safe error categories', async () => {
  const telemetry = [], input = binding();
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: async request => ({ ...caseEvidence(request), reportedFacts: { notes: 'FICTIONAL_PATIENT_SECRET' } }),
    readVerifiedLab: labEvidence, recordTelemetry: async event => telemetry.push(event),
    invokeAgent: async ({ callTool }) => { await callTool('get_case_evidence'); throw new Error('PROVIDER_SECRET'); } });
  await assert.rejects(adapter.run(input), error => error.code === 'CLINICAL_SHADOW_UNAVAILABLE');
  assert.equal(telemetry.length, 1);
  assert.deepEqual(Object.keys(telemetry[0]).sort(), ['caseId', 'durationMs', 'errorCode', 'requestId', 'status', 'toolNames'].sort());
  assert.equal(JSON.stringify(telemetry).includes('FICTIONAL_PATIENT_SECRET'), false);
  assert.equal(JSON.stringify(telemetry).includes('PROVIDER_SECRET'), false);
});

test('unavailable evidence tools fail safely without substituting facts', async () => {
  const adapter = createClinicalShadowAdapter({ readCaseEvidence: async () => { throw new Error('FICTIONAL_TOOL_PAYLOAD'); }, readVerifiedLab: labEvidence,
    invokeAgent: async ({ callTool }) => callTool('get_case_evidence') });
  await assert.rejects(adapter.run(binding()), error => {
    assert.equal(error.code, 'CLINICAL_SHADOW_UNAVAILABLE');
    assert.equal(JSON.stringify(error).includes('FICTIONAL_TOOL_PAYLOAD'), false);
    return true;
  });
});

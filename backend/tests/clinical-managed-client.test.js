import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredManagedClinicalModel, createManagedClinicalModel, createMetadataAccessTokenProvider, managedClinicalAssessmentEvidenceRefs,
  createReasoningEngineInvoker, managedClinicalIntegrationVersion } from '../src/agent-platform/clinical-managed-client.js';
import { assessment } from './clinical-fixtures.js';
import { newCaseId } from '../src/cases/store.js';

const manifest = 'a'.repeat(64);
const context = () => ({ caseId: newCaseId(), observationVersion: 2, evidenceRefs: ['case', 'obs-1'],
  investigation: { read_case: { symptoms: ['fictional headache'] } } });
const validAssessment = refs => {
  const value = assessment({ evidenceRefs: refs });
  value.hypotheses[0].evidenceRefs = ['case'];
  value.recommendedActions = [{ toolName: 'read_case', expectedOutcome: 'Retain read-only review.', proposedRisk: 'READ_ONLY' }];
  return value;
};

test('off mode constructs no managed client and cannot call the runtime', () => {
  let calls = 0;
  assert.equal(createConfiguredManagedClinicalModel({ M60_CLINICAL_AGENT_MODE: 'off' }, { invokeRuntime: async () => { calls++; } }), undefined);
  assert.equal(calls, 0);
});

test('managed client binds authorized evidence and validates a non-publishing response', async () => {
  const input = context(); let captured;
  const model = createManagedClinicalModel({ policyVersion: 'm60-fictional-v1', policyManifestDigest: manifest,
    invokeRuntime: async value => {
      captured = value;
      return { integrationVersion: managedClinicalIntegrationVersion, requestId: value.binding.requestId,
        evidenceDigest: value.binding.evidenceDigest, publishable: false, status: 'shadow_validated',
        evidenceRefs: ['case', 'obs-1', 'POLICY-SCO-DEMO-BOUNDARY-04-03'], toolCalls: ['get_case_evidence', 'retrieve_approved_policy'],
        assessment: validAssessment(['case', 'obs-1', 'POLICY-SCO-DEMO-BOUNDARY-04-03']) };
    } });
  const result = await model(input, AbortSignal.timeout(100));
  assert.equal(result.caseSummary.length > 0, true);
  assert.equal(captured.binding.caseId, input.caseId);
  assert.equal(captured.binding.evidenceVersion, 2);
  assert.equal(captured.binding.policyVersion, 'm60-fictional-v1');
  assert.equal(captured.evidence.context.investigation.read_case.symptoms[0], 'fictional headache');
  assert.deepEqual(managedClinicalAssessmentEvidenceRefs(result), ['case', 'obs-1', 'POLICY-SCO-DEMO-BOUNDARY-04-03']);
});

test('managed client rejects invented citations, changed digests, and unsafe publication state', async () => {
  for (const mutate of [
    output => { output.evidenceDigest = 'b'.repeat(64); },
    output => { output.publishable = true; },
    output => { output.assessment.observations[0].evidenceRefs = ['invented']; },
  ]) {
    const model = createManagedClinicalModel({ policyVersion: 'm60-fictional-v1', policyManifestDigest: manifest,
      invokeRuntime: async value => {
        const output = { integrationVersion: managedClinicalIntegrationVersion, requestId: value.binding.requestId,
          evidenceDigest: value.binding.evidenceDigest, publishable: false, status: 'shadow_validated', evidenceRefs: [...value.evidence.evidenceRefs], toolCalls: ['get_case_evidence'],
          assessment: validAssessment(value.evidence.evidenceRefs) };
        mutate(output); return output;
      } });
    await assert.rejects(model(context(), AbortSignal.timeout(100)));
  }
});

test('managed client rejects a runtime-invented policy reference even when the assessment cites it consistently', async () => {
  const model = createManagedClinicalModel({ policyVersion: 'm60-fictional-v1', policyManifestDigest: manifest,
    invokeRuntime: async value => ({ integrationVersion: managedClinicalIntegrationVersion, requestId: value.binding.requestId,
      evidenceDigest: value.binding.evidenceDigest, publishable: false, status: 'shadow_validated',
      evidenceRefs: [...value.evidence.evidenceRefs, 'POLICY-INVENTED-01'], toolCalls: ['get_case_evidence', 'retrieve_approved_policy'],
      assessment: validAssessment([...value.evidence.evidenceRefs, 'POLICY-INVENTED-01']) }) });
  await assert.rejects(model(context(), AbortSignal.timeout(100)), error => error.code === 'M60_MANAGED_EVIDENCE_INVALID');
});

test('reasoning-engine transport uses the exact managed endpoint and envelope', async () => {
  let call;
  const invoke = createReasoningEngineInvoker({ projectId: 'demo-project', location: 'asia-southeast1', engineId: '12345',
    accessToken: async () => 'token-token-token-token-token', request: async (url, options) => {
      call = { url, options }; return { ok: true, json: async () => ({ output: { ok: true } }) };
    } });
  assert.deepEqual(await invoke({ hello: 'world' }, AbortSignal.timeout(100)), { ok: true });
  assert.equal(call.url.endsWith('/reasoningEngines/12345:query'), true);
  assert.deepEqual(JSON.parse(call.options.body), { class_method: 'query_application_shadow', input: { hello: 'world' } });
});

test('metadata token provider caches only bounded token metadata', async () => {
  let calls = 0, current = 1_000_000;
  const provider = createMetadataAccessTokenProvider({ now: () => current, request: async () => {
    calls++; return { ok: true, json: async () => ({ access_token: 'token-token-token-token-token', expires_in: 300 }) };
  } });
  assert.equal(await provider(), 'token-token-token-token-token');
  assert.equal(await provider(), 'token-token-token-token-token');
  assert.equal(calls, 1);
  current += 250_000;
  assert.equal(await provider(), 'token-token-token-token-token');
  assert.equal(calls, 2);
});

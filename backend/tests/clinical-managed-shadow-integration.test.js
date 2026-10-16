import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedClinicalModel } from '../src/agent-platform/clinical-managed-client.js';
import { createClinicalModelCutover } from '../src/agent-platform/clinical-cutover.js';
import { createManagedApplicationService } from '../../agent-runtime/clinical-shadow/application-service.js';
import { validAssessment } from '../../agent-runtime/clinical-shadow/tests/fixtures.js';
import { newCaseId } from '../src/cases/store.js';

const policyVersion = 'm60-fictional-v1';
const policyManifestDigest = 'a'.repeat(64);
const context = () => ({ caseId: newCaseId(), observationVersion: 1, evidenceRefs: ['case'],
  investigation: { read_case: { reportedSymptoms: ['fictional headache'] } } });
const shadowEnvironment = caseId => ({ M60_CLINICAL_AGENT_MODE: 'shadow', M60_GATE_C_ACCEPTED: 'true', M60_GATE_D_ACCEPTED: 'true',
  M60_SHADOW_CASE_IDS: caseId, M60_SHADOW_START_AT: '2026-10-16T00:00:00Z', M60_SHADOW_END_AT: '2026-10-16T01:00:00Z' });
const invokeAgent = async ({ binding, callTool }) => {
  const evidence = await callTool('get_case_evidence', {});
  const refs = [...evidence.evidenceRefs];
  if (binding.policyVersion) refs.push(...(await callTool('retrieve_approved_policy', { query: 'human review' })).map(item => item.evidenceRef));
  return validAssessment(refs);
};
const policy = [{ evidenceRef: 'POLICY-SCO-DEMO-BOUNDARY-04-03', documentId: 'SCO-DEMO-BOUNDARY-04', version: policyVersion, section: 'Human review',
  contentDigest: 'b'.repeat(64), passage: 'Doctor review remains authoritative.' }];

test('application shadow validates managed output but returns only the current clinical result', async () => {
  const input = context();
  const service = createManagedApplicationService({ invokeAgent, retrievePolicy: async () => policy });
  const managedModel = createManagedClinicalModel({ policyVersion, policyManifestDigest, invokeRuntime: input => service.query(input) });
  const telemetry = [];
  const selected = createClinicalModelCutover({ currentModel: async () => ({ source: 'current' }), managedModel,
    env: shadowEnvironment(input.caseId), now: () => Date.parse('2026-10-16T00:30:00Z'), recordTelemetry: async event => telemetry.push(event) });
  assert.deepEqual(await selected(input, AbortSignal.timeout(1000)), { source: 'current' });
  assert.deepEqual(telemetry, [{ mode: 'shadow', status: 'shadow_validated', caseId: input.caseId, durationMs: 0 }]);
});

test('application shadow preserves the current result for every managed boundary failure', async () => {
  const failures = [
    async () => { throw new Error('provider unavailable'); },
    async input => ({ integrationVersion: 'wrong', requestId: input.binding.requestId }),
    async input => ({ integrationVersion: input.integrationVersion, requestId: input.binding.requestId,
      evidenceDigest: input.binding.evidenceDigest, publishable: true, status: 'shadow_validated', evidenceRefs: [...input.evidence.evidenceRefs], toolCalls: ['get_case_evidence'],
      assessment: validAssessment(input.evidence.evidenceRefs) }),
    async input => { const value = validAssessment(input.evidence.evidenceRefs); value.observations[0].evidenceRefs = ['invented'];
      return { integrationVersion: input.integrationVersion, requestId: input.binding.requestId,
        evidenceDigest: input.binding.evidenceDigest, publishable: false, status: 'shadow_validated', evidenceRefs: [...input.evidence.evidenceRefs], toolCalls: ['get_case_evidence'], assessment: value }; },
  ];
  for (const invokeRuntime of failures) {
    const input = context();
    const managedModel = createManagedClinicalModel({ policyVersion, policyManifestDigest, invokeRuntime });
    const selected = createClinicalModelCutover({ currentModel: async () => 'current-authoritative', managedModel,
      env: shadowEnvironment(input.caseId), now: () => Date.parse('2026-10-16T00:30:00Z') });
    assert.equal(await selected(input, AbortSignal.timeout(1000)), 'current-authoritative');
  }
});

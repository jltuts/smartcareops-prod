import test from 'node:test';
import assert from 'node:assert/strict';
import { clinicalAgentMode, clinicalAssessmentSource, clinicalShadowCohort, createClinicalModelCutover } from '../src/agent-platform/clinical-cutover.js';

const caseId = 'SC-00000000-0000-4000-8000-000000000001';
const shadowEnv = { M60_CLINICAL_AGENT_MODE: 'shadow', M60_GATE_C_ACCEPTED: 'true', M60_GATE_D_ACCEPTED: 'true',
  M60_SHADOW_CASE_IDS: caseId, M60_SHADOW_START_AT: '2026-10-16T00:00:00Z', M60_SHADOW_END_AT: '2026-10-16T01:00:00Z' };

test('cutover defaults off and leaves the current clinical model authoritative', async () => {
  let managedCalls = 0;
  const model = createClinicalModelCutover({ env: {}, currentModel: async () => 'current', managedModel: async () => { managedCalls++; return 'managed'; } });
  assert.equal(await model({}, AbortSignal.timeout(100)), 'current');
  assert.equal(managedCalls, 0);
});

test('shadow mode requires Gate C and always returns the current result', async () => {
  assert.throws(() => clinicalAgentMode({ M60_CLINICAL_AGENT_MODE: 'shadow' }), error => error.code === 'M60_SHADOW_GATES_REQUIRED');
  const telemetry = []; let clock = Date.parse('2026-10-16T00:30:00Z');
  const model = createClinicalModelCutover({ env: shadowEnv, now: () => clock,
    currentModel: async () => 'current', managedModel: async () => 'managed', recordTelemetry: async event => telemetry.push(event) });
  assert.equal(await model({ caseId }, AbortSignal.timeout(100)), 'current');
  assert.deepEqual(telemetry, [{ mode: 'shadow', status: 'shadow_validated', caseId, durationMs: 0 }]);
});

test('shadow cohort is exact, time bounded, and makes no managed call outside the boundary', async () => {
  assert.deepEqual([...clinicalShadowCohort(shadowEnv).caseIds], [caseId]);
  for (const env of [
    { ...shadowEnv, M60_SHADOW_CASE_IDS: '' },
    { ...shadowEnv, M60_SHADOW_CASE_IDS: 'SC-invalid' },
    { ...shadowEnv, M60_SHADOW_END_AT: '2026-10-18T00:00:00Z' },
  ]) assert.throws(() => clinicalShadowCohort(env));
  let managedCalls = 0;
  for (const [candidate, clock] of [
    ['SC-00000000-0000-4000-8000-000000000002', Date.parse('2026-10-16T00:30:00Z')],
    [caseId, Date.parse('2026-10-15T23:59:59Z')],
    [caseId, Date.parse('2026-10-16T01:00:00Z')],
  ]) {
    const model = createClinicalModelCutover({ env: shadowEnv, now: () => clock, currentModel: async () => 'current',
      managedModel: async () => { managedCalls++; return 'managed'; } });
    assert.equal(await model({ caseId: candidate }, AbortSignal.timeout(100)), 'current');
  }
  assert.equal(managedCalls, 0);
});

test('review mode requires accepted governance and explicit cutover approval', async () => {
  const incomplete = { M60_CLINICAL_AGENT_MODE: 'review', M60_GATE_C_ACCEPTED: 'true', M60_GATE_D_ACCEPTED: 'true' };
  assert.throws(() => clinicalAgentMode(incomplete), error => error.code === 'M60_REVIEW_CUTOVER_NOT_APPROVED');
  const env = { ...shadowEnv, ...incomplete, M60_REVIEW_CUTOVER_APPROVED: 'true' };
  const selected = createClinicalModelCutover({ env, now: () => Date.parse('2026-10-16T00:30:00Z'), currentModel: async () => 'current', managedModel: async () => 'managed' });
  assert.equal(await selected({ caseId }, AbortSignal.timeout(100)), 'managed');
});

test('review mode is exact and time bounded, and identifies the selected managed source', async () => {
  const env = { ...shadowEnv, M60_CLINICAL_AGENT_MODE: 'review', M60_REVIEW_CUTOVER_APPROVED: 'true' };
  let managedCalls = 0;
  const managedAssessment = {}, currentAssessment = {};
  const selected = createClinicalModelCutover({ env, now: () => Date.parse('2026-10-16T00:30:00Z'),
    currentModel: async () => currentAssessment, managedModel: async () => { managedCalls++; return managedAssessment; } });
  assert.equal(await selected({ caseId }, AbortSignal.timeout(100)), managedAssessment);
  assert.equal(clinicalAssessmentSource(managedAssessment), 'gemini-enterprise-agent-platform');
  const outside = await selected({ caseId: 'SC-00000000-0000-4000-8000-000000000002' }, AbortSignal.timeout(100));
  assert.equal(outside, currentAssessment);
  assert.equal(clinicalAssessmentSource(outside), 'gemini-api');
  assert.equal(managedCalls, 1);
});

test('review mode rolls back to the current model on managed failure without exposing the error', async () => {
  const telemetry = [];
  const env = { ...shadowEnv, M60_CLINICAL_AGENT_MODE: 'review', M60_REVIEW_CUTOVER_APPROVED: 'true' };
  const current = {};
  const fallback = createClinicalModelCutover({ env, currentModel: async () => current, managedModel: async () => { throw new Error('PRIVATE_PROVIDER_TEXT'); },
    now: () => Date.parse('2026-10-16T00:30:00Z'), recordTelemetry: async event => telemetry.push(event) });
  assert.equal(await fallback({ caseId }, AbortSignal.timeout(100)), current);
  assert.equal(clinicalAssessmentSource(current), 'gemini-api-fallback');
  assert.equal(JSON.stringify(telemetry).includes('PRIVATE_PROVIDER_TEXT'), false);
  assert.deepEqual(telemetry, [{ mode: 'review', status: 'rollback_current', caseId, durationMs: 0 }]);
});

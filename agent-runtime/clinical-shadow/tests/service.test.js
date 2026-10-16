import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedClinicalShadowService, managedEvaluationVersion } from '../service.js';
import { managedFixtureIds } from '../fixtures.js';
import { boundedAgent } from './fixtures.js';

const input = (fixtureId = 'ordinary-routed-case', requestId = `managed-${fixtureId}`) => ({ fixtureId, requestId, evaluationVersion: managedEvaluationVersion });

test('managed service exposes only the seven fixed fictional fixtures and never publishes', async () => {
  const telemetry = [];
  const service = createManagedClinicalShadowService({ invokeAgent: boundedAgent, recordTelemetry: async event => telemetry.push(event) });
  for (const fixtureId of managedFixtureIds) {
    const result = await service.query(input(fixtureId));
    assert.equal(result.fixtureId, fixtureId);
    assert.equal(result.status, 'shadow_validated');
    assert.equal(result.publishable, false);
    assert(result.toolCalls.includes('get_case_evidence'));
    assert(result.toolCalls.every(name => ['get_case_evidence', 'get_verified_lab_revision', 'retrieve_approved_policy'].includes(name)));
  }
  assert.equal(telemetry.length, managedFixtureIds.length);
  assert(telemetry.every(event => !Object.hasOwn(event, 'caseId') && !Object.hasOwn(event, 'assessment')));
});

test('managed service rejects arbitrary evidence, identifiers, versions, and unknown fixtures before agent invocation', async () => {
  let invocations = 0;
  const service = createManagedClinicalShadowService({ invokeAgent: async value => { invocations++; return boundedAgent(value); } });
  for (const value of [
    { ...input(), caseId: 'SC-00000000-0000-4000-8000-000000000099' },
    { ...input(), patientText: 'arbitrary' },
    { ...input(), fixtureId: 'not-allowlisted' },
    { ...input(), evaluationVersion: 'future-version' },
    { ...input(), requestId: 'not allowed spaces' },
  ]) await assert.rejects(service.query(value), error => error.code === (value.fixtureId === 'not-allowlisted' ? 'MANAGED_SHADOW_FIXTURE_NOT_ALLOWED' : 'INVALID_MANAGED_SHADOW_REQUEST'));
  assert.equal(invocations, 0);
});

test('managed service reuses duplicate results and rejects a request ID bound to another fixture', async () => {
  let invocations = 0;
  const service = createManagedClinicalShadowService({ invokeAgent: async value => { invocations++; return boundedAgent(value); } });
  const first = await service.query(input('ordinary-routed-case', 'managed-duplicate'));
  const duplicate = await service.query(input('ordinary-routed-case', 'managed-duplicate'));
  assert.deepEqual(duplicate, first);
  assert.equal(invocations, 1);
  await assert.rejects(service.query(input('doctor-verified-lab', 'managed-duplicate')), error => error.code === 'MANAGED_SHADOW_IDEMPOTENCY_CONFLICT');
  assert.equal(invocations, 1);
});

test('managed service returns only a safe category when the agent fails', async () => {
  const telemetry = [];
  const service = createManagedClinicalShadowService({ invokeAgent: async ({ callTool }) => {
    await callTool('get_case_evidence', {});
    const error = new Error('FICTIONAL_PATIENT_TEXT SECRET_API_KEY'); error.status = 429; throw error;
  }, recordTelemetry: async event => telemetry.push(event) });
  await assert.rejects(service.query(input()), error => {
    assert.equal(error.code, 'CLINICAL_SHADOW_UNAVAILABLE');
    assert.equal(JSON.stringify(error).includes('FICTIONAL_PATIENT_TEXT'), false);
    return true;
  });
  assert.equal(JSON.stringify(telemetry).includes('FICTIONAL_PATIENT_TEXT'), false);
  assert.equal(JSON.stringify(telemetry).includes('SECRET_API_KEY'), false);
});

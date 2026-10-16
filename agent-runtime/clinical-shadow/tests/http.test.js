import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createManagedShadowHttpHandler } from '../http.js';
import { createManagedClinicalShadowService, managedEvaluationVersion } from '../service.js';
import { boundedAgent } from './fixtures.js';
import { createManagedApplicationService, managedApplicationVersion } from '../application-service.js';
import { canonicalDigest } from '../../../backend/src/clinical/contracts.js';

async function withServer(run, logger = { error() {} }) {
  const service = createManagedClinicalShadowService({ invokeAgent: boundedAgent });
  const applicationService = createManagedApplicationService({ invokeAgent: boundedAgent, retrievePolicy: async () => [] });
  const server = createServer(createManagedShadowHttpHandler({ service, applicationService, logger }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); await once(server, 'close'); }
}
const input = { fixtureId: 'ordinary-routed-case', requestId: 'managed-http-1', evaluationVersion: managedEvaluationVersion };

test('runtime health and unary query follow the managed container contract', async () => withServer(async base => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'smartcareops-clinical-shadow-runtime' });
  const response = await fetch(`${base}/api/reasoning_engine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ class_method: 'query', input }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.output.publishable, false);
  assert.equal(result.output.fixtureId, input.fixtureId);
}));

test('runtime stream query returns one bounded NDJSON record', async () => withServer(async base => {
  const response = await fetch(`${base}/api/stream_reasoning_engine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ class_method: 'stream_query', input: { ...input, requestId: 'managed-stream-1' } }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  const body = await response.text();
  assert.equal(body.endsWith('\n'), true);
  assert.equal(JSON.parse(body.trim()).output.publishable, false);
}));

test('application shadow uses its separate class method and remains non-publishing', async () => withServer(async base => {
  const evidence = { caseId: 'SC-00000000-0000-4000-8000-000000000001', evidenceVersion: 1, evidenceRefs: ['case'],
    context: { caseId: 'SC-00000000-0000-4000-8000-000000000001', observationVersion: 1, evidenceRefs: ['case'] } };
  const binding = { caseId: evidence.caseId, evidenceVersion: 1, evidenceDigest: canonicalDigest(evidence), labBinding: null,
    policyVersion: 'm60-fictional-v1', policyManifestDigest: 'a'.repeat(64) };
  binding.requestId = `m60_${canonicalDigest(binding).slice(0, 48)}`;
  const applicationInput = { integrationVersion: managedApplicationVersion, binding, evidence };
  const response = await fetch(`${base}/api/reasoning_engine`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ class_method: 'query_application_shadow', input: applicationInput }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.output.publishable, false);
  assert.equal(result.output.integrationVersion, managedApplicationVersion);
}));

test('runtime rejects unsupported envelopes and logs no submitted content', async () => {
  const logs = [];
  await withServer(async base => {
    const response = await fetch(`${base}/api/reasoning_engine`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ class_method: 'query', input: { ...input, patientText: 'FICTIONAL_PRIVATE_TEXT' } }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_MANAGED_SHADOW_REQUEST', message: 'Managed fictional shadow evaluation unavailable.' } });
  }, { error: value => logs.push(value) });
  assert.equal(JSON.stringify(logs).includes('FICTIONAL_PRIVATE_TEXT'), false);
});

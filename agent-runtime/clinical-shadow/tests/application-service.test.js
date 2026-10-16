import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedApplicationService, managedApplicationVersion } from '../application-service.js';
import { canonicalDigest } from '../../../backend/src/clinical/contracts.js';
import { boundedAgent } from './fixtures.js';

const caseId = 'SC-00000000-0000-4000-8000-000000000001';
const policy = [{ evidenceRef: 'POLICY-DEMO-01', documentId: 'DEMO', version: 'm60-fictional-v1', section: 'Boundary',
  contentDigest: 'b'.repeat(64), passage: 'Fictional policy guidance for human review.' }];
const request = () => {
  const evidence = { caseId, evidenceVersion: 1, evidenceRefs: ['case'], context: { caseId, observationVersion: 1,
    evidenceRefs: ['case'], investigation: { read_case: { reportedSymptoms: ['fictional headache'] } } } };
  const binding = { caseId, evidenceVersion: 1, evidenceDigest: canonicalDigest(evidence), labBinding: null,
    policyVersion: 'm60-fictional-v1', policyManifestDigest: 'a'.repeat(64) };
  binding.requestId = `m60_${canonicalDigest(binding).slice(0, 48)}`;
  return { integrationVersion: managedApplicationVersion, binding, evidence };
};

test('application service reads only the immutable bound evidence and never publishes', async () => {
  const service = createManagedApplicationService({ retrievePolicy: async () => policy, invokeAgent: boundedAgent });
  const result = await service.query(request());
  assert.equal(result.publishable, false);
  assert.equal(result.evidenceDigest, request().binding.evidenceDigest);
  assert(result.evidenceRefs.includes('POLICY-DEMO-01'));
});

test('application service rejects changed evidence, unbound lab data, and a stale policy version', async () => {
  const base = request();
  const service = createManagedApplicationService({ retrievePolicy: async () => policy, invokeAgent: boundedAgent });
  await assert.rejects(service.query({ ...base, evidence: { ...base.evidence, evidenceVersion: 2 } }), error => error.code === 'MANAGED_APPLICATION_EVIDENCE_INVALID');
  await assert.rejects(service.query({ ...base, binding: { ...base.binding, labBinding: { reportId: 'x', revision: 1, evidenceDigest: 'c'.repeat(64) } } }));
  const stale = createManagedApplicationService({ retrievePolicy: async () => [{ ...policy[0], version: 'stale' }], invokeAgent: boundedAgent });
  await assert.rejects(stale.query(base));
});

test('application service exposes no effect tools', async () => {
  const service = createManagedApplicationService({ retrievePolicy: async () => [], invokeAgent: async ({ callTool }) => callTool('notify_doctor', {}) });
  await assert.rejects(service.query(request()));
});

test('application binding survives transport key reordering and omitted undefined fields', async () => {
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().filter(key => value[key] !== undefined).map(key => [key, reorder(value[key])])) : value;
  const original = request();
  original.evidence.context.transportOnlyUndefined = undefined;
  original.binding.evidenceDigest = canonicalDigest(original.evidence);
  const transported = reorder(JSON.parse(JSON.stringify(original)));
  const service = createManagedApplicationService({ retrievePolicy: async () => policy, invokeAgent: boundedAgent });
  const result = await service.query(transported);
  assert.equal(result.status, 'shadow_validated');
  assert.equal(result.evidenceDigest, original.binding.evidenceDigest);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedPolicyRegistry } from '../src/agent-platform/policy-governance.js';

const manifest = { corpusId: 'fictional-clinical-policy', version: 'fictional-v1', manifestDigest: 'a'.repeat(64), status: 'approved',
  approvedBy: 'fictional-review-board', approvedAt: '2026-10-15T00:00:00.000Z', retiredAt: null };
const passage = { evidenceRef: 'POLICY-fictional-1', documentId: 'fictional-policy', version: 'fictional-v1', section: '1',
  contentDigest: 'b'.repeat(64), passage: 'Fictional policy text for governance tests.' };

test('policy retrieval requires an approved active version and preserves source metadata', async () => {
  const registry = createApprovedPolicyRegistry({ manifests: [manifest], retrieve: async ({ manifest: active }) => {
    assert.equal(active.version, 'fictional-v1'); return [passage];
  } });
  assert.deepEqual(await registry.search({ version: 'fictional-v1', query: 'review timing' }), [passage]);
  await assert.rejects(registry.search({ version: 'unknown', query: 'review timing' }), error => error.code === 'POLICY_CORPUS_NOT_APPROVED');
});

test('unapproved, retired, stale, and malformed policy material fails closed', async () => {
  for (const invalid of [
    { ...manifest, status: 'draft' },
    { ...manifest, retiredAt: '2026-10-15T01:00:00.000Z' },
  ]) assert.throws(() => createApprovedPolicyRegistry({ manifests: [invalid], retrieve: async () => [] }));
  const stale = createApprovedPolicyRegistry({ manifests: [manifest], retrieve: async () => [{ ...passage, version: 'fictional-v2' }] });
  await assert.rejects(stale.search({ version: 'fictional-v1', query: 'review timing' }), error => error.code === 'POLICY_RETRIEVAL_INVALID');
});

test('empty and conflicting approved retrieval remain explicit evidence outcomes', async () => {
  const empty = createApprovedPolicyRegistry({ manifests: [manifest], retrieve: async () => [] });
  assert.deepEqual(await empty.search({ version: 'fictional-v1', query: 'missing guidance' }), []);
  const conflicting = createApprovedPolicyRegistry({ manifests: [manifest], retrieve: async () => [passage,
    { ...passage, evidenceRef: 'POLICY-fictional-2', documentId: 'fictional-policy-2', contentDigest: 'c'.repeat(64), section: '2' }] });
  assert.equal((await conflicting.search({ version: 'fictional-v1', query: 'conflicting guidance' })).length, 2);
});

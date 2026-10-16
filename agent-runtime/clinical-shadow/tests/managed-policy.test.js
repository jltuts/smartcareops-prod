import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedPolicyRetriever } from '../managed-policy.js';

const fixture = { schemaVersion: '1.0', version: 'm60-fictional-v1', manifestDigest: 'a'.repeat(64), chunks: [{
  evidenceRef: 'POLICY-DEMO-01', documentId: 'DEMO', version: 'm60-fictional-v1', section: 'Boundary',
  contentDigest: 'b'.repeat(64), passage: 'Canonical approved text.' }] };
const receipt = { status: 'uploaded', project: 'demo-project', location: 'asia-southeast1', corpusVersion: fixture.version,
  manifestDigest: fixture.manifestDigest, corpusResource: 'projects/demo-project/locations/asia-southeast1/ragCorpora/123',
  uploaded: [{ evidenceRef: 'POLICY-DEMO-01', displayName: 'POLICY-DEMO-01', ragFile: 'projects/demo-project/locations/asia-southeast1/ragCorpora/123/ragFiles/456' }] };

test('managed retriever maps live provenance back to canonical approved text', async () => {
  let body;
  const retrieve = createManagedPolicyRetriever({ fixture, receipt, accessToken: async () => 'token-token-token-token-token',
    request: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ contexts: { contexts: [{
      sourceUri: 'POLICY-DEMO-01', sourceDisplayName: 'POLICY-DEMO-01', text: 'chunked service text', score: 0.75,
      chunk: { fileId: '456', chunkId: '1', text: 'chunked service text' } }] } }) }; } });
  const passages = await retrieve({ query: 'human review boundary', binding: { policyVersion: fixture.version, policyManifestDigest: fixture.manifestDigest } });
  assert.equal(passages[0].passage, 'Canonical approved text.');
  assert.equal(body.vertexRagStore.ragResources[0].ragCorpus, receipt.corpusResource);
});

test('managed retriever rejects stale bindings and unknown provenance', async () => {
  const retrieve = createManagedPolicyRetriever({ fixture, receipt, accessToken: async () => 'token-token-token-token-token',
    request: async () => ({ ok: true, json: async () => ({ contexts: { contexts: [{ sourceUri: 'UNKNOWN', sourceDisplayName: 'UNKNOWN',
      text: 'unknown', score: 1, chunk: { fileId: '999', chunkId: '1', text: 'unknown' } }] } }) }) });
  await assert.rejects(retrieve({ query: 'policy', binding: { policyVersion: 'stale', policyManifestDigest: fixture.manifestDigest } }), error => error.code === 'MANAGED_POLICY_BINDING_STALE');
  await assert.rejects(retrieve({ query: 'policy', binding: { policyVersion: fixture.version, policyManifestDigest: fixture.manifestDigest } }));
});

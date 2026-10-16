import test from 'node:test';
import assert from 'node:assert/strict';
import { mapManagedPolicyContexts } from '../src/agent-platform/policy-managed-retrieval.js';

const digest = 'a'.repeat(64), corpusResource = 'projects/example-project/locations/asia-southeast1/ragCorpora/1';
const fixture = { schemaVersion: '1.0', version: 'm60-fictional-v1', manifestDigest: digest, chunks: [{
  evidenceRef: 'POLICY-SCO-DEMO-01-01', documentId: 'SCO-DEMO-01', version: 'm60-fictional-v1', section: '1. Evidence',
  contentDigest: 'b'.repeat(64), passage: '## 1. Evidence\n\nApproved canonical policy.',
}] };
const receipt = { status: 'uploaded', corpusResource, corpusVersion: fixture.version, manifestDigest: digest, uploaded: [{
  evidenceRef: 'POLICY-SCO-DEMO-01-01', displayName: 'POLICY-SCO-DEMO-01-01',
  ragFile: 'projects/123/locations/asia-southeast1/ragCorpora/1/ragFiles/22', fileDigest: 'c'.repeat(64),
}] };
const context = { sourceUri: 'POLICY-SCO-DEMO-01-01', sourceDisplayName: 'POLICY-SCO-DEMO-01-01',
  text: '1. Evidence\nApproved canonical policy.', score: 0.2,
  chunk: { text: '1. Evidence\nApproved canonical policy.', fileId: '22', chunkId: '33' } };

test('maps live direct-upload provenance to the canonical approved passage', () => {
  const mapped = mapManagedPolicyContexts({ response: { contexts: { contexts: [context] } }, fixture, receipt, corpusResource });
  assert.deepEqual(mapped, [fixture.chunks[0]]);
  assert.equal(mapped[0].passage.startsWith('##'), true);
});

test('returns no policy evidence for an empty managed retrieval', () => {
  assert.deepEqual(mapManagedPolicyContexts({ response: {}, fixture, receipt, corpusResource }), []);
});

test('rejects unknown, duplicate, mismatched, stale, and oversized retrieval evidence', () => {
  const invoke = contexts => mapManagedPolicyContexts({ response: { contexts: { contexts } }, fixture, receipt, corpusResource });
  for (const changed of [
    { ...context, sourceDisplayName: 'POLICY-UNKNOWN' },
    { ...context, sourceUri: 'POLICY-OTHER' },
    { ...context, chunk: { ...context.chunk, fileId: '999' } },
    { ...context, chunk: { ...context.chunk, text: 'changed' } },
    { ...context, score: Number.NaN },
  ]) assert.throws(() => invoke([changed]), error => error.code === 'POLICY_MANAGED_RETRIEVAL_SOURCE_INVALID');
  assert.throws(() => invoke([context, context]), error => error.code === 'POLICY_MANAGED_RETRIEVAL_SOURCE_INVALID');
  assert.throws(() => mapManagedPolicyContexts({ response: {}, fixture, receipt: { ...receipt, corpusVersion: 'stale' }, corpusResource }),
    error => error.code === 'POLICY_MANAGED_RETRIEVAL_CONFIG_INVALID');
  assert.throws(() => invoke(Array(6).fill(context)), error => error.code === 'POLICY_MANAGED_RETRIEVAL_INVALID');
});

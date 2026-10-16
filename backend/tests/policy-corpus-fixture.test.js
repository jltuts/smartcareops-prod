import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPolicyCorpusFixture } from '../src/agent-platform/policy-corpus-fixture.js';

const markdown = '# Fictional policy\n\n## Evidence boundary\n\nUse only supplied fictional evidence.\n';
const hash = createHash('sha256').update(markdown).digest('hex');
const dossier = {
  schemaVersion: '1.0', status: 'approved', corpusId: 'fictional-policy', version: 'fictional-v1', manifestDigest: 'a'.repeat(64),
  owner: { name: 'Fictional owner', contact: 'owner@example.invalid' },
  license: { name: 'Fictional license', permittedUse: 'Fictional evaluation', evidenceReference: 'LICENSE' },
  clinicalApproval: { reviewer: 'Product safety review', approvedAt: '2026-10-16T00:00:00.000Z', scope: 'Fictional safety controls' },
  lifecycle: { effectiveAt: '2026-10-16T00:00:00.000Z', retiredAt: null, updateProcess: 'Create a new version.', rollbackProcess: 'Restore the prior version.' },
  dataBoundary: { classification: 'approved-clinical-policy', policyOnly: true, prohibitedContentAttested: true },
  documents: [{ documentId: 'SCO-DEMO-1', title: 'Fictional policy', version: 'fictional-v1', contentDigest: hash,
    sourceReference: 'docs/fictional.md', effectiveAt: '2026-10-16T00:00:00.000Z', retiredAt: null }],
};

test('builds deterministic section-level chunks with approved source metadata', () => {
  const fixture = buildPolicyCorpusFixture({ dossier, documentsByReference: { 'docs/fictional.md': markdown } });
  assert.deepEqual(fixture.chunks, [{ evidenceRef: 'POLICY-SCO-DEMO-1-01', documentId: 'SCO-DEMO-1', version: 'fictional-v1',
    section: 'Evidence boundary', contentDigest: hash, passage: '## Evidence boundary\n\nUse only supplied fictional evidence.' }]);
});

test('blocks changed content and unapproved dossiers', () => {
  assert.throws(() => buildPolicyCorpusFixture({ dossier, documentsByReference: { 'docs/fictional.md': `${markdown}changed` } }),
    error => error.code === 'POLICY_DOCUMENT_DIGEST_MISMATCH');
  assert.throws(() => buildPolicyCorpusFixture({ dossier: { ...dossier, status: 'draft' }, documentsByReference: { 'docs/fictional.md': markdown } }),
    error => error.code === 'POLICY_CORPUS_NOT_APPROVED');
});

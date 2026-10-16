import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicyCorpusApproval } from '../src/agent-platform/policy-corpus-approval.js';

const approved = {
  schemaVersion: '1.0', status: 'approved', corpusId: 'fictional-policy', version: 'fictional-v1', manifestDigest: 'a'.repeat(64),
  owner: { name: 'Fictional policy owner', contact: 'owner@example.invalid' },
  license: { name: 'Fictional test license', permittedUse: 'Fictional evaluation only', evidenceReference: 'TEST-LICENSE-1' },
  clinicalApproval: { reviewer: 'Fictional clinical reviewer', approvedAt: '2026-10-16T00:00:00.000Z', scope: 'Fictional evaluation only' },
  lifecycle: { effectiveAt: '2026-10-16T00:00:00.000Z', retiredAt: null, updateProcess: 'Create a new immutable version.', rollbackProcess: 'Restore the prior approved version.' },
  dataBoundary: { classification: 'approved-clinical-policy', policyOnly: true, prohibitedContentAttested: true },
  documents: [{ documentId: 'fictional-doc-1', title: 'Fictional policy', version: 'fictional-v1', contentDigest: 'b'.repeat(64), sourceReference: 'TEST-SOURCE-1', effectiveAt: '2026-10-16T00:00:00.000Z', retiredAt: null }],
};

test('accepts a complete approved policy-corpus dossier without changing it', () => {
  assert.deepEqual(validatePolicyCorpusApproval(approved), approved);
});

test('blocks draft approval and incomplete governance evidence', () => {
  assert.throws(() => validatePolicyCorpusApproval({ ...approved, status: 'draft' }), error => error.code === 'POLICY_CORPUS_NOT_APPROVED');
  assert.throws(() => validatePolicyCorpusApproval({ ...approved, license: { ...approved.license, evidenceReference: '' } }),
    error => error.code === 'POLICY_LICENSE_REQUIRED');
});

test('blocks prohibited content attestation gaps and stale document versions', () => {
  assert.throws(() => validatePolicyCorpusApproval({ ...approved, dataBoundary: { ...approved.dataBoundary, prohibitedContentAttested: false } }),
    error => error.code === 'POLICY_DATA_BOUNDARY_INVALID');
  assert.throws(() => validatePolicyCorpusApproval({ ...approved, documents: [{ ...approved.documents[0], version: 'fictional-v2' }] }),
    error => error.code === 'POLICY_DOCUMENT_INVALID');
});

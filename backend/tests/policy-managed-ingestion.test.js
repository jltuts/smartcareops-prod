import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManagedPolicyIngestion, requireCleanModelArmorInspection, requireEmptyManagedCorpus,
  validateManagedCorpusPrefix, validateManagedPolicyBundle,
  validateRagFileUploadResponse } from '../src/agent-platform/policy-managed-ingestion.js';

const fixture = { schemaVersion: '1.0', corpusId: 'fictional-policy', version: 'fictional-v1', manifestDigest: 'a'.repeat(64), chunks: [{
  evidenceRef: 'POLICY-SCO-DEMO-01-01', documentId: 'SCO-DEMO-01', version: 'fictional-v1', section: 'Evidence',
  contentDigest: 'b'.repeat(64), passage: '## Evidence\n\nUse only approved fictional evidence.',
}] };
const corpusResource = 'projects/gen-lang-client-0710663107/locations/asia-southeast1/ragCorpora/2305843009213693952';
const modelArmorTemplate = 'projects/gen-lang-client-0710663107/locations/asia-southeast1/templates/smartcareops-m60-inspect';

test('builds a deterministic one-file-per-evidence-reference upload bundle', () => {
  const bundle = buildManagedPolicyIngestion({ fixture, corpusResource, modelArmorTemplate });
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].fileName, 'POLICY-SCO-DEMO-01-01.md');
  assert.equal(bundle.files[0].displayName, 'POLICY-SCO-DEMO-01-01');
  assert.match(bundle.files[0].description, /source_sha256=b{64}/);
  const manifest = { ...bundle, files: bundle.files.map(({ content: _content, ...file }) => file) };
  assert.equal(validateManagedPolicyBundle(manifest, { [bundle.files[0].fileName]: bundle.files[0].content }), true);
});

test('fails closed for changed files, a populated corpus, and Model Armor findings', () => {
  const bundle = buildManagedPolicyIngestion({ fixture, corpusResource, modelArmorTemplate });
  const manifest = { ...bundle, files: bundle.files.map(({ content: _content, ...file }) => file) };
  assert.throws(() => validateManagedPolicyBundle(manifest, { [bundle.files[0].fileName]: 'changed' }),
    error => error.code === 'POLICY_INGESTION_FILE_DIGEST_MISMATCH');
  assert.throws(() => requireEmptyManagedCorpus({ ragFiles: [{ name: 'existing' }] }), error => error.code === 'POLICY_CORPUS_NOT_EMPTY');
  assert.throws(() => requireCleanModelArmorInspection({ sanitizationResult: { invocationResult: 'SUCCESS', filterMatchState: 'MATCH_FOUND' } }),
    error => error.code === 'POLICY_MODEL_ARMOR_MATCH');
  assert.throws(() => requireCleanModelArmorInspection({ sanitizationResult: { invocationResult: 'SUCCESS' } }),
    error => error.code === 'POLICY_MODEL_ARMOR_UNAVAILABLE');
  assert.equal(requireEmptyManagedCorpus({}), true);
  assert.equal(requireCleanModelArmorInspection({ sanitizationResult: { invocationResult: 'SUCCESS', filterMatchState: 'NO_MATCH_FOUND' } }), true);
});

test('resumes only from an exact active prefix of the approved manifest', () => {
  const bundle = buildManagedPolicyIngestion({ fixture, corpusResource, modelArmorTemplate });
  const file = bundle.files[0];
  const ragFile = { name: `projects/123456/locations/asia-southeast1/ragCorpora/1/ragFiles/2`,
    displayName: file.displayName, description: file.description, fileStatus: { state: 'ACTIVE' } };
  assert.deepEqual(validateManagedCorpusPrefix(bundle.files, [ragFile]), [{ evidenceRef: file.evidenceRef,
    fileDigest: file.fileDigest, ragFile: ragFile.name, displayName: file.displayName }]);
  assert.throws(() => validateManagedCorpusPrefix(bundle.files, [{ ...ragFile, description: 'changed' }]),
    error => error.code === 'POLICY_CORPUS_RESUME_MISMATCH');
  assert.throws(() => validateManagedCorpusPrefix(bundle.files, [{ ...ragFile, fileStatus: { state: 'ERROR' } }]),
    error => error.code === 'POLICY_CORPUS_RESUME_MISMATCH');
});

test('accepts the documented UploadRagFileResponse wrapper', () => {
  const response = { ragFile: { name: 'projects/123/locations/asia-southeast1/ragCorpora/1/ragFiles/2',
    displayName: 'POLICY-SCO-DEMO-01' } };
  assert.equal(validateRagFileUploadResponse(response, 'POLICY-SCO-DEMO-01'), response.ragFile);
  assert.throws(() => validateRagFileUploadResponse(response.ragFile, 'POLICY-SCO-DEMO-01'),
    error => error.code === 'POLICY_RAG_UPLOAD_RESPONSE_INVALID');
});

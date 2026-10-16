import { ClinicalError, exact, textValue } from '../clinical/contracts.js';

const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const approvedAt = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fail = (condition, code, status = 409) => {
  if (!condition) throw new ClinicalError(code, status);
};

function validateManifest(manifest) {
  exact(manifest, ['corpusId', 'version', 'manifestDigest', 'status', 'approvedBy', 'approvedAt', 'retiredAt']);
  fail(textValue(manifest.corpusId, 80) && textValue(manifest.version, 80) && sha256(manifest.manifestDigest), 'POLICY_CORPUS_INVALID');
  fail(manifest.status === 'approved' && textValue(manifest.approvedBy, 160) && approvedAt(manifest.approvedAt), 'POLICY_CORPUS_NOT_APPROVED', 403);
  fail(manifest.retiredAt === null, 'POLICY_CORPUS_RETIRED', 409);
  return Object.freeze(structuredClone(manifest));
}

export function createApprovedPolicyRegistry({ manifests = [], retrieve } = {}) {
  fail(Array.isArray(manifests) && typeof retrieve === 'function', 'POLICY_GOVERNANCE_CONFIGURATION_REQUIRED', 500);
  const registry = new Map();
  for (const source of manifests) {
    const manifest = validateManifest(source);
    fail(!registry.has(manifest.version), 'POLICY_CORPUS_VERSION_CONFLICT', 500);
    registry.set(manifest.version, manifest);
  }
  return {
    async search({ version, query }) {
      fail(textValue(version, 80) && textValue(query, 300), 'POLICY_QUERY_INVALID', 400);
      const manifest = registry.get(version);
      fail(manifest, 'POLICY_CORPUS_NOT_APPROVED', 403);
      const passages = await retrieve({ manifest: structuredClone(manifest), query: query.trim() });
      fail(Array.isArray(passages) && passages.length <= 5, 'POLICY_RETRIEVAL_INVALID', 503);
      return passages.map(passage => {
        exact(passage, ['evidenceRef', 'documentId', 'version', 'section', 'contentDigest', 'passage']);
        fail(textValue(passage.evidenceRef, 160) && passage.evidenceRef.startsWith('POLICY-') && textValue(passage.documentId, 160) &&
          passage.version === manifest.version && textValue(passage.section, 160) && sha256(passage.contentDigest) && textValue(passage.passage, 1500),
        'POLICY_RETRIEVAL_INVALID', 503);
        return structuredClone(passage);
      });
    },
    describe(version) {
      const manifest = registry.get(version);
      return manifest ? structuredClone(manifest) : null;
    },
  };
}

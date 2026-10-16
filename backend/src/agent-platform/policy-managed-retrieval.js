import { ClinicalError } from '../clinical/contracts.js';

const fail = (condition, code, status = 503) => {
  if (!condition) throw new ClinicalError(code, status);
};
const boundedText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export function mapManagedPolicyContexts({ response, fixture, receipt, corpusResource, maximum = 5 }) {
  fail(fixture?.schemaVersion === '1.0' && Array.isArray(fixture.chunks) && fixture.chunks.length > 0 &&
    receipt?.status === 'uploaded' && receipt.corpusResource === corpusResource &&
    receipt.corpusVersion === fixture.version && receipt.manifestDigest === fixture.manifestDigest &&
    Array.isArray(receipt.uploaded) && Number.isInteger(maximum) && maximum > 0 && maximum <= 5,
  'POLICY_MANAGED_RETRIEVAL_CONFIG_INVALID');
  const contexts = response?.contexts?.contexts ?? [];
  fail(Array.isArray(contexts) && contexts.length <= maximum, 'POLICY_MANAGED_RETRIEVAL_INVALID');
  const chunks = new Map(fixture.chunks.map(chunk => [chunk.evidenceRef, chunk]));
  const files = new Map(receipt.uploaded.map(file => [file.evidenceRef, file]));
  fail(chunks.size === fixture.chunks.length && files.size === receipt.uploaded.length,
    'POLICY_MANAGED_RETRIEVAL_CONFIG_INVALID');
  const seen = new Set();
  return contexts.map(context => {
    const evidenceRef = context?.sourceDisplayName;
    const chunk = chunks.get(evidenceRef), file = files.get(evidenceRef);
    fail(boundedText(evidenceRef, 160) && context.sourceUri === evidenceRef && !seen.has(evidenceRef) && chunk && file &&
      file.displayName === evidenceRef && boundedText(file.ragFile, 500) &&
      context.chunk?.fileId === file.ragFile.split('/').at(-1) && /^\d+$/.test(context.chunk?.chunkId ?? '') &&
      boundedText(context.text, 5000) && context.chunk.text === context.text &&
      Number.isFinite(context.score) && context.score >= 0 && context.score <= 2,
    'POLICY_MANAGED_RETRIEVAL_SOURCE_INVALID');
    seen.add(evidenceRef);
    return Object.freeze({ evidenceRef: chunk.evidenceRef, documentId: chunk.documentId, version: chunk.version,
      section: chunk.section, contentDigest: chunk.contentDigest, passage: chunk.passage });
  });
}

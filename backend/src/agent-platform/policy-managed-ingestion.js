import { createHash } from 'node:crypto';
import { ClinicalError } from '../clinical/contracts.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const digestValue = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const fail = (condition, code, status = 409) => {
  if (!condition) throw new ClinicalError(code, status);
};

const corpusPattern = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/asia-southeast1\/ragCorpora\/[0-9]+$/;
const templatePattern = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/asia-southeast1\/templates\/[a-z][a-z0-9-]{0,62}$/;

export function buildManagedPolicyIngestion({ fixture, corpusResource, modelArmorTemplate }) {
  fail(fixture && fixture.schemaVersion === '1.0' && text(fixture.corpusId, 80) && text(fixture.version, 80) &&
    digestValue(fixture.manifestDigest) && Array.isArray(fixture.chunks) && fixture.chunks.length > 0,
  'POLICY_INGESTION_FIXTURE_INVALID');
  fail(corpusPattern.test(corpusResource), 'POLICY_INGESTION_CORPUS_INVALID');
  fail(templatePattern.test(modelArmorTemplate), 'POLICY_INGESTION_MODEL_ARMOR_INVALID');
  const seen = new Set();
  const files = fixture.chunks.map(chunk => {
    fail(chunk && text(chunk.evidenceRef, 160) && /^POLICY-[A-Z0-9-]+$/.test(chunk.evidenceRef) &&
      text(chunk.documentId, 160) && chunk.version === fixture.version && text(chunk.section, 160) &&
      digestValue(chunk.contentDigest) && text(chunk.passage, 1500) && !seen.has(chunk.evidenceRef),
    'POLICY_INGESTION_CHUNK_INVALID');
    seen.add(chunk.evidenceRef);
    const fileName = `${chunk.evidenceRef}.md`;
    const content = `${chunk.passage.trim()}\n`;
    return Object.freeze({
      evidenceRef: chunk.evidenceRef,
      documentId: chunk.documentId,
      version: chunk.version,
      section: chunk.section,
      contentDigest: chunk.contentDigest,
      fileName,
      fileDigest: sha256(content),
      displayName: chunk.evidenceRef,
      description: `document=${chunk.documentId}; version=${chunk.version}; section=${chunk.section}; source_sha256=${chunk.contentDigest}; manifest_sha256=${fixture.manifestDigest}`,
      content,
    });
  });
  return Object.freeze({ schemaVersion: '1.0', corpusId: fixture.corpusId, version: fixture.version,
    manifestDigest: fixture.manifestDigest, corpusResource, modelArmorTemplate, files });
}

export function validateManagedPolicyBundle(bundle, contentsByFileName) {
  fail(bundle && bundle.schemaVersion === '1.0' && text(bundle.corpusId, 80) && text(bundle.version, 80) &&
    digestValue(bundle.manifestDigest) && corpusPattern.test(bundle.corpusResource) &&
    templatePattern.test(bundle.modelArmorTemplate) && Array.isArray(bundle.files) && bundle.files.length > 0,
  'POLICY_INGESTION_BUNDLE_INVALID');
  fail(contentsByFileName && typeof contentsByFileName === 'object' && !Array.isArray(contentsByFileName),
    'POLICY_INGESTION_FILES_REQUIRED');
  const seenFiles = new Set(), seenEvidence = new Set();
  for (const file of bundle.files) {
    fail(file && text(file.evidenceRef, 160) && /^POLICY-[A-Z0-9-]+$/.test(file.evidenceRef) &&
      text(file.documentId, 160) && file.version === bundle.version && text(file.section, 160) &&
      digestValue(file.contentDigest) && text(file.fileName, 200) && file.fileName === `${file.evidenceRef}.md` &&
      digestValue(file.fileDigest) && file.displayName === file.evidenceRef && text(file.description, 1000) &&
      !seenFiles.has(file.fileName) && !seenEvidence.has(file.evidenceRef), 'POLICY_INGESTION_BUNDLE_INVALID');
    const content = contentsByFileName[file.fileName];
    fail(typeof content === 'string' && sha256(content) === file.fileDigest, 'POLICY_INGESTION_FILE_DIGEST_MISMATCH');
    seenFiles.add(file.fileName); seenEvidence.add(file.evidenceRef);
  }
  fail(Object.keys(contentsByFileName).length === bundle.files.length, 'POLICY_INGESTION_FILE_INVENTORY_MISMATCH');
  return true;
}

export function requireEmptyManagedCorpus(response) {
  fail(response && typeof response === 'object' && Array.isArray(response.ragFiles ?? []), 'POLICY_CORPUS_LIST_INVALID', 503);
  fail((response.ragFiles ?? []).length === 0 && !response.nextPageToken, 'POLICY_CORPUS_NOT_EMPTY', 409);
  return true;
}

export function validateManagedCorpusPrefix(manifestFiles, ragFiles) {
  fail(Array.isArray(manifestFiles) && manifestFiles.length > 0 && Array.isArray(ragFiles) && ragFiles.length > 0 &&
    ragFiles.length <= manifestFiles.length, 'POLICY_CORPUS_RESUME_INVALID');
  const byDisplayName = new Map();
  for (const ragFile of ragFiles) {
    fail(ragFile && text(ragFile.name, 500) && /\/ragFiles\/[0-9]+$/.test(ragFile.name) &&
      text(ragFile.displayName, 160) && !byDisplayName.has(ragFile.displayName), 'POLICY_CORPUS_RESUME_INVALID');
    byDisplayName.set(ragFile.displayName, ragFile);
  }
  const expectedPrefix = manifestFiles.slice(0, ragFiles.length);
  const ordered = expectedPrefix.map(file => {
    const ragFile = byDisplayName.get(file.displayName);
    fail(ragFile && ragFile.description === file.description && ragFile.fileStatus?.state === 'ACTIVE',
      'POLICY_CORPUS_RESUME_MISMATCH');
    return { evidenceRef: file.evidenceRef, fileDigest: file.fileDigest, ragFile: ragFile.name, displayName: ragFile.displayName };
  });
  fail(byDisplayName.size === ordered.length && ordered.every(file => byDisplayName.has(file.displayName)),
    'POLICY_CORPUS_RESUME_MISMATCH');
  return ordered;
}

export function validateRagFileUploadResponse(response, expectedDisplayName) {
  const ragFile = response?.ragFile;
  fail(!response?.error && ragFile && text(ragFile.name, 500) && /\/ragFiles\/[0-9]+$/.test(ragFile.name) &&
    ragFile.displayName === expectedDisplayName, 'POLICY_RAG_UPLOAD_RESPONSE_INVALID', 502);
  return ragFile;
}

export function requireCleanModelArmorInspection(response) {
  const result = response?.sanitizationResult;
  fail(result && result.invocationResult === 'SUCCESS', 'POLICY_MODEL_ARMOR_UNAVAILABLE', 503);
  fail(result.filterMatchState === 'NO_MATCH_FOUND' || result.filterMatchState === 'MATCH_FOUND',
    'POLICY_MODEL_ARMOR_UNAVAILABLE', 503);
  fail(result.filterMatchState === 'NO_MATCH_FOUND', 'POLICY_MODEL_ARMOR_MATCH', 409);
  return true;
}

import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const objectPrefix = 'case-evidence/';
export const stagingOrphanAgeMs = 24 * 60 * 60 * 1000;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeStorageCode = error => {
  const status = Number(error?.code);
  if (status === 404) return 'NOT_FOUND';
  if (status === 401 || status === 403) return 'ACCESS_DENIED';
  if (status === 408 || status === 429 || status >= 500) return 'TEMPORARY_UNAVAILABLE';
  if (status === 412) return 'PRECONDITION_FAILED';
  return 'STORAGE_ERROR';
};

const validateInput = ({ caseId, patientUid, evidenceId, mimeType, bytes }) => {
  if (typeof caseId !== 'string' || !caseId || typeof patientUid !== 'string' || !patientUid ||
      !/^[a-z0-9-]{1,48}$/.test(evidenceId || '') || !allowedMimeTypes.has(mimeType) ||
      !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 512 * 1024) throw new Error('INVALID_EVIDENCE_OBJECT');
};

const objectRefFor = (caseId, evidenceId) => `${objectPrefix}${sha256(`${caseId}\0${evidenceId}`)}`;
const sameBinding = (metadata, expected) => metadata?.metadata?.smartcareCaseId === expected.caseId &&
  metadata?.metadata?.smartcareEvidenceId === expected.evidenceId &&
  metadata?.metadata?.smartcarePatientUidHash === sha256(expected.patientUid) &&
  metadata?.metadata?.smartcareSha256 === expected.checksum && Number(metadata.size) === expected.byteLength &&
  metadata.contentType === expected.mimeType;

export function createCloudEvidenceStore({ bucket, now = Date.now, logger = console } = {}) {
  if (!bucket) throw new Error('EVIDENCE_BUCKET_REQUIRED');
  const log = (level, detail) => logger[level]?.('[case-evidence-storage]', JSON.stringify(detail));
  return {
    async stage({ caseId, patientUid, evidenceId, mimeType, bytes }) {
      validateInput({ caseId, patientUid, evidenceId, mimeType, bytes });
      const checksum = sha256(bytes), byteLength = bytes.length, objectRef = objectRefFor(caseId, evidenceId);
      const file = bucket.file(objectRef), stagedAt = new Date(now()).toISOString();
      try {
        await file.save(bytes, { resumable: false, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType: mimeType, cacheControl: 'private, no-store', metadata: {
            smartcareState: 'staging', smartcareCaseId: caseId, smartcareEvidenceId: evidenceId,
            smartcarePatientUidHash: sha256(patientUid), smartcareSha256: checksum, smartcareStagedAt: stagedAt,
          } } });
      } catch (error) {
        if (Number(error?.code) !== 412) {
          log('warn', { operation: 'stage', category: safeStorageCode(error) });
          throw error;
        }
        const [metadata] = await file.getMetadata();
        if (!sameBinding(metadata, { caseId, patientUid, evidenceId, mimeType, checksum, byteLength })) {
          log('warn', { operation: 'stage', category: 'IDEMPOTENCY_CONFLICT' });
          throw new Error('EVIDENCE_OBJECT_CONFLICT');
        }
      }
      return Object.freeze({ objectRef, checksum, byteLength, mimeType, storageSource: 'gcs' });
    },
    async commit(reference) {
      const file = bucket.file(reference.objectRef), [metadata] = await file.getMetadata();
      if (metadata?.metadata?.smartcareSha256 !== reference.checksum || Number(metadata.size) !== reference.byteLength) throw new Error('EVIDENCE_OBJECT_CONFLICT');
      await file.setMetadata({ cacheControl: 'private, no-store', metadata: { ...metadata.metadata, smartcareState: 'committed', smartcareCommittedAt: new Date(now()).toISOString() } },
        { preconditionOpts: { ifMetagenerationMatch: Number(metadata.metageneration) } });
    },
    async read(reference) {
      if (!reference?.objectRef || !reference?.checksum || !allowedMimeTypes.has(reference.mimeType)) return null;
      try {
        const file = bucket.file(reference.objectRef), [[metadata], [bytes]] = await Promise.all([file.getMetadata(), file.download()]);
        if (metadata?.metadata?.smartcareSha256 !== reference.checksum || Number(metadata.size) !== bytes.length ||
            bytes.length !== reference.byteLength || sha256(bytes) !== reference.checksum || metadata.contentType !== reference.mimeType) {
          log('warn', { operation: 'read', category: 'INTEGRITY_MISMATCH' });
          throw new Error('EVIDENCE_INTEGRITY_MISMATCH');
        }
        return { mimeType: reference.mimeType, byteLength: bytes.length, bytes: Buffer.from(bytes) };
      } catch (error) {
        log('warn', { operation: 'read', category: safeStorageCode(error) });
        throw error;
      }
    },
    async deleteReferences(references = []) {
      let deleted = 0;
      for (const reference of references.filter(item => item?.storageSource === 'gcs' && item.objectRef)) {
        try { await bucket.file(reference.objectRef).delete({ ignoreNotFound: true }); deleted += 1; }
        catch (error) { log('warn', { operation: 'delete', category: safeStorageCode(error) }); throw error; }
      }
      return deleted;
    },
    async previewPurge() {
      const [files] = await bucket.getFiles({ prefix: objectPrefix, autoPaginate: true });
      const versions = [];
      for (const file of files) {
        const [metadata] = await file.getMetadata();
        versions.push(`${file.name}:${metadata.generation || ''}:${metadata.metageneration || ''}`);
      }
      versions.sort();
      return Object.freeze({ count: files.length, version: sha256(versions.join('\n')) });
    },
    async purgeAll() {
      const [files] = await bucket.getFiles({ prefix: objectPrefix, autoPaginate: true });
      let deleted = 0;
      for (const file of files) {
        try {
          const [metadata] = await file.getMetadata();
          await file.delete({ ignoreNotFound: true, preconditionOpts: { ifGenerationMatch: Number(metadata.generation) } });
          deleted += 1;
        } catch (error) {
          log('warn', { operation: 'purge', category: safeStorageCode(error) });
          const failure = new Error('EVIDENCE_PURGE_PARTIAL');
          failure.code = 'EVIDENCE_PURGE_PARTIAL'; failure.deleted = deleted; failure.category = safeStorageCode(error);
          throw failure;
        }
      }
      return deleted;
    },
    async cleanupStaging({ isReferenced, olderThanMs = stagingOrphanAgeMs, limit = 100 } = {}) {
      if (typeof isReferenced !== 'function' || !Number.isInteger(limit) || limit < 1 || limit > 500 || olderThanMs < stagingOrphanAgeMs) throw new Error('INVALID_EVIDENCE_CLEANUP');
      const [files] = await bucket.getFiles({ prefix: objectPrefix, maxResults: limit });
      const counts = { inspected: 0, deleted: 0, preserved: 0, errors: 0 };
      for (const file of files) {
        counts.inspected += 1;
        try {
          const [metadata] = await file.getMetadata(), custom = metadata.metadata || {};
          if (custom.smartcareState !== 'staging' || !Number.isFinite(Date.parse(custom.smartcareStagedAt)) || now() - Date.parse(custom.smartcareStagedAt) < olderThanMs) { counts.preserved += 1; continue; }
          const reference = { objectRef: file.name, checksum: custom.smartcareSha256, storageSource: 'gcs' };
          if (await isReferenced({ caseId: custom.smartcareCaseId, evidenceId: custom.smartcareEvidenceId, reference })) { counts.preserved += 1; continue; }
          await file.delete({ preconditionOpts: { ifGenerationMatch: Number(metadata.generation) } }); counts.deleted += 1;
        } catch (error) { counts.errors += 1; log('warn', { operation: 'cleanup', category: safeStorageCode(error) }); }
      }
      log('info', { operation: 'cleanup', ...counts });
      return counts;
    },
  };
}

export function createConfiguredCloudEvidenceStore(env = process.env, options = {}) {
  if (!env.EVIDENCE_BUCKET) return null;
  const storage = options.storage || new Storage({ projectId: env.FIREBASE_PROJECT_ID });
  return createCloudEvidenceStore({ bucket: storage.bucket(env.EVIDENCE_BUCKET), ...options });
}

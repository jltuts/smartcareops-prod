import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { environmentConfig } from '../environment.js';
import { validateLabExtraction } from './contracts.js';
import { validateLabReview } from './review.js';

export const maxLabReportBytes = 2 * 1024 * 1024;
const prefix = 'lab-reports/';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const objectName = (caseId, reportId) => `${prefix}${sha256(caseId)}/${reportId}`;
const publicReport = ({ objectRef, checksum, uploaderUid, extractionAttemptId, reviewToken, ...report }, hasMemoryOriginal = false) => ({
  ...report, ...(report.status === 'pending_review' ? { reviewToken } : {}),
  canExtract: (Boolean(objectRef) || hasMemoryOriginal) && ['uploaded', 'failed'].includes(report.status),
});
const reportRef = (db, caseId, reportId) => db.collection('cases').doc(caseId).collection('labReports').doc(reportId);

export function createMemoryLabReportStore({ now = Date.now } = {}) {
  const reports = new Map(), bytes = new Map();
  const key = (caseId, reportId) => `${caseId}\0${reportId}`;
  const publicMemoryReport = report => publicReport(report, bytes.has(key(report.caseId, report.reportId)));
  return {
    async create({ caseId, uploaderUid, filename, mimeType, content }) {
      const reportId = randomUUID(), createdAt = new Date(now()).toISOString();
      const report = { reportId, caseId, filename, mimeType, byteLength: content.length, status: 'uploaded', createdAt, updatedAt: createdAt, uploaderUid, checksum: sha256(content) };
      reports.set(key(caseId, reportId), report); bytes.set(key(caseId, reportId), Buffer.from(content));
      return publicMemoryReport(report);
    },
    async list(caseId) { return [...reports.values()].filter(item => item.caseId === caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicMemoryReport); },
    async read(caseId, reportId) {
      const report = reports.get(key(caseId, reportId)), content = bytes.get(key(caseId, reportId));
      if (!report || !content || sha256(content) !== report.checksum) return null;
      return { report: publicMemoryReport(report), content: Buffer.from(content) };
    },
    async beginExtraction(caseId, reportId) {
      const keyValue = key(caseId, reportId), report = reports.get(keyValue), startedAt = new Date(now()).toISOString();
      if (!report || !['uploaded', 'failed'].includes(report.status) && !(report.status === 'processing' && Date.parse(report.processingStartedAt) + 120_000 < now())) return null;
      const attemptId = randomUUID(); reports.set(keyValue, { ...report, status: 'processing', extractionAttemptId: attemptId, processingStartedAt: startedAt, updatedAt: startedAt, failureCategory: null });
      return { attemptId, report: publicMemoryReport(reports.get(keyValue)) };
    },
    async completeExtraction(caseId, reportId, attemptId, extraction) {
      const keyValue = key(caseId, reportId), report = reports.get(keyValue);
      if (!report || report.status !== 'processing' || report.extractionAttemptId !== attemptId) return null;
      extraction = validateLabExtraction(extraction);
      const updatedAt = new Date(now()).toISOString();
      reports.set(keyValue, { ...report, status: 'pending_review', unverifiedExtraction: { ...extraction, extractedAt: updatedAt }, reviewToken: randomUUID(), extractionAttemptId: null, updatedAt });
      return publicMemoryReport(reports.get(keyValue));
    },
    async failExtraction(caseId, reportId, attemptId, category) {
      const keyValue = key(caseId, reportId), report = reports.get(keyValue);
      if (!report || report.status !== 'processing' || report.extractionAttemptId !== attemptId) return null;
      const updatedAt = new Date(now()).toISOString();
      reports.set(keyValue, { ...report, status: 'failed', failureCategory: category, extractionAttemptId: null, updatedAt });
      return publicMemoryReport(reports.get(keyValue));
    },
    async verify(caseId, reportId, input, reviewerUid) {
      const keyValue = key(caseId, reportId), report = reports.get(keyValue);
      if (!report || report.status !== 'pending_review' || report.reviewToken !== input?.expectedReviewToken || !bytes.has(keyValue)) return null;
      const reviewed = validateLabReview(input, report.unverifiedExtraction), verifiedAt = new Date(now()).toISOString();
      const next = { ...report, status: 'verified', updatedAt: verifiedAt, verifiedResult: {
        revision: 1, sourceExtractionAt: report.unverifiedExtraction.extractedAt,
        ...reviewed, verifiedBy: reviewerUid, verifiedAt,
      } };
      reports.set(keyValue, next); return publicMemoryReport(next);
    },
    async deleteForCase(caseId) { let deleted = 0; for (const item of [...reports.values()].filter(value => value.caseId === caseId)) { reports.delete(key(caseId, item.reportId)); bytes.delete(key(caseId, item.reportId)); deleted++; } return deleted; },
  };
}

export function createCloudLabReportObjectStore({ bucket } = {}) {
  if (!bucket) throw new Error('LAB_REPORT_BUCKET_REQUIRED');
  return {
    async save({ caseId, reportId, mimeType, content }) {
      const objectRef = objectName(caseId, reportId), checksum = sha256(content), file = bucket.file(objectRef);
      await file.save(content, { resumable: false, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 }, metadata: {
        contentType: mimeType, cacheControl: 'private, no-store', metadata: { smartcareCaseHash: sha256(caseId), smartcareReportId: reportId, smartcareSha256: checksum },
      } });
      return { objectRef, checksum };
    },
    async read({ objectRef, checksum, mimeType, byteLength }) {
      if (!objectRef?.startsWith(prefix)) throw new Error('LAB_REPORT_INTEGRITY');
      const file = bucket.file(objectRef), [[metadata], [content]] = await Promise.all([file.getMetadata(), file.download()]);
      if (metadata.contentType !== mimeType || metadata.metadata?.smartcareSha256 !== checksum || content.length !== byteLength || sha256(content) !== checksum) throw new Error('LAB_REPORT_INTEGRITY');
      return Buffer.from(content);
    },
    async delete(objectRef) { if (objectRef?.startsWith(prefix)) await bucket.file(objectRef).delete({ ignoreNotFound: true }); },
    async previewPurge() {
      const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
      const versions = [];
      for (const file of files) { const [metadata] = await file.getMetadata(); versions.push(`${file.name}:${metadata.generation || ''}:${metadata.metageneration || ''}`); }
      return { count: files.length, version: sha256(versions.sort().join('\n')) };
    },
    async purgeAll() {
      const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
      let deleted = 0;
      for (const file of files) {
        try { const [metadata] = await file.getMetadata(); await file.delete({ ignoreNotFound: true, preconditionOpts: { ifGenerationMatch: Number(metadata.generation) } }); deleted++; }
        catch { const error = new Error('LAB_REPORT_PURGE_PARTIAL'); error.code = 'LAB_REPORT_PURGE_PARTIAL'; error.deleted = deleted; throw error; }
      }
      return deleted;
    },
  };
}

export function createFirestoreLabReportStore({ db, objects, now = Date.now } = {}) {
  if (!db || !objects) throw new Error('LAB_REPORT_STORAGE_REQUIRED');
  return {
    async create({ caseId, uploaderUid, filename, mimeType, content }) {
      const reportId = randomUUID(), createdAt = new Date(now()).toISOString(), ref = reportRef(db, caseId, reportId);
      let stored;
      try {
        stored = await objects.save({ caseId, reportId, mimeType, content });
        const report = { reportId, caseId, uploaderUid, filename, mimeType, byteLength: content.length, checksum: stored.checksum, objectRef: stored.objectRef,
          status: 'uploaded', createdAt, updatedAt: createdAt };
        await ref.create(report);
        return publicReport(report);
      } catch (error) {
        if (stored?.objectRef) await objects.delete(stored.objectRef).catch(() => {});
        // An upload failure is visible to the Doctor without publishing a file reference.
        if (!stored) await ref.create({ reportId, caseId, uploaderUid, filename, mimeType, byteLength: content.length,
          status: 'failed', failureCategory: 'STORAGE_UNAVAILABLE', createdAt, updatedAt: createdAt }).catch(() => {});
        throw error;
      }
    },
    async list(caseId) { const snapshot = await db.collection('cases').doc(caseId).collection('labReports').get(); return snapshot.docs.map(doc => publicReport(doc.data())).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    async read(caseId, reportId) {
      const snapshot = await reportRef(db, caseId, reportId).get();
      if (!snapshot.exists) return null;
      const report = snapshot.data();
      if (!report.objectRef) return null;
      return { report: publicReport(report), content: await objects.read(report) };
    },
    async beginExtraction(caseId, reportId) {
      const ref = reportRef(db, caseId, reportId), startedAt = new Date(now()).toISOString(), attemptId = randomUUID();
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref); if (!snapshot.exists) return null;
        const report = snapshot.data();
        if (!report.objectRef || !['uploaded', 'failed'].includes(report.status) && !(report.status === 'processing' && Date.parse(report.processingStartedAt) + 120_000 < now())) return null;
        const next = { ...report, status: 'processing', extractionAttemptId: attemptId, processingStartedAt: startedAt, updatedAt: startedAt, failureCategory: null };
        transaction.set(ref, next); return { attemptId, report: publicReport(next) };
      });
    },
    async completeExtraction(caseId, reportId, attemptId, extraction) {
      const ref = reportRef(db, caseId, reportId);
      extraction = validateLabExtraction(extraction);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref); if (!snapshot.exists) return null;
        const report = snapshot.data(); if (report.status !== 'processing' || report.extractionAttemptId !== attemptId) return null;
        const updatedAt = new Date(now()).toISOString();
        const next = { ...report, status: 'pending_review', unverifiedExtraction: { ...extraction, extractedAt: updatedAt }, reviewToken: randomUUID(), extractionAttemptId: null, updatedAt };
        transaction.set(ref, next); return publicReport(next);
      });
    },
    async failExtraction(caseId, reportId, attemptId, category) {
      const ref = reportRef(db, caseId, reportId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref); if (!snapshot.exists) return null;
        const report = snapshot.data(); if (report.status !== 'processing' || report.extractionAttemptId !== attemptId) return null;
        const updatedAt = new Date(now()).toISOString();
        const next = { ...report, status: 'failed', failureCategory: category, extractionAttemptId: null, updatedAt };
        transaction.set(ref, next); return publicReport(next);
      });
    },
    async verify(caseId, reportId, input, reviewerUid) {
      const ref = reportRef(db, caseId, reportId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref); if (!snapshot.exists) return null;
        const report = snapshot.data();
        if (!report.objectRef || report.status !== 'pending_review' || report.reviewToken !== input?.expectedReviewToken) return null;
        const reviewed = validateLabReview(input, report.unverifiedExtraction), verifiedAt = new Date(now()).toISOString();
        const next = { ...report, status: 'verified', updatedAt: verifiedAt, verifiedResult: {
          revision: 1, sourceExtractionAt: report.unverifiedExtraction.extractedAt,
          ...reviewed, verifiedBy: reviewerUid, verifiedAt,
        } };
        transaction.set(ref, next); return publicReport(next);
      });
    },
    async deleteForCase(caseId) {
      const collection = db.collection('cases').doc(caseId).collection('labReports'), snapshot = await collection.get();
      for (const doc of snapshot.docs) { const report = doc.data(); if (report.objectRef) await objects.delete(report.objectRef); await doc.ref.delete(); }
      return snapshot.size;
    },
    async close() { await db.terminate(); },
  };
}

export function createConfiguredLabReportStore(env = process.env, { caseStorage } = {}) {
  if (caseStorage === 'memory') return createMemoryLabReportStore();
  if (caseStorage !== 'firestore' || !env.EVIDENCE_BUCKET || !env.FIREBASE_PROJECT_ID) return null;
  const config = environmentConfig(env);
  if (!config.projectId) return null;
  const db = new Firestore({ projectId: config.projectId, databaseId: config.database });
  const bucket = new Storage({ projectId: env.FIREBASE_PROJECT_ID }).bucket(env.EVIDENCE_BUCKET);
  return createFirestoreLabReportStore({ db, objects: createCloudLabReportObjectStore({ bucket }) });
}

export function createConfiguredLabReportObjectStore(env = process.env) {
  if (!env.EVIDENCE_BUCKET) return null;
  const bucket = new Storage({ projectId: env.FIREBASE_PROJECT_ID }).bucket(env.EVIDENCE_BUCKET);
  return createCloudLabReportObjectStore({ bucket });
}

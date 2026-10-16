import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from './environment.js';
import { browserSignalsAccept, createOriginPolicy } from './origin.js';
import { newCaseId } from './cases/store.js';
import { DEFAULT_LIVE_LANGUAGE, isSupportedByLiveModel } from '../../shared/live-languages.js';

export const LIVE_SESSION_TTL_MS = 60_000;
export const ACTIVE_INTAKE_TTL_MS = 11 * 60_000;
export const LIVE_PROTOCOL = 'smartcareops.live.v1';
const tokenPrefix = 'smartcareops.session.';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idempotencyKeyPattern = /^[0-9a-f-]{36}$/i;
const digest = token => createHash('sha256').update(token).digest('hex');
const purpose = 'gemini-live';

function validateRecord(record, { origin, path, now, sessionId }) {
  const preferredLanguage = record?.preferredLanguage || DEFAULT_LIVE_LANGUAGE;
  if (!record || record.consumedAt || record.path !== path || record.origin !== origin || record.purpose !== purpose ||
      record.role !== 'patient' || typeof record.uid !== 'string' || !record.uid ||
      !Number.isFinite(record.expiresAt) || record.expiresAt <= now ||
      !isSupportedByLiveModel(preferredLanguage, process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live')) return null;
  const resetGeneration = Number.isSafeInteger(record.resetGeneration) && record.resetGeneration >= 0 ? record.resetGeneration : 0;
  return Object.freeze({ uid: record.uid, roles: ['patient'], intakeSessionId: sessionId, patientCaseId: record.patientCaseId,
    preferredLanguage, resetGeneration });
}

const validSessionId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const activeRecord = (record, { uid, now }) => !!record && record.uid === uid && !!record.consumedAt && !record.endedAt &&
  Number.isFinite(record.activeUntil) && record.activeUntil > now && typeof record.patientCaseId === 'string';
const sameMedication = (left, right) => ['name', 'strength', 'howTaken', 'source', 'verification'].every(key => left?.[key] === right?.[key]);
const medicineScanResult = (candidate, timestamp) => ({
  revision: randomUUID(),
  status: candidate.status,
  ...(candidate.status === 'identified' ? { name: candidate.name, strength: candidate.strength } : {}),
  createdAt: new Date(timestamp).toISOString(),
});
const appointmentRequest = ({ intakeSessionId, uid, patientCaseId, idempotencyKey, selection, resourceVersion, timestamp }) => ({
  appointmentRequestId: randomUUID(), intakeSessionId, patientUid: uid, caseId: patientCaseId, idempotencyKey,
  state: 'requested', simulation: true, contacted: false, confirmed: false, resourceVersion,
  selection: structuredClone(selection), requestedAt: new Date(timestamp).toISOString(),
  receipt: { receiptId: `SIM-APT-${idempotencyKey.slice(0, 8).toUpperCase()}`, requestedAt: new Date(timestamp).toISOString(), simulation: true },
});
const sameAppointment = (prior, input) => prior.idempotencyKey === input.idempotencyKey &&
  prior.caseId === input.patientCaseId && JSON.stringify(prior.selection) === JSON.stringify(input.selection);

export function createMemoryLiveSessionStore({ now = () => Date.now(), ttlMs = LIVE_SESSION_TTL_MS } = {}) {
  const records = new Map(), medicineImages = new Map(), pendingEvidence = new Map();
  return {
    async create({ uid, roles, origin, path = '/api/live', preferredLanguage = DEFAULT_LIVE_LANGUAGE, resetGeneration = 0, resumeIntakeSessionId }) {
      if (!roles?.includes('patient')) return null;
      if (!isSupportedByLiveModel(preferredLanguage)) return null;
      const token = randomBytes(32).toString('base64url');
      const createdAt = now(), expiresAt = createdAt + ttlMs;
      const intakeSessionId = digest(token);
      const prior = validSessionId(resumeIntakeSessionId) ? records.get(resumeIntakeSessionId) : null;
      const resumable = prior?.uid === uid && prior.resetGeneration === resetGeneration && Number.isFinite(prior.activeUntil) && prior.activeUntil > createdAt && prior.questionPlan?.status !== 'ready_to_complete' && !prior.questionPlan?.emergency;
      const language = resumable ? prior.preferredLanguage : preferredLanguage;
      records.set(intakeSessionId, { uid, role: 'patient', origin, path, purpose, patientCaseId: resumable ? prior.patientCaseId : newCaseId(), preferredLanguage: language, resetGeneration, createdAt, expiresAt, consumedAt: null, activeUntil: null, endedAt: null, medicineScanAt: [], ...(resumable ? { questionPlan: structuredClone(prior.questionPlan), ...(prior.intakeSnapshot ? { intakeSnapshot: structuredClone(prior.intakeSnapshot) } : {}), resumedFrom: resumeIntakeSessionId } : {}) });
      return { token, expiresAt, intakeSessionId, preferredLanguage: language, resumed: !!resumable };
    },
    async consume({ token, origin, path = '/api/live' }) {
      if (!tokenPattern.test(token || '')) return null;
      const key = digest(token), record = records.get(key), consumedAt = now();
      const identity = validateRecord(record, { origin, path, now: consumedAt, sessionId: key });
      if (!identity) { if (record?.expiresAt <= consumedAt) records.delete(key); return null; }
      records.set(key, { ...record, consumedAt, activeUntil: consumedAt + ACTIVE_INTAKE_TTL_MS });
      return identity;
    },
    async resolveActive({ intakeSessionId, uid }) {
      if (!validSessionId(intakeSessionId)) return null;
      const record = records.get(intakeSessionId);
      return activeRecord(record, { uid, now: now() }) ? structuredClone(record) : null;
    },
    async getQuestionPlan({ intakeSessionId, uid }) {
      const record = records.get(intakeSessionId);
      return record?.uid === uid && record.questionPlan ? structuredClone(record.questionPlan) : null;
    },
    async saveQuestionPlan({ intakeSessionId, uid, plan }) {
      const record = records.get(intakeSessionId);
      if (!record || record.uid !== uid || !plan || !Number.isSafeInteger(plan.revision) || plan.revision < 0) return null;
      if ((record.questionPlan?.revision || 0) > plan.revision) return structuredClone(record.questionPlan);
      records.set(intakeSessionId, { ...record, questionPlan: structuredClone(plan) });
      return structuredClone(plan);
    },
    async getIntakeSnapshot({ intakeSessionId, uid }) {
      const record = records.get(intakeSessionId);
      return record?.uid === uid && record.intakeSnapshot ? structuredClone(record.intakeSnapshot) : null;
    },
    async saveIntakeSnapshot({ intakeSessionId, uid, intake }) {
      const record = records.get(intakeSessionId);
      if (!record || record.uid !== uid || !intake || typeof intake !== 'object') return null;
      records.set(intakeSessionId, { ...record, intakeSnapshot: structuredClone(intake) }); return structuredClone(intake);
    },
    async takeMedicineScan({ intakeSessionId, uid, limit = 4, windowMs = 60_000 }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      if (!record) return false;
      const time = now(), recent = (record.medicineScanAt || []).filter(value => time - value < windowMs);
      if (recent.length >= limit) return false;
      recent.push(time); records.set(intakeSessionId, { ...record, medicineScanAt: recent }); return true;
    },
    async saveMedicineScanResult({ intakeSessionId, uid, candidate, image = null }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      if (!record) return null;
      const result = medicineScanResult(candidate, now());
      records.set(intakeSessionId, { ...record, medicineInteraction: { state: 'scan_ready', result } });
      if (image) medicineImages.set(intakeSessionId, structuredClone(image));
      return structuredClone(result);
    },
    async savePatientEvidence({ intakeSessionId, uid, evidence }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      if (!record || !evidence || !/^[0-9a-f-]{36}$/.test(evidence.evidenceId || '')) return null;
      const existing = pendingEvidence.get(intakeSessionId) || [];
      const prior = existing.find(item => item.evidenceId === evidence.evidenceId);
      if (prior) return prior.kind === evidence.kind && prior.label === evidence.label && prior.patientDescription === evidence.patientDescription &&
        prior.mimeType === evidence.mimeType && prior.imageBase64 === evidence.imageBase64
        ? { evidenceId: prior.evidenceId, kind: prior.kind, label: prior.label, patientDescription: prior.patientDescription } : { conflict: true };
      if (existing.length >= 4) return null;
      existing.push({ ...structuredClone(evidence), imageBase64: evidence.imageBase64 }); pendingEvidence.set(intakeSessionId, existing);
      return { evidenceId: evidence.evidenceId, kind: evidence.kind, label: evidence.label, patientDescription: evidence.patientDescription };
    },
    async getPatientEvidence({ intakeSessionId, uid, patientCaseId }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      if (!record || record.patientCaseId !== patientCaseId) return [];
      return (pendingEvidence.get(intakeSessionId) || []).map(item => ({ evidenceId: item.evidenceId, kind: item.kind, label: item.label,
        patientDescription: item.patientDescription, mimeType: item.mimeType, byteLength: item.byteLength, capturedAt: item.capturedAt,
        bytes: Buffer.from(item.imageBase64, 'base64') }));
    },
    async getMedicineScanResult({ intakeSessionId, uid }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      return record?.medicineInteraction?.result ? structuredClone(record.medicineInteraction.result) : null;
    },
    async saveMedication({ intakeSessionId, uid, idempotencyKey, medication }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      if (!record) return null;
      if (record.medication) {
        if (record.medication.idempotencyKey !== idempotencyKey || !sameMedication(record.medication, medication)) return { conflict: true };
        return structuredClone(record.medication);
      }
      const saved = { ...structuredClone(medication), idempotencyKey, confirmedAt: new Date(now()).toISOString() };
      records.set(intakeSessionId, { ...record, medication: saved }); return structuredClone(saved);
    },
    async getMedication({ intakeSessionId, uid, patientCaseId }) {
      const record = records.get(intakeSessionId);
      return record?.uid === uid && record.patientCaseId === patientCaseId && record.medication ? structuredClone(record.medication) : null;
    },
    async saveAppointmentRequest({ intakeSessionId, uid, patientCaseId, idempotencyKey, selection, resourceVersion }) {
      const record = records.get(intakeSessionId);
      if (!idempotencyKeyPattern.test(idempotencyKey || '') || !selection || !activeRecord(record, { uid, now: now() }) || record.patientCaseId !== patientCaseId) return null;
      const input = { patientCaseId, idempotencyKey, selection };
      if (record.appointmentRequest) return sameAppointment(record.appointmentRequest, input) ? structuredClone(record.appointmentRequest) : { conflict: true };
      const saved = appointmentRequest({ intakeSessionId, uid, patientCaseId, idempotencyKey, selection, resourceVersion, timestamp: now() });
      records.set(intakeSessionId, { ...record, appointmentRequest: saved });
      return structuredClone(saved);
    },
    async getAppointmentRequest({ intakeSessionId, uid, patientCaseId }) {
      const record = records.get(intakeSessionId);
      return record?.uid === uid && (!patientCaseId || record.patientCaseId === patientCaseId) && record.appointmentRequest
        ? structuredClone(record.appointmentRequest) : null;
    },
    async getMedicineImage({ intakeSessionId, uid, patientCaseId }) {
      const record = records.get(intakeSessionId);
      const image = record?.uid === uid && record.patientCaseId === patientCaseId && record.medication ? medicineImages.get(intakeSessionId) : null;
      return image ? { mimeType: image.mimeType, byteLength: image.byteLength, bytes: Buffer.from(image.imageBase64, 'base64') } : null;
    },
    async discardMedicineImage({ intakeSessionId, uid, patientCaseId }) {
      const record = records.get(intakeSessionId);
      if (record?.uid === uid && record.patientCaseId === patientCaseId) medicineImages.delete(intakeSessionId);
    },
    async discardPatientEvidence({ intakeSessionId, uid, patientCaseId }) {
      const record = records.get(intakeSessionId);
      if (record?.uid === uid && record.patientCaseId === patientCaseId) pendingEvidence.delete(intakeSessionId);
    },
    async end({ intakeSessionId, uid }) {
      if (!validSessionId(intakeSessionId)) return;
      const record = records.get(intakeSessionId);
      if (record?.uid === uid) records.set(intakeSessionId, { ...record, endedAt: now() });
    },
    close() { records.clear(); medicineImages.clear(); pendingEvidence.clear(); },
  };
}

export function createFirestoreLiveSessionStore(db, { now = () => Date.now(), ttlMs = LIVE_SESSION_TTL_MS } = {}) {
  const collection = db.collection('liveSessions');
  const medicineImages = db.collection('pendingMedicineEvidence');
  const pendingEvidence = db.collection('pendingPatientEvidence');
  const cleanupExpired = async cutoff => {
    const expired = await collection.where('expiresAt', '<=', cutoff).limit(20).get();
    const expiredImages = await medicineImages.where('createdAt', '<=', cutoff - ACTIVE_INTAKE_TTL_MS).limit(20).get();
    const expiredEvidence = await pendingEvidence.where('createdAt', '<=', cutoff - ACTIVE_INTAKE_TTL_MS).limit(20).get();
    if (expired.empty && expiredImages.empty && expiredEvidence.empty) return;
    const batch = db.batch();
    for (const document of expired.docs) {
      const record = document.data();
      if (!record.consumedAt || record.endedAt || !Number.isFinite(record.activeUntil) || record.activeUntil <= cutoff) batch.delete(document.ref);
    }
    for (const document of expiredImages.docs) batch.delete(document.ref);
    for (const document of expiredEvidence.docs) batch.delete(document.ref);
    await batch.commit();
  };
  return {
    async create({ uid, roles, origin, path = '/api/live', preferredLanguage = DEFAULT_LIVE_LANGUAGE, resetGeneration = 0, resumeIntakeSessionId }) {
      if (!roles?.includes('patient')) return null;
      if (!isSupportedByLiveModel(preferredLanguage)) return null;
      const token = randomBytes(32).toString('base64url');
      const createdAt = now(), expiresAt = createdAt + ttlMs;
      await cleanupExpired(createdAt);
      const intakeSessionId = digest(token);
      const priorSnapshot = validSessionId(resumeIntakeSessionId) ? await collection.doc(resumeIntakeSessionId).get() : null;
      const prior = priorSnapshot?.exists ? priorSnapshot.data() : null;
      const resumable = prior?.uid === uid && prior.resetGeneration === resetGeneration && Number.isFinite(prior.activeUntil) && prior.activeUntil > createdAt && prior.questionPlan?.status !== 'ready_to_complete' && !prior.questionPlan?.emergency;
      const language = resumable ? prior.preferredLanguage : preferredLanguage;
      await collection.doc(intakeSessionId).create({ uid, role: 'patient', origin, path, purpose, patientCaseId: resumable ? prior.patientCaseId : newCaseId(), preferredLanguage: language, resetGeneration, createdAt, expiresAt, consumedAt: null, activeUntil: null, endedAt: null, medicineScanAt: [], ...(resumable ? { questionPlan: structuredClone(prior.questionPlan), ...(prior.intakeSnapshot ? { intakeSnapshot: structuredClone(prior.intakeSnapshot) } : {}), resumedFrom: resumeIntakeSessionId } : {}) });
      return { token, expiresAt, intakeSessionId, preferredLanguage: language, resumed: !!resumable };
    },
    async consume({ token, origin, path = '/api/live' }) {
      if (!tokenPattern.test(token || '')) return null;
      const ref = collection.doc(digest(token)), consumedAt = now();
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const record = snapshot.exists ? snapshot.data() : null;
        const identity = validateRecord(record, { origin, path, now: consumedAt, sessionId: digest(token) });
        if (!identity) { if (record?.expiresAt <= consumedAt) transaction.delete(ref); return null; }
        transaction.update(ref, { consumedAt, activeUntil: consumedAt + ACTIVE_INTAKE_TTL_MS });
        return identity;
      });
    },
    async resolveActive({ intakeSessionId, uid }) {
      if (!validSessionId(intakeSessionId)) return null;
      const snapshot = await collection.doc(intakeSessionId).get(), record = snapshot.exists ? snapshot.data() : null;
      return activeRecord(record, { uid, now: now() }) ? structuredClone(record) : null;
    },
    async getQuestionPlan({ intakeSessionId, uid }) {
      if (!validSessionId(intakeSessionId)) return null;
      const snapshot = await collection.doc(intakeSessionId).get(), record = snapshot.exists ? snapshot.data() : null;
      return record?.uid === uid && record.questionPlan ? structuredClone(record.questionPlan) : null;
    },
    async saveQuestionPlan({ intakeSessionId, uid, plan }) {
      if (!validSessionId(intakeSessionId) || !plan || !Number.isSafeInteger(plan.revision) || plan.revision < 0) return null;
      return db.runTransaction(async transaction => {
        const ref = collection.doc(intakeSessionId), snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null;
        if (!record || record.uid !== uid) return null;
        if ((record.questionPlan?.revision || 0) > plan.revision) return structuredClone(record.questionPlan);
        transaction.update(ref, { questionPlan: structuredClone(plan) }); return structuredClone(plan);
      });
    },
    async getIntakeSnapshot({ intakeSessionId, uid }) {
      if (!validSessionId(intakeSessionId)) return null;
      const snapshot = await collection.doc(intakeSessionId).get(), record = snapshot.exists ? snapshot.data() : null;
      return record?.uid === uid && record.intakeSnapshot ? structuredClone(record.intakeSnapshot) : null;
    },
    async saveIntakeSnapshot({ intakeSessionId, uid, intake }) {
      if (!validSessionId(intakeSessionId) || !intake || typeof intake !== 'object') return null;
      const ref = collection.doc(intakeSessionId), snapshot = await ref.get(), record = snapshot.exists ? snapshot.data() : null;
      if (!record || record.uid !== uid) return null;
      await ref.update({ intakeSnapshot: structuredClone(intake) }); return structuredClone(intake);
    },
    async takeMedicineScan({ intakeSessionId, uid, limit = 4, windowMs = 60_000 }) {
      if (!validSessionId(intakeSessionId)) return false;
      return db.runTransaction(async transaction => {
        const ref = collection.doc(intakeSessionId), snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null, time = now();
        if (!activeRecord(record, { uid, now: time })) return false;
        const recent = (record.medicineScanAt || []).filter(value => time - value < windowMs);
        if (recent.length >= limit) return false;
        recent.push(time); transaction.update(ref, { medicineScanAt: recent }); return true;
      });
    },
    async saveMedicineScanResult({ intakeSessionId, uid, candidate, image = null }) {
      if (!validSessionId(intakeSessionId)) return null;
      const ref = collection.doc(intakeSessionId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null, time = now();
        if (!activeRecord(record, { uid, now: time })) return null;
        const result = medicineScanResult(candidate, time);
        transaction.update(ref, { medicineInteraction: { state: 'scan_ready', result } });
        if (image) transaction.set(medicineImages.doc(intakeSessionId), { uid, mimeType: image.mimeType,
          imageBase64: image.imageBase64, byteLength: image.byteLength, createdAt: time });
        return result;
      });
    },
    async savePatientEvidence({ intakeSessionId, uid, evidence }) {
      if (!validSessionId(intakeSessionId) || !/^[0-9a-f-]{36}$/.test(evidence?.evidenceId || '')) return null;
      const sessionRef = collection.doc(intakeSessionId), evidenceRef = pendingEvidence.doc(`${intakeSessionId}-${evidence.evidenceId}`);
      return db.runTransaction(async transaction => {
        const sessionSnapshot = await transaction.get(sessionRef), evidenceSnapshot = await transaction.get(evidenceRef);
        const record = sessionSnapshot.exists ? sessionSnapshot.data() : null;
        if (!activeRecord(record, { uid, now: now() })) return null;
        if (evidenceSnapshot.exists) {
          const prior = evidenceSnapshot.data();
          return prior.kind === evidence.kind && prior.label === evidence.label && prior.patientDescription === evidence.patientDescription &&
            prior.mimeType === evidence.mimeType && prior.imageBase64 === evidence.imageBase64
            ? { evidenceId: prior.evidenceId, kind: prior.kind, label: prior.label, patientDescription: prior.patientDescription } : { conflict: true };
        }
        if ((record.patientEvidenceCount || 0) >= 4) return null;
        transaction.create(evidenceRef, { intakeSessionId, patientCaseId: record.patientCaseId, uid, ...evidence, createdAt: now() });
        transaction.update(sessionRef, { patientEvidenceCount: (record.patientEvidenceCount || 0) + 1 });
        return { evidenceId: evidence.evidenceId, kind: evidence.kind, label: evidence.label, patientDescription: evidence.patientDescription };
      });
    },
    async getPatientEvidence({ intakeSessionId, uid, patientCaseId }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      if (!record || record.patientCaseId !== patientCaseId) return [];
      const result = await pendingEvidence.where('intakeSessionId', '==', intakeSessionId).where('uid', '==', uid).limit(4).get();
      return result.docs.map(document => { const item = document.data(); return { evidenceId: item.evidenceId, kind: item.kind, label: item.label,
        patientDescription: item.patientDescription, mimeType: item.mimeType, byteLength: item.byteLength, capturedAt: item.capturedAt,
        bytes: Buffer.from(item.imageBase64, 'base64') }; });
    },
    async getMedicineScanResult({ intakeSessionId, uid }) {
      const record = await this.resolveActive({ intakeSessionId, uid });
      return record?.medicineInteraction?.result ? structuredClone(record.medicineInteraction.result) : null;
    },
    async saveMedication({ intakeSessionId, uid, idempotencyKey, medication }) {
      if (!validSessionId(intakeSessionId)) return null;
      return db.runTransaction(async transaction => {
        const ref = collection.doc(intakeSessionId), snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null;
        if (!activeRecord(record, { uid, now: now() })) return null;
        if (record.medication) return record.medication.idempotencyKey === idempotencyKey && sameMedication(record.medication, medication) ? structuredClone(record.medication) : { conflict: true };
        const saved = { ...structuredClone(medication), idempotencyKey, confirmedAt: new Date(now()).toISOString() };
        transaction.update(ref, { medication: saved }); return saved;
      });
    },
    async getMedication({ intakeSessionId, uid, patientCaseId }) {
      if (!validSessionId(intakeSessionId)) return null;
      const snapshot = await collection.doc(intakeSessionId).get(), record = snapshot.exists ? snapshot.data() : null;
      return record?.uid === uid && record.patientCaseId === patientCaseId && record.medication ? structuredClone(record.medication) : null;
    },
    async saveAppointmentRequest({ intakeSessionId, uid, patientCaseId, idempotencyKey, selection, resourceVersion }) {
      if (!validSessionId(intakeSessionId) || !idempotencyKeyPattern.test(idempotencyKey || '') || !selection) return null;
      return db.runTransaction(async transaction => {
        const ref = collection.doc(intakeSessionId), snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null;
        if (!activeRecord(record, { uid, now: now() }) || record.patientCaseId !== patientCaseId) return null;
        const input = { patientCaseId, idempotencyKey, selection };
        if (record.appointmentRequest) return sameAppointment(record.appointmentRequest, input) ? structuredClone(record.appointmentRequest) : { conflict: true };
        const saved = appointmentRequest({ intakeSessionId, uid, patientCaseId, idempotencyKey, selection, resourceVersion, timestamp: now() });
        transaction.update(ref, { appointmentRequest: saved });
        return saved;
      });
    },
    async getAppointmentRequest({ intakeSessionId, uid, patientCaseId }) {
      if (!validSessionId(intakeSessionId)) return null;
      const snapshot = await collection.doc(intakeSessionId).get(), record = snapshot.exists ? snapshot.data() : null;
      return record?.uid === uid && (!patientCaseId || record.patientCaseId === patientCaseId) && record.appointmentRequest
        ? structuredClone(record.appointmentRequest) : null;
    },
    async getMedicineImage({ intakeSessionId, uid, patientCaseId }) {
      if (!validSessionId(intakeSessionId)) return null;
      const snapshot = await collection.doc(intakeSessionId).get(), record = snapshot.exists ? snapshot.data() : null;
      const imageSnapshot = record?.uid === uid && record.patientCaseId === patientCaseId && record.medication ? await medicineImages.doc(intakeSessionId).get() : null;
      const image = imageSnapshot?.exists && imageSnapshot.data().uid === uid ? imageSnapshot.data() : null;
      return image ? { mimeType: image.mimeType, byteLength: image.byteLength, bytes: Buffer.from(image.imageBase64, 'base64') } : null;
    },
    async discardMedicineImage({ intakeSessionId, uid, patientCaseId }) {
      if (!validSessionId(intakeSessionId)) return;
      const sessionSnapshot = await collection.doc(intakeSessionId).get();
      const record = sessionSnapshot.exists ? sessionSnapshot.data() : null;
      if (record?.uid === uid && record.patientCaseId === patientCaseId) await medicineImages.doc(intakeSessionId).delete();
    },
    async discardPatientEvidence({ intakeSessionId, uid, patientCaseId }) {
      if (!validSessionId(intakeSessionId)) return;
      const record = await this.resolveActive({ intakeSessionId, uid });
      if (!record || record.patientCaseId !== patientCaseId) return;
      const results = await pendingEvidence.where('intakeSessionId', '==', intakeSessionId).where('uid', '==', uid).limit(4).get();
      if (results.empty) return;
      const batch = db.batch(); for (const document of results.docs) batch.delete(document.ref); await batch.commit();
    },
    async end({ intakeSessionId, uid }) {
      if (!validSessionId(intakeSessionId)) return;
      const ref = collection.doc(intakeSessionId);
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null;
        if (record?.uid === uid) transaction.update(ref, { endedAt: now() });
      });
    },
    close: () => db.terminate(),
  };
}

export function createConfiguredLiveSessionStore(env = process.env) {
  if (env.LIVE_SESSION_STORE === 'memory') return createMemoryLiveSessionStore();
  const config = environmentConfig(env);
  if (!config.projectId || env.LIVE_SESSION_STORE && env.LIVE_SESSION_STORE !== 'firestore') return null;
  return createFirestoreLiveSessionStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

export function liveSessionProtocol(request) {
  const values = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
  if (!values.includes(LIVE_PROTOCOL)) return null;
  const candidate = values.find(value => value.startsWith(tokenPrefix));
  const token = candidate?.slice(tokenPrefix.length);
  return tokenPattern.test(token || '') ? { token, protocol: LIVE_PROTOCOL } : null;
}

export function createLiveSessionLimiter({ now = () => Date.now(), windowMs = 60_000, perUid = 5, perOrigin = 20, outstandingPerUid = 3 } = {}) {
  const uidWindows = new Map(), originWindows = new Map(), outstanding = new Map();
  const take = (map, key, limit, time) => {
    const recent = (map.get(key) || []).filter(value => time - value < windowMs);
    if (recent.length >= limit) { map.set(key, recent); return false; }
    recent.push(time); map.set(key, recent); return true;
  };
  return {
    allow(uid, origin) {
      const time = now();
      const active = (outstanding.get(uid) || []).filter(value => value > time);
      if (active.length >= outstandingPerUid || !take(uidWindows, uid, perUid, time) || !take(originWindows, origin, perOrigin, time)) return false;
      active.push(time + LIVE_SESSION_TTL_MS); outstanding.set(uid, active); return true;
    },
  };
}

export function liveSessionEndpoint(store, { webSocketUrl, createEphemeralToken, allowedOrigins = [], limiter = createLiveSessionLimiter(), getResetState = async () => ({ status: 'idle', generation: 0 }), log = detail => console.info('[live-bootstrap]', JSON.stringify(detail)) } = {}) {
  const originPolicy = createOriginPolicy(allowedOrigins);
  return async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path !== '/api/live/session' || request.method !== 'POST') return false;
    const origin = originPolicy.validate(request.headers.origin);
    if (!store || !request.user?.roles?.includes('patient') || !origin || !browserSignalsAccept(request.headers) || !createEphemeralToken && !/^wss:\/\//.test(webSocketUrl || '')) {
      log({ outcome: 'rejected', reason: !origin ? 'origin' : !browserSignalsAccept(request.headers) ? 'browser_metadata' : 'authorization_or_configuration', origin: origin || null });
      response.writeHead(store ? 403 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: store ? 'LIVE_SESSION_REJECTED' : 'LIVE_UNAVAILABLE' }));
      return true;
    }
    if (!limiter.allow(request.user.uid, origin)) {
      log({ outcome: 'rejected', reason: 'rate_limit', origin });
      response.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '60' });
      response.end(JSON.stringify({ code: 'LIVE_SESSION_REJECTED' })); return true;
    }
    let raw = '';
    try {
      for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 2048) throw new Error('body_limit'); }
    } catch { response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ code: 'INVALID_LIVE_SESSION_OPTIONS' })); return true; }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { body = null; }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !['preferredLanguage', 'resumeIntakeSessionId'].includes(key)) ||
        body.resumeIntakeSessionId !== undefined && !validSessionId(body.resumeIntakeSessionId) ||
        body.preferredLanguage !== undefined && !isSupportedByLiveModel(body.preferredLanguage, process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live')) {
      response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ code: 'UNSUPPORTED_LIVE_LANGUAGE' })); return true;
    }
    const preferredLanguage = body.preferredLanguage || DEFAULT_LIVE_LANGUAGE;
    let reset;
    try { reset = await getResetState(); }
    catch { response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ code: 'DATA_RESET_STATE_UNAVAILABLE' })); return true; }
    if (reset?.status === 'purging') { response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30' }); response.end(JSON.stringify({ code: 'PURGE_IN_PROGRESS' })); return true; }
    const resetGeneration = Number.isSafeInteger(reset?.generation) && reset.generation >= 0 ? reset.generation : 0;
    const session = await store.create({ uid: request.user.uid, roles: request.user.roles, origin, preferredLanguage, resetGeneration, resumeIntakeSessionId: body.resumeIntakeSessionId });
    if (!session) { response.writeHead(403); response.end(); return true; }
    if (createEphemeralToken) {
      try {
        const identity = await store.consume({ token: session.token, origin, path: '/api/live' });
        if (!identity) throw new Error('LIVE_SESSION_UNAVAILABLE');
        const ephemeral = await createEphemeralToken();
        log({ outcome: 'issued_direct', origin, ttlMs: Date.parse(ephemeral.expiresAt) - Date.now() });
        response.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(JSON.stringify({ geminiToken: ephemeral.token, model: ephemeral.model, intakeSessionId: session.intakeSessionId,
          preferredLanguage: session.preferredLanguage || preferredLanguage, resumed: !!session.resumed, expiresAt: ephemeral.expiresAt }));
        return true;
      } catch (error) {
        log({ outcome: 'unavailable', reason: 'ephemeral_token', exceptionClass: error?.name || 'Error' });
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '5' });
        response.end(JSON.stringify({ code: 'LIVE_UNAVAILABLE' })); return true;
      }
    }
    log({ outcome: 'issued', origin, ttlMs: LIVE_SESSION_TTL_MS });
    response.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify({ token: session.token, intakeSessionId: session.intakeSessionId, preferredLanguage: session.preferredLanguage || preferredLanguage, resumed: !!session.resumed, expiresAt: new Date(session.expiresAt).toISOString(), webSocketUrl }));
    return true;
  };
}

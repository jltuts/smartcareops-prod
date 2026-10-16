import { Firestore, FieldPath } from '@google-cloud/firestore';
import { isDeepStrictEqual } from 'node:util';
import { CaseStoreError, createCaseService, createMemoryCaseStore } from './store.js';
import { environmentConfig } from '../environment.js';
import { activeEmergencyWorkflows, emergencyWorkflows } from '../../../shared/emergency.js';
import { demoFleet } from '../ambulance/fleet.js';
import { createConfiguredCloudEvidenceStore } from './cloud-storage.js';
import { caseCreatedOutboxRecord, caseLifecycleOutboxRecords } from '../events/case-events.js';

export function createFirestoreCaseStore(db, storage = 'firestore', { evidenceStore = null, operationsOutboxEnabled = false, clinicalNotificationOutboxEnabled = false, outboxCollection = 'eventOutbox' } = {}) {
  return createCaseService({
    async getFleet() { return Promise.all(demoFleet.map(async unit => { const doc = await db.collection('ambulances').doc(unit.unitId).get(); return doc.exists ? doc.data() : null; })); },
    transactAssignment(caseId, unitId, change) {
      const caseRef = db.collection('cases').doc(caseId), unitRef = db.collection('ambulances').doc(unitId);
      return db.runTransaction(async transaction => {
        // Read both documents before either write. Firestore retries on conflicts.
        const caseSnapshot = await transaction.get(caseRef), unitSnapshot = await transaction.get(unitRef);
        const previousCase = caseSnapshot.exists ? caseSnapshot.data() : null, previousUnit = unitSnapshot.exists ? unitSnapshot.data() : null;
        const next = change(previousCase, previousUnit);
        if (!isDeepStrictEqual(previousCase, next.case)) transaction.set(caseRef, next.case);
        if (!isDeepStrictEqual(previousUnit, next.unit)) {
          if (next.unit === null) transaction.delete(unitRef); else transaction.set(unitRef, next.unit);
        }
        return next;
      });
    },
    async get(id) { const doc = await db.collection('cases').doc(id).get(); return doc.exists ? doc.data() : null; },
    async listPatient({ patientUid, after, limit }) {
      let query = db.collection('cases').where('patientUid', '==', patientUid)
        .orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(limit);
      if (after) query = query.startAfter(after.createdAt, after.caseId);
      return (await query.get()).docs.map(doc => doc.data());
    },
    async listAppointmentNoticeCases({ recipientType, recipientUid, limit }) {
      const query = recipientType === 'patient' ? db.collection('cases').where('patientUid', '==', recipientUid) :
        db.collection('cases').where('appointmentNoticeDoctorUids', 'array-contains', recipientUid);
      return (await query.limit(limit).get()).docs.map(doc => doc.data());
    },
    ...(evidenceStore ? {
      async stagePatientEvidence(caseId, patientUid, image) { return evidenceStore.stage({ caseId, patientUid, ...image }); },
      async commitPatientEvidence(reference) { return evidenceStore.commit(reference); },
      async deletePatientEvidenceForCase(doc) { return evidenceStore.deleteReferences(doc?.patientEvidence || []); },
      async cleanupPatientEvidence(options = {}) {
        return evidenceStore.cleanupStaging({ ...options, isReferenced: async ({ caseId, evidenceId, reference }) => {
          if (!caseId || !evidenceId) return false;
          const snapshot = await db.collection('cases').doc(caseId).get();
          const item = snapshot.exists ? snapshot.data()?.patientEvidence?.find(value => value.evidenceId === evidenceId) : null;
          return item?.storageSource === 'gcs' && item.objectRef === reference.objectRef && item.checksum === reference.checksum;
        } });
      },
    } : {}),
    async putPatientEvidence(caseId, image) {
      await db.collection('caseEvidence').doc(`${caseId}-${image.evidenceId}`).create({
        caseId, evidenceId: image.evidenceId, kind: image.kind, mimeType: image.mimeType, byteLength: image.byteLength,
        bytes: Buffer.from(image.bytes), createdAt: image.capturedAt || new Date().toISOString(),
      });
    },
    async getPatientEvidence(caseId, evidenceId, metadata = null) {
      if (metadata?.storageSource === 'gcs') return evidenceStore?.read(metadata) || null;
      let snapshot = await db.collection('caseEvidence').doc(`${caseId}-${evidenceId}`).get();
      if (!snapshot.exists && evidenceId === 'medicine-package') snapshot = await db.collection('caseEvidence').doc(`${caseId}-medicine-package`).get();
      if (!snapshot.exists) return null;
      const value = snapshot.data();
      return { mimeType: value.mimeType, byteLength: value.byteLength, bytes: Buffer.from(value.bytes) };
    },
    async putMedicineImage(caseId, image) { return this.putPatientEvidence(caseId, { ...image, evidenceId: 'medicine-package', kind: 'medicine_package' }); },
    async getMedicineImage(caseId) { return this.getPatientEvidence(caseId, 'medicine-package'); },
    async listEmergency({ after, limit }) {
      let query = db.collection('cases').where('workflowStatus', 'in', activeEmergencyWorkflows)
        .orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(limit);
      if (after) query = query.startAfter(after.createdAt, after.caseId);
      return (await query.get()).docs.map(doc => doc.data());
    },
    async listEmergencyResponses({ limit }) {
      return (await db.collection('cases').where('workflowStatus', 'in', emergencyWorkflows).orderBy(FieldPath.documentId()).limit(limit).get()).docs.map(doc => doc.data());
    },
    async listRouted({ after, limit }) {
      let query = db.collection('cases').where('workflowStatus', 'in', ['submitted_for_clinical_review', 'routed_to_doctor']).orderBy(FieldPath.documentId()).limit(limit);
      if (after) query = query.startAfter(after);
      return (await query.get()).docs.map(doc => doc.data());
    },
    transact(id, change) {
      const ref = db.collection('cases').doc(id);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const previous = snapshot.exists ? snapshot.data() : null;
        const next = change(previous);
        if (snapshot.exists && isDeepStrictEqual(previous, next)) return next;
        if (snapshot.exists) transaction.set(ref, next); else transaction.create(ref, next);
        if (!snapshot.exists && operationsOutboxEnabled) {
          const record = caseCreatedOutboxRecord(next);
          transaction.create(db.collection(outboxCollection).doc(record.outboxId), record);
        }
        if (clinicalNotificationOutboxEnabled) {
          for (const record of caseLifecycleOutboxRecords(previous, next)) {
            transaction.create(db.collection(outboxCollection).doc(record.outboxId), record);
          }
        }
        return next;
      });
    },
    close: () => db.terminate(),
  }, storage, { chatSourceMarkerEnabled: clinicalNotificationOutboxEnabled });
}

// Initialized once by the server, shared by all completion/read/handoff calls.
// There is never an automatic downgrade from Firestore to memory.
export function createConfiguredCaseStore(env = process.env) {
  const config = environmentConfig(env);
  if (env.CASE_STORE === 'memory') return createMemoryCaseStore();
  const unavailable = createCaseService({ get() { throw new CaseStoreError(); }, transact() { throw new CaseStoreError(); } }, 'unavailable');
  if (env.CASE_STORE && env.CASE_STORE !== 'firestore') return unavailable;
  if (!config.projectId) return unavailable;
  if (env.FIRESTORE_EMULATOR_HOST && (config.environment === 'production' || env.NODE_ENV === 'production' || !/^(127\.0\.0\.1|localhost):\d{2,5}$/.test(env.FIRESTORE_EMULATOR_HOST))) return unavailable;
  const evidenceStore = env.FIRESTORE_EMULATOR_HOST ? null : createConfiguredCloudEvidenceStore(env);
  return createFirestoreCaseStore(new Firestore({ projectId: config.projectId, databaseId: config.database }), env.FIRESTORE_EMULATOR_HOST ? 'firestore_emulator' : 'firestore', {
    evidenceStore,
    operationsOutboxEnabled: env.M55_OPERATIONS_SOURCE_ENABLED === 'true',
    clinicalNotificationOutboxEnabled: env.M55_CASE_LIFECYCLE_SOURCE_ENABLED === 'true',
  });
}

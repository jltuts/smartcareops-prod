import { Firestore, FieldPath } from '@google-cloud/firestore';
import { isDeepStrictEqual } from 'node:util';
import { CaseStoreError, createCaseService, createMemoryCaseStore } from './store.js';
import { environmentConfig } from '../environment.js';
import { activeEmergencyWorkflows } from '../../../shared/emergency.js';
import { demoFleet } from '../ambulance/fleet.js';

export function createFirestoreCaseStore(db, storage = 'firestore') {
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
        if (!isDeepStrictEqual(previousUnit, next.unit)) transaction.set(unitRef, next.unit);
        return next;
      });
    },
    async get(id) { const doc = await db.collection('cases').doc(id).get(); return doc.exists ? doc.data() : null; },
    async listEmergency({ after, limit }) {
      let query = db.collection('cases').where('workflowStatus', 'in', activeEmergencyWorkflows).orderBy(FieldPath.documentId()).limit(limit);
      if (after) query = query.startAfter(after);
      return (await query.get()).docs.map(doc => doc.data());
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
        return next;
      });
    },
    close: () => db.terminate(),
  }, storage);
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
  return createFirestoreCaseStore(new Firestore({ projectId: config.projectId, databaseId: config.database }), env.FIRESTORE_EMULATOR_HOST ? 'firestore_emulator' : 'firestore');
}

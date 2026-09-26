import { Firestore } from '@google-cloud/firestore';
import { buckets, emptyWorkspace, memoryClinicalStore, firestoreClinicalStore } from '../clinical/storage.js';
import { environmentConfig } from '../environment.js';
export const recordBuckets = [...buckets, 'reports', 'snapshots'];
export const empty = () => ({ ...emptyWorkspace(), reports: {}, snapshots: {}, pressureEvidence: null, hospitalSource: null });
export function memoryRegionalStore(caseStore, readHospital, backing = new Map()) {
  return memoryClinicalStore(backing, () => caseStore.listAmbulances(), { empty, captureFleet: true, hydrate: async state => {
    const hospital = await readHospital(); const revision = hospital.meta?.currentRevisionId, plan = hospital.plans[revision];
    if (!state.resourceEnvironment && hospital.resourceEnvironment) state.resourceEnvironment = structuredClone(hospital.resourceEnvironment);
    state.hospitalSource = plan ? hospital.snapshots[`OPS-SNAPSHOT-${plan.snapshotVersion}`] : null;
    state.pressureEvidence = hospital.events[`hospital_pressure_${revision}`] || null;
  } });
}
export function firestoreRegionalStore(db) {
  return firestoreClinicalStore(db, { rootCollection: 'regionalWorkspaces', recordBuckets, empty, captureFleet: true, hydrate: async (state, get, database) => {
    const root = database.collection('hospitalWorkspaces').doc('OPS-HOSP-001'), meta = await get(root);
    if (!meta.exists || !meta.data().currentRevisionId) return;
    const revisionId = meta.data().currentRevisionId, plan = await get(root.collection('plans').doc(revisionId));
    if (!plan.exists) return;
    const [snapshot, signal] = await Promise.all([get(root.collection('snapshots').doc(`OPS-SNAPSHOT-${plan.data().snapshotVersion}`)), get(root.collection('events').doc(`hospital_pressure_${revisionId}`))]);
    state.hospitalSource = snapshot.exists ? snapshot.data() : null; state.pressureEvidence = signal.exists ? signal.data() : null;
  } });
}
export function configuredRegionalStore(env, caseStore) {
  const config = environmentConfig(env);
  if (config.environment !== 'development' || env.NODE_ENV === 'production') throw new Error('M11 is DEV only');
  if (env.CASE_STORE !== 'firestore' || !config.projectId || env.FIRESTORE_EMULATOR_HOST) throw new Error('M11 requires explicit DEV Firestore; tests use the memory factory');
  return firestoreRegionalStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

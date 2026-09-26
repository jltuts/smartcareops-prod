import { Firestore } from '@google-cloud/firestore';
import { buckets, emptyWorkspace, memoryClinicalStore, firestoreClinicalStore } from '../clinical/storage.js';
import { environmentConfig } from '../environment.js';
import { projectCase } from './snapshot.js';
export const recordBuckets = [...buckets, 'members', 'snapshots'];
export const empty = () => ({ ...emptyWorkspace(), members: {}, snapshots: {}, caseEvidence: [] });
export function memoryOperationsStore(caseStore, backing = new Map()) {
  return memoryClinicalStore(backing, () => caseStore.listAmbulances(), { empty, captureFleet: true, hydrate: async state => {
    state.caseEvidence = await Promise.all(Object.values(state.members).sort((a, b) => a.caseId.localeCompare(b.caseId)).map(async member => projectCase(await caseStore.getCase(member.caseId), member)));
  } });
}
export function firestoreOperationsStore(db) {
  return firestoreClinicalStore(db, { rootCollection: 'hospitalWorkspaces', recordBuckets, empty, captureFleet: true, hydrate: async (state, get, database) => {
    state.caseEvidence = await Promise.all(Object.values(state.members).sort((a, b) => a.caseId.localeCompare(b.caseId)).map(async member => {
      const doc = await get(database.collection('cases').doc(member.caseId)); return projectCase(doc.exists ? doc.data() : null, member);
    }));
  } });
}
export function configuredOperationsStore(env, caseStore) {
  const config = environmentConfig(env);
  if (config.environment !== 'development' || env.NODE_ENV === 'production') throw new Error('M10 is DEV only');
  if (env.CASE_STORE === 'memory') return memoryOperationsStore(caseStore);
  if (env.CASE_STORE !== 'firestore' || !config.projectId || env.FIRESTORE_EMULATOR_HOST) throw new Error('M10 storage unavailable');
  return firestoreOperationsStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

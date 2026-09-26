import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from '../environment.js';

const clone = value => value == null ? null : structuredClone(value);
const STORE_ERROR = 'PREDICTIVE_STORE_UNAVAILABLE';
export function createMemoryPredictiveStore(initial = null) {
  let value = clone(initial);
  return { async get() { return clone(value); }, async save(next) { value = clone(next); return clone(value); },
    async close() {} };
}
export function createFirestorePredictiveStore(db) {
  const ref = db.collection('simulationStates').doc('m17-predictive');
  return { async get() { const snapshot = await ref.get(); return snapshot.exists ? snapshot.data() : null; },
    async save(value) { await db.runTransaction(async transaction => transaction.set(ref, value)); return clone(value); },
    close() { return db.terminate(); } };
}
export function createConfiguredPredictiveStore(env = process.env) {
  if (env.CASE_STORE === 'memory') return createMemoryPredictiveStore();
  const config = environmentConfig(env);
  if (config.environment !== 'development' || !config.projectId || env.FIRESTORE_EMULATOR_HOST && env.NODE_ENV === 'production') throw new Error(STORE_ERROR);
  return createFirestorePredictiveStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

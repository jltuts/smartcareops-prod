import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from '../environment.js';

const clone = value => value == null ? null : structuredClone(value);
const document = Object.freeze({ collection: 'simulationStates', id: 'm18-pattern-intelligence' });

export function createMemoryPatternStore(initial = null) {
  let value = clone(initial);
  return { async get() { return clone(value); }, async save(next) { value = clone(next); return clone(value); }, async close() {} };
}

export function createFirestorePatternStore(db) {
  const ref = db.collection(document.collection).doc(document.id);
  return { async get() { const snapshot = await ref.get(); return snapshot.exists ? snapshot.data() : null; },
    async save(next) { await db.runTransaction(async transaction => transaction.set(ref, next)); return clone(next); },
    close() { return db.terminate(); } };
}

export function createConfiguredPatternStore(env = process.env) {
  if (env.CASE_STORE === 'memory') return createMemoryPatternStore();
  const config = environmentConfig(env);
  if (config.environment !== 'development' || !config.projectId || env.FIRESTORE_EMULATOR_HOST && (env.NODE_ENV === 'production' || config.environment === 'production')) {
    throw new Error('PATTERN_STORE_UNAVAILABLE');
  }
  return createFirestorePatternStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}


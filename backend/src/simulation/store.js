import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from '../environment.js';
import { createInitialSimulationState } from './engine.js';

const documentPath = Object.freeze({ collection: 'simulationStates', id: 'm15-healthcare-network' });
const clone = value => structuredClone(value);

export function createMemorySimulationStore({ initial = () => createInitialSimulationState() } = {}) {
  let state = null, pending = Promise.resolve();
  return {
    async get() { state ||= initial(); return clone(state); },
    transact(change) {
      const work = pending.then(async () => {
        const current = state ? clone(state) : initial();
        const next = await change(current);
        state = clone(next); return clone(state);
      });
      pending = work.catch(() => {}); return work;
    },
    async close() {},
  };
}

export function createFirestoreSimulationStore(db, { initial = () => createInitialSimulationState() } = {}) {
  const ref = db.collection(documentPath.collection).doc(documentPath.id);
  return {
    async get() {
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) return snapshot.data();
        const state = initial(); transaction.create(ref, state); return state;
      });
    },
    transact(change) {
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), current = snapshot.exists ? snapshot.data() : initial();
        const next = await change(clone(current));
        transaction.set(ref, next); return next;
      });
    },
    close: () => db.terminate(),
  };
}

export function createConfiguredSimulationStore(env = process.env) {
  if (env.CASE_STORE === 'memory') return createMemorySimulationStore();
  const config = environmentConfig(env);
  if (env.CASE_STORE !== 'firestore' || !config.projectId || env.FIRESTORE_EMULATOR_HOST && (env.NODE_ENV === 'production' || config.environment === 'production')) {
    return { async get() { throw new Error('SIMULATION_STORE_UNAVAILABLE'); }, async transact() { throw new Error('SIMULATION_STORE_UNAVAILABLE'); }, async close() {} };
  }
  return createFirestoreSimulationStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

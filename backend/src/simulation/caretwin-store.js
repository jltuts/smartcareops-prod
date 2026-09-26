import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from '../environment.js';

const path = Object.freeze({ collection: 'simulationStates', id: 'm16-caretwin' });
const clone = value => value == null ? null : structuredClone(value);
export class CareTwinStoreError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

export function createMemoryCareTwinStore(initial = null) {
  let value = clone(initial), pending = Promise.resolve();
  return {
    async get() { return clone(value); },
    async save(next) { value = clone(next); return clone(value); },
    update(generationId, change) {
      const work = pending.then(async () => {
        if (!value || value.generationId !== generationId) throw new CareTwinStoreError('CARETWIN_STALE_GENERATION');
        value = clone(await change(clone(value))); return clone(value);
      });
      pending = work.catch(() => {}); return work;
    },
    async close() {},
  };
}

export function createFirestoreCareTwinStore(db) {
  const ref = db.collection(path.collection).doc(path.id);
  return {
    async get() { const snapshot = await ref.get(); return snapshot.exists ? snapshot.data() : null; },
    save(value) { return db.runTransaction(async transaction => { transaction.set(ref, value); return value; }); },
    update(generationId, change) {
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), current = snapshot.exists ? snapshot.data() : null;
        if (!current || current.generationId !== generationId) throw new CareTwinStoreError('CARETWIN_STALE_GENERATION');
        const next = await change(clone(current)); transaction.set(ref, next); return next;
      });
    },
    close: () => db.terminate(),
  };
}

export function createConfiguredCareTwinStore(env = process.env) {
  const config = environmentConfig(env);
  if (env.CASE_STORE === 'memory') return createMemoryCareTwinStore();
  if (config.environment !== 'development' || !config.projectId || env.FIRESTORE_EMULATOR_HOST && (env.NODE_ENV === 'production' || config.environment === 'production')) {
    throw new CareTwinStoreError('CARETWIN_STORE_UNAVAILABLE', 503);
  }
  return createFirestoreCareTwinStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

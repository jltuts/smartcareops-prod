import { Firestore } from '@google-cloud/firestore';
import { isDeepStrictEqual } from 'node:util';
import { environmentConfig } from '../environment.js';
import { digest } from './contracts.js';
import { demoFleet } from '../ambulance/fleet.js';
import { currentEmergency } from '../cases/store.js';
import { notificationBuckets } from '../notifications/lifecycle.js';

// Deliberately bounded, single-patient workspaces. No original case is modified.
export const buckets = ['observations', 'events', 'agentRuns', 'plans', 'approvals', 'toolExecutions', 'monitoring', 'receipts', 'resourceSnapshots', ...notificationBuckets];
export const emptyWorkspace = () => ({ meta: null, resourceEnvironment: null, fleetEvidenceVersion: null, ...Object.fromEntries(buckets.map(key => [key, {}])) });
const fleetVersion = units => 'fleet:' + digest(units.map(({ unitId, status }) => ({ unitId, status })).sort((a, b) => a.unitId.localeCompare(b.unitId)));
export function memoryClinicalStore(backing = new Map(), readFleet, { empty = emptyWorkspace, hydrate, captureFleet = false, readCase } = {}) {
  let tail = Promise.resolve();
  const read = async id => {
    const state = structuredClone(backing.get(id) || empty());
    if (state.resourceEnvironment && readFleet) {
      const units = (await readFleet()).units;
      state.fleetEvidenceVersion = fleetVersion(units);
      if (captureFleet) state.fleetEvidence = units.map(({ unitId, status }) => ({ unitId, status }));
    }
    if (hydrate) await hydrate(state);
    if (readCase) {
      const patient = await readCase(id);
      state.notificationCaseState = { caseId: id, acknowledgedEmergency: Boolean(patient?.source === 'smartcareops_demo' && patient.emergency?.status === 'acknowledged' && ['emergency_acknowledged', 'ambulance_assigned', 'ambulance_en_route'].includes(patient.workflowStatus)) };
    }
    return state;
  };
  return {
    storage: 'memory', backing,
    read,
    transaction(id, change) {
      const work = tail.then(async () => {
        const state = await read(id);
        const result = change(state);
        if (result instanceof Promise) throw new Error('Transaction must be synchronous');
        backing.set(id, state); return structuredClone(result);
      });
      tail = work.catch(() => {}); return work;
    },
    async close() {},
  };
}
export function firestoreClinicalStore(db, { rootCollection = 'clinicalWorkspaces', recordBuckets = buckets, empty = emptyWorkspace, hydrate, captureFleet = false, captureCase = false } = {}) {
  const root = id => db.collection(rootCollection).doc(id);
  async function read(id, transaction) {
    const ref = root(id), get = query => transaction ? transaction.get(query) : query.get();
    const [doc, resourceDoc, ...snapshots] = await Promise.all([get(ref), get(db.collection('resourceEnvironments').doc('m9-demo')), ...recordBuckets.map(key => get(ref.collection(key).limit(201)))]);
    const state = empty(); state.meta = doc.exists ? doc.data() : null;
    state.resourceEnvironment = resourceDoc.exists ? resourceDoc.data() : null;
    if (state.resourceEnvironment) {
      // Read M7 reservation documents inside the SAME transaction as approval and
      // receipt writes. A concurrent reservation conflicts and forces revalidation.
      const fleet = await Promise.all(demoFleet.map(unit => get(db.collection('ambulances').doc(unit.unitId))));
      const units = fleet.map((doc, index) => ({ unitId: demoFleet[index].unitId, status: doc.exists ? 'assigned' : 'available' }));
      state.fleetEvidenceVersion = fleetVersion(units);
      if (captureFleet) state.fleetEvidence = units;
    }
    snapshots.forEach((snapshot, index) => {
      if (snapshot.docs.length > 200) throw new Error('Workspace capacity exceeded');
      state[recordBuckets[index]] = Object.fromEntries(snapshot.docs.map(item => [item.id, item.data()]));
    });
    if (hydrate) await hydrate(state, get, db);
    if (captureCase) { const patient = await get(db.collection('cases').doc(id)); const data = patient.exists ? patient.data() : null;
      state.notificationCaseState = { caseId: id, acknowledgedEmergency: Boolean(data && currentEmergency(data) && data.emergency.status === 'acknowledged') }; }
    return state;
  }
  return {
    storage: 'firestore', read,
    transaction(id, change) {
      return db.runTransaction(async transaction => {
        const before = await read(id, transaction), state = structuredClone(before);
        const result = change(state);
        if (result instanceof Promise) throw new Error('Transaction must be synchronous');
        const ref = root(id);
        if (!isDeepStrictEqual(before, state)) {
          // All writers touch this version; concurrent claims/observations conflict.
          state.meta.storageVersion = (before.meta?.storageVersion || 0) + 1;
          transaction.set(ref, state.meta);
          if (!isDeepStrictEqual(before.resourceEnvironment, state.resourceEnvironment)) transaction.set(db.collection('resourceEnvironments').doc('m9-demo'), state.resourceEnvironment);
          for (const key of recordBuckets) for (const [recordId, record] of Object.entries(state[key])) {
            if (!isDeepStrictEqual(record, before[key][recordId])) transaction.set(ref.collection(key).doc(recordId), record);
          }
        }
        return result;
      });
    },
    close: () => db.terminate(),
  };
}
export function configuredClinicalStore(env = process.env, { readFleet, readCase, captureCase = false } = {}) {
  const config = environmentConfig(env);
  if (config.environment !== 'development') throw new Error('Clinical reasoning is DEV only');
  if (env.CASE_STORE === 'memory') return memoryClinicalStore(new Map(), readFleet, { readCase: captureCase ? readCase : undefined });
  if (env.CASE_STORE !== 'firestore' || !config.projectId || env.FIRESTORE_EMULATOR_HOST) throw new Error('M8 storage unavailable');
  return firestoreClinicalStore(new Firestore({ projectId: config.projectId, databaseId: config.database }), { captureCase });
}

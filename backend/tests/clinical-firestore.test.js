import test from 'node:test';
import assert from 'node:assert/strict';
import { firestoreClinicalStore } from '../src/clinical/storage.js';
import { createClinicalService } from '../src/clinical/service.js';
import { fixture, observationSet } from './clinical-fixtures.js';
import { resourceFixture } from './resources-fixtures.js';

// Contract fake asserts read-before-write, atomic commit and fresh-client durability.
function database() {
  const documents = new Map(); let tail = Promise.resolve(), fail = false;
  const snapshot = path => ({ id: path.split('/').at(-1), exists: documents.has(path), data: () => structuredClone(documents.get(path)) });
  const ref = path => ({ path, collection: name => collection(`${path}/${name}`), get: async () => snapshot(path) });
  const collection = path => ({ doc: id => ref(`${path}/${id}`), limit: limit => ({ path, limit, get: async () => query(path, limit) }) });
  const query = (path, limit) => ({ docs: [...documents.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).slice(0, limit).map(snapshot) });
  return { documents, failNext() { fail = true; }, collection,
    runTransaction(change) {
      const work = tail.then(async () => {
        const writes = [];
        const result = await change({ async get(target) { assert.equal(writes.length, 0); return target.limit ? query(target.path, target.limit) : snapshot(target.path); }, set(target, value) { writes.push([target.path, structuredClone(value)]); } });
        if (fail) { fail = false; throw new Error('Storage unavailable'); }
        for (const [path, value] of writes) documents.set(path, value); return result;
      }); tail = work.catch(() => {}); return work;
    }, async terminate() {},
  };
}
test('Firestore event/observation atomic commit, separate service resumes and receipt survives another client', async () => {
  const f = await fixture(), db = database(), store = firestoreClinicalStore(db), service = createClinicalService({ ...f, store });
  await service.enroll(); db.failNext(); await assert.rejects(service.append(observationSet()));
  assert.equal((await service.view()).observations.length, 0); assert.equal((await service.view()).events.length, 0);
  await service.append(observationSet());
  const restarted = createClinicalService({ ...f, store: firestoreClinicalStore(db) }); await restarted.tick();
  const first = await restarted.view(), id = first.approvals[0].approvalId;
  await restarted.decide(id, 'approved'); await restarted.execute(id);
  const third = createClinicalService({ ...f, store: firestoreClinicalStore(db) }); await third.append(observationSet()); await third.tick();
  assert.equal((await third.view()).receipts.length, 1);
  const rawPlan = (await store.read(f.caseId)).plans.revision_1;
  await third.append(observationSet('setB', 88)); await third.tick();
  assert.deepEqual((await store.read(f.caseId)).plans.revision_1, rawPlan);
  assert.equal((await third.view()).plans[0].status, 'superseded');
});

test('Firestore capacity and event commit atomically; fresh worker replans without rewriting history or receipts', async () => {
  const f = await resourceFixture(), db = database(), store = firestoreClinicalStore(db), service = createClinicalService({ ...f, store });
  await service.append(observationSet()); await service.tick();
  const first = await store.read(f.caseId), id = Object.keys(first.approvals)[0];
  await service.decide(id, 'approved'); await service.execute(id);
  const receipts = (await store.read(f.caseId)).receipts;
  const input = { requestId: 'firestoreCapacity', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 1 };
  db.failNext(); await assert.rejects(service.changeCapacity(input));
  assert.equal((await store.read(f.caseId)).resourceEnvironment.version, 1);
  assert.equal((await store.read(f.caseId)).events.resource_firestoreCapacity, undefined);
  await service.changeCapacity(input);
  assert.equal(db.documents.get('resourceEnvironments/m9-demo').hospitals[0].capacity.monitoredBedsAvailable, 0);
  const restarted = createClinicalService({ ...f, store: firestoreClinicalStore(db) }); await restarted.tick();
  await restarted.changeCapacity(input); await restarted.tick();
  const after = await firestoreClinicalStore(db).read(f.caseId);
  assert.equal(Object.keys(after.plans).length, 2); assert.deepEqual(after.plans.revision_1, first.plans.revision_1);
  assert.deepEqual(after.receipts, receipts); assert.equal(after.events.resource_firestoreCapacity.status, 'completed');
});

test('Firestore M7 reservation change blocks an approved clinical effect and triggers a resource replan', async () => {
  const f = await resourceFixture(), db = database(), store = firestoreClinicalStore(db), service = createClinicalService({ ...f, store });
  await service.append(observationSet()); await service.tick();
  const first = await service.view(), id = first.approvals[0].approvalId; await service.decide(id, 'approved');
  // Another domain service reserves a previously available unit.
  db.documents.set('ambulances/AMB-02', { unitId: 'AMB-02', status: 'assigned' });
  await assert.rejects(service.execute(id), { code: 'STALE_APPROVAL' });
  await service.tick(); const after = await service.view();
  assert.equal(after.receipts.length, 0); assert.equal(after.approvals[0].status, 'superseded');
  assert.equal(after.plans.length, 2); assert.notEqual(after.plans[0].fleetEvidenceVersion, after.plans[1].fleetEvidenceVersion);
});

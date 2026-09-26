import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreUserProfileStore } from '../src/user-profiles.js';

function firestoreFake() {
  const records = new Map();
  const db = {
    collection(name) {
      assert.equal(name, 'userProfiles');
      return { doc: id => ({ id, get: async () => ({ exists: records.has(id), data: () => structuredClone(records.get(id)) }) }) };
    },
    runTransaction: callback => callback({
      async get(ref) { return { exists: records.has(ref.id), data: () => structuredClone(records.get(ref.id)) }; },
      create(ref, value) { if (records.has(ref.id)) throw new Error('duplicate'); records.set(ref.id, structuredClone(value)); },
      set(ref, value) { records.set(ref.id, structuredClone(value)); },
    }),
    async terminate() {},
  };
  return { db, records };
}

test('Firestore profile provisioning creates one backend-owned active Patient record', async () => {
  const { db, records } = firestoreFake();
  const store = createFirestoreUserProfileStore(db, { now: () => Date.parse('2026-09-25T00:00:00.000Z') });
  const identity = { uid: 'firebase-uid', email: 'patient@example.invalid', name: 'Patient Name', roles: ['doctor'], status: 'admin' };
  const first = await store.provisionPatient(identity), second = await store.provisionPatient({ ...identity, roles: ['admin'] });
  assert.deepEqual(first.roles, ['patient']); assert.deepEqual(second, first); assert.equal(records.size, 1);
  assert.deepEqual(records.get('firebase-uid'), { uid: 'firebase-uid', email: 'patient@example.invalid', displayName: 'Patient Name', roles: ['patient'], status: 'active', createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' });
});

test('own profile update derives display name and preserves backend-owned and unrelated fields', async () => {
  const { db, records } = firestoreFake();
  records.set('firebase-uid', { uid: 'firebase-uid', email: 'fixed@example.invalid', displayName: 'Google Name', roles: ['patient', 'doctor'], status: 'active', approvalState: 'approved', createdAt: 'earlier', updatedAt: 'earlier' });
  const store = createFirestoreUserProfileStore(db, { now: () => Date.parse('2026-09-25T02:00:00.000Z') });
  const profile = await store.updateOwnProfile('firebase-uid', { firstName: '  John Louis ', middleName: '', lastName: ' Garcia ', birthday: '1990-05-10', addressLine1: '123 José Rizal St.', addressLine2: '', cityMunicipality: 'Quezon City', provinceState: 'Metro Manila', postalCode: '', country: 'Philippines' });
  assert.equal(profile.displayName, 'John Louis Garcia'); assert.equal(profile.middleName, undefined); assert.equal(profile.birthday, '1990-05-10');
  assert.deepEqual(profile.roles, ['patient', 'doctor']); assert.equal(profile.email, 'fixed@example.invalid'); assert.equal(profile.uid, 'firebase-uid');
  assert.equal(records.get('firebase-uid').approvalState, 'approved'); assert.equal(records.get('firebase-uid').createdAt, 'earlier');
});

test('profile validation supports Unicode names and rejects missing names, future birthday and protected fields', async () => {
  const records = new Map([['user', { uid: 'user', email: null, displayName: 'Old', roles: ['patient'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const store = (await import('../src/user-profiles.js')).createMemoryUserProfileStore(records);
  const valid = await store.updateOwnProfile('user', { firstName: "Anne-Marie", middleName: 'Zoë', lastName: "D’Ávila", birthday: '', addressLine1: '', addressLine2: '', cityMunicipality: '', provinceState: '', postalCode: '', country: '' });
  assert.equal(valid.displayName, "Anne-Marie Zoë D’Ávila");
  for (const patch of [{ firstName: '', lastName: 'Garcia' }, { firstName: 'John', lastName: '' }, { firstName: 'John', lastName: 'Garcia', birthday: '2999-01-01' }, { firstName: 'John', lastName: 'Garcia', roles: ['doctor'] }]) await assert.rejects(() => store.updateOwnProfile('user', patch));
});

test('profile identity lookup returns only safe structured display fields', async () => {
  const { db, records } = firestoreFake();
  records.set('patient-1', { uid: 'patient-1', email: 'private@example.invalid', displayName: 'John Garcia', firstName: 'John Louis', middleName: 'Miguel', lastName: 'Garcia', roles: ['patient'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' });
  const identity = await createFirestoreUserProfileStore(db).getPatientIdentity('patient-1');
  assert.deepEqual(identity, { displayName: 'John Garcia', firstName: 'John Louis', middleName: 'Miguel', lastName: 'Garcia' });
  assert.ok(!Object.hasOwn(identity, 'uid') && !Object.hasOwn(identity, 'email') && !Object.hasOwn(identity, 'roles'));
});

test('Firestore profile provisioning preserves backend-owned inactive and privileged state', async () => {
  const { db, records } = firestoreFake();
  const existing = { uid: 'firebase-uid', email: null, displayName: null, roles: ['patient', 'doctor'], status: 'inactive', createdAt: 'earlier', updatedAt: 'earlier' };
  records.set(existing.uid, structuredClone(existing));
  const profile = await createFirestoreUserProfileStore(db).provisionPatient({ uid: existing.uid, email: 'spoof@example.invalid', name: 'Spoof' });
  assert.deepEqual(profile, existing); assert.deepEqual(records.get(existing.uid), existing);
});

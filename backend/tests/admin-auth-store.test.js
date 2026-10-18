import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseAuthAccountStore } from '../src/admin/auth-store.js';

const google = (uid, email) => ({ uid, email, providerData: [{ providerId: 'google.com' }] });

test('Google account purge preserves the two protected accounts and deletes only other Google identities', async () => {
  const users = [
    google('john-uid', 'JohnLouisGarcia@gmail.com'),
    google('che-uid', 'changed-address@example.com'),
    google('patient-uid', 'patient@example.com'),
    google('doctor-uid', 'doctor@example.com'),
    { uid: 'password-uid', email: 'password@example.com', providerData: [{ providerId: 'password' }] },
  ];
  const deleted = [];
  const auth = {
    async listUsers() { return { users, pageToken: undefined }; },
    async deleteUsers(uids) { deleted.push(...uids); return { successCount: uids.length, failureCount: 0, errors: [] }; },
  };
  const store = createFirebaseAuthAccountStore(auth, {
    protectedEmails: ['johnlouisgarcia@gmail.com', 'chebulay.12@gmail.com'],
    protectedUids: ['john-uid', 'che-uid'],
  });
  const preview = await store.previewPurge();
  assert.equal(preview.count, 2); assert.equal(preview.preservedCount, 2);
  assert.equal(await store.purgeAll({ expectedVersion: preview.version }), 2);
  assert.deepEqual(deleted.sort(), ['doctor-uid', 'patient-uid']);
});

test('Google account purge rejects a changed inventory before deleting an account', async () => {
  const users = [google('patient-uid', 'patient@example.com')];
  const auth = {
    async listUsers() { return { users, pageToken: undefined }; },
    async deleteUsers() { throw new Error('must not delete'); },
  };
  const store = createFirebaseAuthAccountStore(auth);
  const preview = await store.previewPurge();
  users.push(google('doctor-uid', 'doctor@example.com'));
  await assert.rejects(store.purgeAll({ expectedVersion: preview.version }), error => error.code === 'AUTH_PURGE_STALE');
});

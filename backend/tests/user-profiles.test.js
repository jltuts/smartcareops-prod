import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreUserProfileStore, createMemoryUserProfileStore } from '../src/user-profiles.js';

function firestoreFake() {
  const records = new Map();
  const settings = new Map();
  const db = {
    collection(name) {
      const source = name === 'userProfiles' ? records : settings;
      return { doc: id => ({ id, source, get: async () => ({ exists: source.has(id), data: () => structuredClone(source.get(id)) }), set: async value => source.set(id, structuredClone(value)) }),
        where(field, operator, value) { return { get: async () => ({ docs: [...records.values()].filter(item => field === 'roles' ? operator === 'array-contains' && item.roles?.includes(value) : field === 'doctorApplication.status' ? operator === '==' && item.doctorApplication?.status === value : field === 'patientApplication.status' ? operator === '==' && item.patientApplication?.status === value : false).map(item => ({ data: () => structuredClone(item) })) }) }; } };
    },
    runTransaction: callback => callback({
      async get(ref) { return ref.get(); },
      create(ref, value) { if (ref.source.has(ref.id)) throw new Error('duplicate'); ref.source.set(ref.id, structuredClone(value)); },
      set(ref, value) { ref.source.set(ref.id, structuredClone(value)); },
    }),
    async terminate() {},
  };
  return { db, records, settings };
}

test('approved Doctor directory is verification-owned, newest-first, minimal, and paginated in both stores', async () => {
  const verified = (uid, approvedAt, overrides = {}) => ({ uid, email: `${uid}@example.invalid`, displayName: 'Editable profile name',
    specialty: 'orthopedics', status: 'active', roles: ['patient', 'doctor'],
    doctorVerification: { status: 'verified', displayName: `Dr. ${uid}`, specialty: 'orthopedics', verifiedAt: approvedAt, verifiedBy: 'admin-uid' },
    doctorApplication: { status: 'approved' }, privateNote: 'never return', ...overrides });
  const entries = [
    verified('older', '2026-09-28T00:00:00.000Z'), verified('newer', '2026-09-30T00:00:00.000Z'),
    verified('rejected', '2026-10-01T00:00:00.000Z', { doctorApplication: { status: 'rejected' } }),
    verified('unverified', '2026-10-01T00:00:00.000Z', { doctorVerification: { status: 'pending' } }),
    verified('inactive', '2026-10-01T00:00:00.000Z', { status: 'inactive' }),
    verified('wrong-specialty', '2026-10-01T00:00:00.000Z', { specialty: 'general_medicine' }),
  ];
  const { db, records } = firestoreFake();
  for (const entry of entries) records.set(entry.uid, structuredClone(entry));
  for (const store of [createMemoryUserProfileStore(new Map(entries.map(entry => [entry.uid, structuredClone(entry)]))), createFirestoreUserProfileStore(db)]) {
    const first = await store.listApprovedDoctors({ limit: 1 });
    assert.deepEqual(first.records, [{ uid: 'newer', email: 'newer@example.invalid', displayName: 'Dr. newer', specialty: 'orthopedics', specialties: ['orthopedics'], status: 'approved', approvedAt: '2026-09-30T00:00:00.000Z' }]);
    assert.equal(first.nextCursor, 'newer');
    const second = await store.listApprovedDoctors({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.records[0].uid, 'older'); assert.equal(second.nextCursor, null);
    await assert.rejects(store.listApprovedDoctors({ limit: 1, cursor: 'missing' }), { code: 'INVALID_ADMIN_QUERY' });
  }
});

test('an approved Doctor can add a separately verified specialty without losing the first', async () => {
  const original = { uid: 'multi-doctor', email: 'doctor@example.invalid', displayName: 'Dr. Louie', specialty: 'orthopedics', roles: ['patient', 'doctor'], status: 'active',
    doctorVerification: { status: 'verified', specialty: 'orthopedics', displayName: 'Dr. Louie', verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBy: 'admin-uid' },
    doctorApplication: { status: 'approved', displayName: 'Dr. Louie', specialty: 'orthopedics', submittedAt: '2026-09-28T00:00:00.000Z', version: 1 } };
  const { db, records } = firestoreFake(); records.set(original.uid, structuredClone(original));
  for (const store of [createMemoryUserProfileStore(new Map([[original.uid, structuredClone(original)]])), createFirestoreUserProfileStore(db)]) {
    const pending = await store.submitDoctorApplication(original.uid, { displayName: 'Dr. Louie', specialty: 'general_medicine' });
    assert.deepEqual(pending.specialties, ['orthopedics']); assert.equal(pending.doctorApplication.status, 'pending');
    const approved = await store.reviewDoctorApplication(original.uid, { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' });
    assert.deepEqual(approved.specialties, ['general_medicine', 'orthopedics']);
    assert.equal(approved.specialty, 'orthopedics'); assert.equal(approved.roles.includes('doctor'), true);
    await assert.rejects(store.submitDoctorApplication(original.uid, { displayName: 'Dr. Louie', specialty: 'general_medicine' }), { code: 'DOCTOR_ACCESS_ALREADY_GRANTED' });
  }
});

test('Admin removes one verified Doctor specialty and removes Doctor access only after the final specialty', async () => {
  const verification = specialty => ({ status: 'verified', specialty, displayName: 'Dr. Louie', verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBy: 'admin-uid' });
  const original = { uid: 'multi-doctor', email: 'doctor@example.invalid', displayName: 'Dr. Louie', specialty: 'orthopedics', roles: ['patient', 'doctor'], status: 'active',
    doctorVerification: verification('orthopedics'), doctorVerifications: { general_medicine: verification('general_medicine'), orthopedics: verification('orthopedics') } };
  const { db, records } = firestoreFake(); records.set(original.uid, structuredClone(original));
  for (const store of [createMemoryUserProfileStore(new Map([[original.uid, structuredClone(original)]])), createFirestoreUserProfileStore(db)]) {
    const firstInput = { specialty: 'orthopedics', reviewedBy: 'admin-uid', expectedSpecialties: ['general_medicine', 'orthopedics'], idempotencyKey: '12345678-1234-4234-8234-123456789012' };
    const first = await store.removeDoctorSpecialty(original.uid, firstInput);
    assert.deepEqual(first.profile.specialties, ['general_medicine']); assert.equal(first.profile.roles.includes('doctor'), true);
    assert.equal(first.profile.specialty, 'general_medicine'); assert.deepEqual((await store.removeDoctorSpecialty(original.uid, firstInput)).receipt, first.receipt);
    await assert.rejects(store.removeDoctorSpecialty(original.uid, { ...firstInput, specialty: 'general_medicine', idempotencyKey: '22345678-1234-4234-8234-123456789012' }), { code: 'DOCTOR_SPECIALTY_STALE' });
    const final = await store.removeDoctorSpecialty(original.uid, { specialty: 'general_medicine', reviewedBy: 'admin-uid', expectedSpecialties: ['general_medicine'], idempotencyKey: '32345678-1234-4234-8234-123456789012' });
    assert.deepEqual(final.profile.roles, ['patient']); assert.equal(final.profile.specialties, undefined); assert.equal(final.profile.doctorVerification, undefined);
    assert.equal((await store.listApprovedDoctors()).length, 0);
  }
});

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
  records.set('firebase-uid', { uid: 'firebase-uid', email: 'fixed@example.invalid', displayName: 'Google Name', specialty: 'general_medicine', doctorVerification: { status: 'verified', specialty: 'general_medicine', displayName: 'Dr Verified', verifiedAt: '2026-01-01T00:00:00.000Z', verifiedBy: 'admin' }, roles: ['patient', 'doctor'], status: 'active', approvalState: 'approved', createdAt: 'earlier', updatedAt: 'earlier' });
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
  assert.deepEqual(profile, { ...existing, roles: ['patient'] }); assert.deepEqual(records.get(existing.uid), existing);
});

test('Doctor application collects a requested Orthopedics specialty without granting or verifying Doctor access', async () => {
  const records = new Map([['applicant', { uid: 'applicant', displayName: 'Google Name', roles: ['patient'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const store = createMemoryUserProfileStore(records, { now: () => Date.parse('2026-09-29T00:00:00Z') });
  const pending = await store.submitDoctorApplication('applicant', { displayName: 'Dr Sample', specialty: 'orthopedics' });
  assert.deepEqual(pending.doctorApplication, { status: 'pending', displayName: 'Dr Sample', specialty: 'orthopedics', submittedAt: '2026-09-29T00:00:00.000Z', version: 1 });
  assert.deepEqual(pending.roles, ['patient']); assert.equal(pending.specialty, undefined); assert.equal(pending.doctorVerification, undefined);
  assert.deepEqual(await store.listVerifiedSpecialties(), new Set());
  await assert.rejects(store.updateOwnProfile('applicant', { firstName: 'A', lastName: 'B', specialty: 'orthopedics' }));
});

test('legacy raw Doctor role can apply but only Admin verification grants effective Doctor access in both stores', async () => {
  const legacy = { uid: 'legacy-doctor', email: 'legacy@example.invalid', displayName: 'Legacy', specialty: 'orthopedics',
    roles: ['patient', 'doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' };
  const { db, records: firestoreRecords } = firestoreFake();
  firestoreRecords.set(legacy.uid, structuredClone(legacy));
  for (const [store, records] of [
    [createMemoryUserProfileStore(new Map([[legacy.uid, structuredClone(legacy)]])), null],
    [createFirestoreUserProfileStore(db), firestoreRecords],
  ]) {
    const pending = await store.submitDoctorApplication(legacy.uid, { displayName: 'Dr. Louie', specialty: 'orthopedics' });
    assert.equal(pending.doctorApplication.status, 'pending');
    assert.deepEqual(pending.roles, ['patient']); assert.equal(pending.specialty, undefined);
    assert.equal((await store.submitDoctorApplication(legacy.uid, { displayName: 'Dr. Louie', specialty: 'orthopedics' })).doctorApplication.version, 1);
    const approved = await store.reviewDoctorApplication(legacy.uid, { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' });
    assert.equal(approved.doctorVerification.status, 'verified');
    assert.equal(approved.specialty, 'orthopedics'); assert.equal(approved.roles.includes('doctor'), true);
    await assert.rejects(store.submitDoctorApplication(legacy.uid, { displayName: 'Dr. Louie', specialty: 'orthopedics' }), { code: 'DOCTOR_ACCESS_ALREADY_GRANTED' });
    if (records) assert.equal(records.get(legacy.uid).doctorVerification.verifiedBy, 'admin-uid');
  }
});

test('incomplete or non-approved Doctor verification cannot block applications in either store', async () => {
  const verified = { status: 'verified', displayName: 'Dr. Louie', specialty: 'orthopedics', verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBy: 'admin-uid' };
  const variants = [
    { doctorVerification: { ...verified, verifiedAt: 'not-a-date' } },
    { doctorVerification: { ...verified, displayName: '  ' } },
    { doctorVerification: { ...verified, specialty: 'general_medicine' } },
    { doctorVerification: { ...verified, status: 'revoked' } },
    { doctorVerification: verified, doctorApplication: { status: 'rejected', displayName: 'Dr. Louie', specialty: 'orthopedics' } },
  ];
  for (const [index, variant] of variants.entries()) {
    const uid = `legacy-${index}`;
    const profile = { uid, displayName: 'Legacy', specialty: 'orthopedics', roles: ['patient', 'doctor'], status: 'active', ...variant };
    const { db, records } = firestoreFake(); records.set(uid, structuredClone(profile));
    for (const store of [createMemoryUserProfileStore(new Map([[uid, structuredClone(profile)]])), createFirestoreUserProfileStore(db)]) {
      const before = await store.getOwnProfile(uid);
      assert.deepEqual(before.roles, ['patient']); assert.equal(before.specialty, undefined); assert.equal(before.doctorVerification, undefined);
      const applied = await store.submitDoctorApplication(uid, { displayName: 'Dr. Louie', specialty: 'orthopedics' });
      assert.equal(applied.doctorApplication.status, 'pending'); assert.deepEqual(applied.roles, ['patient']);
    }
  }
});

test('Doctor display names accept narrow professional punctuation and normalize whitespace without granting access', async () => {
  const records = new Map([['applicant', { uid: 'applicant', roles: ['patient'], status: 'active' }]]);
  const store = createMemoryUserProfileStore(records);
  for (const [input, expected] of [
    ['Dr. Louie', 'Dr. Louie'], ["Dr. Anne-Marie O'Connor", "Dr. Anne-Marie O'Connor"],
    ['Prof. Zoë D’Ávila', 'Prof. Zoë D’Ávila'], ['A'.repeat(100), 'A'.repeat(100)], ['  Dr.   Louie  ', 'Dr. Louie'],
  ]) {
    const result = await store.submitDoctorApplication('applicant', { displayName: input, specialty: 'orthopedics' });
    assert.equal(result.doctorApplication.displayName, expected);
    assert.deepEqual(result.roles, ['patient']); assert.equal(result.doctorVerification, undefined);
  }
  const before = structuredClone(records.get('applicant'));
  const repeated = await store.submitDoctorApplication('applicant', { displayName: ' Dr. Louie ', specialty: 'orthopedics' });
  assert.equal(repeated.doctorApplication.version, before.doctorApplication.version);
  assert.deepEqual(records.get('applicant'), before);
  for (const displayName of ['', '   ', '\u0301', 'Dr.\nLouie', 'Dr.\u0000 Louie', '<script>alert(1)</script>', 'Dr. Louie!', 'Dr.. Louie', 'https://example.com', 'A'.repeat(101)]) {
    await assert.rejects(store.submitDoctorApplication('applicant', { displayName, specialty: 'orthopedics' }), { code: 'INVALID_DOCTOR_DISPLAY_NAME' });
    assert.deepEqual(records.get('applicant'), before);
  }
  await assert.rejects(store.submitDoctorApplication('applicant', { displayName: 'Dr. Louie', specialty: 'not-listed' }), { code: 'INVALID_SPECIALTY' });
  const approved = await store.reviewDoctorApplication('applicant', { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' });
  assert.equal(approved.doctorVerification.displayName, 'Dr. Louie');
  await assert.rejects(store.submitDoctorApplication('applicant', { displayName: 'Dr. Louie', specialty: 'orthopedics' }), { code: 'DOCTOR_ACCESS_ALREADY_GRANTED' });
});

test('Firestore Doctor application and direct verification use the same professional-name rule', async () => {
  const { db, records } = firestoreFake();
  records.set('applicant', { uid: 'applicant', roles: ['patient'], status: 'active' });
  const store = createFirestoreUserProfileStore(db);
  const pending = await store.submitDoctorApplication('applicant', { displayName: ' Dr. Louie ', specialty: 'orthopedics' });
  assert.equal(pending.doctorApplication.displayName, 'Dr. Louie');
  assert.equal((await store.submitDoctorApplication('applicant', { displayName: 'Dr. Louie', specialty: 'orthopedics' })).doctorApplication.version, 1);
  await assert.rejects(store.submitDoctorApplication('applicant', { displayName: 'Dr. Louie!', specialty: 'orthopedics' }), { code: 'INVALID_DOCTOR_DISPLAY_NAME' });
  const verified = await store.approveDoctorApplication('applicant', { displayName: 'Dr. Louie', specialty: 'orthopedics', verifiedBy: 'admin' });
  assert.equal(verified.doctorVerification.displayName, 'Dr. Louie');
  await assert.rejects(store.submitDoctorApplication('applicant', { displayName: 'Dr. Louie', specialty: 'orthopedics' }), { code: 'DOCTOR_ACCESS_ALREADY_GRANTED' });
});

test('only the administrator approval path converts a pending application into a verified Doctor specialty', async () => {
  const records = new Map([['applicant', { uid: 'applicant', displayName: 'Google Name', roles: ['patient'], status: 'active', doctorApplication: { status: 'pending', displayName: 'Dr Applicant', specialty: 'orthopedics', submittedAt: 'earlier' }, createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const store = createMemoryUserProfileStore(records, { now: () => Date.parse('2026-09-29T01:00:00Z') });
  const verified = await store.approveDoctorApplication('applicant', { displayName: 'Dr Verified', specialty: 'orthopedics', verifiedBy: 'admin@example.invalid' });
  assert.deepEqual(verified.roles, ['patient', 'doctor']); assert.equal(verified.specialty, 'orthopedics');
  assert.deepEqual(verified.doctorVerification, { status: 'verified', specialty: 'orthopedics', displayName: 'Dr Verified', verifiedAt: '2026-09-29T01:00:00.000Z' });
  assert.equal(Object.hasOwn(verified.doctorVerification, 'verifiedBy'), false);
  assert.deepEqual(await store.listVerifiedSpecialties(), new Set(['orthopedics']));
  await assert.rejects(store.approveDoctorApplication('another', { displayName: 'Dr Other', specialty: 'orthopedics', verifiedBy: 'admin' }));
});

test('Admin review queue lists pending applications and records approve/reject decisions', async () => {
  const records = new Map([
    ['approve-me', { uid: 'approve-me', email: 'doctor@example.invalid', roles: ['patient'], status: 'active', doctorApplication: { status: 'pending', displayName: 'Dr Applicant', specialty: 'orthopedics', submittedAt: '2026-09-29T00:00:00.000Z' }, createdAt: 'earlier', updatedAt: 'earlier' }],
    ['reject-me', { uid: 'reject-me', email: 'other@example.invalid', roles: ['patient'], status: 'active', doctorApplication: { status: 'pending', displayName: 'Other Applicant', specialty: 'general_medicine', submittedAt: '2026-09-29T00:01:00.000Z' }, createdAt: 'earlier', updatedAt: 'earlier' }],
  ]);
  const store = createMemoryUserProfileStore(records, { now: () => Date.parse('2026-09-29T02:00:00Z') });
  const queue = await store.listPendingDoctorApplications();
  assert.deepEqual(queue.map(item => item.uid), ['approve-me', 'reject-me']);
  await assert.rejects(store.reviewDoctorApplication('approve-me', { decision: 'approved', reviewedBy: 'admin-uid' }), { code: 'INVALID_DOCTOR_REVIEW' });
  const approved = await store.reviewDoctorApplication('approve-me', { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' });
  assert.deepEqual(approved.roles, ['patient', 'doctor']); assert.equal(approved.specialty, 'orthopedics');
  assert.equal(records.get('approve-me').doctorVerification.verifiedBy, 'admin-uid');
  assert.equal(records.get('approve-me').doctorApplication.reviewedBy, 'admin-uid');
  const rejected = await store.reviewDoctorApplication('reject-me', { decision: 'rejected', reviewedBy: 'admin-uid' });
  assert.deepEqual(rejected.roles, ['patient']); assert.equal(records.get('reject-me').doctorApplication.status, 'rejected');
  assert.deepEqual(await store.listPendingDoctorApplications(), []);
  await assert.rejects(store.reviewDoctorApplication('reject-me', { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' }), { code: 'DOCTOR_APPLICATION_NOT_PENDING' });
});

test('Firestore approval persists the verified Doctor role and specialty with audit identity', async () => {
  const { db, records } = firestoreFake();
  records.set('applicant', { uid: 'applicant', displayName: 'Applicant', roles: ['patient'], status: 'active', doctorApplication: { status: 'pending', displayName: 'Applicant', specialty: 'orthopedics', submittedAt: 'earlier' }, createdAt: 'earlier', updatedAt: 'earlier' });
  const store = createFirestoreUserProfileStore(db, { now: () => Date.parse('2026-09-29T02:00:00Z') });
  await store.approveDoctorApplication('applicant', { displayName: 'Dr Verified', specialty: 'orthopedics', verifiedBy: 'trusted-admin' });
  assert.deepEqual(records.get('applicant').roles, ['patient', 'doctor']);
  assert.equal(records.get('applicant').doctorVerification.verifiedBy, 'trusted-admin');
  assert.deepEqual(await store.listVerifiedSpecialties(), new Set(['orthopedics']));
});

test('Firestore Admin review is atomic, audit-recorded, and removes resolved requests from queue', async () => {
  const { db, records } = firestoreFake();
  records.set('applicant', { uid: 'applicant', email: 'doctor@example.invalid', displayName: 'Applicant', roles: ['patient'], status: 'active', doctorApplication: { status: 'pending', displayName: 'Dr Applicant', specialty: 'orthopedics', submittedAt: '2026-09-29T00:00:00.000Z' }, createdAt: 'earlier', updatedAt: 'earlier' });
  const store = createFirestoreUserProfileStore(db, { now: () => Date.parse('2026-09-29T02:00:00Z') });
  assert.equal((await store.listPendingDoctorApplications()).length, 1);
  const approved = await store.reviewDoctorApplication('applicant', { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' });
  assert.equal(approved.doctorApplication.status, 'approved');
  assert.equal(records.get('applicant').doctorVerification.verifiedBy, 'admin-uid');
  assert.equal(records.get('applicant').doctorApplication.reviewedBy, 'admin-uid');
  assert.deepEqual(await store.listPendingDoctorApplications(), []);
  await assert.rejects(store.reviewDoctorApplication('applicant', { decision: 'rejected', reviewedBy: 'admin-uid' }), { code: 'DOCTOR_APPLICATION_NOT_PENDING' });
});

test('Patient applications require Admin approval in approved-only mode and can be reopened by policy', async () => {
  const records = new Map([['patient-applicant', { uid: 'patient-applicant', email: 'patient@example.invalid', displayName: 'Patient', roles: ['patient'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const store = createMemoryUserProfileStore(records, { patientAccessMode: 'approved_only', now: () => Date.parse('2026-09-29T03:00:00Z') });
  const submitted = await store.submitPatientApplication('patient-applicant');
  assert.equal(submitted.patientApplication.status, 'pending'); assert.deepEqual(await store.listPendingPatientApplications(), [{ uid: 'patient-applicant', email: 'patient@example.invalid', displayName: 'Patient', patientApplication: { status: 'pending', submittedAt: '2026-09-29T03:00:00.000Z', version: 1 } }]);
  const approved = await store.reviewPatientApplication('patient-applicant', { decision: 'approved', reviewedBy: 'admin-uid' });
  assert.equal(approved.patientApplication.status, 'approved'); assert.deepEqual(approved.roles, ['patient']);
  assert.equal(records.get('patient-applicant').patientApplication.reviewedBy, 'admin-uid');
  await assert.rejects(store.reviewPatientApplication('patient-applicant', { decision: 'rejected', reviewedBy: 'admin-uid' }), { code: 'PATIENT_APPLICATION_NOT_PENDING' });
  const policy = await store.setPatientAccessMode('open', { reviewedBy: 'admin-uid', expectedVersion: 1, idempotencyKey: '12345678-1234-4234-8234-123456789012', confirmed: true });
  assert.equal(policy.mode, 'open'); assert.equal(policy.version, 2); assert.equal(policy.receipt.previousVersion, 1);
  assert.equal(await store.getPatientAccessMode(), 'open');
});

test('Firestore Patient applications are queued, audited, and Patient access mode persists separately', async () => {
  const { db, records, settings } = firestoreFake();
  records.set('applicant', { uid: 'applicant', email: 'patient@example.invalid', displayName: 'Patient', roles: ['patient'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' });
  const store = createFirestoreUserProfileStore(db, { now: () => Date.parse('2026-09-29T03:00:00Z') });
  await store.submitPatientApplication('applicant');
  assert.equal((await store.listPendingPatientApplications()).length, 1);
  await store.reviewPatientApplication('applicant', { decision: 'approved', reviewedBy: 'admin-uid' });
  assert.equal(records.get('applicant').patientApplication.reviewedBy, 'admin-uid');
  await store.setPatientAccessMode('approved_only', { reviewedBy: 'admin-uid', expectedVersion: 1, idempotencyKey: '12345678-1234-4234-8234-123456789012', confirmed: true });
  assert.equal(await store.getPatientAccessMode(), 'approved_only'); assert.equal(settings.get('patientAccess').updatedBy, 'admin-uid');
});

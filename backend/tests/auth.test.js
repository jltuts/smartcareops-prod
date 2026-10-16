import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { configuredTokenVerifier, createAuthentication } from '../src/auth.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';
import { newCaseId } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';
import { doctorDisplayNameGuidance } from '../../shared/doctor-display-name.js';

const doctorVerification = (specialty, displayName = 'Verified Doctor') => ({ status: 'verified', specialty, displayName, verifiedAt: '2026-01-01T00:00:00.000Z', verifiedBy: 'test-admin' });

test('local development assigns the Patient identity to direct voice completion', async () => {
  const authentication = createAuthentication({
    env: { NODE_ENV: 'development' },
    userProfileStore: createMemoryUserProfileStore(),
  });
  const request = { method: 'POST', url: '/api/intake/voice/complete', headers: {} };
  assert.equal(await authentication.handle(request, {}), false);
  assert.equal(request.user.uid, 'local-development-patient');
  assert.deepEqual(request.user.roles, ['patient']);
  await authentication.close();
});

async function setup(t, approved = '', patient = '', options = {}) {
  let verifications = 0;
  const caseStore = options.caseStore || createMemoryCaseStore(), { caseStore: _caseStore, apiOptions = {}, patientAccessMode = 'open', ...authenticationOptions } = options;
  const userProfileStore = authenticationOptions.userProfileStore || createMemoryUserProfileStore(new Map(), { patientAccessMode });
  await userProfileStore.setPatientAccessMode?.(patientAccessMode, { reviewedBy: 'test-suite' });
  const api = createApiServer({ caseStore, ...apiOptions, authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: approved, DEV_PATIENT_UIDS: patient },
    verifyToken: async token => {
      verifications++;
      if (token !== 'valid-google-token') throw new Error('Do not disclose provider details');
      return { uid: 'verified-user', email: 'fictional@example.invalid', name: 'Verified Patient', role: 'owner', firebase: { sign_in_provider: 'google.com' } };
    },
    ...authenticationOptions, userProfileStore,
  } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  return { base: `http://127.0.0.1:${api.server.address().port}`, verifications: () => verifications, caseStore };
}
test('production health stays public but missing, invalid and expired tokens are rejected safely', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/readyz')).status, 200);
  for (const token of [null, 'invalid', 'expired']) {
    const r = await fetch(base + '/api/auth/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal(r.status, 401); assert.doesNotMatch(await r.text(), /provider details/);
  }
});
test('verified identity ignores spoofed roles and receives only backend-provisioned Patient access', async t => {
  const { base } = await setup(t);
  const headers = { Authorization: 'Bearer valid-google-token', 'X-User-Role': 'doctor', 'X-User-Id': 'someone-else' };
  const me = await (await fetch(base + '/api/auth/me', { headers })).json();
  assert.equal(me.user.uid, 'verified-user'); assert.deepEqual(me.user.roles, ['patient']); assert.equal(me.demoAccess, true);
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 403);
});
test('auth/me exposes configured Live languages only to a Patient with Live access', async t => {
  const liveSessionStore = (await import('../src/live-session.js')).createMemoryLiveSessionStore();
  const apiOptions = { liveSessionEnabled: true, liveSessionStore, liveWebSocketUrl: 'wss://live.example.invalid/api/live' };
  const patient = await setup(t, '', 'verified-user', { apiOptions, env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_PATIENT_UIDS: 'verified-user', GEMINI_LIVE_MODEL: 'gemini-3.8-live' } });
  const patientMe = await (await fetch(patient.base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } })).json();
  assert.equal(patientMe.liveAvailable, true);
  assert(patientMe.liveSupportedLanguages.some(language => language.code === 'fil'));
  assert.equal(patientMe.liveSupportedLanguages[0].code, 'af');

  const doctor = await setup(t, 'verified-user', '', { apiOptions: { ...apiOptions, liveSessionEnabled: false }, env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: 'verified-user', GEMINI_LIVE_MODEL: 'gemini-3.8-live' } });
  const doctorMe = await (await fetch(doctor.base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } })).json();
  assert.equal(doctorMe.liveAvailable, false);
  assert.equal(Object.hasOwn(doctorMe, 'liveSupportedLanguages'), false);

  const unknownModel = await setup(t, '', 'verified-user', { apiOptions, env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_PATIENT_UIDS: 'verified-user', GEMINI_LIVE_MODEL: 'unrecognized-model' } });
  const unknownModelMe = await (await fetch(unknownModel.base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } })).json();
  assert.deepEqual(unknownModelMe.liveSupportedLanguages.map(({ code }) => code), ['en']);
});
test('only explicit backend UID allowlist grants bounded DEV demo access', async t => {
  const { base } = await setup(t, 'verified-user');
  const r = await fetch(base + '/api/auth/me', { headers: { 'X-Forwarded-Authorization': 'Bearer valid-google-token', Authorization: 'Bearer gateway-iam-token' } });
  assert.equal(r.status, 200);
  const me = await r.json(); assert.equal(me.demoAccess, true); assert.deepEqual(me.user.roles, ['patient', 'doctor', 'dispatcher', 'command-center']); assert.equal(me.liveAvailable, false);
});
test('auth/me returns every stored Firestore role in its stable stored order', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Verified User', specialty: 'general_medicine', doctorVerification: doctorVerification('general_medicine'), roles: ['patient', 'doctor', 'dispatcher', 'command_center'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const response = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.user.roles, ['patient', 'doctor', 'dispatcher', 'command_center']);
  assert.equal(body.demoAccess, true);
});
test('Firestore Doctor role and trusted specialty authorize Doctor APIs without DEV UID allowlisting', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Verified User', specialty: 'general_medicine', doctorVerification: doctorVerification('general_medicine'), roles: ['patient', 'doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const response = await fetch(base + '/api/doctor/cases', { headers: { Authorization: 'Bearer valid-google-token' } });
  assert.equal(response.status, 200);
});
test('case review decision route requires the Doctor role', async t => {
  let reviewer;
  const caseStore = createMemoryCaseStore(), caseId = newCaseId();
  await caseStore.createCase({ caseId, intake: routingIntake([['fatigue', 'confirmed']]), patientUid: 'patient-owner', submittedForReview: true });
  await caseStore.routeCase(caseId, { availableSpecialties: new Set(['general_medicine']) });
  const decisionService = { caseId, decideCaseReview: async (_requestId, _decision, value) => { reviewer = value; return { status: 'approved' }; }, tick: async () => {}, close: async () => {} };
  const body = JSON.stringify({ requestId: randomUUID(), decision: 'approved' });
  const headers = { Authorization: 'Bearer valid-google-token', Origin: 'http://localhost:5173', 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  const patientOnly = await setup(t, '', 'verified-user', { caseStore, apiOptions: { clinicalService: decisionService, clinicalEnabled: true } });
  assert.equal((await fetch(`${patientOnly.base}/api/clinical/case-review?caseId=${decisionService.caseId}`, { method: 'POST', headers, body })).status, 403);
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'doctor@example.invalid', displayName: 'Dr. Verified', specialty: 'general_medicine', doctorVerification: doctorVerification('general_medicine', 'Dr. Verified'), roles: ['doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const doctor = await setup(t, '', '', { caseStore, apiOptions: { clinicalService: decisionService, clinicalEnabled: true }, userProfileStore: createMemoryUserProfileStore(records) });
  assert.equal((await fetch(`${doctor.base}/api/clinical/case-review?caseId=${decisionService.caseId}`, { method: 'POST', headers, body })).status, 200);
  assert.deepEqual(reviewer, { uid: 'verified-user', displayName: 'Dr. Verified', specialties: ['general_medicine'] });
});
test('notification inspection is bound to the authenticated portal role', async t => {
  for (const [role, allowedRecipient, deniedRecipient] of [['doctor', 'doctor', 'dispatcher'], ['dispatcher', 'dispatcher', 'doctor']]) {
    const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Verified User', ...(role === 'doctor' ? { specialty: 'orthopedics', doctorVerification: doctorVerification('orthopedics') } : {}), roles: ['patient', role], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
    const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
    const headers = { Authorization: 'Bearer valid-google-token' };
    assert.equal((await fetch(`${base}/api/notifications?recipientType=${allowedRecipient}`, { headers })).status, 503);
    assert.equal((await fetch(`${base}/api/notifications?recipientType=${deniedRecipient}`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/notifications`, { headers })).status, 403);
  }
});
test('patient-only UID allowlist grants no privileged role', async t => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId();
  await caseStore.createCase({ caseId, intake: routingIntake(), patientUid: 'verified-user', submittedForReview: true });
  const { base } = await setup(t, '', 'verified-user', { caseStore });
  const headers = { Authorization: 'Bearer valid-google-token' };
  const response = await fetch(base + '/api/auth/me', { headers });
  assert.equal(response.status, 200);
  const me = await response.json();
  assert.equal(me.demoAccess, true);
  assert.deepEqual(me.user.roles, ['patient']);
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 403);
  assert.equal((await fetch(`${base}/api/cases/${caseId}/route`, { method: 'POST', headers: { ...headers, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/dispatcher/cases', { headers })).status, 403);
  assert.equal((await fetch(`${base}/api/dispatcher/cases/${caseId}/acknowledge`, { method: 'POST', headers: { ...headers, Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/operations', { headers })).status, 403);
});
test('Doctor application submission remains pending and cannot grant role or specialty', async t => {
  const records = new Map(), { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const headers = { Authorization: 'Bearer valid-google-token', Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'Idempotency-Key': '12345678-1234-4234-8234-123456789012' };
  await fetch(base + '/api/auth/me', { headers });
  const submitted = await fetch(base + '/api/doctor/application', { method: 'POST', headers, body: JSON.stringify({ displayName: 'Dr Applicant', specialty: 'orthopedics' }) });
  assert.equal(submitted.status, 200); assert.equal((await submitted.json()).application.status, 'pending');
  const me = await (await fetch(base + '/api/auth/me', { headers })).json();
  assert.deepEqual(me.user.roles, ['patient']); assert.equal(me.user.specialty, undefined);
  assert.equal(records.get('verified-user').specialty, undefined); assert.equal(records.get('verified-user').doctorVerification, undefined);
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 403);
});
test('Doctor application HTTP 400 names the safe display-name rule and preserves the pending application', async t => {
  const records = new Map(), store = createMemoryUserProfileStore(records);
  const { base } = await setup(t, '', '', { userProfileStore: store });
  const headers = { Authorization: 'Bearer valid-google-token', Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
  await fetch(base + '/api/auth/me', { headers });
  const post = displayName => fetch(base + '/api/doctor/application', { method: 'POST', headers, body: JSON.stringify({ displayName, specialty: 'orthopedics' }) });
  for (const name of ['', 'Dr.\nLouie', '<script>bad</script>', 'Dr. Louie!', 'A'.repeat(101)]) {
    const response = await post(name);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'INVALID_DOCTOR_DISPLAY_NAME', message: doctorDisplayNameGuidance });
    assert.equal(records.get('verified-user').doctorApplication, undefined);
  }
  const first = await post(' Dr. Louie ');
  assert.equal(first.status, 200);
  assert.equal((await first.json()).application.displayName, 'Dr. Louie');
  const repeated = await post('Dr. Louie');
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).application.version, 1);
  const me = await (await fetch(base + '/api/auth/me', { headers })).json();
  assert.deepEqual(me.user.roles, ['patient']);
  assert.equal(me.user.specialty, undefined);
  const approved = await store.reviewDoctorApplication('verified-user', { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' });
  assert.equal(approved.doctorVerification.displayName, 'Dr. Louie');
  const afterApproval = await post('Dr. Louie');
  assert.equal(afterApproval.status, 400);
  assert.equal((await afterApproval.json()).code, 'DOCTOR_ACCESS_ALREADY_GRANTED');
});
test('only the configured Admin UID can view and decide Doctor applications', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'applicant@example.invalid', displayName: 'Patient Applicant', roles: ['patient'], status: 'active', doctorApplication: { status: 'pending', displayName: 'Dr Applicant', specialty: 'orthopedics', submittedAt: '2026-09-29T00:00:00.000Z' }, createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const userProfileStore = createMemoryUserProfileStore(records);
  const admin = await setup(t, '', '', { userProfileStore, env: { NODE_ENV: 'production', APP_ENV: 'development', ADMIN_UIDS: 'verified-user' } });
  const headers = { Authorization: 'Bearer valid-google-token', Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'Idempotency-Key': '12345678-1234-4234-8234-123456789012' };
  const me = await (await fetch(admin.base + '/api/auth/me', { headers })).json();
  assert.deepEqual(me.user.roles, ['admin', 'patient']);
  const queue = await fetch(admin.base + '/api/admin/doctor-applications', { headers });
  assert.equal(queue.status, 200); assert.equal((await queue.json()).applications[0].specialty, 'orthopedics');
  const forbidden = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(new Map([['verified-user', { uid: 'verified-user', roles: ['patient'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]])), env: { NODE_ENV: 'production', APP_ENV: 'development', ADMIN_UIDS: 'some-other-uid' } });
  assert.equal((await fetch(forbidden.base + '/api/admin/doctor-applications', { headers })).status, 403);
  const invalid = await fetch(admin.base + '/api/admin/doctor-applications/verified-user/decision', { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) });
  assert.equal(invalid.status, 400);
  const approval = await fetch(admin.base + '/api/admin/doctor-applications/verified-user/decision', { method: 'POST', headers, body: JSON.stringify({ decision: 'approved', independentlyVerified: true, applicationVersion: 1, confirmed: true }) });
  assert.equal(approval.status, 200); assert.equal((await approval.json()).application.status, 'approved');
  assert.deepEqual((await (await fetch(admin.base + '/api/auth/me', { headers })).json()).user.roles, ['admin', 'patient', 'doctor']);
  assert.deepEqual(await userProfileStore.listVerifiedSpecialties(), new Set(['orthopedics']));
});
test('each configured Admin UID receives Admin access while other identities remain excluded', async t => {
  const profileStore = createMemoryUserProfileStore(new Map());
  const api = createApiServer({ caseStore: createMemoryCaseStore(), authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development', ADMIN_UIDS: 'first-admin,second-admin' },
    userProfileStore: profileStore,
    verifyToken: async token => ({ uid: token, email: `${token}@example.invalid`, name: token,
      firebase: { sign_in_provider: 'google.com' } }),
  } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const rolesFor = async uid => (await (await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${uid}` },
  })).json()).user.roles;
  assert.deepEqual(await rolesFor('first-admin'), ['admin', 'patient']);
  assert.deepEqual(await rolesFor('second-admin'), ['admin', 'patient']);
  assert.deepEqual(await rolesFor('ordinary-user'), []);
});
test('Admin alone controls Patient access mode and approves Patient applications before restricted intake access', async t => {
  const records = new Map(), profileStore = createMemoryUserProfileStore(records, { patientAccessMode: 'approved_only' });
  const api = createApiServer({ caseStore: createMemoryCaseStore(), authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development', ADMIN_UIDS: 'admin-user' }, userProfileStore: profileStore,
    verifyToken: async token => ({ uid: token, email: `${token}@example.invalid`, name: token, firebase: { sign_in_provider: 'google.com' } }),
  } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`, headers = uid => ({ Authorization: `Bearer ${uid}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'Idempotency-Key': `12345678-1234-4234-8234-${uid.padEnd(12, '0').slice(0, 12)}` });
  const applicant = headers('patient-applicant'), admin = headers('admin-user');
  const initial = await (await fetch(base + '/api/auth/me', { headers: applicant })).json();
  assert.deepEqual(initial.user.roles, []); assert.equal(initial.patientAccessMode, 'approved_only');
  const application = await fetch(base + '/api/patient/application', { method: 'POST', headers: applicant, body: JSON.stringify({ confirm: true }) });
  assert.equal(application.status, 200); assert.equal((await application.json()).application.status, 'pending');
  assert.equal((await fetch(base + '/api/cases', { headers: applicant })).status, 403);
  const queue = await fetch(base + '/api/admin/patient-applications', { headers: admin });
  assert.equal(queue.status, 200); assert.equal((await queue.json()).applications[0].uid, 'patient-applicant');
  const approval = await fetch(base + '/api/admin/patient-applications/patient-applicant/decision', { method: 'POST', headers: admin, body: JSON.stringify({ decision: 'approved', applicationVersion: 1, confirmed: true }) });
  assert.equal(approval.status, 200); assert.equal((await approval.json()).application.status, 'approved');
  assert.deepEqual((await (await fetch(base + '/api/auth/me', { headers: applicant })).json()).user.roles, ['patient']);
  const changed = await fetch(base + '/api/admin/settings/patient-access', { method: 'PUT', headers: { ...admin, 'Idempotency-Key': '22345678-1234-4234-8234-123456789012' }, body: JSON.stringify({ mode: 'open', expectedVersion: 1, confirmed: true }) });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).patientAccessMode, 'open');
  const ordinary = headers('new-user'); await fetch(base + '/api/auth/me', { headers: ordinary });
  assert.deepEqual((await (await fetch(base + '/api/auth/me', { headers: ordinary })).json()).user.roles, ['patient']);
  const forbidden = await fetch(base + '/api/admin/settings/patient-access', { method: 'PUT', headers: applicant, body: JSON.stringify({ mode: 'approved_only' }) });
  assert.equal(forbidden.status, 403);
});
test('stored Doctor role and specialty without administrator verification do not authorize Doctor APIs', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'doctor@example.invalid', displayName: 'Unverified', specialty: 'orthopedics', roles: ['doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const headers = { Authorization: 'Bearer valid-google-token' };
  const me = await (await fetch(base + '/api/auth/me', { headers })).json();
  assert.deepEqual(me.user.roles, ['patient']); assert.equal(me.user.specialty, undefined);
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 403);
});
test('legacy raw Doctor role submits for Admin review and gains Doctor access only after verification', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'doctor@example.invalid', displayName: 'Legacy',
    specialty: 'orthopedics', roles: ['patient', 'doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const store = createMemoryUserProfileStore(records);
  const { base } = await setup(t, '', '', { userProfileStore: store });
  const headers = { Authorization: 'Bearer valid-google-token', Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
  const post = () => fetch(base + '/api/doctor/application', { method: 'POST', headers, body: JSON.stringify({ displayName: 'Dr. Louie', specialty: 'orthopedics' }) });
  const me = async () => (await (await fetch(base + '/api/auth/me', { headers })).json()).user;
  assert.deepEqual((await me()).roles, ['patient']);
  assert.equal((await me()).doctorVerification, undefined);
  assert.equal((await post()).status, 200);
  assert.equal(records.get('verified-user').doctorApplication.status, 'pending');
  assert.deepEqual((await me()).roles, ['patient']);
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 403);
  await store.reviewDoctorApplication('verified-user', { decision: 'rejected', reviewedBy: 'admin-uid' });
  assert.deepEqual((await me()).roles, ['patient']);
  assert.equal((await post()).status, 200);
  await store.reviewDoctorApplication('verified-user', { decision: 'approved', independentlyVerified: true, reviewedBy: 'admin-uid' });
  const verified = await me();
  assert.equal(verified.roles.includes('doctor'), true); assert.equal(verified.specialty, 'orthopedics'); assert.equal(verified.displayName, 'Dr. Louie');
  assert.equal(verified.doctorVerification.status, 'verified'); assert.equal(verified.doctorVerification.specialty, 'orthopedics'); assert.equal(verified.doctorVerification.displayName, 'Dr. Louie');
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 200);
  const alreadyGranted = await post();
  assert.equal(alreadyGranted.status, 400); assert.equal((await alreadyGranted.json()).code, 'DOCTOR_ACCESS_ALREADY_GRANTED');
  records.get('verified-user').doctorVerification.status = 'revoked';
  assert.deepEqual((await me()).roles, ['patient']);
  assert.equal((await me()).doctorVerification, undefined);
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 403);
  assert.equal((await post()).status, 200);
});
test('Patient case list is available only to the authenticated Patient role', async t => {
  const patientAccess = await setup(t, '', 'verified-user');
  assert.equal((await fetch(patientAccess.base + '/api/cases', { headers: { Authorization: 'Bearer valid-google-token' } })).status, 200);
  for (const role of ['doctor', 'dispatcher']) {
    const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Verified User', roles: [role], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
    const denied = await setup(t, '', '', { patientAccessMode: 'approved_only', userProfileStore: createMemoryUserProfileStore(records, { patientAccessMode: 'approved_only' }) });
    assert.equal((await fetch(denied.base + '/api/cases', { headers: { Authorization: 'Bearer valid-google-token' } })).status, 403);
  }
});
test('medicine packaging image is returned only through the authenticated Doctor case route', async t => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(), bytes = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  await caseStore.createCase({ caseId, intake: routingIntake(), patientUid: 'patient-owner', submittedForReview: true,
    medication: { name: 'Fictionalmed', strength: '10 mg', howTaken: 'One each morning', source: 'packaging_shown', verification: 'patient_reported', confirmedAt: new Date().toISOString() },
    medicationImage: { mimeType: 'image/jpeg', byteLength: bytes.length, bytes } });
  const patient = await setup(t, '', 'verified-user', { caseStore });
  const path = `/api/doctor/cases/${caseId}/medicine-image`, headers = { Authorization: 'Bearer valid-google-token' };
  assert.equal((await fetch(patient.base + path, { headers })).status, 403);
  await caseStore.routeCase(caseId, { availableSpecialties: new Set(['neurology']) });
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'doctor@example.invalid', displayName: 'Doctor', specialty: 'neurology', doctorVerification: doctorVerification('neurology', 'Doctor'), roles: ['doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const doctor = await setup(t, '', '', { caseStore, patientAccessMode: 'approved_only', userProfileStore: createMemoryUserProfileStore(records, { patientAccessMode: 'approved_only' }) });
  const response = await fetch(doctor.base + path, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
test('patient-shared stills are case-scoped, metadata-only in case JSON, and readable to the owner and eligible Doctor', async t => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(), bytes = Buffer.from([0xff, 0xd8, 9, 8, 7, 0xff, 0xd9]);
  const description = 'Patient reports pain over the outer left shoulder.';
  const saved = await caseStore.createCase({ caseId, intake: routingIntake(), patientUid: 'verified-user', submittedForReview: true,
    patientEvidence: [{ evidenceId: 'body-area-123', kind: 'body_area', label: 'Pain location', patientDescription: description,
      mimeType: 'image/jpeg', byteLength: bytes.length, bytes }] });
  assert.deepEqual(saved.patientEvidence, [{ evidenceId: 'body-area-123', kind: 'body_area', label: 'Pain location', patientDescription: description,
    status: 'available', mimeType: 'image/jpeg', byteLength: bytes.length, capturedAt: saved.patientEvidence[0].capturedAt }]);
  assert.equal(JSON.stringify(saved).includes(bytes.toString('base64')), false);
  assert.equal(JSON.stringify(saved).includes('imageBase64'), false);
  assert.equal(JSON.stringify(saved).includes('https://'), false);
  assert.equal(saved.reportedFacts.symptoms.some(item => /supraspinatus|tear|tendon/i.test(`${item.name} ${item.patientReportedText}`)), false);

  const patient = await setup(t, '', 'verified-user', { caseStore }), patientHeaders = { Authorization: 'Bearer valid-google-token' };
  const caseResponse = await fetch(`${patient.base}/api/cases/${caseId}`, { headers: patientHeaders });
  assert.equal(caseResponse.status, 200); assert.deepEqual((await caseResponse.json()).patientEvidence[0].patientDescription, description);
  const ownImage = await fetch(`${patient.base}/api/cases/${caseId}/evidence/body-area-123`, { headers: patientHeaders });
  assert.equal(ownImage.status, 200); assert.equal(ownImage.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await ownImage.arrayBuffer()), bytes);
  const otherPatient = await setup(t, '', '', { caseStore, verifyToken: async () => ({ uid: 'different-patient', email: 'other@example.invalid', role: 'owner', firebase: { sign_in_provider: 'google.com' } }) });
  assert.equal((await fetch(`${otherPatient.base}/api/cases/${caseId}/evidence/body-area-123`, { headers: patientHeaders })).status, 404);

  await caseStore.routeCase(caseId, { availableSpecialties: new Set(['neurology']) });
  const doctorProfiles = new Map([['verified-user', { uid: 'verified-user', email: 'doctor@example.invalid', displayName: 'Doctor', specialty: 'neurology', doctorVerification: doctorVerification('neurology', 'Doctor'), roles: ['doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const doctor = await setup(t, '', '', { caseStore, patientAccessMode: 'approved_only', userProfileStore: createMemoryUserProfileStore(doctorProfiles, { patientAccessMode: 'approved_only' }) });
  const doctorImage = await fetch(`${doctor.base}/api/doctor/cases/${caseId}/evidence/body-area-123`, { headers: patientHeaders });
  assert.equal(doctorImage.status, 200); assert.deepEqual(Buffer.from(await doctorImage.arrayBuffer()), bytes);
  assert.equal((await fetch(`${doctor.base}/api/cases/${caseId}/evidence/body-area-123`, { headers: patientHeaders })).status, 403);
  const dispatcherProfiles = new Map([['verified-user', { uid: 'verified-user', email: 'dispatcher@example.invalid', displayName: 'Dispatcher', roles: ['dispatcher'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const dispatcher = await setup(t, '', '', { caseStore, patientAccessMode: 'approved_only', userProfileStore: createMemoryUserProfileStore(dispatcherProfiles, { patientAccessMode: 'approved_only' }) });
  assert.equal((await fetch(`${dispatcher.base}/api/cases/${caseId}/evidence/body-area-123`, { headers: patientHeaders })).status, 403);
  assert.equal((await fetch(`${dispatcher.base}/api/doctor/cases/${caseId}/evidence/body-area-123`, { headers: patientHeaders })).status, 403);
});
test('first verified Google access creates one durable active Patient profile and repeat login is idempotent', async t => {
  const records = new Map();
  const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const headers = { Authorization: 'Bearer valid-google-token' };
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/api/auth/me', { headers });
    assert.equal(response.status, 200);
    const me = await response.json();
    assert.deepEqual(me.user.roles, ['patient']); assert.equal(me.user.displayName, 'Verified Patient');
  }
  assert.equal(records.size, 1);
  assert.deepEqual(records.get('verified-user').roles, ['patient']);
  assert.equal(records.get('verified-user').status, 'active');
  assert.equal(records.get('verified-user').email, 'fictional@example.invalid');
});
test('auto-provisioned Patient remains denied from every privileged portal API', async t => {
  const { base } = await setup(t);
  const headers = { Authorization: 'Bearer valid-google-token', 'X-User-Role': 'admin,doctor,dispatcher,command-center' };
  assert.deepEqual((await (await fetch(base + '/api/auth/me', { headers })).json()).user.roles, ['patient']);
  for (const path of ['/api/doctor/cases', '/api/doctor/cases/SC-12345678-1234-4234-8234-123456789012', '/api/dispatcher/cases', '/api/operations']) assert.equal((await fetch(base + path, { headers })).status, 403);
});
test('authenticated profile API loads and updates only the verified caller profile', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Google Name', specialty: 'general_medicine', doctorVerification: doctorVerification('general_medicine'), roles: ['patient', 'doctor'], status: 'active', approvalState: 'approved', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const { base } = await setup(t, 'verified-user', '', { userProfileStore: createMemoryUserProfileStore(records) }); const headers = { Authorization: 'Bearer valid-google-token' };
  assert.equal((await fetch(base + '/api/profile')).status, 401);
  const loaded = await (await fetch(base + '/api/profile', { headers })).json(); assert.equal(loaded.profile.uid, 'verified-user'); assert.deepEqual(loaded.profile.roles, ['patient', 'doctor']);
  const body = { firstName: ' John Louis ', middleName: '', lastName: ' Garcia ', birthday: '1990-05-10', addressLine1: '123 Mabini St.', addressLine2: '', cityMunicipality: 'Quezon City', provinceState: 'Metro Manila', postalCode: '', country: 'Philippines' };
  const response = await fetch(base + '/api/profile', { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); const profile = (await response.json()).profile; assert.equal(profile.displayName, 'John Louis Garcia'); assert.equal(profile.birthday, body.birthday);
  assert.deepEqual(profile.roles, ['patient', 'doctor']); assert.equal(profile.status, 'active'); assert.equal(profile.email, 'fixed@example.invalid'); assert.equal(records.get('verified-user').approvalState, 'approved');
  assert.equal(records.size, 1); assert.equal(records.has('someone-else'), false);
});
test('profile API rejects protected fields and invalid birthday without changing backend-owned state', async t => {
  const records = new Map(); const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) }); const headers = { Authorization: 'Bearer valid-google-token', 'Content-Type': 'application/json' };
  await fetch(base + '/api/auth/me', { headers });
  for (const body of [{ firstName: 'John', lastName: 'Garcia', roles: ['doctor'] }, { firstName: 'John', lastName: 'Garcia', status: 'disabled' }, { firstName: 'John', lastName: 'Garcia', uid: 'other' }, { firstName: 'John', lastName: 'Garcia', email: 'other@example.invalid' }, { firstName: 'John', lastName: 'Garcia', birthday: '2999-01-01' }]) assert.equal((await fetch(base + '/api/profile', { method: 'PATCH', headers, body: JSON.stringify(body) })).status, 400);
  assert.deepEqual(records.get('verified-user').roles, ['patient']); assert.equal(records.get('verified-user').status, 'active'); assert.equal(records.get('verified-user').uid, 'verified-user');
});
test('authorized Doctor queue resolves only the case owner trusted profile identity', async t => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(), records = new Map([
    ['patient-owner', { uid: 'patient-owner', email: 'private@example.invalid', displayName: 'John Garcia', firstName: 'John Louis', middleName: 'Miguel', lastName: 'Garcia', roles: ['patient'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }],
    ['verified-user', { uid: 'verified-user', email: 'doctor@example.invalid', displayName: 'Verified Doctor', specialty: 'neurology', doctorVerification: doctorVerification('neurology'), roles: ['doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }],
  ]);
  await caseStore.createCase({ caseId, intake: routingIntake(), patientUid: 'patient-owner', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  await caseStore.routeCase(caseId, { availableSpecialties: new Set(['neurology']) });
  const { base } = await setup(t, 'verified-user', '', { caseStore, userProfileStore: createMemoryUserProfileStore(records) });
  const response = await fetch(base + '/api/doctor/cases', { headers: { Authorization: 'Bearer valid-google-token' } });
  assert.equal(response.status, 200); const body = await response.json(), record = body.cases[0];
  assert.deepEqual(record.patientIdentity, { displayName: 'John Garcia', firstName: 'John Louis', middleName: 'Miguel', lastName: 'Garcia' });
  assert.equal(record.patient.name, 'Demo Alex'); assert.ok(!Object.hasOwn(record, 'patientUid'));
});
test('inactive durable profile remains denied and is not overwritten on login', async t => {
  const at = new Date().toISOString();
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'old@example.invalid', displayName: 'Disabled', roles: ['patient'], status: 'inactive', createdAt: at, updatedAt: at }]]);
  const { base } = await setup(t, 'verified-user', 'verified-user', { userProfileStore: createMemoryUserProfileStore(records) });
  const response = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } });
  assert.equal(response.status, 403); assert.equal((await response.json()).code, 'ACCOUNT_INACTIVE');
  assert.equal(records.get('verified-user').status, 'inactive');
});
test('Patient profile survives backend restart without duplication', async t => {
  const records = new Map();
  const first = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  assert.equal((await fetch(first.base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } })).status, 200);
  assert.equal(first.verifications(), 1);
  const second = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const me = await (await fetch(second.base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } })).json();
  assert.deepEqual(me.user.roles, ['patient']); assert.equal(records.size, 1);
});
test('CORS permits exact allowed origin and blocks unknown origin without wildcard', async t => {
  const { base, verifications } = await setup(t);
  const allowed = await fetch(base + '/api/auth/me', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const denied = await fetch(base + '/api/auth/me', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid' } });
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null); assert.equal(verifications(), 0);
});
test('production Live upgrade fails closed rather than treating Origin as identity', async t => {
  const { base } = await setup(t, 'verified-user');
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { origin: 'http://localhost:5173' });
  await new Promise((resolve, reject) => {
    socket.on('open', () => reject(new Error('Unauthenticated Live must not open')));
    socket.on('unexpected-response', (request, response) => { assert.equal(response.statusCode, 403); response.resume(); request.destroy(); resolve(); });
    socket.on('error', () => {});
  });
});
test('production cannot trust an Auth emulator', () => {
  assert.throws(() => configuredTokenVerifier({ NODE_ENV: 'production', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' }), /not permitted/);
});

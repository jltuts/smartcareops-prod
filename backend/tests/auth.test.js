import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { configuredTokenVerifier } from '../src/auth.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';
import { newCaseId } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';

async function setup(t, approved = '', patient = '', options = {}) {
  let verifications = 0;
  const caseStore = options.caseStore || createMemoryCaseStore(), { caseStore: _caseStore, ...authenticationOptions } = options;
  const api = createApiServer({ caseStore, authOptions: {
    env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_AUTH_UIDS: approved, DEV_PATIENT_UIDS: patient },
    verifyToken: async token => {
      verifications++;
      if (token !== 'valid-google-token') throw new Error('Do not disclose provider details');
      return { uid: 'verified-user', email: 'fictional@example.invalid', name: 'Verified Patient', role: 'owner', firebase: { sign_in_provider: 'google.com' } };
    },
    ...authenticationOptions,
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
test('only explicit backend UID allowlist grants bounded DEV demo access', async t => {
  const { base } = await setup(t, 'verified-user');
  const r = await fetch(base + '/api/auth/me', { headers: { 'X-Forwarded-Authorization': 'Bearer valid-google-token', Authorization: 'Bearer gateway-iam-token' } });
  assert.equal(r.status, 200);
  const me = await r.json(); assert.equal(me.demoAccess, true); assert.deepEqual(me.user.roles, ['patient', 'doctor', 'dispatcher', 'command-center']); assert.equal(me.liveAvailable, false);
});
test('auth/me returns every stored Firestore role in its stable stored order', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Verified User', roles: ['patient', 'doctor', 'dispatcher', 'command_center'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const response = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer valid-google-token' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.user.roles, ['patient', 'doctor', 'dispatcher', 'command_center']);
  assert.equal(body.demoAccess, true);
});
test('Firestore Doctor role authorizes Doctor APIs without DEV UID allowlisting', async t => {
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Verified User', roles: ['patient', 'doctor'], status: 'active', createdAt: 'earlier', updatedAt: 'earlier' }]]);
  const { base } = await setup(t, '', '', { userProfileStore: createMemoryUserProfileStore(records) });
  const response = await fetch(base + '/api/doctor/cases', { headers: { Authorization: 'Bearer valid-google-token' } });
  assert.equal(response.status, 200);
});
test('patient-only UID allowlist grants no privileged role', async t => {
  const { base } = await setup(t, '', 'verified-user');
  const headers = { Authorization: 'Bearer valid-google-token' };
  const response = await fetch(base + '/api/auth/me', { headers });
  assert.equal(response.status, 200);
  const me = await response.json();
  assert.equal(me.demoAccess, true);
  assert.deepEqual(me.user.roles, ['patient']);
  assert.equal((await fetch(base + '/api/doctor/cases', { headers })).status, 403);
  assert.equal((await fetch(base + '/api/dispatcher/cases', { headers })).status, 403);
  assert.equal((await fetch(base + '/api/operations', { headers })).status, 403);
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
  const records = new Map([['verified-user', { uid: 'verified-user', email: 'fixed@example.invalid', displayName: 'Google Name', roles: ['patient', 'doctor'], status: 'active', approvalState: 'approved', createdAt: 'earlier', updatedAt: 'earlier' }]]);
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
  ]);
  await caseStore.createCase({ caseId, intake: routingIntake(), patientUid: 'patient-owner', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
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

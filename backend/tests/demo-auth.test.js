import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDemoAuthentication, loadDemoAuthConfig, passwordHash } from '../src/demo-auth.js';
import { createMemoryDemoAccessStore } from '../src/demo-access.js';

const names = ['patient1', 'patient2', 'patient3', 'doctor1', 'doctor2', 'doctor3', 'dispatcher1', 'dispatcher2', 'commandcenter1', 'commandcenter2', 'admin1'];
async function fixture() {
  const accounts = [];
  for (const username of names) { const passwordSalt = randomBytes(16).toString('base64url'); accounts.push({ username, uid: `demo-local-${username}`, displayName: username, active: true, accountVersion: 1, passwordSalt, passwordHash: await passwordHash('Correct-demo-password!', passwordSalt) }); }
  return loadDemoAuthConfig({ DEMO_LOCAL_AUTH_ENABLED: 'true', DEMO_LOCAL_AUTH_CONFIG: JSON.stringify({ version: 1, signingKey: randomBytes(48).toString('base64url'), accounts }) });
}

test('demo authentication issues an eight-hour signed token without embedding roles or password data', async () => {
  const auth = createDemoAuthentication(await fixture(), { now: () => Date.parse('2026-10-18T00:00:00Z') });
  const login = await auth.login('patient1', 'Correct-demo-password!', 'test');
  const payload = JSON.parse(Buffer.from(login.sessionToken.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.sub, 'demo-local-patient1'); assert.equal(payload.exp - payload.iat, 28800);
  assert.equal(Object.hasOwn(payload, 'roles'), false); assert.equal(Object.hasOwn(payload, 'passwordHash'), false);
  assert.equal(auth.verify(login.sessionToken).username, 'patient1');
});

test('demo authentication rejects wrong, tampered, expired, and unknown credentials with one bounded error', async () => {
  let now = Date.parse('2026-10-18T00:00:00Z'); const auth = createDemoAuthentication(await fixture(), { now: () => now });
  await assert.rejects(auth.login('patient1', 'wrong', 'test'), error => error.code === 'DEMO_LOGIN_INVALID');
  await assert.rejects(auth.login('unknown', 'Correct-demo-password!', 'test'), error => error.code === 'DEMO_LOGIN_INVALID');
  const { sessionToken } = await auth.login('doctor1', 'Correct-demo-password!', 'other-source');
  const parts = sessionToken.split('.'); parts[2] = `${parts[2][0] === 'a' ? 'b' : 'a'}${parts[2].slice(1)}`;
  assert.throws(() => auth.verify(parts.join('.')), error => error.code === 'AUTH_INVALID');
  now += 8 * 60 * 60 * 1000 + 1000; assert.throws(() => auth.verify(sessionToken), error => error.code === 'AUTH_INVALID');
});

test('Demo Doctor roles and specialties remain fixed and server owned', async () => {
  const store = createMemoryDemoAccessStore();
  assert.deepEqual(await store.resolve({ username: 'doctor1' }), { roles: ['doctor'], specialties: ['general_medicine', 'neurology'] });
  assert.deepEqual(await store.resolve({ username: 'doctor2' }), { roles: ['doctor'], specialties: ['orthopedics'] });
  assert.deepEqual(await store.resolve({ username: 'doctor3' }), { roles: ['doctor'], specialties: ['cardiology'] });
});

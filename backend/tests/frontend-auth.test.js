import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthStatus, createAuthController } from '../../src/auth/controller.js';

test('Google SDK boundary owns user transitions and token retrieval', async () => {
  let observer, signIns = 0, signOuts = 0, tokenCalls = 0;
  const user = { uid: 'test-user', getIdToken: async () => { tokenCalls++; return 'mock-token'; } };
  const auth = createAuthController({ observe: next => { observer = next; }, signIn: async () => { signIns++; observer(user); }, signOut: async () => { signOuts++; observer(null); } });
  assert.equal(auth.getState().status, AuthStatus.AUTH_LOADING);
  observer(null); assert.equal(auth.getState().status, AuthStatus.SIGNED_OUT);
  await assert.rejects(auth.getIdToken(), /Sign in/);
  await auth.signIn(); assert.equal(auth.getState().status, AuthStatus.SIGNED_IN); assert.equal(auth.getState().user, user);
  assert.equal(await auth.getIdToken(), 'mock-token');
  await auth.signOut(); assert.equal(auth.getState().status, AuthStatus.SIGNED_OUT); assert.equal(auth.getState().user, null);
  assert.equal(signIns, 1); assert.equal(signOuts, 1); assert.equal(tokenCalls, 1);
  assert.equal('token' in auth.getState(), false);
});
test('persistent observer restores a signed-in session after controller creation', () => {
  const restored = { uid: 'restored-user', email: 'restored@example.invalid', getIdToken: async () => 'restored-token' };
  const auth = createAuthController({ observe: next => next(restored), signIn: async () => {}, signOut: async () => {} });
  assert.equal(auth.getState().status, AuthStatus.SIGNED_IN);
  assert.equal(auth.getState().user, restored);
});
test('auth failures expose only a safe UI message', async () => {
  const auth = createAuthController({ observe: next => next(null), signIn: async () => { throw new Error('provider-secret'); }, signOut: async () => {} });
  await auth.signIn(); assert.doesNotMatch(auth.getState().error, /provider-secret/);
});

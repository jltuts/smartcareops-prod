import test from 'node:test';
import assert from 'node:assert/strict';
import { startupReadiness, verifyStartupDependencies } from '../src/platform-readiness.js';

const env = { APP_ENV: 'development', CASE_STORE: 'firestore', FIREBASE_PROJECT_ID: 'gen-lang-client-0710663107', GEMINI_API_KEY: 'fictional-test-value', K_SERVICE: 'test' };
test('startup checks Firestore once and closes its client without reading a patient case', async () => {
  let reads = 0, closes = 0;
  const state = startupReadiness(() => verifyStartupDependencies(env, options => {
    assert.equal(options.databaseId, '(default)');
    return { doc: path => { assert.equal(path, '_smartcareops_platform/readiness'); return { get: async () => { reads++; } }; }, terminate: async () => { closes++; } };
  }));
  assert.equal(state.isReady(), false);
  await state.settled;
  assert.equal(state.isReady(), true);
  assert.equal(state.isReady(), true);
  assert.equal(reads, 1); assert.equal(closes, 1);
});
test('missing secret and hosted memory storage fail closed before external work', async () => {
  for (const invalid of [{ ...env, GEMINI_API_KEY: '' }, { ...env, CASE_STORE: 'memory' }]) {
    await assert.rejects(verifyStartupDependencies(invalid, () => assert.fail('No database initialization')));
  }
});
test('failed dependency keeps cached readiness false and disposes client', async () => {
  let closed = false;
  const state = startupReadiness(() => verifyStartupDependencies(env, () => ({ doc: () => ({ get: async () => { throw new Error('fictional failure'); } }), terminate: async () => { closed = true; } })));
  await state.settled;
  assert.equal(state.isReady(), false); assert.equal(closed, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentConfig, environmentMetadata } from '../src/environment.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';

test('environment metadata includes only safe configured values', () => {
  assert.deepEqual(environmentMetadata('firestore', { APP_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-project', GEMINI_API_KEY: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'private-path' }),
    { environment: 'development', projectId: 'demo-project', database: '(default)', storage: 'firestore' });
});
test('both environments use default database and obtain project IDs from configuration', () => {
  for (const environment of ['development', 'production']) {
    assert.deepEqual(environmentConfig({ APP_ENV: environment, FIREBASE_PROJECT_ID: `demo-${environment}` }), { environment, projectId: `demo-${environment}`, database: '(default)' });
  }
  assert.equal(environmentConfig({ NODE_ENV: 'production' }).environment, 'production');
  assert.equal(environmentConfig({}).projectId, null);
  assert.throws(() => environmentConfig({ APP_ENV: 'secret-invalid' }), /Invalid APP_ENV/);
});
test('production environment rejects local emulator even without NODE_ENV', () => {
  assert.equal(createConfiguredCaseStore({ APP_ENV: 'production', FIREBASE_PROJECT_ID: 'demo-project', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085' }).storage, 'unavailable');
});

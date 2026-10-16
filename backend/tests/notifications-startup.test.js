import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';
import { createMemoryPatternStore } from '../src/simulation/pattern-store.js';

const authOptions = () => ({
  env: { NODE_ENV: 'development', APP_ENV: 'development', CASE_STORE: 'memory', DEV_AUTH_UIDS: '', DEV_PATIENT_UIDS: '' },
  userProfileStore: createMemoryUserProfileStore(),
});

function patternOnlyServer(livePublicOnly) {
  const patternStore = createMemoryPatternStore({ alert: null, notifications: {}, approvals: {}, receipts: {}, followups: {} });
  return createApiServer({
    caseStore: createMemoryCaseStore(),
    authOptions: authOptions(),
    livePublicOnly,
    liveSessionEnabled: false,
    liveSessionStore: null,
    notificationsEnabled: true,
    notificationEnvironment: { NODE_ENV: 'production', APP_ENV: 'development', CASE_STORE: 'firestore' },
    patternEnabled: true,
    patternStore,
    patternService: { async close() {} },
    simulationEnabled: false,
    careTwinEnabled: false,
    predictiveEnabled: false,
  });
}

async function start(api) {
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  return `http://127.0.0.1:${api.server.address().port}`;
}

function noScopeServer(livePublicOnly) {
  return createApiServer({
    caseStore: createMemoryCaseStore(),
    authOptions: authOptions(),
    livePublicOnly,
    liveSessionEnabled: false,
    liveSessionStore: null,
    notificationsEnabled: true,
    notificationEnvironment: { NODE_ENV: 'production', APP_ENV: 'development', CASE_STORE: 'firestore' },
    patternEnabled: false,
    simulationEnabled: false,
    careTwinEnabled: false,
    predictiveEnabled: false,
  });
}

test('Live transport starts with notifications enabled and no notification case scope', async () => {
  const api = noScopeServer(true);
  const base = await start(api);
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    assert.equal((await fetch(`${base}/api/notifications?recipientType=doctor`)).status, 404);
  } finally { await api.shutdown(); }
});

test('normal API still initializes notifications and requires a configured scope', () => {
  assert.throws(() => noScopeServer(false), { code: 'NOTIFICATION_CASE_SCOPE_REQUIRED' });
});

test('M57 reviewed coordination starts with an Operations-only notification source', async () => {
  const api = createApiServer({
    caseStore: createMemoryCaseStore(), authOptions: authOptions(), liveSessionEnabled: false, liveSessionStore: null,
    operationsService: { async view() { return {}; }, async close() {} }, notificationsEnabled: true,
    notificationEnvironment: { NODE_ENV: 'production', APP_ENV: 'development', CASE_STORE: 'memory', M57_REVIEWED_COORDINATION_ENABLED: 'true' },
    simulationEnabled: false, careTwinEnabled: false, predictiveEnabled: false, patternEnabled: false,
  });
  const base = await start(api);
  try { assert.equal((await fetch(`${base}/healthz`)).status, 200); }
  finally { await api.shutdown(); }
});

test('M21 API starts with a pattern-only notification source and no clinical case scope', async () => {
  const api = patternOnlyServer(false);
  const base = await start(api);
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const response = await fetch(`${base}/api/notifications?recipientType=doctor`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.notifications, []);
    assert.deepEqual(body.unavailableScopes, []);
  } finally { await api.shutdown(); }
});

test('M21 live-transport starts with shared notification flags and keeps REST notifications unavailable', async () => {
  const api = patternOnlyServer(true);
  const base = await start(api);
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/notifications?recipientType=doctor`)).status, 404);
  } finally { await api.shutdown(); }
});

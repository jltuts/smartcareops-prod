import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApiServer } from '../src/server.js';
import { createMemoryCaseStore } from '../src/cases/store.js';
import { createLiveSessionLimiter, createMemoryLiveSessionStore, LIVE_PROTOCOL } from '../src/live-session.js';
import { browserSignalsAccept, createOriginPolicy } from '../src/origin.js';

const origin = 'http://localhost:5173';
const identity = { uid: 'patient-uid', email: 'patient@example.invalid', firebase: { sign_in_provider: 'google.com' } };

async function setup(t, { patient = true, now, livePublicOnly = false, liveSessionOptions = {}, liveOptions = {} } = {}) {
  const store = createMemoryLiveSessionStore({ ...(now ? { now } : {}) });
  const api = createApiServer({
    caseStore: createMemoryCaseStore(), liveSessionStore: store, liveSessionEnabled: true,
    liveWebSocketUrl: 'wss://live.example.invalid/api/live', livePublicOnly,
    authOptions: { env: { NODE_ENV: 'production', APP_ENV: 'development', DEV_PATIENT_UIDS: patient ? identity.uid : '' }, verifyToken: async token => {
      if (token !== 'firebase-token') throw new Error('invalid'); return identity;
    } },
    liveSessionOptions,
    liveOptions: { apiKey: 'fake', connect: async () => ({ sendRealtimeInput() {}, close() {} }), ...liveOptions },
  });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  return { api, store, base: `http://127.0.0.1:${api.server.address().port}` };
}

const post = (base, headers = {}) => fetch(base + '/api/live/session', { method: 'POST', headers: { Origin: origin, ...headers } });

test('bootstrap requires Firebase authentication and auto-provisions verified Google users as Patients', async t => {
  const allowed = await setup(t);
  assert.equal((await post(allowed.base)).status, 401);
  assert.equal((await post(allowed.base, { Authorization: 'Bearer invalid' })).status, 401);
  const newlyAuthenticated = await setup(t, { patient: false });
  assert.equal((await post(newlyAuthenticated.base, { Authorization: 'Bearer firebase-token' })).status, 201);
});

test('Patient bootstrap returns only a short-lived opaque session and binds exact origin', async t => {
  const { base } = await setup(t);
  const response = await post(base, { Authorization: 'Bearer firebase-token' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.webSocketUrl, 'wss://live.example.invalid/api/live');
  assert(Date.parse(body.expiresAt) > Date.now());
  assert(!JSON.stringify(body).includes('firebase-token'));
  assert.equal((await post(base, { Origin: 'https://evil.invalid', Authorization: 'Bearer firebase-token' })).status, 403);
});

test('origin policy normalizes scheme, hostname and port while rejecting unsafe forms', () => {
  const policy = createOriginPolicy(['https://gen-lang-client-0710663107.web.app', 'http://localhost:5173']);
  assert.equal(policy.validate('https://GEN-LANG-CLIENT-0710663107.web.app:443'), 'https://gen-lang-client-0710663107.web.app');
  assert.equal(policy.validate('http://localhost:5173'), 'http://localhost:5173');
  for (const value of [undefined, 'null', '*', 'https://gen-lang-client-0710663107.web.app.evil.com', 'https://evil-gen-lang-client-0710663107.web.app', 'https://gen-lang-client-0710663107.web.app/path', 'not-an-origin']) {
    assert.equal(policy.validate(value), null);
  }
});

test('session is one-time, rejects wrong origin, malformed token and expiry', async () => {
  let clock = 1_000;
  const store = createMemoryLiveSessionStore({ now: () => clock, ttlMs: 60_000 });
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  assert.equal(await store.consume({ token: session.token, origin: 'https://evil.invalid' }), null);
  assert.equal(await store.consume({ token: 'bad', origin }), null);
  assert.deepEqual(await store.consume({ token: session.token, origin }), { uid: identity.uid, roles: ['patient'] });
  assert.equal(await store.consume({ token: session.token, origin }), null);
  const expired = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  clock += 60_001;
  assert.equal(await store.consume({ token: expired.token, origin }), null);
});

test('concurrent double-use atomically permits exactly one connection identity', async () => {
  const store = createMemoryLiveSessionStore();
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  const results = await Promise.all([store.consume({ token: session.token, origin }), store.consume({ token: session.token, origin })]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter(value => value === null).length, 1);
  assert.equal(results.find(Boolean).uid, identity.uid);
});

test('bootstrap rate and outstanding-session limits fail closed with generic response', async t => {
  const logs = [];
  const limiter = createLiveSessionLimiter({ perUid: 10, perOrigin: 10, outstandingPerUid: 2 });
  const { base } = await setup(t, { liveSessionOptions: { limiter, log: detail => logs.push(detail) } });
  const headers = { Authorization: 'Bearer firebase-token' };
  assert.equal((await post(base, headers)).status, 201);
  assert.equal((await post(base, headers)).status, 201);
  const rejected = await post(base, headers);
  assert.equal(rejected.status, 429);
  assert.deepEqual(await rejected.json(), { code: 'LIVE_SESSION_REJECTED' });
  assert(logs.some(entry => entry.reason === 'rate_limit'));
  assert(!JSON.stringify(logs).includes('firebase-token'));
  assert(!JSON.stringify(logs).includes('smartcareops.session.'));
});

test('bootstrap rejects missing, null, malformed, lookalike origins and invalid browser metadata', async t => {
  const { base } = await setup(t);
  const authorization = { Authorization: 'Bearer firebase-token' };
  assert.equal((await fetch(base + '/api/live/session', { method: 'POST', headers: authorization })).status, 403);
  for (const bad of ['null', 'not-an-origin', 'http://localhost:5173.evil.com']) {
    assert.equal((await post(base, { ...authorization, Origin: bad })).status, 403);
  }
  assert.equal(browserSignalsAccept({ 'sec-fetch-mode': 'navigate' }), false);
  assert.equal(browserSignalsAccept({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), true);
  assert.equal(browserSignalsAccept({ 'sec-fetch-mode': 'websocket' }, { webSocket: true }), true);
});

test('public Live transport exposes no REST API and consumes bootstrap before upgrade', async t => {
  const { api, store, base } = await setup(t, { livePublicOnly: true });
  assert.equal((await fetch(base + '/api/auth/me')).status, 404);
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  const connect = token => new Promise(resolve => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', [LIVE_PROTOCOL, `smartcareops.session.${token}`], { origin });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (request, response) => { response.resume(); request.destroy(); resolve(response.statusCode); });
    ws.on('error', () => {});
  });
  assert.equal(await connect(session.token), 101);
  assert.equal(await connect(session.token), 403);
  assert.equal(await connect('A'.repeat(43)), 403);
  assert.equal(api.server.listenerCount('upgrade') > 0, true);
});

test('upgrade logs outcomes without credential or authorization material', async t => {
  const logs = [];
  const { store, base } = await setup(t, { livePublicOnly: true, liveOptions: { upgradeLog: detail => logs.push(detail) } });
  const session = await store.create({ uid: identity.uid, roles: ['patient'], origin });
  const status = await new Promise(resolve => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', [LIVE_PROTOCOL, `smartcareops.session.${session.token}`], { origin: 'https://evil.invalid' });
    ws.on('unexpected-response', (request, response) => { response.resume(); request.destroy(); resolve(response.statusCode); });
    ws.on('error', () => {});
  });
  assert.equal(status, 403);
  const serialized = JSON.stringify(logs);
  assert(!serialized.includes(session.token));
  assert(!serialized.includes('Authorization'));
  assert(logs.some(entry => entry.reason === 'origin'));
});

test('repeated failed upgrade attempts are bounded per transport instance', async t => {
  const { base } = await setup(t, { livePublicOnly: true, liveOptions: { upgradeLimit: 2 } });
  const attempt = () => new Promise(resolve => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', [LIVE_PROTOCOL, `smartcareops.session.${'A'.repeat(43)}`], { origin });
    ws.on('unexpected-response', (request, response) => { response.resume(); request.destroy(); resolve(response.statusCode); });
    ws.on('error', () => {});
  });
  assert.equal(await attempt(), 403);
  assert.equal(await attempt(), 403);
  assert.equal(await attempt(), 429);
});

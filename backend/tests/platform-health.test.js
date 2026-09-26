import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../src/server.js';

test('platform probes preserve /health and never query data or invoke clinical actions', async t => {
  const caseStore = new Proxy({ storage: 'unavailable' }, { get(target, key) {
    if (key in target) return target[key];
    if (key === 'close') return undefined;
    return () => assert.fail(`A health probe must not invoke ${String(key)}`);
  } });
  const api = createApiServer({ caseStore, agentRun: () => assert.fail('No browser execution') });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  for (const path of ['/health', '/healthz']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'smartcareops-api' });
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 404);
  }
  const unavailable = await fetch(base + '/readyz');
  assert.equal(unavailable.status, 503);
});

test('readiness changes independently of liveness without per-request dependency calls', async t => {
  let ready = false;
  const api = createApiServer({ caseStore: { storage: 'memory' }, isReady: () => ready });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `http://127.0.0.1:${api.server.address().port}`;
  assert.equal((await fetch(base + '/readyz')).status, 503);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  ready = true;
  assert.equal((await fetch(base + '/readyz')).status, 200);
  assert.equal((await fetch(base + '/readyz', { method: 'POST' })).status, 404);
});

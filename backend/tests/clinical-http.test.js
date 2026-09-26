import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, observationSet } from './clinical-fixtures.js';
import { clinicalEndpoint } from '../src/clinical/http.js';
import { resourceFixture } from './resources-fixtures.js';
test('HTTP clinical commands reject forged identity, fields, origins and arbitrary targets', async t => {
  const f = await fixture(), origin = 'http://localhost:4173';
  const server = createServer(clinicalEndpoint(f.service, [origin])); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/clinical`;
  const post = (path, body, source = origin) => fetch(base + path, { method: 'POST', headers: { Origin: source, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/observations', observationSet(), 'https://evil.test')).status, 403);
  assert.equal((await post('/observations', { ...observationSet(), caseId: 'arbitrary' })).status, 400);
  assert.equal((await post('/observations', observationSet())).status, 200); await f.service.tick();
  const view = await (await fetch(base)).json(), id = view.approvals[0].approvalId;
  assert.equal((await post(`/approvals/${id}`, { decision: 'approved', reviewer: 'real_doctor' })).status, 400);
  assert.equal((await post(`/approvals/${id}`, { decision: 'approved' })).status, 200); await f.service.tick();
  const after = await (await fetch(base)).json(); assert.equal(after.receipts.length, 1); assert.equal(after.approvals[0].reviewer, 'demo_doctor');
  assert.equal((await post('/execute_shell', {})).status, 400);
});

test('HTTP capacity command enforces origin, exact fields, known IDs, version conflict and idempotency', async t => {
  const f = await resourceFixture(), origin = 'http://localhost:4173'; await f.service.append(observationSet()); await f.service.tick();
  const server = createServer(clinicalEndpoint(f.service, [origin])); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await f.service.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/clinical/resources/capacity`;
  const input = { requestId: 'httpCapacity', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 1 };
  const post = (body, source = origin) => fetch(url, { method: 'POST', headers: { Origin: source, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(input, 'https://evil.test')).status, 403);
  assert.equal((await post({ ...input, source: 'live' })).status, 400);
  assert.equal((await post({ ...input, monitoredBedsAvailable: -1 })).status, 400);
  assert.equal((await post(input)).status, 200); await f.service.tick();
  assert.equal((await post(input)).status, 200);
  const conflict = await post({ ...input, requestId: 'stale' }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'RESOURCE_VERSION_CONFLICT');
  assert.equal((await f.service.view()).resourceEnvironment.version, 2);
});

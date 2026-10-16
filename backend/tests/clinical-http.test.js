import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, observationSet } from './clinical-fixtures.js';
import { clinicalEndpoint } from '../src/clinical/http.js';
import { resourceFixture } from './resources-fixtures.js';
import { newCaseId } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';
import { memoryClinicalStore } from '../src/clinical/storage.js';
import { createClinicalService } from '../src/clinical/service.js';
test('HTTP clinical commands reject forged identity, fields, origins and arbitrary targets', async t => {
  const f = await fixture(), origin = 'https://gen-lang-client-0710663107.web.app';
  const server = createServer(clinicalEndpoint(f.service, [origin])); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/clinical`;
  const post = (path, body, source = origin) => fetch(base + path, { method: 'POST', headers: {
    Origin: source, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
  }, body: JSON.stringify(body) });
  assert.equal((await post('/observations', observationSet(), 'https://evil.test')).status, 403);
  assert.equal((await post('/observations', { ...observationSet(), caseId: 'arbitrary' })).status, 400);
  assert.equal((await post('/observations', observationSet())).status, 200); await f.service.tick();
  const view = await (await fetch(base)).json(), id = view.approvals[0].approvalId;
  assert.equal((await post(`/approvals/${id}`, { decision: 'approved', reviewer: 'real_doctor' })).status, 400);
  const approved = await post(`/approvals/${id}`, { decision: 'approved' });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).status, 'approved'); await f.service.tick();
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

test('HTTP case review decision is exact, durable, and independent of recommended actions', async t => {
  const { caseStore } = await fixture();
  // Use a dedicated submitted Live case because a case-level review is not
  // valid for a generic observation-only clinical fixture.
  const submittedId = newCaseId();
  await caseStore.createCase({ caseId: submittedId, intake: routingIntake(), patientUid: 'patient-1', submittedForReview: true,
    intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  const service = createClinicalService({ caseId: submittedId, caseStore, store: memoryClinicalStore(), modelName: 'test-model', model: async () => { throw new Error('not needed'); } });
  const origin = 'https://gen-lang-client-0710663107.web.app', server = createServer(clinicalEndpoint(service, [origin]));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/clinical/case-review?caseId=${submittedId}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  const requestId = crypto.randomUUID(), post = body => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ requestId, decision: 'approved', actionId: 'forged' })).status, 400);
  const first = await post({ requestId, decision: 'approved' }); assert.equal(first.status, 200);
  assert.equal((await post({ requestId, decision: 'approved' })).status, 200);
  const conflict = await post({ requestId: crypto.randomUUID(), decision: 'rejected' }); assert.equal(conflict.status, 409);
  assert.equal((await caseStore.getCase(submittedId)).clinicalReview.status, 'approved');
});

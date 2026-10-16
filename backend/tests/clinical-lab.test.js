import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, assessment } from './clinical-fixtures.js';
import { clinicalEndpoint } from '../src/clinical/http.js';

const reportId = '0db12bf8-1853-4c29-aa5a-926566f14e01';
const verified = revision => ({
  reportId, status: 'verified', verifiedResult: { revision, rows: [{ sourceIndex: 0, testName: 'Sodium', resultText: '140', numericValue: 140,
    unit: 'mmol/L', referenceRange: '135-145', sourceLocation: 'page 1', uncertain: false, unreadable: false }] },
  unverifiedExtraction: { rows: [{ testName: 'Wrong AI value', resultText: '999' }] },
});

test('only a Doctor-requested current verified revision enters a review-only assessment', async () => {
  let report = verified(1), seen;
  const f = await fixture({ labReportStore: { list: async () => [report] }, model: async context => { seen = context; return assessment(context); } });
  await f.caseStore.routeCase(f.caseId, { availableSpecialties: new Set(['neurology']) });
  await assert.rejects(f.service.requestLabRun({ requestId: 'old', reportId, expectedRevision: 2 }), { code: 'LAB_REVISION_STALE' });
  const requested = await f.service.requestLabRun({ requestId: 'current', reportId, expectedRevision: 1 });
  assert.equal(requested.type, 'lab.assessment.requested');
  await f.service.tick();
  const view = await f.service.view(), plan = view.plans.find(item => item.labBinding);
  assert.equal(plan?.status, 'current');
  assert.equal(plan.labBinding.revision, 1);
  assert.deepEqual(plan.recommendedActions, []);
  assert.equal(seen.verifiedLabReport.rows[0].resultText, '140');
  assert.equal(JSON.stringify(seen).includes('Wrong AI value'), false);
  assert.ok(plan.evidenceRefs.includes(seen.verifiedLabReport.evidenceRef));
  report = verified(2);
  const stale = await f.service.view();
  assert.equal(stale.plans.find(item => item.labBinding).status, 'stale');
  assert.equal(stale.meta.ready, false);
});

test('unverified lab rows cannot request a clinical assessment', async () => {
  const f = await fixture({ labReportStore: { list: async () => [{ reportId, status: 'pending_review', unverifiedExtraction: { rows: [{ testName: 'Sodium' }] } }] } });
  await f.caseStore.routeCase(f.caseId, { availableSpecialties: new Set(['neurology']) });
  await assert.rejects(f.service.requestLabRun({ requestId: 'unverified', reportId, expectedRevision: 1 }), { code: 'LAB_REVISION_STALE' });
  assert.equal((await f.store.read(f.caseId)).events && Object.keys((await f.store.read(f.caseId)).events).length, 0);
});

test('a verification change during Gemini processing cannot publish the old lab assessment', async () => {
  let report = verified(1), release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture({ labReportStore: { list: async () => [report] }, model: context => new Promise(resolve => {
    release = () => resolve(assessment(context)); started();
  }) });
  await f.caseStore.routeCase(f.caseId, { availableSpecialties: new Set(['neurology']) });
  await f.service.requestLabRun({ requestId: 'changing', reportId, expectedRevision: 1 });
  const running = f.service.tick(); await entered;
  report = verified(2); release(); await running;
  const view = await f.service.view();
  assert.equal(view.plans.length, 0);
  assert.equal(view.runs[0].status, 'failed');
  assert.equal(view.receipts.length, 0);
});

test('lab assessment HTTP request requires an authorized Doctor, exact body, and allowed origin', async t => {
  const f = await fixture({ labReportStore: { list: async () => [verified(1)] } });
  await f.caseStore.routeCase(f.caseId, { availableSpecialties: new Set(['neurology']) });
  const origin = 'http://localhost:5173';
  const handler = clinicalEndpoint(f.service, [origin], { authorizeDoctorCase: async user => user.specialties.includes('neurology') });
  const server = createServer((request, response) => {
    request.user = { uid: 'doctor-1', roles: request.headers['x-test-role'] === 'patient' ? ['patient'] : ['doctor'],
      specialties: [request.headers['x-test-specialty'] || 'neurology'] };
    return handler(request, response);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/clinical/lab-run?caseId=${f.caseId}`;
  const input = { requestId: 'http_lab', reportId, expectedRevision: 1 };
  const post = (body, extra = {}) => fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post(input, { 'x-test-role': 'patient' })).status, 404);
  assert.equal((await post(input, { 'x-test-specialty': 'orthopedics' })).status, 404);
  assert.equal((await post(input, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await post({ ...input, unverifiedRows: [] })).status, 400);
  assert.equal((await post(input)).status, 200);
});

test('local demo accepts the same verified-lab request without Firebase identity', async t => {
  const f = await fixture({ labReportStore: { list: async () => [verified(1)] } });
  await f.caseStore.routeCase(f.caseId, { availableSpecialties: new Set(['neurology']) });
  const origin = 'http://127.0.0.1:5173';
  const server = createServer(clinicalEndpoint(f.service, [origin], { authEnabled: false }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/clinical/lab-run?caseId=${f.caseId}`;
  const response = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'local_demo', reportId, expectedRevision: 1 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).type, 'lab.assessment.requested');
});

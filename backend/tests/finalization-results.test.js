import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createFinalizationResults, createMemoryFinalizationDriver } from '../src/finalization-results.js';

test('summary result is UID-bound, durable across instances, and preserves the committed copy', async t => {
  const records = new Map(), writer = createFinalizationResults({ driver: createMemoryFinalizationDriver(records), log() {} });
  const reader = createFinalizationResults({ driver: createMemoryFinalizationDriver(records), log() {} });
  const server = createServer((req, res) => { req.user = { uid: req.headers['x-test-uid'] }; void reader.handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/intake-finalization`;
  const job = await writer.create({ uid: 'patient-1', caseId: 'SC-10000000-0000-4000-8000-000000000001' });
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(url, { headers: { 'X-SmartCareOps-Finalization-Id': job.ticket, 'X-Test-Uid': 'patient-2' } })).status, 404);
  const options = { headers: { 'X-SmartCareOps-Finalization-Id': job.ticket, 'X-Test-Uid': 'patient-1' } };
  assert.equal((await fetch(url, options)).status, 202);
  const result = { type: 'intake-complete', status: 'COMPLETED', snapshot: { patient: { name: 'JL' } }, patientCase: { caseId: 'SC-10000000-0000-4000-8000-000000000001', workflowStatus: 'submitted_for_clinical_review' } };
  await job.resolve(result); result.snapshot.patient.name = 'Changed';
  await job.resolve({ status: 'FAILED' }); // A second resolution cannot replace the committed result.
  const response = await fetch(url, options);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).snapshot.patient.name, 'JL');
  assert.equal((await fetch(url, options)).status, 200);
});

test('pending and failed finalization states remain durable across a simulated process restart', async t => {
  const records = new Map(), first = createFinalizationResults({ driver: createMemoryFinalizationDriver(records), log() {} });
  const job = await first.create({ uid: 'patient-1' });
  await first.close();
  const restarted = createFinalizationResults({ driver: createMemoryFinalizationDriver(records), log() {} });
  const server = createServer((req, res) => { req.user = { uid: 'patient-1' }; void restarted.handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/intake-finalization`, options = { headers: { 'X-SmartCareOps-Finalization-Id': job.ticket } };
  assert.equal((await fetch(url, options)).status, 202);
  await job.resolve({ status: 'FAILED', error: { code: 'EXTRACTION_FAILED' } });
  const response = await fetch(url, options);
  assert.equal(response.status, 200); assert.equal((await response.json()).error.code, 'EXTRACTION_FAILED');
});

test('pending durable result exposes a persisted minimal case across instances', async t => {
  const records = new Map(), writer = createFinalizationResults({ driver: createMemoryFinalizationDriver(records), log() {} });
  const reader = createFinalizationResults({ driver: createMemoryFinalizationDriver(records), log() {} });
  const server = createServer((req, res) => { req.user = { uid: 'patient-1' }; void reader.handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const job = await writer.create({ uid: 'patient-1', caseId: 'SC-10000000-0000-4000-8000-000000000002' });
  await job.progress({ patientCase: { caseId: 'SC-10000000-0000-4000-8000-000000000002', workflowStatus: 'submitted_for_clinical_review', enrichmentStatus: 'pending' } });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/intake-finalization`, { headers: { 'X-SmartCareOps-Finalization-Id': job.ticket } });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'PENDING');
  assert.equal(body.patientCase.workflowStatus, 'submitted_for_clinical_review');
  assert.equal(body.patientCase.enrichmentStatus, 'pending');
});

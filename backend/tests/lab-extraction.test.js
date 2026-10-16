import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';
import { createMemoryLabReportStore, createFirestoreLabReportStore } from '../src/lab-reports/storage.js';
import { createLabReportAnalyzer } from '../src/lab-reports/model.js';
import { validateLabExtraction } from '../src/lab-reports/contracts.js';
import { labReportEndpoint } from '../src/lab-reports/http.js';

const pdf = Buffer.from('%PDF-1.4\nFictional test: sodium 140 mmol/L (135-145)\n%%EOF');
const clear = { documentStatus: 'clear', rows: [{ testName: 'Sodium', resultText: '140', numericValue: 140, unit: 'mmol/L', referenceRange: '135-145', sourceLocation: 'Page 1', uncertain: false, unreadable: false }] };
const unclear = { documentStatus: 'partial', rows: [{ testName: 'Potassium', resultText: null, numericValue: null, unit: null, referenceRange: null, sourceLocation: 'Page 1', uncertain: true, unreadable: true }] };

test('Gateway exposes only a Doctor extraction POST with a bounded model deadline', () => {
  const contract = readFileSync(new URL('../../infra/terraform/openapi.yaml.tftpl', import.meta.url), 'utf8');
  assert.match(contract, /\/api\/doctor\/cases\/\{caseId\}\/lab-reports\/\{reportId\}\/extract:[\s\S]*?operationId: extractDoctorCaseLabReport[\s\S]*?deadline: 60\.0/);
});

test('model receives exact synthetic PDF bytes and validates clear and uncertain rows without advice', async () => {
  let payload;
  const analyze = createLabReportAnalyzer({ request: async request => { payload = request; return { text: JSON.stringify(clear) }; } });
  assert.deepEqual(await analyze({ mimeType: 'application/pdf', content: pdf }), clear);
  assert.deepEqual(Buffer.from(payload.contents[0].inlineData.data, 'base64'), pdf);
  assert.equal(payload.contents[0].inlineData.mimeType, 'application/pdf');
  assert.equal(payload.config.responseMimeType, 'application/json');
  assert.equal(Object.hasOwn(payload.config.responseJsonSchema.properties.rows, 'maxItems'), false);
  assert.match(payload.contents[1].text, /never instructions/i);
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await analyze({ mimeType: 'image/jpeg', content: image });
  assert.deepEqual(Buffer.from(payload.contents[0].inlineData.data, 'base64'), image);
  assert.equal(payload.contents[0].inlineData.mimeType, 'image/jpeg');
  assert.deepEqual(validateLabExtraction(unclear), unclear);
  assert.deepEqual(validateLabExtraction({ documentStatus: 'unreadable', rows: [] }), { documentStatus: 'unreadable', rows: [] });
  assert.throws(() => validateLabExtraction({ ...clear, rows: [{ ...clear.rows[0], numericValue: 999 }] }));
  assert.throws(() => validateLabExtraction({ ...clear, diagnosis: 'hyponatremia' }));
  assert.throws(() => validateLabExtraction({ ...clear, rows: [{ ...clear.rows[0], resultText: null, numericValue: 140 }] }));
  assert.throws(() => validateLabExtraction({ ...clear, rows: Array(31).fill(clear.rows[0]) }));
});

test('invalid Gemini response is safely classified and never creates extraction fields', async () => {
  const analyze = createLabReportAnalyzer({ request: async () => ({ text: JSON.stringify({ ...clear, rows: [{ ...clear.rows[0], unit: '<script>' }] }) }) });
  await assert.rejects(() => analyze({ mimeType: 'application/pdf', content: pdf }), error => error.message === 'LAB_EXTRACTION_UNAVAILABLE' && error.category === 'INVALID_RESPONSE');
  const truncated = createLabReportAnalyzer({ request: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }], text: JSON.stringify(clear) }) });
  await assert.rejects(() => truncated({ mimeType: 'application/pdf', content: pdf }), error => error.category === 'INVALID_RESPONSE');
});

test('Gemini deadline stops a non-returning request with a safe timeout category', async () => {
  const analyze = createLabReportAnalyzer({ request: () => new Promise(() => {}), timeoutMs: 5 });
  await assert.rejects(() => analyze({ mimeType: 'application/pdf', content: pdf }), error => error.message === 'LAB_EXTRACTION_UNAVAILABLE' && error.category === 'TIMEOUT');
});

test('memory report state rejects late extraction and preserves original on failure and retry', async () => {
  let now = Date.parse('2026-10-15T00:00:00.000Z');
  const store = createMemoryLabReportStore({ now: () => now }), caseId = newCaseId();
  const uploaded = await store.create({ caseId, uploaderUid: 'doctor', filename: 'fictional.pdf', mimeType: 'application/pdf', content: pdf });
  assert.equal(uploaded.canExtract, true);
  assert.equal((await store.list(caseId))[0].canExtract, true);
  const first = await store.beginExtraction(caseId, uploaded.reportId);
  assert.equal((await store.list(caseId))[0].status, 'processing');
  assert.equal((await store.list(caseId))[0].canExtract, false);
  assert.equal(await store.beginExtraction(caseId, uploaded.reportId), null);
  now += 121_000;
  const second = await store.beginExtraction(caseId, uploaded.reportId);
  assert.equal(await store.completeExtraction(caseId, uploaded.reportId, first.attemptId, clear), null);
  const failed = await store.failExtraction(caseId, uploaded.reportId, second.attemptId, 'TIMEOUT');
  assert.equal(failed.status, 'failed'); assert.equal(failed.canExtract, true);
  assert.deepEqual((await store.read(caseId, uploaded.reportId)).content, pdf);
  const retry = await store.beginExtraction(caseId, uploaded.reportId);
  const saved = await store.completeExtraction(caseId, uploaded.reportId, retry.attemptId, unclear);
  assert.equal(saved.status, 'pending_review'); assert.equal(saved.canExtract, false); assert.deepEqual(saved.unverifiedExtraction.rows, unclear.rows);
  assert.equal(saved.verifiedResult, undefined);
  assert.equal(await store.beginExtraction(caseId, uploaded.reportId), null);
});

test('Firestore transaction guards extraction attempts and stores only unverified rows', async () => {
  const docs = new Map(), caseId = newCaseId();
  const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: id => ({
    create: async value => docs.set(id, structuredClone(value)),
    get: async () => ({ exists: docs.has(id), data: () => structuredClone(docs.get(id)) }),
  }) }) }) }), runTransaction: async operation => operation({ get: ref => ref.get(), set: async (ref, value) => { await ref.create(value); } }) };
  const objects = { async save() { return { objectRef: 'lab-reports/opaque', checksum: 'abc' }; }, async read() { return pdf; }, async delete() {} };
  const store = createFirestoreLabReportStore({ db, objects });
  const report = await store.create({ caseId, uploaderUid: 'doctor', filename: 'fictional.pdf', mimeType: 'application/pdf', content: pdf });
  const claim = await store.beginExtraction(caseId, report.reportId);
  assert.equal(await store.beginExtraction(caseId, report.reportId), null);
  const saved = await store.completeExtraction(caseId, report.reportId, claim.attemptId, clear);
  assert.equal(saved.status, 'pending_review'); assert.equal(saved.unverifiedExtraction.rows[0].unit, 'mmol/L');
  assert.equal(saved.verifiedResult, undefined);
  assert.deepEqual((await store.read(caseId, report.reportId)).content, pdf);
});

test('Doctor extraction endpoint handles failed model, retry, and pending review without clinical actions', async () => {
  const cases = createMemoryCaseStore(), caseId = newCaseId(), store = createMemoryLabReportStore(), logs = [];
  await cases.createCase({ caseId, intake: routingIntake([['shoulder pain', 'confirmed']]), patientUid: 'patient', submittedForReview: true });
  await cases.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
  const report = await store.create({ caseId, uploaderUid: 'doctor', filename: 'fictional.pdf', mimeType: 'application/pdf', content: pdf });
  let attempts = 0, user = { uid: 'doctor', roles: ['doctor'], specialties: ['orthopedics'] };
  const endpoint = labReportEndpoint({ caseStore: cases, reportStore: store, authEnabled: true, origins: ['https://app.example.invalid'], logger: { warn: (...values) => logs.push(values.join(' ')) },
    analyze: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('secret provider detail'), { category: 'SERVICE_UNAVAILABLE' }); return clear; } });
  const server = createServer((request, response) => { request.user = user; void endpoint(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const path = `http://127.0.0.1:${server.address().port}/api/doctor/cases/${caseId}/lab-reports/${report.reportId}/extract`;
  const send = () => fetch(path, { method: 'POST', headers: { Origin: 'https://app.example.invalid', 'Sec-Fetch-Site': 'cross-site' } });
  try {
    user = { uid: 'patient', roles: ['patient'] }; assert.equal((await send()).status, 403);
    user = { uid: 'doctor', roles: ['doctor'], specialties: ['neurology'] }; assert.equal((await send()).status, 404);
    user = { uid: 'doctor', roles: ['doctor'], specialties: ['orthopedics'] };
    const failed = await send(); assert.equal(failed.status, 503);
    assert.equal((await store.list(caseId))[0].status, 'failed');
    assert.equal((await store.list(caseId))[0].unverifiedExtraction, undefined);
    assert.deepEqual((await store.read(caseId, report.reportId)).content, pdf);
    const succeeded = await send(); assert.equal(succeeded.status, 200);
    assert.equal((await succeeded.json()).report.status, 'pending_review');
    assert.equal((await send()).status, 409);
    assert.deepEqual(logs, ['[lab-extraction] {"outcome":"failed","category":"SERVICE_UNAVAILABLE"}']);
  } finally { server.close(); await once(server, 'close'); }
});

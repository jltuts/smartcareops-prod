import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';
import { createMemoryLabReportStore, createFirestoreLabReportStore } from '../src/lab-reports/storage.js';
import { labReportEndpoint } from '../src/lab-reports/http.js';
import { validateLabReview } from '../src/lab-reports/review.js';

const pdf = Buffer.from('%PDF-1.4\nFictional sodium: 140 mmol/L\n%%EOF');
const extraction = { documentStatus: 'clear', rows: [{ testName: 'Sodium', resultText: '140', numericValue: 140, unit: 'mmol/L', referenceRange: '135-145', sourceLocation: 'Page 1', uncertain: false, unreadable: false }] };
const reviewedRow = { include: true, testName: 'Sodium', resultText: '141', numericValue: 141, unit: 'mmol/L', referenceRange: '135-145', sourceLocation: 'Page 1' };
const input = expectedReviewToken => ({ expectedReviewToken, confirmedOriginal: true, rows: [reviewedRow] });

test('Doctor review contract keeps original extraction and records each correction', () => {
  const result = validateLabReview(input('f142c55c-019a-4581-a263-572be3a6b913'), extraction);
  const { include, ...fields } = reviewedRow;
  assert.deepEqual(result.rows[0], { sourceIndex: 0, ...fields, uncertain: false, unreadable: false });
  assert.deepEqual(result.corrections, [
    { sourceIndex: 0, field: 'resultText', originalValue: '140', verifiedValue: '141' },
    { sourceIndex: 0, field: 'numericValue', originalValue: 140, verifiedValue: 141 },
  ]);
  assert.throws(() => validateLabReview({ ...input('v'), confirmedOriginal: false }, extraction));
  assert.throws(() => validateLabReview({ ...input('v'), rows: [{ include: false }] }, extraction));
  assert.throws(() => validateLabReview({ ...input('v'), rows: [{ ...reviewedRow, numericValue: 999 }] }, extraction));
});

test('memory verification is version-checked, Doctor-owned, and preserves the original', async () => {
  const store = createMemoryLabReportStore(), caseId = newCaseId();
  const report = await store.create({ caseId, uploaderUid: 'uploader', filename: 'fictional.pdf', mimeType: 'application/pdf', content: pdf });
  const claim = await store.beginExtraction(caseId, report.reportId);
  const pending = await store.completeExtraction(caseId, report.reportId, claim.attemptId, extraction);
  assert.equal(await store.verify(caseId, report.reportId, input('f142c55c-019a-4581-a263-572be3a6b913'), 'doctor-a'), null);
  const verified = await store.verify(caseId, report.reportId, input(pending.reviewToken), 'doctor-a');
  assert.equal(verified.status, 'verified'); assert.equal(verified.verifiedResult.revision, 1);
  assert.equal(verified.verifiedResult.verifiedBy, 'doctor-a');
  assert.equal(verified.unverifiedExtraction.rows[0].resultText, '140');
  assert.equal(verified.verifiedResult.rows[0].resultText, '141');
  assert.deepEqual((await store.read(caseId, report.reportId)).content, pdf);
  assert.equal(await store.verify(caseId, report.reportId, input(pending.reviewToken), 'doctor-b'), null);
});

test('Firestore verification checks the extraction token inside its transaction', async () => {
  const documents = new Map(), caseId = newCaseId();
  const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: id => ({
    create: async value => documents.set(id, structuredClone(value)),
    get: async () => ({ exists: documents.has(id), data: () => structuredClone(documents.get(id)) }),
  }) }) }) }), runTransaction: async operation => operation({
    get: ref => ref.get(), set: (ref, value) => { documents.set(value.reportId, structuredClone(value)); },
  }) };
  const objects = { async save() { return { objectRef: 'lab-reports/opaque', checksum: 'synthetic-checksum' }; }, async read() { return pdf; }, async delete() {} };
  const store = createFirestoreLabReportStore({ db, objects });
  const report = await store.create({ caseId, uploaderUid: 'uploader', filename: 'fictional.pdf', mimeType: 'application/pdf', content: pdf });
  const claim = await store.beginExtraction(caseId, report.reportId);
  const pending = await store.completeExtraction(caseId, report.reportId, claim.attemptId, extraction);
  assert.equal(await store.verify(caseId, report.reportId, input('f142c55c-019a-4581-a263-572be3a6b913'), 'doctor-a'), null);
  const verified = await store.verify(caseId, report.reportId, input(pending.reviewToken), 'doctor-a');
  assert.equal(verified.status, 'verified'); assert.equal(verified.reviewToken, undefined);
  assert.equal(verified.verifiedResult.corrections.length, 2);
  assert.equal(await store.verify(caseId, report.reportId, input(pending.reviewToken), 'doctor-b'), null);
  assert.deepEqual((await store.read(caseId, report.reportId)).content, pdf);
});

test('Doctor verify endpoint rejects wrong role, wrong specialty, invalid review, and stale tabs', async () => {
  const contract = readFileSync(new URL('../../infra/terraform/openapi.yaml.tftpl', import.meta.url), 'utf8');
  assert.match(contract, /\/api\/doctor\/cases\/\{caseId\}\/lab-reports\/\{reportId\}\/verify:[\s\S]*?operationId: verifyDoctorCaseLabReport/);
  const cases = createMemoryCaseStore(), caseId = newCaseId(), reports = createMemoryLabReportStore();
  await cases.createCase({ caseId, intake: routingIntake([['shoulder pain', 'confirmed']]), patientUid: 'patient', submittedForReview: true });
  await cases.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
  const report = await reports.create({ caseId, uploaderUid: 'uploader', filename: 'fictional.pdf', mimeType: 'application/pdf', content: pdf });
  const claim = await reports.beginExtraction(caseId, report.reportId);
  const pending = await reports.completeExtraction(caseId, report.reportId, claim.attemptId, extraction);
  let user = { uid: 'doctor-a', roles: ['doctor'], specialties: ['orthopedics'] };
  const endpoint = labReportEndpoint({ caseStore: cases, reportStore: reports, authEnabled: true, origins: ['https://app.example.invalid'] });
  const server = createServer((request, response) => { request.user = user; void endpoint(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const path = `http://127.0.0.1:${server.address().port}/api/doctor/cases/${caseId}/lab-reports/${report.reportId}/verify`;
  const send = body => fetch(path, { method: 'POST', headers: { Origin: 'https://app.example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    user = { uid: 'patient', roles: ['patient'] }; assert.equal((await send(input(pending.reviewToken))).status, 403);
    user = { uid: 'doctor-b', roles: ['doctor'], specialties: ['neurology'] }; assert.equal((await send(input(pending.reviewToken))).status, 404);
    user = { uid: 'doctor-a', roles: ['doctor'], specialties: ['orthopedics'] };
    assert.equal((await send({ ...input(pending.reviewToken), confirmedOriginal: false })).status, 400);
    assert.equal((await send(input('f142c55c-019a-4581-a263-572be3a6b913'))).status, 409);
    const succeeded = await send(input(pending.reviewToken)); assert.equal(succeeded.status, 200);
    assert.equal((await succeeded.json()).report.verifiedResult.verifiedBy, 'doctor-a');
    assert.equal((await send(input(pending.reviewToken))).status, 409);
    assert.equal((await reports.read(caseId, report.reportId)).report.status, 'verified');
  } finally { server.close(); await once(server, 'close'); }
});

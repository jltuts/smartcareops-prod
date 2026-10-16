import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { routingIntake } from './routing-fixtures.js';
import { createCloudLabReportObjectStore, createFirestoreLabReportStore, createMemoryLabReportStore, maxLabReportBytes } from '../src/lab-reports/storage.js';
import { labReportEndpoint } from '../src/lab-reports/http.js';

const pdf = Buffer.from('%PDF-1.4\nSynthetic fictional laboratory report\n%%EOF');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fictional pixels')]);
const origin = 'https://app.example.invalid';
const doctor = { uid: 'doctor-a', roles: ['doctor'], specialties: ['orthopedics'] };

test('Gateway contract exposes Doctor report upload, list, original read and preflight', () => {
  const contract = readFileSync(new URL('../../infra/terraform/openapi.yaml.tftpl', import.meta.url), 'utf8');
  for (const operation of ['listDoctorCaseLabReports', 'uploadDoctorCaseLabReport', 'downloadDoctorCaseLabReport', 'doctorCaseLabReportsCorsPreflight', 'doctorCaseLabReportFileCorsPreflight']) {
    assert.match(contract, new RegExp(`operationId: ${operation}\\b`));
  }
});

async function served(endpoint) {
  let user = doctor;
  const server = createServer((request, response) => { request.user = user; void endpoint(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, setUser(value) { user = value; }, async close() { server.close(); await once(server, 'close'); } };
}

async function caseStore() {
  const store = createMemoryCaseStore(), caseId = newCaseId();
  await store.createCase({ caseId, intake: routingIntake([['shoulder pain', 'confirmed']]), patientUid: 'patient', submittedForReview: true });
  await store.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
  return { store, caseId };
}

class FakeBucket {
  objects = new Map();
  failSave = false;
  file(name) {
    return {
      name,
      save: async (bytes, options) => { if (this.failSave) throw new Error('STORAGE_DOWN'); if (this.objects.has(name)) throw new Error('DUPLICATE_OBJECT'); this.objects.set(name, { bytes: Buffer.from(bytes), metadata: { ...options.metadata, generation: '1', metageneration: '1' } }); },
      getMetadata: async () => [{ ...this.objects.get(name).metadata }],
      download: async () => [Buffer.from(this.objects.get(name).bytes)],
      delete: async () => { this.objects.delete(name); },
    };
  }
  async getFiles({ prefix }) { return [[...this.objects.keys()].filter(name => name.startsWith(prefix)).map(name => this.file(name))]; }
}

function fakeDb() {
  const values = new Map();
  return { values, collection() { return { doc: caseId => ({ collection: () => ({
    doc: reportId => ({ create: async value => { const key = `${caseId}/${reportId}`; if (values.has(key)) throw new Error('DUPLICATE'); values.set(key, value); }, get: async () => ({ exists: values.has(`${caseId}/${reportId}`), data: () => values.get(`${caseId}/${reportId}`) }), delete: async () => values.delete(`${caseId}/${reportId}`) }),
    get: async () => ({ docs: [...values].filter(([key]) => key.startsWith(`${caseId}/`)).map(([key, value]) => ({ data: () => value, ref: { delete: async () => values.delete(key) } })), size: [...values.keys()].filter(key => key.startsWith(`${caseId}/`)).length }),
  }) }) }; } };
}

test('authorized Doctor can round-trip synthetic PDF, JPEG and PNG, each bound to one case', async () => {
  const { store, caseId } = await caseStore(), reports = createMemoryLabReportStore();
  const app = await served(labReportEndpoint({ caseStore: store, reportStore: reports, origins: [origin], authEnabled: true }));
  const path = `${app.base}/api/doctor/cases/${caseId}/lab-reports`;
  try {
    for (const [mimeType, content, filename] of [['application/pdf', pdf, 'synthetic.pdf'], ['image/jpeg', jpeg, 'synthetic.jpg'], ['image/png', png, 'synthetic.png']]) {
      const saved = await fetch(path, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, mimeType, reportBase64: content.toString('base64') }) });
      assert.equal(saved.status, 201);
      const { report } = await saved.json(); assert.equal(report.status, 'uploaded');
      assert.equal(report.objectRef, undefined); assert.equal(report.checksum, undefined);
      const file = await fetch(`${path}/${report.reportId}/file`, { headers: { Origin: origin } });
      assert.equal(file.status, 200); assert.equal(file.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), content);
    }
    assert.equal((await (await fetch(path)).json()).reports.length, 3);
    assert.equal((await fetch(`${app.base}/api/doctor/cases/${newCaseId()}/lab-reports`)).status, 404);
  } finally { await app.close(); }
});

test('wrong role, specialty, origin, MIME and size are rejected before saving', async () => {
  const { store, caseId } = await caseStore(), reports = createMemoryLabReportStore();
  const app = await served(labReportEndpoint({ caseStore: store, reportStore: reports, origins: [origin], authEnabled: true }));
  const path = `${app.base}/api/doctor/cases/${caseId}/lab-reports`;
  const send = (body, requestOrigin = origin) => fetch(path, { method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const valid = { filename: 'synthetic.pdf', mimeType: 'application/pdf', reportBase64: pdf.toString('base64') };
  try {
    app.setUser({ uid: 'patient', roles: ['patient'] }); assert.equal((await send(valid)).status, 403);
    app.setUser({ ...doctor, specialties: ['neurology'] }); assert.equal((await send(valid)).status, 404);
    app.setUser(doctor);
    assert.equal((await send(valid, 'https://other.example.invalid')).status, 403);
    assert.equal((await send({ ...valid, mimeType: 'image/jpeg' })).status, 400);
    assert.equal((await send({ ...valid, filename: '../report.pdf' })).status, 400);
    assert.equal((await send({ ...valid, reportBase64: Buffer.alloc(maxLabReportBytes + 1, 1).toString('base64') })).status, 413);
    assert.equal((await reports.list(caseId)).length, 0);
  } finally { await app.close(); }
});

test('private Cloud objects, failed metadata, deletion and purge stay case-scoped', async () => {
  const bucket = new FakeBucket(), objects = createCloudLabReportObjectStore({ bucket }), db = fakeDb();
  const reports = createFirestoreLabReportStore({ db, objects });
  const caseId = newCaseId(), otherCase = newCaseId();
  const first = await reports.create({ caseId, uploaderUid: doctor.uid, filename: 'synthetic.pdf', mimeType: 'application/pdf', content: pdf });
  assert.equal(bucket.objects.size, 1); assert.deepEqual((await reports.read(caseId, first.reportId)).content, pdf);
  assert.equal(await reports.read(otherCase, first.reportId), null);
  assert.equal((await reports.list(caseId))[0].objectRef, undefined);
  const second = await reports.create({ caseId, uploaderUid: doctor.uid, filename: 'synthetic.pdf', mimeType: 'application/pdf', content: pdf });
  assert.notEqual(second.reportId, first.reportId); assert.equal(bucket.objects.size, 2);
  bucket.failSave = true;
  await assert.rejects(() => reports.create({ caseId, uploaderUid: doctor.uid, filename: 'failed.pdf', mimeType: 'application/pdf', content: pdf }));
  assert.equal((await reports.list(caseId)).filter(report => report.status === 'failed').length, 1);
  bucket.failSave = false;
  assert.equal(await reports.deleteForCase(caseId), 3); assert.equal(bucket.objects.size, 0);
  await reports.create({ caseId: otherCase, uploaderUid: doctor.uid, filename: 'other.pdf', mimeType: 'application/pdf', content: pdf });
  bucket.objects.set('case-evidence/keep', { bytes: pdf, metadata: { generation: '1', metageneration: '1' } });
  assert.equal((await objects.previewPurge()).count, 1);
  assert.equal(await objects.purgeAll(), 1); assert.deepEqual([...bucket.objects.keys()], ['case-evidence/keep']);
});

test('a metadata write failure removes the uploaded original and exposes no report', async () => {
  const bucket = new FakeBucket(), objects = createCloudLabReportObjectStore({ bucket });
  const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ create: async () => { throw new Error('FIRESTORE_DOWN'); } }) }) }) }) };
  const reports = createFirestoreLabReportStore({ db, objects });
  await assert.rejects(() => reports.create({ caseId: newCaseId(), uploaderUid: doctor.uid, filename: 'fictional.pdf', mimeType: 'application/pdf', content: pdf }), /FIRESTORE_DOWN/);
  assert.equal(bucket.objects.size, 0);
});

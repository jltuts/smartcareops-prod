import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createCloudEvidenceStore, stagingOrphanAgeMs } from '../src/cases/cloud-storage.js';
import { createCaseService } from '../src/cases/store.js';
import { emptyIntake } from '../src/intake/schema.js';

class FakeFile {
  constructor(bucket, name) { this.bucket = bucket; this.name = name; }
  async save(bytes, options) {
    if (this.bucket.failSave) throw Object.assign(new Error('provider failed'), { code: 503 });
    if (this.bucket.objects.has(this.name)) throw Object.assign(new Error('exists'), { code: 412 });
    this.bucket.objects.set(this.name, { bytes: Buffer.from(bytes), metadata: { ...options.metadata, size: String(bytes.length), generation: '1', metageneration: '1' } });
  }
  async getMetadata() {
    const value = this.bucket.objects.get(this.name);
    if (!value) throw Object.assign(new Error('missing'), { code: 404 });
    return [{ ...value.metadata, metadata: { ...value.metadata.metadata } }];
  }
  async setMetadata(update) {
    if (this.bucket.failCommit) throw Object.assign(new Error('commit failed'), { code: 503 });
    const value = this.bucket.objects.get(this.name);
    value.metadata = { ...value.metadata, ...update, metageneration: String(Number(value.metadata.metageneration) + 1), metadata: { ...update.metadata } };
  }
  async download() {
    if (this.bucket.failRead) throw Object.assign(new Error('read failed'), { code: 503 });
    const value = this.bucket.objects.get(this.name);
    if (!value) throw Object.assign(new Error('missing'), { code: 404 });
    return [Buffer.from(value.bytes)];
  }
  async delete() { this.bucket.objects.delete(this.name); }
}
class FakeBucket {
  constructor() { this.objects = new Map(); }
  file(name) { return new FakeFile(this, name); }
  async getFiles({ prefix, maxResults }) { const matches = [...this.objects.keys()].filter(name => name.startsWith(prefix)); return [matches.slice(0, maxResults ?? matches.length).map(name => this.file(name))]; }
}

const bytes = Buffer.from('synthetic fictional image bytes');
const input = { caseId: `SC-${randomUUID()}`, patientUid: 'patient-a', evidenceId: 'medicine-package', mimeType: 'image/png', bytes };
const digest = value => createHash('sha256').update(value).digest('hex');

test('Cloud evidence preserves exact confirmed bytes and checksum without logging content', async () => {
  const bucket = new FakeBucket(), logs = [];
  const store = createCloudEvidenceStore({ bucket, logger: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) } });
  const reference = await store.stage(input);
  assert.equal(reference.checksum, digest(bytes));
  assert.equal(reference.byteLength, bytes.length);
  assert.equal(reference.storageSource, 'gcs');
  assert.ok(!reference.objectRef.includes(input.caseId));
  await store.commit(reference);
  const result = await store.read(reference);
  assert.deepEqual(result.bytes, bytes);
  const stored = bucket.objects.get(reference.objectRef);
  assert.equal(stored.metadata.metadata.smartcareState, 'committed');
  assert.equal(stored.metadata.cacheControl, 'private, no-store');
  assert.ok(logs.every(line => !line.includes(bytes.toString()) && !line.includes('medicine-package')));
});

test('Cloud evidence staging is idempotent for identical bytes and rejects changed content', async () => {
  const bucket = new FakeBucket(), store = createCloudEvidenceStore({ bucket });
  const first = await store.stage(input), second = await store.stage(input);
  assert.deepEqual(second, first);
  await assert.rejects(() => store.stage({ ...input, bytes: Buffer.from('different bytes') }), /EVIDENCE_OBJECT_CONFLICT/);
  assert.equal(bucket.objects.size, 1);
});

test('bounded cleanup deletes only aged unreferenced staging objects', async () => {
  let clock = Date.parse('2026-09-29T00:00:00.000Z');
  const bucket = new FakeBucket(), store = createCloudEvidenceStore({ bucket, now: () => clock });
  const oldOrphan = await store.stage(input);
  const oldReferenced = await store.stage({ ...input, caseId: `SC-${randomUUID()}`, evidenceId: 'body-area-a' });
  const committed = await store.stage({ ...input, caseId: `SC-${randomUUID()}`, evidenceId: 'body-area-b' });
  await store.commit(committed);
  clock += stagingOrphanAgeMs + 1;
  const fresh = await store.stage({ ...input, caseId: `SC-${randomUUID()}`, evidenceId: 'body-area-c' });
  const result = await store.cleanupStaging({ isReferenced: ({ reference }) => reference.objectRef === oldReferenced.objectRef });
  assert.deepEqual(result, { inspected: 4, deleted: 1, preserved: 3, errors: 0 });
  assert.equal(bucket.objects.has(oldOrphan.objectRef), false);
  assert.equal(bucket.objects.has(oldReferenced.objectRef), true);
  assert.equal(bucket.objects.has(committed.objectRef), true);
  assert.equal(bucket.objects.has(fresh.objectRef), true);
});

test('case deletion removes only referenced Cloud objects and is retryable', async () => {
  const bucket = new FakeBucket(), store = createCloudEvidenceStore({ bucket });
  const reference = await store.stage(input);
  assert.equal(await store.deleteReferences([reference]), 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal(await store.deleteReferences([reference]), 1);
});

test('Admin purge inventory counts and deletes the complete private evidence prefix', async () => {
  const bucket = new FakeBucket(), store = createCloudEvidenceStore({ bucket });
  await store.stage(input);
  await store.stage({ ...input, caseId: `SC-${randomUUID()}`, evidenceId: 'body-area-a' });
  bucket.objects.set('outside-prefix/retained', { bytes: Buffer.from('retained'), metadata: { generation: '1', metageneration: '1', metadata: {} } });
  const preview = await store.previewPurge();
  assert.equal(preview.count, 2); assert.match(preview.version, /^[a-f0-9]{64}$/);
  assert.equal(await store.purgeAll(), 2);
  assert.deepEqual([...bucket.objects.keys()], ['outside-prefix/retained']);
});

test('read detects altered bytes and emits only a sanitized category', async () => {
  const bucket = new FakeBucket(), logs = [], store = createCloudEvidenceStore({ bucket, logger: { warn: (...args) => logs.push(args.join(' ')) } });
  const reference = await store.stage(input);
  bucket.objects.get(reference.objectRef).bytes = Buffer.from('tampered');
  await assert.rejects(() => store.read(reference), /EVIDENCE_INTEGRITY_MISMATCH/);
  assert.match(logs.join('\n'), /INTEGRITY_MISMATCH/);
  assert.doesNotMatch(logs.join('\n'), /tampered|synthetic fictional/);
});

test('case metadata commit preserves text and an honest unavailable state when upload fails', async () => {
  const docs = new Map(), driver = {
    async stagePatientEvidence() { throw new Error('storage unavailable'); },
    async transact(id, change) { const next = change(docs.get(id) || null); docs.set(id, structuredClone(next)); return structuredClone(next); },
    async get(id) { return structuredClone(docs.get(id) || null); },
  };
  const service = createCaseService(driver, 'firestore');
  const intake = emptyIntake(); intake.patient.name = 'Synthetic Patient'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Synthetic Patient' };
  const created = await service.createCase({ caseId: input.caseId, intake, patientUid: input.patientUid, patientEvidence: [{
    evidenceId: 'body-area', kind: 'body_area', label: 'Pain location', patientDescription: 'Fictional shoulder location', mimeType: 'image/png', bytes,
  }] });
  assert.equal(created.patientEvidence[0].status, 'unavailable');
  assert.equal(created.patientEvidence[0].patientDescription, 'Fictional shoulder location');
  assert.equal(JSON.stringify(created).includes(bytes.toString('base64')), false);
});

test('a committed case remains readable after commit-marker failure without exposing its object reference', async () => {
  const docs = new Map(); let commits = 0;
  const reference = { objectRef: 'case-evidence/opaque', checksum: digest(bytes), byteLength: bytes.length, mimeType: 'image/png', storageSource: 'gcs' };
  const driver = {
    async stagePatientEvidence() { return reference; },
    async commitPatientEvidence() { commits += 1; throw new Error('metadata marker failed'); },
    async getPatientEvidence(_caseId, _evidenceId, metadata) { assert.equal(metadata.objectRef, reference.objectRef); return { mimeType: 'image/png', byteLength: bytes.length, bytes }; },
    async transact(id, change) { const next = change(docs.get(id) || null); docs.set(id, structuredClone(next)); return structuredClone(next); },
    async get(id) { return structuredClone(docs.get(id) || null); },
  };
  const service = createCaseService(driver, 'firestore');
  const intake = emptyIntake(); intake.patient.name = 'Synthetic Patient'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Synthetic Patient' };
  const created = await service.createCase({ caseId: input.caseId, intake, patientUid: input.patientUid, submittedForReview: true, patientEvidence: [{
    evidenceId: 'medicine-package', kind: 'medicine_package', label: 'Medicine package', patientDescription: 'Patient-reported use', mimeType: 'image/png', bytes,
  }] });
  assert.equal(commits, 1);
  assert.equal(created.patientEvidence[0].status, 'available');
  assert.doesNotMatch(JSON.stringify(created), /objectRef|checksum|case-evidence\/opaque/);
  assert.deepEqual((await service.getPatientCaseEvidence(input.caseId, 'medicine-package', input.patientUid)).bytes, bytes);
  await assert.rejects(() => service.getPatientCaseEvidence(input.caseId, 'medicine-package', 'patient-b'), error => error.code === 'CASE_NOT_FOUND');
  assert.deepEqual((await service.getDoctorCaseEvidence(input.caseId, 'medicine-package')).bytes, bytes);
});

test('failed case metadata commit leaves only an aged cleanable staging orphan', async () => {
  let clock = Date.parse('2026-09-29T00:00:00.000Z');
  const bucket = new FakeBucket(), objectStore = createCloudEvidenceStore({ bucket, now: () => clock });
  const driver = {
    async stagePatientEvidence(caseId, patientUid, image) { return objectStore.stage({ caseId, patientUid, ...image }); },
    async transact() { throw new Error('metadata commit failed'); },
  };
  const service = createCaseService(driver, 'firestore');
  const intake = emptyIntake(); intake.patient.name = 'Synthetic Patient'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Synthetic Patient' };
  await assert.rejects(() => service.createCase({ caseId: input.caseId, intake, patientUid: input.patientUid, patientEvidence: [{
    evidenceId: 'body-area', kind: 'body_area', label: 'Pain location', patientDescription: 'Fictional shoulder location', mimeType: 'image/png', bytes,
  }] }), error => error.code === 'CASE_STORE_UNAVAILABLE');
  assert.equal(bucket.objects.size, 1);
  clock += stagingOrphanAgeMs + 1;
  const cleaned = await objectStore.cleanupStaging({ isReferenced: async () => false });
  assert.equal(cleaned.deleted, 1);
  assert.equal(bucket.objects.size, 0);
});

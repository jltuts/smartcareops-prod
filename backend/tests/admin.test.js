import test from 'node:test';
import assert from 'node:assert/strict';
import { adminEndpoint } from '../src/admin/http.js';
import { createFirestoreAdminDataStore, purgeCollections } from '../src/admin/data-store.js';
import { createMemoryUserProfileStore } from '../src/user-profiles.js';

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
}
function request(method, url, { user = { uid: 'admin', roles: ['admin'] }, body, origin = 'https://smartcareops.example', secFetchSite, idempotencyKey = '12345678-1234-4234-8234-123456789012' } = {}) {
  return { method, url, user, headers: { ...(origin !== null ? { origin } : {}), ...(secFetchSite ? { 'sec-fetch-site': secFetchSite } : {}), 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
}
async function call(handler, req) { const res = response(); await handler(req, res); return { status: res.status, body: JSON.parse(res.body), headers: res.headers }; }

test('Admin writes accept an allowlisted cross-site Hosting Origin and reject missing, malformed, unlisted, or non-Admin requests', async () => {
  const calls = [];
  const receipt = { receiptId: 'receipt-1', decision: 'approved', applicationVersion: 1, reviewedAt: '2026-10-01T00:00:00.000Z' };
  const profiles = {
    async reviewDoctorApplication(uid) { calls.push('doctor'); return { uid, doctorApplication: { status: 'approved', displayName: 'Dr. Louie', specialty: 'orthopedics', reviewedAt: receipt.reviewedAt, reviewReceipt: receipt } }; },
    async reviewPatientApplication(uid) { calls.push('patient'); return { uid, patientApplication: { status: 'approved', reviewedAt: receipt.reviewedAt, reviewReceipt: receipt } }; },
    async setPatientAccessMode(mode) { calls.push('setting'); return { mode, version: 2, updatedAt: receipt.reviewedAt, receipt: { receiptId: 'setting-1', mode, previousVersion: 1, updatedAt: receipt.reviewedAt } }; },
  };
  const dataStore = { async purge() { calls.push('purge'); return { receiptId: 'purge-1', status: 'completed' }; } };
  const hosting = 'https://gen-lang-client-0710663107.web.app';
  const handler = adminEndpoint(profiles, [hosting], dataStore);
  const writes = [
    ['doctor', 'POST', '/api/admin/doctor-applications/doctor-1/decision', { decision: 'approved', independentlyVerified: true, applicationVersion: 1, confirmed: true }],
    ['patient', 'POST', '/api/admin/patient-applications/patient-1/decision', { decision: 'approved', applicationVersion: 1, confirmed: true }],
    ['setting', 'PUT', '/api/admin/settings/patient-access', { mode: 'approved_only', expectedVersion: 1, confirmed: true }],
    ['purge', 'POST', '/api/admin/purge', { confirmation: 'PURGE ALL TEST DATA', previewId: '11111111-1111-4111-8111-111111111111' }],
  ];
  for (const [kind, method, path, body] of writes) {
    const options = { body, origin: hosting, secFetchSite: 'cross-site' };
    assert.equal((await call(handler, request(method, path, options))).status, 200, kind);
    for (const origin of ['https://unlisted.example', null, `${hosting}/path`]) {
      const result = await call(handler, request(method, path, { ...options, origin }));
      assert.equal(result.status, 403, `${kind}: ${origin}`);
      assert.equal(result.body.code, 'ORIGIN_NOT_ALLOWED');
    }
    const denied = await call(handler, request(method, path, { ...options, user: { uid: 'patient', roles: ['patient'] } }));
    assert.equal(denied.status, 403, kind); assert.equal(denied.body.code, 'ADMIN_REQUIRED');
  }
  assert.deepEqual(calls, writes.map(([kind]) => kind));
});

test('approved Doctors API requires backend Admin role and returns only verification-derived directory fields', async () => {
  const records = new Map([['doctor-1', { uid: 'doctor-1', email: 'doctor@example.invalid', displayName: 'Editable name', roles: ['doctor'], status: 'active', specialty: 'orthopedics',
    doctorVerification: { status: 'verified', displayName: 'Dr. Louie', specialty: 'orthopedics', verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBy: 'admin-uid' },
    doctorApplication: { status: 'approved', reviewedBy: 'admin-uid' }, privateNote: 'secret' }]]);
  const handler = adminEndpoint(createMemoryUserProfileStore(records), ['https://smartcareops.example']);
  assert.equal((await call(handler, request('GET', '/api/admin/approved-doctors?limit=1', { user: { uid: 'patient', roles: ['patient'] } }))).status, 403);
  const listed = await call(handler, request('GET', '/api/admin/approved-doctors?limit=1'));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { doctors: [{ uid: 'doctor-1', email: 'doctor@example.invalid', displayName: 'Dr. Louie', specialty: 'orthopedics', specialties: ['orthopedics'], status: 'approved', approvedAt: '2026-09-29T00:00:00.000Z' }], nextCursor: null });
  assert.equal(listed.headers['Cache-Control'], 'no-store');
  assert.equal((await call(handler, request('GET', '/api/admin/approved-doctors?limit=51'))).status, 400);
});

test('Admin specialty removal is explicit, stale-safe, role-protected, and returns a bounded receipt', async () => {
  const records = new Map([['doctor-1', { uid: 'doctor-1', email: 'doctor@example.invalid', displayName: 'Dr. Louie', roles: ['patient', 'doctor'], status: 'active', specialty: 'orthopedics',
    doctorVerification: { status: 'verified', displayName: 'Dr. Louie', specialty: 'orthopedics', verifiedAt: '2026-09-29T00:00:00.000Z', verifiedBy: 'admin-uid' } }]]);
  const handler = adminEndpoint(createMemoryUserProfileStore(records, { now: () => Date.parse('2026-10-01T00:00:00.000Z') }), ['https://smartcareops.example']);
  const path = '/api/admin/approved-doctors/doctor-1/specialties/orthopedics';
  const body = { expectedSpecialties: ['orthopedics'], confirmed: true };
  assert.equal((await call(handler, request('DELETE', path, { body, user: { uid: 'patient', roles: ['patient'] } }))).status, 403);
  assert.equal((await call(handler, request('DELETE', path, { body, origin: 'https://evil.example' }))).status, 403);
  const removed = await call(handler, request('DELETE', path, { body }));
  assert.equal(removed.status, 200); assert.equal(removed.body.removedSpecialty, 'orthopedics'); assert.deepEqual(removed.body.remainingSpecialties, []);
  assert.equal(removed.body.receipt.specialty, 'orthopedics'); assert.equal(Object.hasOwn(removed.body.receipt, 'removedBy'), false);
  assert.deepEqual(records.get('doctor-1').roles, ['patient']);
  const retry = await call(handler, request('DELETE', path, { body })); assert.deepEqual(retry.body.receipt, removed.body.receipt);
});

test('Admin purge endpoint requires role, exact phrase, server preview ID, idempotency key, and allowed Origin', async () => {
  let purges = 0;
  const dataStore = {
    async preview() { return { previewId: '11111111-1111-4111-8111-111111111111', counts: { cases: 1 }, total: 1, expiresAt: '2026-10-01T00:05:00.000Z' }; },
    async purge(input) { purges++; assert.equal(input.previewId, '11111111-1111-4111-8111-111111111111'); return { receiptId: 'receipt-1', status: 'completed', total: 1 }; },
  };
  const handler = adminEndpoint({}, ['https://smartcareops.example'], dataStore);
  assert.equal((await call(handler, request('GET', '/api/admin/purge-preview', { user: { uid: 'patient', roles: ['patient'] } }))).status, 403);
  const body = { confirmation: 'PURGE ALL TEST DATA', previewId: '11111111-1111-4111-8111-111111111111' };
  assert.equal((await call(handler, request('POST', '/api/admin/purge', { body }))).status, 200);
  assert.equal(purges, 1);
  assert.equal((await call(handler, request('POST', '/api/admin/purge', { body: { ...body, confirmation: 'delete' } }))).status, 400);
  assert.equal((await call(handler, request('POST', '/api/admin/purge', { body, origin: 'https://evil.example' }))).status, 403);
  assert.equal((await call(handler, request('POST', '/api/admin/purge', { body, idempotencyKey: 'short' }))).status, 400);
});

function fakeFirestore() {
  const node = (data = {}, children = new Map()) => ({ data, children });
  const roots = new Map([
    ['cases', new Map([['case-1', node({ patientUid: 'p1' }, new Map([['clinical', new Map([['plan-1', node()]])]]))]])],
    ['userProfiles', new Map([['admin-uid', node({ roles: ['admin'] })], ['patient-uid', node({ roles: ['patient'] })]])],
    ['simulationStates', new Map([['demo', node()]])],
  ]);
  const collection = (name, docs) => ({
    id: name,
    async get() { return { docs: [...docs].map(([id, value]) => snapshot(id, value, docs, name)) }; },
    doc(id) {
      const getNode = () => docs.get(id);
      return {
        id,
        async get() { const value = getNode(); return { exists: Boolean(value), data: () => structuredClone(value?.data) }; },
        async set(value, options) { const current = getNode(); docs.set(id, node(options?.merge ? { ...(current?.data || {}), ...structuredClone(value) } : structuredClone(value), current?.children || new Map())); },
        async listCollections() { const value = getNode(); return [...(value?.children || [])].map(([childName, childDocs]) => collection(childName, childDocs)); },
      };
    },
  });
  const snapshot = (id, value, docs, name) => ({ id, data: () => structuredClone(value.data), updateTime: { toMillis: () => JSON.stringify(value.data).length }, ref: { id, rootName: name,
    async listCollections() { return [...value.children].map(([childName, childDocs]) => collection(childName, childDocs)); } } });
  const db = {
    collection(name) { if (!roots.has(name)) roots.set(name, new Map()); return collection(name, roots.get(name)); },
    async recursiveDelete(documentRef) { roots.get(documentRef.rootName)?.delete(documentRef.id); },
    async terminate() {},
    runTransaction(operation) { return operation({ async get(ref) { return ref.get(); }, set(ref, value, options) { return ref.set(value, options); } }); },
  };
  return { db, roots };
}

test('Firestore purge preview is short-lived/server-owned, counts recursive allowlisted data, and preserves Admin/config/audit', async () => {
  const { db, roots } = fakeFirestore();
  let current = Date.parse('2026-10-01T00:00:00.000Z');
  const store = createFirestoreAdminDataStore(db, { now: () => current, protectedAdminUid: 'admin-uid' });
  const preview = await store.preview({ adminUid: 'admin-uid' });
  assert.match(preview.previewId, /^[0-9a-f-]{36}$/); assert.equal(preview.counts.cases, 2); assert.equal(preview.counts.userProfiles, 1); assert.equal(preview.total, 4);
  const result = await store.purge({ adminUid: 'admin-uid', previewId: preview.previewId, idempotencyKey: '12345678-1234-4234-8234-123456789012' });
  assert.equal(result.status, 'completed'); assert.equal(result.total, 4);
  assert.equal(roots.get('userProfiles').has('admin-uid'), true); assert.equal(roots.get('userProfiles').has('patient-uid'), false);
  assert.equal(roots.get('adminAudit').size, 1); assert.equal(roots.get('adminPurgePreviews').size, 1);
  assert.deepEqual(purgeCollections.includes('adminSettings'), false);
  assert.deepEqual(await store.purge({ adminUid: 'admin-uid', previewId: preview.previewId, idempotencyKey: '12345678-1234-4234-8234-123456789012' }), result);
  current += 10 * 60 * 1000;
  await assert.rejects(store.purge({ adminUid: 'admin-uid', previewId: preview.previewId, idempotencyKey: '22345678-1234-4234-8234-123456789012' }), /PURGE_PREVIEW_STALE/);
});

test('Firestore purge allows any configured Admin and preserves every configured Admin profile', async () => {
  const { db, roots } = fakeFirestore();
  roots.get('userProfiles').set('second-admin', { data: { roles: ['admin'] }, children: new Map() });
  const store = createFirestoreAdminDataStore(db, { protectedAdminUids: ['admin-uid', 'second-admin'] });
  const preview = await store.preview({ adminUid: 'second-admin' });
  assert.equal(preview.counts.userProfiles, 1);
  assert.equal(preview.preservedAdminProfiles, 2);
  const result = await store.purge({ adminUid: 'second-admin', previewId: preview.previewId,
    idempotencyKey: '52345678-1234-4234-8234-123456789012' });
  assert.equal(result.preservedAdminProfiles, 2);
  assert.equal(roots.get('userProfiles').has('admin-uid'), true);
  assert.equal(roots.get('userProfiles').has('second-admin'), true);
  assert.equal(roots.get('userProfiles').has('patient-uid'), false);
  await assert.rejects(store.preview({ adminUid: 'unconfigured-admin' }), /PURGE_ADMIN_MISMATCH/);
});

test('purge inventories all private evidence objects and records an honest partial receipt before retry', async () => {
  const { db, roots } = fakeFirestore(); let fail = true, objects = 2;
  const evidenceStore = {
    async previewPurge() { return { count: objects, version: `objects-${objects}` }; },
    async purgeAll() { if (fail) throw Object.assign(new Error('private detail'), { code: 'EVIDENCE_PURGE_PARTIAL', deleted: 1 }); const deleted = objects; objects = 0; return deleted; },
  };
  const store = createFirestoreAdminDataStore(db, { evidenceStore, protectedAdminUid: 'admin-uid' });
  const preview = await store.preview({ adminUid: 'admin-uid' }); assert.equal(preview.counts.evidenceObjects, 2);
  await assert.rejects(store.purge({ adminUid: 'admin-uid', previewId: preview.previewId, idempotencyKey: '32345678-1234-4234-8234-123456789012' }), error => {
    assert.equal(error.code, 'PURGE_PARTIAL_FAILURE'); assert.equal(error.receipt.status, 'partial_failure');
    assert.deepEqual(error.receipt.errorCategories, ['EVIDENCE_PURGE_PARTIAL']); return true;
  });
  assert.equal(roots.get('cases').has('case-1'), true); assert.equal(roots.get('adminAudit').size, 1);
  fail = false; const fresh = await store.preview({ adminUid: 'admin-uid' });
  const result = await store.purge({ adminUid: 'admin-uid', previewId: fresh.previewId, idempotencyKey: '42345678-1234-4234-8234-123456789012' });
  assert.equal(result.status, 'completed'); assert.equal(result.deleted.evidenceObjects, 2);
});

test('Admin purge inventories and removes laboratory report objects with case metadata', async () => {
  const { db, roots } = fakeFirestore();
  roots.get('cases').get('case-1').children.set('labReports', new Map([['report-1', { data: { status: 'uploaded' }, children: new Map() }]]));
  let objects = 2;
  const labReportObjects = {
    async previewPurge() { return { count: objects, version: `lab-${objects}` }; },
    async purgeAll() { const removed = objects; objects = 0; return removed; },
  };
  const store = createFirestoreAdminDataStore(db, { labReportObjects, protectedAdminUid: 'admin-uid' });
  const preview = await store.preview({ adminUid: 'admin-uid' });
  assert.equal(preview.counts.labReportObjects, 2);
  assert.equal(preview.counts.cases, 3);
  const receipt = await store.purge({ adminUid: 'admin-uid', previewId: preview.previewId, idempotencyKey: '62345678-1234-4234-8234-123456789012' });
  assert.equal(receipt.deleted.labReportObjects, 2);
  assert.equal(receipt.deleted.cases, 3);
  assert.equal(roots.get('cases').size, 0);
});

test('persistent purge control increments its generation, rejects old writers, and preserves the configured Admin', async () => {
  let document = null;
  const reference = { async get() { return { exists: document !== null, data: () => structuredClone(document) }; }, async set(value, options) { document = options?.merge ? { ...(document || {}), ...structuredClone(value) } : structuredClone(value); } };
  const db = {
    collection(name) { assert.equal(name, 'adminSettings'); return { doc(id) { assert.equal(id, 'dataReset'); return reference; } }; },
    runTransaction(operation) { return operation({ async get(ref) { return ref.get(); }, set(ref, value, options) { return ref.set(value, options); } }); }, async terminate() {},
  };
  const store = createFirestoreAdminDataStore(db, { now: () => Date.parse('2026-09-29T01:00:00.000Z'), protectedAdminUid: 'sole-admin' });
  assert.deepEqual(await store.getResetState(), { status: 'idle', generation: 0 });
  await assert.rejects(() => store.beginReset({ adminUid: 'different-admin' }), /PURGE_ADMIN_MISMATCH/);
  const started = await store.beginReset({ adminUid: 'sole-admin' }); assert.equal(started.generation, 1);
  assert.equal(await store.canWrite(0), false); assert.equal(await store.finishReset({ purgeId: started.purgeId, completed: true, adminUid: 'sole-admin' }), true);
  assert.equal(await store.canWrite(1), true);
});

test('Admin endpoint gives the purge coordinator only the authenticated Admin identity', async () => {
  let context;
  const dataStore = { async purge() { return { receiptId: 'receipt-1', status: 'completed', total: 0 }; } };
  const handler = adminEndpoint({}, ['https://smartcareops.example'], dataStore, { async runPurge(value, operation) { context = value; return operation(); } });
  const result = await call(handler, request('POST', '/api/admin/purge', { user: { uid: 'sole-admin', roles: ['admin'] },
    body: { confirmation: 'PURGE ALL TEST DATA', previewId: '11111111-1111-4111-8111-111111111111' } }));
  assert.equal(result.status, 200); assert.deepEqual(context, { adminUid: 'sole-admin' });
});

test('Admin list and mutation contracts are bounded, rate-limited, stale-safe, and receipt validated', async () => {
  const profile = { uid: 'doctor-1', email: 'd@example.invalid', doctorApplication: { status: 'pending', displayName: 'Dr One', specialty: 'general', submittedAt: '2026-10-01T00:00:00.000Z', version: 2 } };
  const profileStore = {
    async listPendingDoctorApplications(options) { assert.deepEqual(options, { limit: 1 }); return { records: [profile], nextCursor: 'doctor-1' }; },
    async reviewDoctorApplication(_uid, input) { assert.equal(input.expectedVersion, 2); return { ...profile, doctorApplication: { ...profile.doctorApplication, status: 'approved', reviewedAt: '2026-10-01T00:01:00.000Z', reviewReceipt: { receiptId: 'doctor-receipt', decision: 'approved', applicationVersion: 2, reviewedAt: '2026-10-01T00:01:00.000Z' } } }; },
  };
  const handler = adminEndpoint(profileStore, ['https://smartcareops.example'], null, { rateLimit: 2 });
  const listed = await call(handler, request('GET', '/api/admin/doctor-applications?limit=1')); assert.equal(listed.body.nextCursor, 'doctor-1');
  const decided = await call(handler, request('POST', '/api/admin/doctor-applications/doctor-1/decision', { body: { decision: 'approved', independentlyVerified: true, applicationVersion: 2, confirmed: true } }));
  assert.equal(decided.status, 200); assert.equal(decided.body.receipt.receiptId, 'doctor-receipt');
  const limited = await call(handler, request('GET', '/api/admin/doctor-applications?limit=1')); assert.equal(limited.status, 429); assert.equal(limited.headers['Retry-After'], '60');
});

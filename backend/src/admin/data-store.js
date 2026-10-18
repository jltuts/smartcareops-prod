import { Firestore } from '@google-cloud/firestore';
import { createHash, randomUUID } from 'node:crypto';
import { environmentConfig } from '../environment.js';
import { createConfiguredCloudEvidenceStore } from '../cases/cloud-storage.js';
import { createConfiguredLabReportObjectStore } from '../lab-reports/storage.js';
import { createConfiguredFirebaseAuthAccountStore } from './auth-store.js';

// Explicit SmartCareOps-owned Firestore roots. Project configuration, secrets,
// adminSettings are deliberately excluded. Google Firebase Authentication
// identities are handled separately so protected accounts are never removed.
export const purgeCollections = Object.freeze([
  'cases', 'caseEvidence', 'ambulances', 'resourceEnvironments', 'intakeFinalizations',
  'liveSessions', 'chatIntakeSessions', 'pendingMedicineEvidence', 'pendingPatientEvidence', 'clinicalWorkspaces',
  'hospitalWorkspaces', 'regionalWorkspaces', 'simulationStates', 'userProfiles',
]);

async function countTree(ref, state, path, updateTime) {
  if (++state.visited > 10000) throw new Error('PURGE_PREVIEW_LIMIT');
  state.version.update(`${path}:${updateTime?.toMillis?.() || updateTime?.toDate?.().toISOString?.() || ''}\n`);
  let count = 1;
  for (const child of await ref.listCollections()) {
    const snapshot = await child.get();
    for (const doc of snapshot.docs) count += await countTree(doc.ref, state, `${path}/${child.id || 'subcollection'}/${doc.id}`, doc.updateTime);
  }
  return count;
}

const sameCounts = (left, right) => left && right && Object.keys(left).length === Object.keys(right).length &&
  Object.keys(right).every(key => Number.isSafeInteger(left[key]) && left[key] === right[key]);
const receiptDocumentId = key => `purge-${createHash('sha256').update(key).digest('hex')}`;
const errorCategory = error => ['EVIDENCE_PURGE_PARTIAL', 'LAB_REPORT_PURGE_PARTIAL', 'AUTH_PURGE_PARTIAL', 'AUTH_PURGE_STALE', 'AUTH_PURGE_LIMIT', 'PURGE_PREVIEW_LIMIT'].includes(error?.code || error?.message)
  ? error.code || error.message : 'DATA_STORE_UNAVAILABLE';

const idleResetState = Object.freeze({ status: 'idle', generation: 0 });
const resetState = snapshot => {
  if (!snapshot?.exists) return idleResetState;
  const value = snapshot.data();
  return Object.freeze({
    status: value?.status === 'purging' ? 'purging' : 'idle',
    generation: Number.isSafeInteger(value?.generation) && value.generation >= 0 ? value.generation : 0,
    ...(typeof value?.purgeId === 'string' ? { purgeId: value.purgeId } : {}),
  });
};

export function createFirestoreAdminDataStore(db, { now = Date.now, protectedAdminUid = null, protectedAdminUids = [], evidenceStore = null, labReportObjects = null, authAccountStore = null, previewTtlMs = 5 * 60 * 1000 } = {}) {
  const configuredAdminUids = new Set([
    ...(Array.isArray(protectedAdminUids) ? protectedAdminUids : []),
    ...(protectedAdminUid ? [protectedAdminUid] : []),
  ].map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean));
  const adminUidFor = requested => {
    if (configuredAdminUids.size && !configuredAdminUids.has(requested)) throw new Error('PURGE_ADMIN_MISMATCH');
    return requested;
  };
  const preservedAdminUidsFor = requested => configuredAdminUids.size ? configuredAdminUids : new Set([requested]);
  const resetControl = () => db.collection('adminSettings').doc('dataReset');
  const previewRef = id => db.collection('adminPurgePreviews').doc(id);
  const auditRef = key => db.collection('adminAudit').doc(receiptDocumentId(key));
  const scan = async adminUid => {
    const counts = {}, version = createHash('sha256');
    let total = 0; const traversal = { visited: 0, version };
    const preservedAdminUids = preservedAdminUidsFor(adminUid);
    for (const name of purgeCollections) {
      const snapshot = await db.collection(name).get();
      let count = 0;
      for (const doc of snapshot.docs) {
        if (name === 'userProfiles' && preservedAdminUids.has(doc.id)) continue;
        count += await countTree(doc.ref, traversal, `${name}/${doc.id}`, doc.updateTime);
      }
      counts[name] = count; total += count;
    }
    if (evidenceStore?.previewPurge) {
      const evidence = await evidenceStore.previewPurge();
      counts.evidenceObjects = evidence.count; total += evidence.count;
      version.update(`evidenceObjects:${evidence.version}\n`);
    }
    if (labReportObjects?.previewPurge) {
      const reports = await labReportObjects.previewPurge();
      counts.labReportObjects = reports.count; total += reports.count;
      version.update(`labReportObjects:${reports.version}\n`);
    }
    let authVersion = null, preservedAuthAccounts = 0;
    if (authAccountStore?.previewPurge) {
      const accounts = await authAccountStore.previewPurge();
      counts.googleAuthAccounts = accounts.count; total += accounts.count;
      preservedAuthAccounts = accounts.preservedCount; authVersion = accounts.version;
      version.update(`googleAuthAccounts:${accounts.version}\n`);
    }
    return { counts, total, dataVersion: version.digest('hex'), authVersion, preservedAuthAccounts };
  };
  const writeAudit = async receipt => { await auditRef(receipt.idempotencyKey).set(receipt); return receipt; };
  return {
    async getResetState() { return resetState(await resetControl().get()); },
    async beginReset({ adminUid }) {
      adminUid = adminUidFor(adminUid);
      if (typeof adminUid !== 'string' || !adminUid) throw new Error('PURGE_ADMIN_REQUIRED');
      return db.runTransaction(async transaction => {
        const current = resetState(await transaction.get(resetControl()));
        if (current.status === 'purging') throw new Error('PURGE_ALREADY_RUNNING');
        const next = { status: 'purging', generation: current.generation + 1, purgeId: randomUUID(),
          startedAt: new Date(now()).toISOString(), startedBy: adminUid };
        transaction.set(resetControl(), next);
        return Object.freeze({ status: next.status, generation: next.generation, purgeId: next.purgeId });
      });
    },
    async finishReset({ purgeId, completed, adminUid }) {
      adminUid = adminUidFor(adminUid);
      if (typeof purgeId !== 'string' || !purgeId) return false;
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(resetControl()), current = resetState(snapshot);
        if (current.status !== 'purging' || current.purgeId !== purgeId) return false;
        transaction.set(resetControl(), { status: 'idle', generation: current.generation,
          completedAt: new Date(now()).toISOString(), completed: completed === true, completedBy: adminUid }, { merge: true });
        return true;
      });
    },
    async canWrite(generation) {
      const current = await this.getResetState();
      return current.status === 'idle' && (generation === undefined || generation === current.generation);
    },
    async preview({ adminUid }) {
      adminUid = adminUidFor(adminUid);
      const observed = await scan(adminUid), previewId = randomUUID(), createdAt = new Date(now()).toISOString();
      const expiresAt = new Date(now() + previewTtlMs).toISOString();
      const profiles = await db.collection('userProfiles').get();
      const preservedAdminProfiles = profiles.docs.filter(doc => preservedAdminUidsFor(adminUid).has(doc.id)).length;
      const record = { previewId, adminUid, createdAt, expiresAt, ...observed, preservedAdminProfiles };
      await previewRef(previewId).set(record);
      return { previewId, createdAt, expiresAt, counts: observed.counts, total: observed.total, dataVersion: observed.dataVersion,
        preservedAdminProfile: preservedAdminProfiles > 0, preservedAdminProfiles, preservedSettings: true,
        preservedAuthAccounts: observed.preservedAuthAccounts };
    },
    async purge({ adminUid, previewId, idempotencyKey }) {
      adminUid = adminUidFor(adminUid);
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw Object.assign(new Error('INVALID_IDEMPOTENCY_KEY'), { code: 'INVALID_IDEMPOTENCY_KEY' });
      const previous = await auditRef(idempotencyKey).get();
      if (previous.exists) return previous.data();
      if (typeof previewId !== 'string' || !/^[0-9a-f-]{36}$/.test(previewId)) throw Object.assign(new Error('PURGE_PREVIEW_REQUIRED'), { code: 'PURGE_PREVIEW_REQUIRED' });
      const previewSnapshot = await previewRef(previewId).get(), preview = previewSnapshot.exists ? previewSnapshot.data() : null;
      if (!preview || preview.adminUid !== adminUid || Date.parse(preview.expiresAt) <= now()) throw Object.assign(new Error('PURGE_PREVIEW_STALE'), { code: 'PURGE_PREVIEW_STALE' });
      const current = await scan(adminUid);
      if (current.dataVersion !== preview.dataVersion || !sameCounts(current.counts, preview.counts)) {
        const error = Object.assign(new Error('PURGE_PREVIEW_STALE'), { code: 'PURGE_PREVIEW_STALE', current }); throw error;
      }
      const deleted = {};
      const startedAt = new Date(now()).toISOString(), receiptId = randomUUID();
      try {
        // Delete the entire private application-owned prefix first. A storage
        // failure leaves Firestore evidence metadata available for a fresh retry.
        if (evidenceStore?.purgeAll) deleted.evidenceObjects = await evidenceStore.purgeAll();
        if (labReportObjects?.purgeAll) deleted.labReportObjects = await labReportObjects.purgeAll();
        for (const name of purgeCollections) {
          const snapshot = await db.collection(name).get();
          let count = 0;
          for (const doc of snapshot.docs) {
            if (name === 'userProfiles' && preservedAdminUidsFor(adminUid).has(doc.id)) continue;
            const before = await countTree(doc.ref, { visited: 0, version: createHash('sha256') }, `${name}/${doc.id}`, doc.updateTime);
            await db.recursiveDelete(doc.ref); count += before;
          }
          deleted[name] = count;
        }
        if (authAccountStore?.purgeAll) deleted.googleAuthAccounts = await authAccountStore.purgeAll({ expectedVersion: current.authVersion });
        const receipt = { receiptId, idempotencyKey, previewId, initiatedBy: adminUid, startedAt, completedAt: new Date(now()).toISOString(),
          status: 'completed', categories: Object.keys(preview.counts), previewCounts: preview.counts, deleted,
          total: Object.values(deleted).reduce((sum, value) => sum + value, 0), preservedAdminProfile: true,
          preservedAdminProfiles: preview.preservedAdminProfiles, preservedSettings: true, preservedAuthAccounts: preview.preservedAuthAccounts };
        await writeAudit(receipt); return receipt;
      } catch (error) {
        if (Number.isSafeInteger(error?.deleted)) {
          const key = error?.code === 'LAB_REPORT_PURGE_PARTIAL' ? 'labReportObjects'
            : error?.code === 'AUTH_PURGE_PARTIAL' ? 'googleAuthAccounts' : 'evidenceObjects';
          deleted[key] = error.deleted;
        }
        const receipt = { receiptId, idempotencyKey, previewId, initiatedBy: adminUid, startedAt, completedAt: new Date(now()).toISOString(),
          status: 'partial_failure', categories: Object.keys(preview.counts), previewCounts: preview.counts, deleted,
          total: Object.values(deleted).reduce((sum, value) => sum + value, 0), errorCategories: [errorCategory(error)],
          preservedAdminProfile: true, preservedAdminProfiles: preview.preservedAdminProfiles,
          preservedSettings: true, preservedAuthAccounts: preview.preservedAuthAccounts };
        await writeAudit(receipt);
        const failure = Object.assign(new Error('PURGE_PARTIAL_FAILURE'), { code: 'PURGE_PARTIAL_FAILURE', receipt }); throw failure;
      }
    },
    async close() { await db.terminate(); },
  };
}

export function createConfiguredAdminDataStore(env = process.env) {
  const config = environmentConfig(env);
  if (env.CASE_STORE !== 'firestore' || !config.projectId || env.FIRESTORE_EMULATOR_HOST) throw new Error('Admin purge requires explicit project Firestore');
  const adminUids = [...new Set((env.ADMIN_UIDS || '').split(',').map(value => value.trim()).filter(Boolean))];
  return createFirestoreAdminDataStore(new Firestore({ projectId: config.projectId, databaseId: config.database }),
    { protectedAdminUids: adminUids, evidenceStore: createConfiguredCloudEvidenceStore(env), labReportObjects: createConfiguredLabReportObjectStore(env),
      authAccountStore: createConfiguredFirebaseAuthAccountStore(env) });
}

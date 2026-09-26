import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from './environment.js';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminal = new Set(['SUCCEEDED', 'FAILED']);

export function createMemoryFinalizationDriver(records = new Map()) {
  return {
    async create(id, value) { if (records.has(id)) throw new Error('Finalization already exists'); records.set(id, structuredClone(value)); },
    async get(id) { return records.has(id) ? structuredClone(records.get(id)) : null; },
    async resolve(id, value) {
      const current = records.get(id);
      if (!current || terminal.has(current.state)) return current ? structuredClone(current) : null;
      const next = { ...current, ...structuredClone(value) }; records.set(id, next); return structuredClone(next);
    },
    async close() {},
  };
}

export function createFirestoreFinalizationDriver(db) {
  const collection = db.collection('intakeFinalizations');
  return {
    async create(id, value) { await collection.doc(id).create(value); },
    async get(id) { const snapshot = await collection.doc(id).get(); return snapshot.exists ? snapshot.data() : null; },
    async resolve(id, value) {
      const ref = collection.doc(id);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), current = snapshot.exists ? snapshot.data() : null;
        if (!current || terminal.has(current.state)) return current;
        const next = { ...current, ...value }; transaction.set(ref, next); return next;
      });
    },
    close: () => db.terminate(),
  };
}

export function createFinalizationResults({ driver = createMemoryFinalizationDriver(), now = () => Date.now(), ttlMs = 10 * 60_000,
  log = detail => console.info('[finalization-result]', JSON.stringify(detail)) } = {}) {
  return {
    async create({ id = randomUUID(), uid = null, caseId = null } = {}) {
      if (!idPattern.test(id)) throw new Error('Invalid finalization identifier');
      const createdAt = now(), record = { id, uid, caseId, state: 'PENDING', result: null, createdAt, updatedAt: createdAt, expiresAt: createdAt + ttlMs };
      await driver.create(id, record);
      log({ finalizationId: id, transition: 'CREATED', at: new Date(createdAt).toISOString(), resultPresent: false, caseId });
      return { ticket: id,
        async progress(progress) {
          const updatedAt = now();
          await driver.resolve(id, { progress: structuredClone(progress), updatedAt });
          log({ finalizationId: id, transition: 'PROGRESS', at: new Date(updatedAt).toISOString(), resultPresent: false,
            caseId: progress?.patientCase?.caseId || caseId, workflowState: progress?.patientCase?.workflowStatus || null,
            enrichmentStatus: progress?.patientCase?.enrichmentStatus || null });
        },
        async resolve(result) {
        const updatedAt = now(), state = result?.status === 'COMPLETED' || result?.status === 'EMERGENCY_ESCALATED' ? 'SUCCEEDED' : 'FAILED';
        const saved = await driver.resolve(id, { state, result: structuredClone(result), updatedAt });
        log({ finalizationId: id, transition: saved?.state || 'MISSING', at: new Date(updatedAt).toISOString(), durationMs: updatedAt - createdAt,
          resultPresent: !!saved?.result, caseId: saved?.result?.patientCase?.caseId || caseId, workflowState: saved?.result?.patientCase?.workflowStatus || null,
          errorCategory: saved?.result?.error?.code || null });
      } };
    },
    async handle(request, response) {
      if (new URL(request.url, 'http://localhost').pathname !== '/api/intake-finalization') return false;
      response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
      const id = request.headers['x-smartcareops-finalization-id'];
      if (request.method !== 'GET' || !idPattern.test(id || '')) { response.writeHead(404); response.end('{}'); return true; }
      const record = await driver.get(id);
      if (!record || record.uid && record.uid !== request.user?.uid || record.expiresAt <= now()) { response.writeHead(404); response.end('{}'); return true; }
      log({ finalizationId: id, transition: 'READ', at: new Date(now()).toISOString(), resultPresent: !!record.result, caseId: record.result?.patientCase?.caseId || record.caseId,
        workflowState: record.result?.patientCase?.workflowStatus || null, errorCategory: record.result?.error?.code || null });
      response.writeHead(record.result ? 200 : 202);
      response.end(JSON.stringify(record.result || { status: record.state, ...(record.progress || {}) }));
      return true;
    },
    close: () => driver.close?.(),
  };
}

export function createConfiguredFinalizationResults(env = process.env) {
  const config = environmentConfig(env);
  if (env.CASE_STORE === 'memory' || !config.projectId) return createFinalizationResults();
  return createFinalizationResults({ driver: createFirestoreFinalizationDriver(new Firestore({ projectId: config.projectId, databaseId: config.database })) });
}

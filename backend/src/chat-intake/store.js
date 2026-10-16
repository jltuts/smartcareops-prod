import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from '../environment.js';

const clone = value => structuredClone(value);
const terminal = new Set(['completed', 'emergency', 'cancelled']);
const messageWindowMs = 60_000;
const messageLimit = 30;

export class ChatIntakeStoreError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

function validateStart(record, { uid, now }) {
  if (!record || record.uid !== uid) throw new ChatIntakeStoreError('CHAT_SESSION_NOT_FOUND', 404);
  if (record.expiresAt <= now || record.status === 'cancelled') throw new ChatIntakeStoreError('CHAT_SESSION_EXPIRED', 410);
  return record;
}

function beginRecord(record, input, now) {
  validateStart(record, { uid: input.uid, now });
  if (record.lastResponse?.idempotencyKey === input.idempotencyKey) {
    if (record.lastResponse.message === input.message) return { replay: clone(record.lastResponse.response) };
    throw new ChatIntakeStoreError('CHAT_MESSAGE_CONFLICT');
  }
  if (terminal.has(record.status)) throw new ChatIntakeStoreError('CHAT_SESSION_COMPLETE');
  if (record.pending) throw new ChatIntakeStoreError('CHAT_MESSAGE_PENDING', 409);
  if (record.revision !== input.expectedRevision) throw new ChatIntakeStoreError('CHAT_SESSION_STALE', 409);
  const messageAttempts = (record.messageAttempts || []).filter(value => Number.isFinite(value) && now - value < messageWindowMs);
  if (messageAttempts.length >= messageLimit) throw new ChatIntakeStoreError('CHAT_RATE_LIMITED', 429);
  messageAttempts.push(now);
  return { record: { ...record, messageAttempts, pending: { idempotencyKey: input.idempotencyKey, message: input.message, expectedRevision: input.expectedRevision, startedAt: now }, updatedAt: now } };
}

function commitRecord(record, input, now, ttlMs) {
  if (!record || record.uid !== input.uid || record.pending?.idempotencyKey !== input.idempotencyKey || record.pending.message !== input.message) {
    throw new ChatIntakeStoreError('CHAT_MESSAGE_CONFLICT');
  }
  const response = clone(input.response);
  return { ...record, ...clone(input.next), revision: record.revision + 1, pending: null, updatedAt: now,
    expiresAt: now + ttlMs, lastResponse: { idempotencyKey: input.idempotencyKey, message: input.message, response } };
}

export function createMemoryChatIntakeStore({ now = () => Date.now(), ttlMs = 11 * 60_000 } = {}) {
  const records = new Map();
  return {
    async create(record) { if (records.has(record.sessionId)) throw new ChatIntakeStoreError('CHAT_SESSION_CONFLICT'); records.set(record.sessionId, clone(record)); return clone(record); },
    async get({ sessionId, uid }) { const record = records.get(sessionId); return validateStart(record, { uid, now: now() }) && clone(record); },
    async begin(input) {
      const result = beginRecord(records.get(input.sessionId), input, now());
      if (result.record) records.set(input.sessionId, result.record);
      return result.replay ? { replay: result.replay } : { record: clone(result.record) };
    },
    async commit(input) {
      const record = commitRecord(records.get(input.sessionId), input, now(), ttlMs);
      records.set(input.sessionId, record); return clone(record);
    },
    async abort({ sessionId, uid, idempotencyKey }) {
      const record = records.get(sessionId);
      if (record?.uid === uid && record.pending?.idempotencyKey === idempotencyKey) records.set(sessionId, { ...record, pending: null, updatedAt: now() });
    },
    async cancel({ sessionId, uid }) {
      const record = validateStart(records.get(sessionId), { uid, now: now() });
      const next = { ...record, status: 'cancelled', pending: null, updatedAt: now() }; records.set(sessionId, next); return clone(next);
    },
    async close() {},
  };
}

export function createFirestoreChatIntakeStore(db, { now = () => Date.now(), ttlMs = 11 * 60_000 } = {}) {
  const collection = db.collection('chatIntakeSessions');
  return {
    async create(record) { await collection.doc(record.sessionId).create(clone(record)); return clone(record); },
    async get({ sessionId, uid }) { const snapshot = await collection.doc(sessionId).get(); return clone(validateStart(snapshot.exists ? snapshot.data() : null, { uid, now: now() })); },
    async begin(input) {
      return db.runTransaction(async transaction => {
        const ref = collection.doc(input.sessionId), snapshot = await transaction.get(ref);
        const result = beginRecord(snapshot.exists ? snapshot.data() : null, input, now());
        if (result.record) transaction.set(ref, result.record);
        return result.replay ? { replay: result.replay } : { record: clone(result.record) };
      });
    },
    async commit(input) {
      return db.runTransaction(async transaction => {
        const ref = collection.doc(input.sessionId), snapshot = await transaction.get(ref);
        const record = commitRecord(snapshot.exists ? snapshot.data() : null, input, now(), ttlMs);
        transaction.set(ref, record); return clone(record);
      });
    },
    async abort({ sessionId, uid, idempotencyKey }) {
      await db.runTransaction(async transaction => {
        const ref = collection.doc(sessionId), snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null;
        if (record?.uid === uid && record.pending?.idempotencyKey === idempotencyKey) transaction.update(ref, { pending: null, updatedAt: now() });
      });
    },
    async cancel({ sessionId, uid }) {
      return db.runTransaction(async transaction => {
        const ref = collection.doc(sessionId), snapshot = await transaction.get(ref);
        const record = validateStart(snapshot.exists ? snapshot.data() : null, { uid, now: now() });
        const next = { ...record, status: 'cancelled', pending: null, updatedAt: now() }; transaction.set(ref, next); return clone(next);
      });
    },
    close: () => db.terminate(),
  };
}

export function createConfiguredChatIntakeStore(env = process.env) {
  if (env.LIVE_SESSION_STORE === 'memory' || env.CASE_STORE === 'memory') return createMemoryChatIntakeStore();
  const config = environmentConfig(env);
  if (!config.projectId) return null;
  return createFirestoreChatIntakeStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

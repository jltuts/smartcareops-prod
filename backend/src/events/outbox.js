import { randomUUID, createHash } from 'node:crypto';
import { createEventEnvelope, validateEventEnvelope, eventAttributes } from './contracts.js';

export const pendingOutboxRecord = (event, eventFamily, now = Date.now) => {
  const envelope = createEventEnvelope(event, eventFamily);
  const availableAt = new Date(now()).toISOString();
  return {
    outboxId: envelope.outboxId,
    envelope,
    status: 'pending',
    publishAttempts: 0,
    availableAt,
    claimableAt: availableAt,
    lease: null,
    publishedAt: null,
    messageId: null,
    lastFailure: null,
  };
};

export const pendingOutboxRecords = (before, after, eventFamily, now = Date.now) => {
  if (!eventFamily) return [];
  return Object.entries(after.events || {}).filter(([eventId]) => !before.events?.[eventId])
    .map(([, event]) => pendingOutboxRecord(event, eventFamily, now));
};

const clone = value => structuredClone(value);
export function createMemoryOutboxStore(records = new Map(), { now = Date.now, leaseMs = 30000 } = {}) {
  return {
    records,
    async claim(limit = 20) {
      const claimed = [];
      for (const record of records.values()) {
        const expired = record.lease && Date.parse(record.lease.expiresAt) <= now();
        if (record.status !== 'pending' || Date.parse(record.availableAt) > now() || (record.lease && !expired)) continue;
        const claimId = randomUUID();
        const expiresAt = new Date(now() + leaseMs).toISOString();
        Object.assign(record, { lease: { claimId, expiresAt }, claimableAt: expiresAt, publishAttempts: record.publishAttempts + 1 });
        claimed.push(clone(record));
        if (claimed.length >= limit) break;
      }
      return claimed;
    },
    async complete(outboxId, claimId, messageId) {
      const record = records.get(outboxId);
      if (!record || record.status !== 'pending' || record.lease?.claimId !== claimId || typeof messageId !== 'string' || !messageId) return false;
      Object.assign(record, { status: 'published', lease: null, claimableAt: null, publishedAt: new Date(now()).toISOString(), messageId, lastFailure: null });
      return true;
    },
    async release(outboxId, claimId, failure = 'PUBLISH_FAILED') {
      const record = records.get(outboxId);
      if (!record || record.status !== 'pending' || record.lease?.claimId !== claimId) return false;
      const delay = Math.min(60000, 1000 * (2 ** Math.min(record.publishAttempts - 1, 6)));
      const availableAt = new Date(now() + delay).toISOString();
      Object.assign(record, { lease: null, availableAt, claimableAt: availableAt, lastFailure: failure });
      return true;
    },
  };
}

const boundedLimit = value => Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : 20;
const retryDelay = attempts => Math.min(60000, 1000 * (2 ** Math.min(Math.max(attempts - 1, 0), 6)));

export function createFirestoreOutboxStore(db, { collection = 'eventOutbox', now = Date.now, leaseMs = 30000 } = {}) {
  const records = db.collection(collection);
  return {
    async claim(requestedLimit = 20) {
      const limit = boundedLimit(requestedLimit), current = now(), currentIso = new Date(current).toISOString();
      const query = records.where('claimableAt', '<=', currentIso).orderBy('claimableAt').limit(limit);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(query), claimed = [];
        for (const document of snapshot.docs) {
          const record = document.data();
          if (record.status !== 'pending' || Date.parse(record.availableAt) > current) continue;
          const expired = record.lease && Date.parse(record.lease.expiresAt) <= current;
          if (record.lease && !expired) continue;
          const claimId = randomUUID(), expiresAt = new Date(current + leaseMs).toISOString();
          const next = { ...record, lease: { claimId, expiresAt }, claimableAt: expiresAt,
            publishAttempts: record.publishAttempts + 1 };
          transaction.set(document.ref, next); claimed.push(clone(next));
        }
        return claimed;
      });
    },
    async complete(outboxId, claimId, messageId) {
      if (typeof messageId !== 'string' || !messageId) return false;
      const ref = records.doc(outboxId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null;
        if (!record || record.status !== 'pending' || record.lease?.claimId !== claimId) return false;
        transaction.set(ref, { ...record, status: 'published', lease: null, claimableAt: null,
          publishedAt: new Date(now()).toISOString(), messageId, lastFailure: null });
        return true;
      });
    },
    async release(outboxId, claimId, failure = 'PUBLISH_FAILED') {
      const ref = records.doc(outboxId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), record = snapshot.exists ? snapshot.data() : null;
        if (!record || record.status !== 'pending' || record.lease?.claimId !== claimId) return false;
        const availableAt = new Date(now() + retryDelay(record.publishAttempts)).toISOString();
        transaction.set(ref, { ...record, lease: null, availableAt, claimableAt: availableAt, lastFailure: failure });
        return true;
      });
    },
  };
}

export function createOutboxPublisher({ store, publish, batchSize = 20 }) {
  return {
    async drain() {
      const claimed = await store.claim(batchSize); let published = 0, failed = 0;
      for (const record of claimed) {
        try {
          const envelope = validateEventEnvelope(record.envelope);
          const messageId = await publish(envelope, eventAttributes(envelope));
          if (!await store.complete(record.outboxId, record.lease.claimId, messageId)) throw new Error('OUTBOX_CLAIM_LOST');
          published++;
        } catch (error) {
          failed++;
          await store.release(record.outboxId, record.lease.claimId, error?.message === 'OUTBOX_CLAIM_LOST' ? 'CLAIM_LOST' : 'PUBLISH_FAILED');
        }
      }
      return Object.freeze({ claimed: claimed.length, published, failed });
    },
  };
}

export function createMemoryAuditStore(receipts = new Map(), { now = Date.now } = {}) {
  return {
    receipts,
    async record(envelope, messageId) {
      envelope = validateEventEnvelope(envelope);
      const digest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
      const previous = receipts.get(envelope.outboxId);
      if (previous) {
        if (previous.envelopeDigest !== digest) throw new Error('AUDIT_EVENT_CONFLICT');
        return { ...clone(previous), duplicate: true };
      }
      const receipt = { receiptId: `audit-${envelope.outboxId}`, outboxId: envelope.outboxId, eventId: envelope.eventId,
        eventType: envelope.eventType, eventFamily: envelope.eventFamily, subjectType: envelope.subjectType,
        subjectId: envelope.subjectId, subjectVersion: envelope.subjectVersion, messageId, envelopeDigest: digest,
        recordedAt: new Date(now()).toISOString() };
      receipts.set(envelope.outboxId, receipt);
      return { ...clone(receipt), duplicate: false };
    },
  };
}

const auditReceipt = (envelope, messageId, recordedAt) => {
  const envelopeDigest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  return { receiptId: `audit-${envelope.outboxId}`, outboxId: envelope.outboxId, eventId: envelope.eventId,
    eventType: envelope.eventType, eventFamily: envelope.eventFamily, subjectType: envelope.subjectType,
    subjectId: envelope.subjectId, subjectVersion: envelope.subjectVersion, messageId, envelopeDigest, recordedAt };
};

export function createFirestoreAuditStore(db, { collection = 'eventAudit', now = Date.now } = {}) {
  const receipts = db.collection(collection);
  return {
    async record(envelope, messageId) {
      envelope = validateEventEnvelope(envelope);
      const proposed = auditReceipt(envelope, messageId, new Date(now()).toISOString());
      const ref = receipts.doc(envelope.outboxId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), previous = snapshot.exists ? snapshot.data() : null;
        if (previous) {
          if (previous.envelopeDigest !== proposed.envelopeDigest) throw new Error('AUDIT_EVENT_CONFLICT');
          return { ...clone(previous), duplicate: true };
        }
        transaction.set(ref, proposed);
        return { ...clone(proposed), duplicate: false };
      });
    },
  };
}

export const createAuditConsumer = store => async ({ envelope, messageId }) => store.record(envelope, messageId);

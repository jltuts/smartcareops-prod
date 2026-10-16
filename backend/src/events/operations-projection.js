import { createHash } from 'node:crypto';
import { validateEventEnvelope } from './contracts.js';

const clone = value => structuredClone(value);
const projectionFor = (envelope, messageId, projectedAt) => ({
  projectionId: `operations-${envelope.outboxId}`,
  outboxId: envelope.outboxId,
  eventId: envelope.eventId,
  eventType: envelope.eventType,
  eventFamily: envelope.eventFamily,
  subjectType: envelope.subjectType,
  subjectId: envelope.subjectId,
  subjectVersion: envelope.subjectVersion,
  occurredAt: envelope.occurredAt,
  correlationId: envelope.correlationId,
  messageId,
  envelopeDigest: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'),
  projectedAt,
});

const validatedOperationsEnvelope = envelope => {
  const validated = validateEventEnvelope(envelope);
  if (validated.eventFamily !== 'operations') throw new Error('OPERATIONS_EVENT_FAMILY_REQUIRED');
  return validated;
};

export function createMemoryOperationsProjectionStore(projections = new Map(), { now = Date.now } = {}) {
  return {
    projections,
    async record(envelope, messageId) {
      envelope = validatedOperationsEnvelope(envelope);
      const proposed = projectionFor(envelope, messageId, new Date(now()).toISOString());
      const previous = projections.get(envelope.outboxId);
      if (previous) {
        if (previous.envelopeDigest !== proposed.envelopeDigest) throw new Error('OPERATIONS_PROJECTION_CONFLICT');
        return { ...clone(previous), duplicate: true };
      }
      projections.set(envelope.outboxId, proposed);
      return { ...clone(proposed), duplicate: false };
    },
    async recordRoutingDecision(envelope, result) {
      envelope = validatedOperationsEnvelope(envelope);
      const previous = projections.get(envelope.outboxId);
      if (!previous) throw new Error('OPERATIONS_PROJECTION_REQUIRED');
      const disposition = result?.handled === true ? 'hospital_operations' : 'normal_care';
      if (previous.routingDisposition) {
        if (previous.routingDisposition !== disposition) throw new Error('OPERATIONS_ROUTING_CONFLICT');
        return clone(previous);
      }
      const next = { ...previous, routingDisposition: disposition,
        hospitalOperationsTriggered: result?.handled === true, classifiedAt: new Date(now()).toISOString() };
      projections.set(envelope.outboxId, next);
      return clone(next);
    },
  };
}

export function createFirestoreOperationsProjectionStore(db, { collection = 'eventOperations', now = Date.now } = {}) {
  const projections = db.collection(collection);
  return {
    async record(envelope, messageId) {
      envelope = validatedOperationsEnvelope(envelope);
      const proposed = projectionFor(envelope, messageId, new Date(now()).toISOString());
      const ref = projections.doc(envelope.outboxId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), previous = snapshot.exists ? snapshot.data() : null;
        if (previous) {
          if (previous.envelopeDigest !== proposed.envelopeDigest) throw new Error('OPERATIONS_PROJECTION_CONFLICT');
          return { ...clone(previous), duplicate: true };
        }
        transaction.set(ref, proposed);
        return { ...clone(proposed), duplicate: false };
      });
    },
    async recordRoutingDecision(envelope, result) {
      envelope = validatedOperationsEnvelope(envelope);
      const ref = projections.doc(envelope.outboxId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref), previous = snapshot.exists ? snapshot.data() : null;
        if (!previous) throw new Error('OPERATIONS_PROJECTION_REQUIRED');
        const disposition = result?.handled === true ? 'hospital_operations' : 'normal_care';
        if (previous.routingDisposition) {
          if (previous.routingDisposition !== disposition) throw new Error('OPERATIONS_ROUTING_CONFLICT');
          return clone(previous);
        }
        const next = { ...previous, routingDisposition: disposition,
          hospitalOperationsTriggered: result?.handled === true, classifiedAt: new Date(now()).toISOString() };
        transaction.set(ref, next);
        return clone(next);
      });
    },
  };
}

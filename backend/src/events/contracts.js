import { createHash } from 'node:crypto';

export const eventFamilies = Object.freeze(['clinical', 'notifications', 'operations']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
const isoDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function createEventEnvelope(event, eventFamily) {
  if (!eventFamilies.includes(eventFamily) || !identifier(event?.eventId) || !identifier(event?.type) ||
      !identifier(event?.subjectType) || !identifier(event?.subjectId) || !Number.isSafeInteger(event?.subjectVersion) ||
      event.subjectVersion < 0 || event?.schemaVersion !== 1 || !isoDate(event?.occurredAt) ||
      !identifier(event?.correlationId) || (event?.causationId !== null && !identifier(event?.causationId))) {
    throw new Error('INVALID_EVENT_ENVELOPE');
  }
  const envelope = {
    schemaVersion: 1,
    eventId: event.eventId,
    eventType: event.type,
    eventFamily,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    subjectVersion: event.subjectVersion,
    occurredAt: new Date(event.occurredAt).toISOString(),
    correlationId: event.correlationId,
    causationId: event.causationId,
  };
  return Object.freeze({
    outboxId: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'),
    ...envelope,
  });
}

export function validateEventEnvelope(value) {
  const keys = ['outboxId', 'schemaVersion', 'eventId', 'eventType', 'eventFamily', 'subjectType', 'subjectId', 'subjectVersion', 'occurredAt', 'correlationId', 'causationId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key))) throw new Error('INVALID_EVENT_ENVELOPE');
  const expected = createEventEnvelope({ eventId: value.eventId, type: value.eventType, subjectType: value.subjectType,
    subjectId: value.subjectId, subjectVersion: value.subjectVersion, schemaVersion: value.schemaVersion,
    occurredAt: value.occurredAt, correlationId: value.correlationId, causationId: value.causationId }, value.eventFamily);
  if (expected.outboxId !== value.outboxId) throw new Error('INVALID_EVENT_ENVELOPE');
  return expected;
}

export const eventAttributes = envelope => ({
  event_family: envelope.eventFamily,
  event_type: envelope.eventType,
  schema_version: String(envelope.schemaVersion),
});

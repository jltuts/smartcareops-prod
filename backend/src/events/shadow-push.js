import { createHash } from 'node:crypto';
import { decodePubSubMessage } from './pubsub.js';
import { validateEventEnvelope } from './contracts.js';

const collections = Object.freeze({ clinical: 'eventClinical', notifications: 'eventNotifications' });
const jsonType = /^application\/json(?:\s*;|$)/i;
const reply = (response, status, body = '') => {
  response.writeHead(status, body ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {});
  response.end(body);
};

export function createFirestoreShadowStore(db, family, { now = Date.now } = {}) {
  if (!collections[family] || !db?.runTransaction) throw new Error('SHADOW_STORE_CONFIGURATION_REQUIRED');
  const collection = db.collection(collections[family]);
  return {
    async record(envelope, messageId) {
      envelope = validateEventEnvelope(envelope);
      if (envelope.eventFamily !== family) throw new Error('SHADOW_EVENT_FAMILY_REQUIRED');
      const digest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
      const ref = collection.doc(envelope.outboxId);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) {
          const previous = snapshot.data();
          if (previous.envelopeDigest !== digest) throw new Error('SHADOW_PROJECTION_CONFLICT');
          return { ...previous, duplicate: true };
        }
        const projection = { outboxId: envelope.outboxId, eventId: envelope.eventId,
          eventType: envelope.eventType, eventFamily: family, subjectType: envelope.subjectType,
          subjectId: envelope.subjectId, subjectVersion: envelope.subjectVersion,
          occurredAt: envelope.occurredAt, correlationId: envelope.correlationId,
          messageId, envelopeDigest: digest, projectedAt: new Date(now()).toISOString() };
        transaction.create(ref, projection);
        return { ...projection, duplicate: false };
      });
    },
  };
}

export function createShadowPushHandler({ family, store, expectedSubscription, onEvent = null, maxBodyBytes = 65536, logger = console } = {}) {
  if (!collections[family] || !store?.record || typeof expectedSubscription !== 'string' || !expectedSubscription) {
    throw new Error('SHADOW_PUSH_CONFIGURATION_REQUIRED');
  }
  return (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && ['/healthz', '/readyz'].includes(path)) {
      reply(response, 200, JSON.stringify({ status: 'ok', mode: `${family}-shadow` }));
      return;
    }
    if (request.method !== 'POST' || path !== `/events/${family}`) { reply(response, 404); return; }
    if (!jsonType.test(request.headers['content-type'] || '')) { reply(response, 415); return; }
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= maxBodyBytes) chunks.push(chunk);
    });
    request.on('end', async () => {
      if (bytes > maxBodyBytes) { reply(response, 413); return; }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body?.subscription !== expectedSubscription) throw new Error('SHADOW_SUBSCRIPTION_MISMATCH');
        const message = body?.message;
        if (typeof message?.data !== 'string' || typeof message?.messageId !== 'string' || !message.messageId) {
          throw new Error('INVALID_PUBSUB_PUSH');
        }
        const { envelope, messageId } = decodePubSubMessage({ id: message.messageId, data: Buffer.from(message.data, 'base64') });
        if (envelope.eventFamily !== family) throw new Error('SHADOW_EVENT_FAMILY_REQUIRED');
        await store.record(envelope, messageId);
        if (onEvent) await onEvent(envelope);
        reply(response, 204);
      } catch (error) {
        const permanent = ['SHADOW_SUBSCRIPTION_MISMATCH', 'INVALID_PUBSUB_PUSH', 'INVALID_PUBSUB_MESSAGE',
          'INVALID_EVENT_ENVELOPE', 'SHADOW_EVENT_FAMILY_REQUIRED', 'SHADOW_PROJECTION_CONFLICT'].includes(error?.message);
        logger.error('[shadow-push]', JSON.stringify({ family, stage: 'delivery', error: permanent ? error.message : 'STORE_UNAVAILABLE' }));
        reply(response, permanent ? 400 : 503);
      }
    });
    request.on('error', () => reply(response, 400));
  };
}

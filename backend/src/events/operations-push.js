import { decodePubSubMessage } from './pubsub.js';

const jsonType = /^application\/json(?:\s*;|$)/i;
const reply = (response, status, body = '') => {
  response.writeHead(status, body ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {});
  response.end(body);
};

export function createOperationsPushHandler({ store, expectedSubscription, onEvent, maxBodyBytes = 65536, logger = console } = {}) {
  if (!store?.record || typeof expectedSubscription !== 'string' || !expectedSubscription) throw new Error('OPERATIONS_PUSH_CONFIGURATION_REQUIRED');
  return (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && ['/healthz', '/readyz'].includes(path)) {
      reply(response, 200, JSON.stringify({ status: 'ok', mode: 'operations-push' }));
      return;
    }
    if (request.method !== 'POST' || path !== '/events/operations') { reply(response, 404); return; }
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
        if (body?.subscription !== expectedSubscription) throw new Error('OPERATIONS_SUBSCRIPTION_MISMATCH');
        const message = body?.message;
        if (typeof message?.data !== 'string' || typeof message?.messageId !== 'string' || !message.messageId) {
          throw new Error('INVALID_PUBSUB_PUSH');
        }
        const { envelope, messageId } = decodePubSubMessage({ id: message.messageId, data: Buffer.from(message.data, 'base64') });
        await store.record(envelope, messageId);
        if (onEvent) {
          const result = await onEvent(envelope, {
          messageId,
          deliveryAttempt: Number.isSafeInteger(body?.deliveryAttempt) && body.deliveryAttempt > 0 ? body.deliveryAttempt : 1,
          });
          if (store.recordRoutingDecision) await store.recordRoutingDecision(envelope, result);
        }
        reply(response, 204);
      } catch (error) {
        const known = ['OPERATIONS_SUBSCRIPTION_MISMATCH', 'OPERATIONS_EVENT_FAMILY_REQUIRED', 'INVALID_PUBSUB_PUSH',
          'INVALID_PUBSUB_MESSAGE', 'OPERATIONS_PROJECTION_CONFLICT', 'OPERATIONS_PROJECTION_REQUIRED', 'OPERATIONS_ROUTING_CONFLICT'];
        const code = known.includes(error?.message) ? error.message : error?.name || 'Error';
        logger.error('[operations-push]', JSON.stringify({ stage: 'delivery', error: code }));
        reply(response, 400);
      }
    });
    request.on('error', () => reply(response, 400));
  };
}

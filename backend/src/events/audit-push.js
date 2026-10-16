import { decodePubSubMessage } from './pubsub.js';

const jsonType = /^application\/json(?:\s*;|$)/i;

const reply = (response, status, body = '') => {
  response.writeHead(status, body ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {});
  response.end(body);
};

export function createAuditPushHandler({ store, expectedSubscription, maxBodyBytes = 65536, logger = console } = {}) {
  if (!store?.record || typeof expectedSubscription !== 'string' || !expectedSubscription) throw new Error('AUDIT_PUSH_CONFIGURATION_REQUIRED');
  return (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && ['/healthz', '/readyz'].includes(path)) {
      reply(response, 200, JSON.stringify({ status: 'ok', mode: 'audit-push' }));
      return;
    }
    if (request.method !== 'POST' || path !== '/events/audit') { reply(response, 404); return; }
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
        if (body?.subscription !== expectedSubscription) throw new Error('AUDIT_SUBSCRIPTION_MISMATCH');
        const message = body?.message;
        if (typeof message?.data !== 'string' || typeof message?.messageId !== 'string' || !message.messageId) {
          throw new Error('INVALID_PUBSUB_PUSH');
        }
        const { envelope, messageId } = decodePubSubMessage({ id: message.messageId, data: Buffer.from(message.data, 'base64') });
        await store.record(envelope, messageId);
        reply(response, 204);
      } catch (error) {
        const known = ['AUDIT_SUBSCRIPTION_MISMATCH', 'INVALID_PUBSUB_PUSH', 'INVALID_PUBSUB_MESSAGE', 'AUDIT_EVENT_CONFLICT'];
        const code = known.includes(error?.message) ? error.message : error?.name || 'Error';
        logger.error('[audit-push]', JSON.stringify({ stage: 'delivery', error: code }));
        reply(response, 400);
      }
    });
    request.on('error', () => reply(response, 400));
  };
}

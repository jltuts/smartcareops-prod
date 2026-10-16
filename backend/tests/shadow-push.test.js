import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { durableEvent } from '../src/agent-core/lifecycle.js';
import { createEventEnvelope } from '../src/events/contracts.js';
import { createFirestoreShadowStore, createShadowPushHandler } from '../src/events/shadow-push.js';
import { eventDatabase } from './event-firestore-fixture.js';

const envelopeFor = (family, id) => createEventEnvelope(durableEvent({ eventId: `${family}.recorded:${id}`,
  type: `${family}.recorded`, subjectType: 'case', subjectId: id, version: 1,
  now: Date.parse('2026-10-15T01:00:00.000Z'), scope: {} }), family);

const deliver = async (handler, { subscription, envelope, messageId = 'message-1', path, contentType = 'application/json' }) => {
  const request = new EventEmitter();
  Object.assign(request, { method: 'POST', url: path, headers: { 'content-type': contentType } });
  let status;
  const response = { writeHead(value) { status = value; return this; }, end() {} };
  handler(request, response);
  request.emit('data', Buffer.from(JSON.stringify({ subscription, message: {
    messageId, data: Buffer.from(JSON.stringify(envelope)).toString('base64'),
  } })));
  request.emit('end');
  await new Promise(resolve => setImmediate(resolve));
  return status;
};

for (const family of ['clinical', 'notifications']) {
  test(`${family} shadow worker records metadata once and performs no case or notification mutation`, async () => {
    const db = eventDatabase(), id = `SC-${family}-test`, envelope = envelopeFor(family, id);
    const subscription = `projects/smartcareops-local/subscriptions/smartcareops-${family}-events`;
    const errors = [], store = createFirestoreShadowStore(db, family, { now: () => Date.parse('2026-10-15T01:01:00.000Z') });
    const handler = createShadowPushHandler({ family, store, expectedSubscription: subscription,
      logger: { error: (...args) => errors.push(args.join(' ')) } });
    assert.equal(await deliver(handler, { subscription, envelope, path: `/events/${family}` }), 204);
    const first = structuredClone(db.documents.get(`event${family === 'clinical' ? 'Clinical' : 'Notifications'}/${envelope.outboxId}`));
    assert.deepEqual(Object.keys(first), ['outboxId', 'eventId', 'eventType', 'eventFamily', 'subjectType', 'subjectId',
      'subjectVersion', 'occurredAt', 'correlationId', 'messageId', 'envelopeDigest', 'projectedAt']);
    assert.equal(await deliver(handler, { subscription, envelope, path: `/events/${family}`, messageId: 'message-2' }), 204);
    assert.deepEqual(db.documents.get(`event${family === 'clinical' ? 'Clinical' : 'Notifications'}/${envelope.outboxId}`), first);
    assert.equal([...db.documents.keys()].length, 1);
    assert.equal(await deliver(handler, { subscription: 'projects/other/subscriptions/wrong', envelope, path: `/events/${family}` }), 400);
    assert.equal(await deliver(handler, { subscription, envelope: envelopeFor(family === 'clinical' ? 'notifications' : 'clinical', id), path: `/events/${family}` }), 400);
    db.failNext();
    assert.equal(await deliver(handler, { subscription, envelope: envelopeFor(family, `${id}-retry`), path: `/events/${family}` }), 503);
    assert.equal([...db.documents.keys()].length, 1);
    assert.equal(errors.length, 3);
    assert.equal(errors.join(' ').includes(id), false);
  });
}

test('active processing retries after a downstream failure without losing the shadow projection', async () => {
  const family = 'clinical', db = eventDatabase(), envelope = envelopeFor(family, 'SC-retry-test');
  const subscription = 'projects/smartcareops-local/subscriptions/smartcareops-clinical-events';
  let attempts = 0;
  const handler = createShadowPushHandler({ family, store: createFirestoreShadowStore(db, family),
    expectedSubscription: subscription, logger: { error() {} },
    onEvent: async () => { if (++attempts === 1) throw new Error('temporary failure'); } });
  assert.equal(await deliver(handler, { subscription, envelope, path: '/events/clinical' }), 503);
  assert.equal(await deliver(handler, { subscription, envelope, path: '/events/clinical' }), 204);
  assert.equal(attempts, 2);
  assert.equal([...db.documents.keys()].length, 1);
});

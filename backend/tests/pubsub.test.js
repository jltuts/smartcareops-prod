import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PubSub } from '@google-cloud/pubsub';
import { durableEvent } from '../src/agent-core/lifecycle.js';
import { memoryClinicalStore, firestoreClinicalStore } from '../src/clinical/storage.js';
import { createEventEnvelope } from '../src/events/contracts.js';
import { createMemoryOutboxStore, createOutboxPublisher, createMemoryAuditStore, createAuditConsumer,
  createFirestoreOutboxStore, createFirestoreAuditStore } from '../src/events/outbox.js';
import { createPubSubPublisher } from '../src/events/pubsub.js';
import { createAuditPushHandler } from '../src/events/audit-push.js';
import { createPublisherWorker, createAuditSubscriptionWorker } from '../src/events/workers.js';
import { eventWorkerConfig, createEventWorkerRuntime } from '../src/events/worker-runtime.js';
import { database } from './firestore-contract-fixture.js';
import { eventDatabase } from './event-firestore-fixture.js';

const caseId = 'SC-12345678-1234-4234-8234-123456789012';
const event = (id = 'obs_local') => durableEvent({ eventId: id, type: 'observation.recorded', subjectType: 'case', subjectId: caseId,
  version: 1, now: Date.parse('2026-10-05T03:00:00.000Z'), causationId: null, scope: { simulation: true }, pending: true,
  extra: { caseSummary: 'This clinical text must never enter the event envelope.' } });

class FakeHttpServer extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.listening = false; }
  listen() { this.listening = true; queueMicrotask(() => this.emit('listening')); }
  close(callback) { this.listening = false; callback(); }
}

const invokePush = async (handler, { method = 'POST', path = '/events/audit', body = {}, contentType = 'application/json' } = {}) => {
  const request = new EventEmitter();
  Object.assign(request, { method, url: path, headers: { 'content-type': contentType } });
  let status = null, payload = '';
  const response = { writeHead(value) { status = value; return this; }, end(value = '') { payload += value; } };
  handler(request, response);
  if (method === 'POST') {
    request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
    await new Promise(resolve => setImmediate(resolve));
  }
  return { status, payload };
};

test('bounded event envelope contains routing metadata and excludes clinical payload', () => {
  const envelope = createEventEnvelope(event(), 'clinical'), encoded = JSON.stringify(envelope);
  assert.deepEqual(Object.keys(envelope), ['outboxId', 'schemaVersion', 'eventId', 'eventType', 'eventFamily', 'subjectType', 'subjectId', 'subjectVersion', 'occurredAt', 'correlationId', 'causationId']);
  assert.equal(envelope.eventFamily, 'clinical');
  assert.equal(encoded.includes('clinical text'), false);
  assert.equal(encoded.includes('caseSummary'), false);
});

test('outbox is opt-in and a new clinical event is captured once', async () => {
  const backing = new Map(), outbox = new Map();
  const ordinary = memoryClinicalStore(backing);
  await ordinary.transaction(caseId, state => { state.meta = { storageVersion: 0 }; state.events.obs_ordinary = event('obs_ordinary'); });
  assert.equal(outbox.size, 0);

  const enabled = memoryClinicalStore(backing, undefined, { outboxFamily: 'clinical', outboxBacking: outbox });
  await enabled.transaction(caseId, state => { state.events.obs_enabled = event('obs_enabled'); });
  await enabled.transaction(caseId, state => state.events.obs_enabled);
  assert.equal(outbox.size, 1);
  assert.equal([...outbox.values()][0].envelope.eventId, 'obs_enabled');
});

test('Firestore source event and outbox record commit or fail together', async () => {
  const db = database(), store = firestoreClinicalStore(db, { outboxFamily: 'clinical' });
  db.failNext();
  await assert.rejects(store.transaction(caseId, state => { state.meta = { storageVersion: 0 }; state.events.obs_failed = event('obs_failed'); }));
  assert.equal([...db.documents.keys()].some(key => key.includes('obs_failed')), false);
  assert.equal([...db.documents.keys()].some(key => key.startsWith('eventOutbox/')), false);

  await store.transaction(caseId, state => { state.meta = { storageVersion: 0 }; state.events.obs_committed = event('obs_committed'); });
  assert.equal(db.documents.has(`clinicalWorkspaces/${caseId}/events/obs_committed`), true);
  const records = [...db.documents.entries()].filter(([key]) => key.startsWith('eventOutbox/'));
  assert.equal(records.length, 1);
  assert.equal(records[0][1].envelope.eventId, 'obs_committed');
});

test('publisher and audit consumer are idempotent across duplicate delivery', async () => {
  let clock = Date.parse('2026-10-05T03:00:00.000Z');
  const records = new Map(), outbox = createMemoryOutboxStore(records, { now: () => clock });
  const envelope = createEventEnvelope(event(), 'clinical');
  records.set(envelope.outboxId, { outboxId: envelope.outboxId, envelope, status: 'pending', publishAttempts: 0,
    availableAt: new Date(clock).toISOString(), lease: null, publishedAt: null, messageId: null, lastFailure: null });
  const audit = createMemoryAuditStore(new Map(), { now: () => clock }), consume = createAuditConsumer(audit);
  const publish = async sent => {
    await consume({ envelope: sent, messageId: 'message-1' });
    const duplicate = await consume({ envelope: sent, messageId: 'message-1-redelivered' });
    assert.equal(duplicate.duplicate, true);
    return 'message-1';
  };
  assert.deepEqual(await createOutboxPublisher({ store: outbox, publish }).drain(), { claimed: 1, published: 1, failed: 0 });
  assert.equal(records.get(envelope.outboxId).status, 'published');
  assert.equal(audit.receipts.size, 1);
});

test('failed publication stays pending and a later bounded retry succeeds', async () => {
  let clock = Date.parse('2026-10-05T03:00:00.000Z'), calls = 0;
  const envelope = createEventEnvelope(event(), 'clinical'), records = new Map([[envelope.outboxId, {
    outboxId: envelope.outboxId, envelope, status: 'pending', publishAttempts: 0, availableAt: new Date(clock).toISOString(),
    lease: null, publishedAt: null, messageId: null, lastFailure: null,
  }]]), store = createMemoryOutboxStore(records, { now: () => clock });
  const publisher = createOutboxPublisher({ store, publish: async () => { if (++calls === 1) throw new Error('provider detail'); return 'message-2'; } });
  assert.deepEqual(await publisher.drain(), { claimed: 1, published: 0, failed: 1 });
  assert.equal(records.get(envelope.outboxId).status, 'pending');
  assert.equal(records.get(envelope.outboxId).lastFailure, 'PUBLISH_FAILED');
  clock += 1000;
  assert.deepEqual(await publisher.drain(), { claimed: 1, published: 1, failed: 0 });
  assert.equal(records.get(envelope.outboxId).status, 'published');
});

test('Firestore outbox recovers an expired lease and rejects the stale worker completion', async () => {
  let clock = Date.parse('2026-10-05T03:00:00.000Z');
  const db = eventDatabase(), envelope = createEventEnvelope(event(), 'clinical'), availableAt = new Date(clock).toISOString();
  db.documents.set(`eventOutbox/${envelope.outboxId}`, { outboxId: envelope.outboxId, envelope, status: 'pending',
    publishAttempts: 0, availableAt, claimableAt: availableAt, lease: null, publishedAt: null, messageId: null, lastFailure: null });
  const firstStore = createFirestoreOutboxStore(db, { now: () => clock, leaseMs: 30000 });
  const first = (await firstStore.claim(1))[0];
  assert.equal((await createFirestoreOutboxStore(db, { now: () => clock }).claim(1)).length, 0);

  clock += 30000;
  const restartedStore = createFirestoreOutboxStore(db, { now: () => clock, leaseMs: 30000 });
  const recovered = (await restartedStore.claim(1))[0];
  assert.notEqual(recovered.lease.claimId, first.lease.claimId);
  assert.equal(recovered.publishAttempts, 2);
  assert.equal(await firstStore.complete(envelope.outboxId, first.lease.claimId, 'stale-message'), false);
  assert.equal(await restartedStore.complete(envelope.outboxId, recovered.lease.claimId, 'message-2'), true);
  assert.equal(db.documents.get(`eventOutbox/${envelope.outboxId}`).status, 'published');
});

test('Firestore retry remains pending until its bounded backoff elapses', async () => {
  let clock = Date.parse('2026-10-05T03:00:00.000Z');
  const db = eventDatabase(), envelope = createEventEnvelope(event(), 'clinical'), availableAt = new Date(clock).toISOString();
  db.documents.set(`eventOutbox/${envelope.outboxId}`, { outboxId: envelope.outboxId, envelope, status: 'pending',
    publishAttempts: 0, availableAt, claimableAt: availableAt, lease: null, publishedAt: null, messageId: null, lastFailure: null });
  const store = createFirestoreOutboxStore(db, { now: () => clock });
  const claimed = (await store.claim(1))[0];
  assert.equal(await store.release(envelope.outboxId, claimed.lease.claimId), true);
  assert.equal((await store.claim(1)).length, 0);
  clock += 1000;
  assert.equal((await store.claim(1)).length, 1);
});

test('restart after publication can redeliver but Firestore audit stores one receipt', async () => {
  let clock = Date.parse('2026-10-05T03:00:00.000Z');
  const db = eventDatabase(), envelope = createEventEnvelope(event(), 'clinical'), availableAt = new Date(clock).toISOString();
  db.documents.set(`eventOutbox/${envelope.outboxId}`, { outboxId: envelope.outboxId, envelope, status: 'pending',
    publishAttempts: 0, availableAt, claimableAt: availableAt, lease: null, publishedAt: null, messageId: null, lastFailure: null });
  const audit = createFirestoreAuditStore(db, { now: () => clock });
  const crashedStore = createFirestoreOutboxStore(db, { now: () => clock, leaseMs: 30000 });
  await crashedStore.claim(1);
  assert.equal((await audit.record(envelope, 'message-before-crash')).duplicate, false);

  clock += 30000;
  const restartedStore = createFirestoreOutboxStore(db, { now: () => clock });
  const worker = createPublisherWorker({ store: restartedStore, publish: async sent => {
    assert.equal((await audit.record(sent, 'message-after-restart')).duplicate, true);
    return 'message-after-restart';
  } });
  assert.deepEqual(await worker.tick(), { claimed: 1, published: 1, failed: 0 });
  assert.equal([...db.documents.keys()].filter(key => key.startsWith('eventAudit/')).length, 1);
});

test('audit subscription acknowledges durable receipts and nacks invalid messages', async () => {
  const subscription = new EventEmitter(), audit = createMemoryAuditStore(), errors = [];
  const worker = createAuditSubscriptionWorker({ subscription, store: audit, onError: error => errors.push(error.message) });
  assert.equal(worker.start(), true); assert.equal(worker.start(), false);
  const envelope = createEventEnvelope(event(), 'clinical');
  let acknowledged = 0, nacked = 0;
  subscription.emit('message', { id: 'message-1', data: Buffer.from(JSON.stringify(envelope)), ack: () => acknowledged++, nack: () => nacked++ });
  await new Promise(resolve => setImmediate(resolve));
  subscription.emit('message', { id: 'message-bad', data: Buffer.from('{'), ack: () => acknowledged++, nack: () => nacked++ });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, 1); assert.equal(nacked, 1); assert.deepEqual(errors, ['INVALID_PUBSUB_MESSAGE']);
  assert.equal(audit.receipts.size, 1); assert.equal(worker.stop(), true); assert.equal(worker.stop(), false);
});

test('authenticated audit push records once and rejects the wrong subscription', async () => {
  const audit = createMemoryAuditStore(), errors = [];
  const expectedSubscription = 'projects/smartcareops-local/subscriptions/smartcareops-audit-events';
  const handler = createAuditPushHandler({ store: audit, expectedSubscription, logger: { error: (...args) => errors.push(args) } });
  const envelope = createEventEnvelope(event(), 'clinical');
  const message = { messageId: 'push-message-1', data: Buffer.from(JSON.stringify(envelope)).toString('base64') };
  assert.equal((await invokePush(handler, { body: { subscription: expectedSubscription, message } })).status, 204);
  assert.equal((await invokePush(handler, { body: { subscription: expectedSubscription, message } })).status, 204);
  assert.equal(audit.receipts.size, 1);
  assert.equal((await invokePush(handler, { body: { subscription: 'projects/other/subscriptions/audit', message } })).status, 400);
  assert.equal(errors.length, 1);
});

test('audit push and publisher diagnostics exclude event data and provider details', async () => {
  const expectedSubscription = 'projects/smartcareops-local/subscriptions/smartcareops-audit-events';
  const auditLogs = [];
  const auditHandler = createAuditPushHandler({
    store: { async record() { throw new Error('secret provider detail'); } }, expectedSubscription,
    logger: { error: (...args) => auditLogs.push(args.join(' ')) },
  });
  const envelope = createEventEnvelope(event(), 'clinical');
  const message = { messageId: 'push-message-2', data: Buffer.from(JSON.stringify(envelope)).toString('base64') };
  assert.equal((await invokePush(auditHandler, { body: { subscription: expectedSubscription, message } })).status, 400);
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].includes('secret provider detail'), false);
  assert.equal(auditLogs[0].includes(caseId), false);

  const clock = Date.parse('2026-10-05T03:00:00.000Z'), records = new Map();
  records.set(envelope.outboxId, { outboxId: envelope.outboxId, envelope, status: 'pending', publishAttempts: 0,
    availableAt: new Date(clock).toISOString(), claimableAt: new Date(clock).toISOString(), lease: null,
    publishedAt: null, messageId: null, lastFailure: null });
  const publisherLogs = [];
  const runtime = createEventWorkerRuntime({
    config: { mode: 'publisher', port: 0, pollIntervalMs: 60000, batchSize: 1 },
    outboxStore: createMemoryOutboxStore(records, { now: () => clock }), publish: async () => { throw new Error('provider detail'); },
    logger: { error: (...args) => publisherLogs.push(args.join(' ')) }, createHttpServer: handler => new FakeHttpServer(handler),
  });
  await runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  await runtime.stop();
  assert.equal(publisherLogs.length, 1);
  assert.match(publisherLogs[0], /"stage":"publish_batch"/);
  assert.match(publisherLogs[0], /"failed":1/);
  assert.equal(publisherLogs[0].includes(caseId), false);
  assert.equal(publisherLogs[0].includes('provider detail'), false);
});

test('worker configuration is explicit, bounded, and disabled by default', () => {
  assert.throws(() => eventWorkerConfig({}), /M55_WORKER_DISABLED/);
  assert.throws(() => eventWorkerConfig({ M55_ENABLED: 'true', M55_WORKER_MODE: 'publisher', FIREBASE_PROJECT_ID: 'smartcareops-local' }), /M55_TOPIC_REQUIRED/);
  assert.throws(() => eventWorkerConfig({ M55_ENABLED: 'true', M55_WORKER_MODE: 'audit', FIREBASE_PROJECT_ID: 'smartcareops-local' }), /M55_SUBSCRIPTION_REQUIRED/);
  assert.deepEqual(eventWorkerConfig({ M55_ENABLED: 'true', M55_WORKER_MODE: 'publisher', FIREBASE_PROJECT_ID: 'smartcareops-local',
    M55_TOPIC: 'smartcareops-care-events', PORT: '8081', M55_POLL_INTERVAL_MS: '1', M55_BATCH_SIZE: '500' }), {
    mode: 'publisher', projectId: 'smartcareops-local', topicName: 'smartcareops-care-events', subscriptionName: '',
    port: 8081, pollIntervalMs: 250, batchSize: 100,
  });
});

test('publisher runtime never overlaps polls and drains before shutdown', async () => {
  let claims = 0, release;
  const runtime = createEventWorkerRuntime({
    config: { mode: 'publisher', port: 0, pollIntervalMs: 5, batchSize: 1 },
    outboxStore: { async claim() { claims++; return new Promise(resolve => { release = () => resolve([]); }); } },
    publish: async () => 'unused', logger: { error() {} }, createHttpServer: handler => new FakeHttpServer(handler),
  });
  assert.equal(await runtime.start(), true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(claims, 1);
  const stopped = runtime.stop(); release();
  assert.equal(await stopped, true);
  assert.equal(runtime.ready, false);
});

test('audit runtime attaches only while ready and acknowledges a valid envelope', async () => {
  const subscription = new EventEmitter(), audit = createMemoryAuditStore();
  const runtime = createEventWorkerRuntime({
    config: { mode: 'audit', port: 0, pollIntervalMs: 1000, batchSize: 1 }, subscription, auditStore: audit,
    logger: { error() {} }, createHttpServer: handler => new FakeHttpServer(handler),
  });
  await runtime.start();
  let acknowledged = 0;
  const envelope = createEventEnvelope(event(), 'clinical');
  subscription.emit('message', { id: 'runtime-message', data: Buffer.from(JSON.stringify(envelope)), ack: () => acknowledged++, nack() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, 1); assert.equal(audit.receipts.size, 1);
  await runtime.stop();
  assert.equal(subscription.listenerCount('message'), 0);
});

test('Firestore outbox and audit workers complete a cycle through the local Pub/Sub emulator', { skip: !process.env.PUBSUB_EMULATOR_HOST }, async () => {
  const projectId = process.env.PUBSUB_PROJECT_ID || 'smartcareops-local', suffix = randomUUID();
  const topicName = `care-events-${suffix}`, subscriptionName = `audit-events-${suffix}`, client = new PubSub({ projectId });
  const [topic] = await client.createTopic(topicName); const [subscription] = await topic.createSubscription(subscriptionName);
  let auditWorker;
  try {
    const db = eventDatabase(), envelope = createEventEnvelope(event(), 'clinical'), availableAt = new Date().toISOString();
    db.documents.set(`eventOutbox/${envelope.outboxId}`, { outboxId: envelope.outboxId, envelope, status: 'pending',
      publishAttempts: 0, availableAt, claimableAt: availableAt, lease: null, publishedAt: null, messageId: null, lastFailure: null });
    const errors = [];
    auditWorker = createAuditSubscriptionWorker({ subscription, store: createFirestoreAuditStore(db), onError: error => errors.push(error) });
    auditWorker.start();
    const publisher = createPublisherWorker({ store: createFirestoreOutboxStore(db),
      publish: createPubSubPublisher({ projectId, topicName, client }) });
    assert.deepEqual(await publisher.tick(), { claimed: 1, published: 1, failed: 0 });
    const deadline = Date.now() + 5000;
    while (!db.documents.has(`eventAudit/${envelope.outboxId}`)) {
      if (Date.now() >= deadline) throw new Error('EMULATOR_DELIVERY_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const outbox = db.documents.get(`eventOutbox/${envelope.outboxId}`), receipt = db.documents.get(`eventAudit/${envelope.outboxId}`);
    assert.equal(outbox.status, 'published');
    assert.equal(receipt.messageId, outbox.messageId);
    assert.equal(receipt.outboxId, envelope.outboxId);
    assert.deepEqual(errors, []);
  } finally {
    auditWorker?.stop();
    subscription.removeAllListeners(); await subscription.close().catch(() => {});
    await subscription.delete().catch(() => {}); await topic.delete().catch(() => {}); await client.close();
  }
});

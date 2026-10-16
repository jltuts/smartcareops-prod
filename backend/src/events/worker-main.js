import { Firestore } from '@google-cloud/firestore';
import { PubSub } from '@google-cloud/pubsub';
import { createFirestoreOutboxStore, createFirestoreAuditStore } from './outbox.js';
import { createPubSubPublisher } from './pubsub.js';
import { eventWorkerConfig, createEventWorkerRuntime } from './worker-runtime.js';

const config = eventWorkerConfig(process.env);
const firestore = new Firestore({ projectId: config.projectId, databaseId: '(default)' });
const pubsub = new PubSub({ projectId: config.projectId });
const subscription = config.mode === 'audit' ? pubsub.subscription(config.subscriptionName, {
  flowControl: { maxMessages: 10, allowExcessMessages: false },
}) : null;
const runtime = createEventWorkerRuntime({ config,
  outboxStore: config.mode === 'publisher' ? createFirestoreOutboxStore(firestore) : null,
  auditStore: config.mode === 'audit' ? createFirestoreAuditStore(firestore) : null,
  publish: config.mode === 'publisher' ? createPubSubPublisher({ projectId: config.projectId, topicName: config.topicName, client: pubsub }) : null,
  subscription,
  close: async () => {
    if (subscription) await subscription.close().catch(() => {});
    await Promise.allSettled([pubsub.close(), firestore.terminate()]);
  },
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await runtime.stop().catch(() => {});
  process.exitCode = 0;
};

await runtime.start();
console.log(`[event-worker] ${config.mode} listening on port ${config.port}`);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

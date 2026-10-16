import { createServer } from 'node:http';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreAuditStore } from './outbox.js';
import { createAuditPushHandler } from './audit-push.js';

const projectId = process.env.FIREBASE_PROJECT_ID || '';
const subscription = process.env.M55_SUBSCRIPTION || '';
const port = Number(process.env.PORT) || 8080;
if (process.env.M55_ENABLED !== 'true' || !projectId || !subscription) throw new Error('M55_AUDIT_PUSH_CONFIGURATION_REQUIRED');

const firestore = new Firestore({ projectId, databaseId: '(default)' });
const expectedSubscription = `projects/${projectId}/subscriptions/${subscription}`;
const server = createServer(createAuditPushHandler({ store: createFirestoreAuditStore(firestore), expectedSubscription }));
server.listen(port, '0.0.0.0', () => console.log(`[audit-push] listening on port ${port}`));

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await firestore.terminate().catch(() => {});
    process.exitCode = 0;
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

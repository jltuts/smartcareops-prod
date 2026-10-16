import { createServer } from 'node:http';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreOperationsProjectionStore } from './operations-projection.js';
import { createOperationsPushHandler } from './operations-push.js';
import { createOperationsEventOrchestrator } from './operations-orchestrator.js';
import { createFirestoreCaseStore } from '../cases/firestore.js';
import { firestoreOperationsStore } from '../operations/storage.js';
import { createOperationsService } from '../operations/service.js';

const projectId = process.env.FIREBASE_PROJECT_ID || '';
const subscription = process.env.M55_SUBSCRIPTION || '';
const port = Number(process.env.PORT) || 8080;
if (process.env.M55_ENABLED !== 'true' || !projectId || !subscription) throw new Error('M55_OPERATIONS_PUSH_CONFIGURATION_REQUIRED');

const firestore = new Firestore({ projectId, databaseId: '(default)' });
const expectedSubscription = `projects/${projectId}/subscriptions/${subscription}`;
const orchestratorEnabled = process.env.M57_AGENTIC_OPERATIONS_ENABLED === 'true';
const reviewedCoordinationEnabled = process.env.M57_REVIEWED_COORDINATION_ENABLED === 'true';
if (orchestratorEnabled && !process.env.GEMINI_API_KEY) throw new Error('M57_OPERATIONS_ORCHESTRATOR_CONFIGURATION_REQUIRED');
if (reviewedCoordinationEnabled && !orchestratorEnabled) throw new Error('M57_REVIEWED_COORDINATION_CONFIGURATION_REQUIRED');
const operationsService = orchestratorEnabled ? createOperationsService({
  store: firestoreOperationsStore(firestore),
  caseStore: createFirestoreCaseStore(firestore),
  notificationsEnabled: reviewedCoordinationEnabled,
}) : null;
const server = createServer(createOperationsPushHandler({
  store: createFirestoreOperationsProjectionStore(firestore), expectedSubscription,
  ...(operationsService ? { onEvent: createOperationsEventOrchestrator(operationsService) } : {}),
}));
server.listen(port, '0.0.0.0', () => console.log(`[operations-push] listening on port ${port}`));

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close(async () => {
    if (operationsService) await operationsService.close().catch(() => {});
    else await firestore.terminate().catch(() => {});
    process.exitCode = 0;
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

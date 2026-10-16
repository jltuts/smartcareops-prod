import { createServer } from 'node:http';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreShadowStore, createShadowPushHandler } from './shadow-push.js';
import { createCaseEventProcessor } from './case-processors.js';
import { createFirestoreCaseStore } from '../cases/firestore.js';
import { firestoreClinicalStore } from '../clinical/storage.js';
import { createClinicalService } from '../clinical/service.js';
import { createFirestoreCaseNoticeStore } from '../notifications/case-notices.js';

const family = process.env.M55_SHADOW_FAMILY || '';
const projectId = process.env.FIREBASE_PROJECT_ID || '';
const subscription = process.env.M55_SUBSCRIPTION || '';
const port = Number(process.env.PORT) || 8080;
if (process.env.M55_ENABLED !== 'true' || !['clinical', 'notifications'].includes(family) || !projectId ||
    subscription !== `smartcareops-${family}-events`) throw new Error('M55_SHADOW_PUSH_CONFIGURATION_REQUIRED');

const firestore = new Firestore({ projectId, databaseId: '(default)' });
const active = process.env.M55_CASE_PROCESSING_ENABLED === 'true';
if (active && family === 'clinical' && !process.env.GEMINI_API_KEY) throw new Error('CLINICAL_MODEL_KEY_REQUIRED');
const caseStore = active ? createFirestoreCaseStore(firestore) : null;
const noticeStore = active && family === 'notifications' ? createFirestoreCaseNoticeStore(firestore) : null;
const onEvent = active ? createCaseEventProcessor({ family,
  getCase: async id => { const snapshot = await firestore.collection('cases').doc(id).get(); return snapshot.exists ? snapshot.data() : null; },
  makeClinical: id => createClinicalService({ caseId: id, caseStore, store: firestoreClinicalStore(firestore), notificationsEnabled: false }),
  recordNotice: notice => noticeStore?.record(notice),
}) : null;
const server = createServer(createShadowPushHandler({ family, store: createFirestoreShadowStore(firestore, family),
  expectedSubscription: `projects/${projectId}/subscriptions/${subscription}`, onEvent }));
server.listen(port, '0.0.0.0', () => console.log(`[shadow-push] ${family} listening`));

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

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { attachLiveRelay } from './live.js';
import { serveHospital } from './agent/portal.js';
import { runHandoff } from './agent/loop.js';
import { createConfiguredCaseStore } from './cases/firestore.js';
import { caseEndpoint } from './cases/http.js';
import { environmentMetadata } from './environment.js';
import { routingEndpoint } from './cases/routing-http.js';
import { dispatcherEndpoint } from './cases/dispatcher-http.js';
import { isEmergencyWorkflow } from '../../shared/emergency.js';
import { CaseStoreError } from './cases/store.js';
import { ambulanceEndpoint } from './ambulance/http.js';
import { configuredClinicalStore } from './clinical/storage.js';
import { createClinicalService } from './clinical/service.js';
import { clinicalEndpoint } from './clinical/http.js';
import { createResourceService } from './resources/service.js';
import { configuredOperationsStore } from './operations/storage.js';
import { createOperationsService } from './operations/service.js';
import { operationsEndpoint } from './operations/http.js';
import { configuredRegionalStore } from './regional/storage.js';
import { createRegionalService } from './regional/service.js';
import { regionalEndpoint } from './regional/http.js';
import { configuredNotificationCenter } from './notifications/service.js';
import { notificationEndpoint } from './notifications/http.js';
import { createHospitalHandoff } from './hospital/service.js';
import { createRestConnector, createComputerUseConnector, demoHospitalEndpoint } from './hospital/connectors.js';
import { validCaseId } from './cases/store.js';
import { startupReadiness, verifyStartupDependencies } from './platform-readiness.js';
import { createAuthentication } from './auth.js';
import { createConfiguredLiveSessionStore, liveSessionEndpoint } from './live-session.js';
import { createConfiguredFinalizationResults, createFinalizationResults } from './finalization-results.js';
import { createConfiguredUserProfileStore } from './user-profiles.js';
import { createConfiguredSimulationStore } from './simulation/store.js';
import { createSimulationService } from './simulation/service.js';
import { simulationEndpoint } from './simulation/http.js';
import { createConfiguredCareTwinStore } from './simulation/caretwin-store.js';
import { createCareTwinService } from './simulation/caretwin-service.js';
import { careTwinEndpoint } from './simulation/caretwin-http.js';
import { createConfiguredPredictiveStore } from './simulation/predictive-store.js';
import { createPredictiveService } from './simulation/predictive-service.js';
import { predictiveEndpoint } from './simulation/predictive-http.js';

try { if (process.env.NODE_ENV !== 'production') loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to load backend/.env'); }

export function createApiServer({ liveOptions = {}, liveSessionOptions = {}, liveSessionStore = createConfiguredLiveSessionStore(), liveSessionEnabled = process.env.LIVE_SESSION_ENABLED === 'true', liveWebSocketUrl = process.env.LIVE_WEBSOCKET_URL, livePublicOnly = process.env.SERVICE_MODE === 'live-transport', agentRun = runHandoff, caseStore = createConfiguredCaseStore(), finalizationResults = caseStore.storage === 'firestore' ? createConfiguredFinalizationResults() : createFinalizationResults(), isReady = () => caseStore.storage !== 'unavailable', authOptions = {}, clinicalService, clinicalEnabled = false, operationsService, operationsEnabled = false, regionalService, regionalEnabled = false, notificationService, notificationsEnabled = false, simulationService, simulationStore, simulationEnabled = process.env.M15_ENABLED === 'true', careTwinService, careTwinStore, careTwinEnabled = process.env.M16_ENABLED === 'true', predictiveService, predictiveStore, predictiveEnabled = process.env.M17_ENABLED === 'true', hospitalConnectors, hospitalTargets } = {}) {
  console.info('[environment]', JSON.stringify(environmentMetadata(caseStore.storage)));
  const readCase = caseEndpoint(caseStore);
  const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173').split(',').map(value => value.trim());
  const liveEnabled = liveSessionEnabled && !!liveSessionStore;
  const userProfileStore = authOptions.userProfileStore || createConfiguredUserProfileStore(authOptions.env || process.env);
  const authentication = createAuthentication({ ...authOptions, userProfileStore, allowedOrigins: origins, liveAvailable: liveEnabled });
  const createLiveSession = liveSessionEndpoint(liveSessionStore, { webSocketUrl: liveWebSocketUrl, allowedOrigins: origins, ...liveSessionOptions });
  const hospitalCredential = randomUUID();
  const hospitalHandoff = createHospitalHandoff({ store: caseStore,
    connectors: hospitalConnectors || { rest: createRestConnector({ endpoint: () => `http://127.0.0.1:${server.address().port}/internal/hospital-demo/cases`, credential: hospitalCredential }),
      computer_use: createComputerUseConnector({ run: agentRun, portalUrl: () => `http://127.0.0.1:${server.address().port}/hospital-demo` }) },
    targets: hospitalTargets || { 'HOSP-001': { connector: process.env.HOSPITAL_HANDOFF_CONNECTOR || 'rest', version: 'fictional-hospital-v1' } } });
  const hospitalApi = demoHospitalEndpoint({ store: caseStore, credential: hospitalCredential });
  const routing = routingEndpoint(caseStore, origins, { resolvePatientIdentity: uid => userProfileStore.getPatientIdentity(uid) });
  const dispatcher = dispatcherEndpoint(caseStore, origins);
  const ambulance = ambulanceEndpoint(caseStore, origins);
  const makeClinical = caseId => createClinicalService({ store: configuredClinicalStore(process.env, { readFleet: () => caseStore.listAmbulances(), readCase: id => caseStore.getCase(id), captureCase: notificationsEnabled }), caseStore, notificationsEnabled, caseId, hospitalHandoff, resources: process.env.M9_ENABLED === 'true' ? createResourceService({ mode: process.env.RESOURCE_MODE || 'simulation', mapsMode: process.env.MAPS_MODE || 'simulation' }) : null });
  const configuredCase = notificationsEnabled ? process.env.M12_CLINICAL_CASE_ID || process.env.M8_CASE_ID : process.env.M8_CASE_ID;
  const clinical = clinicalService || (clinicalEnabled && validCaseId(configuredCase) ? makeClinical(configuredCase) : null);
  const clinicalCases = new Map(clinical ? [[clinical.caseId, clinical]] : []);
  const clinicalHttp = clinicalEndpoint(async id => {
    if (!id) return clinical;
    if (clinicalCases.has(id)) return clinicalCases.get(id);
    if (!clinicalEnabled || !validCaseId(id) || clinicalCases.size >= 16) return null;
    const record = await caseStore.getCase(id);
    if (!record || record.source !== 'smartcareops_demo') return null;
    if (!clinicalCases.has(id)) clinicalCases.set(id, makeClinical(id));
    return clinicalCases.get(id);
  }, origins);
  const operations = operationsService || (operationsEnabled ? createOperationsService({ store: configuredOperationsStore(process.env, caseStore), caseStore, notificationsEnabled }) : null);
  const operationsHttp = operationsEndpoint(operations, origins);
  const regional = regionalService || (regionalEnabled ? createRegionalService({ store: configuredRegionalStore(process.env, caseStore), caseStore, notificationsEnabled }) : null);
  const regionalHttp = regionalEndpoint(regional, origins);
  const notifications = notificationService || (notificationsEnabled ? configuredNotificationCenter(process.env, caseStore, { clinical, operations, regional }) : null);
  const notificationsHttp = notificationEndpoint(notifications, origins);
  const simulationStateStore = simulationStore || ((simulationEnabled || careTwinEnabled || predictiveEnabled) ? createConfiguredSimulationStore(process.env) : null);
  const simulation = simulationService || (simulationEnabled ? createSimulationService(simulationStateStore) : null);
  const simulationHttp = simulationEndpoint(simulation, origins, { enabled: simulationEnabled });
  const careTwin = careTwinService || (careTwinEnabled ? createCareTwinService({ simulationStore: simulationStateStore, store: careTwinStore || createConfiguredCareTwinStore(process.env) }) : null);
  const careTwinHttp = careTwinEndpoint(careTwin, origins, { enabled: careTwinEnabled });
  const predictive = predictiveService || (predictiveEnabled ? createPredictiveService({ simulationStore: simulationStateStore, store: predictiveStore || createConfiguredPredictiveStore(process.env) }) : null);
  const predictiveHttp = predictiveEndpoint(predictive, origins, { enabled: predictiveEnabled });
  let regionalTimer;
  let operationsTimer;
  let clinicalTimer;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (livePublicOnly && !(request.method === 'GET' && ['/health', '/healthz', '/readyz'].includes(pathname))) {
      response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Not found' })); return;
    }
    if (await authentication.handle(request, response)) return;
    if (pathname.startsWith('/api/predictive')) { void predictiveHttp(request, response); return; }
    if (pathname.startsWith('/api/caretwin')) { void careTwinHttp(request, response); return; }
    if (pathname.startsWith('/api/simulation')) { void simulationHttp(request, response); return; }
    if (await createLiveSession(request, response)) return;
    if (new URL(request.url, 'http://localhost').pathname === '/internal/hospital-demo/cases') { void hospitalApi(request, response); return; }
    if (request.url.startsWith('/api/notifications')) { void notificationsHttp(request, response); return; }
    if (request.url.startsWith('/api/regional')) { void regionalHttp(request, response); return; }
    if (request.url.startsWith('/api/operations')) { void operationsHttp(request, response); return; }
    if (request.url.startsWith('/api/clinical')) { void clinicalHttp(request, response); return; }
    if (request.url.startsWith('/api/ambulances') || /^\/api\/cases\/[^/]+\/ambulance/.test(request.url)) { void ambulance(request, response); return; }
    if (request.url.startsWith('/api/dispatcher') || /^\/api\/cases\/[^/]+\/evaluate-emergency/.test(request.url)) { void dispatcher(request, response); return; }
    if (request.url.startsWith('/api/doctor') || /^\/api\/cases\/[^/]+\/route/.test(request.url)) { void routing(request, response); return; }
    if (request.url.startsWith('/api/cases')) { void readCase(request, response); return; }
    if (await live.handleFinalization(request, response)) return;
    if (request.method === 'GET' && pathname === '/hospital-demo') { serveHospital(response); return; }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Readiness uses cached startup checks; health requests never invoke upstreams.
    if (request.method === 'GET' && ['/health', '/healthz', '/readyz'].includes(pathname)) {
      const ready = pathname !== '/readyz' || isReady();
      response.writeHead(ready ? 200 : 503);
      response.end(JSON.stringify({ status: ready ? 'ok' : 'not_ready', service: 'smartcareops-api' }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  server.once('listening', () => {
    if (regional) { regionalTimer = setInterval(() => void regional.tick().catch(() => {}), 2000); regionalTimer.unref(); void regional.tick().catch(() => {}); }
    if (operations) { operationsTimer = setInterval(() => void operations.tick().catch(() => {}), 2000); operationsTimer.unref(); void operations.tick().catch(() => {}); }
    if (clinical || clinicalEnabled) { const tick = () => { for (const service of clinicalCases.values()) void service.tick().catch(() => {}); }; clinicalTimer = setInterval(tick, 2000); clinicalTimer.unref(); tick(); }
  });

  const writes = new Set();
  const persist = (intake, { caseId, patientUid, fictionalConfirmed = false, enrichmentStatus = null }, emergency = false) => {
    const work = caseStore.createCase({ caseId, intake, emergency, patientUid, fictionalConfirmed, submittedForReview: !emergency,
      intakeSource: 'live_intake', enrichmentStatus });
    writes.add(work); void work.finally(() => writes.delete(work)).catch(() => {});
    return work;
  };
  const live = attachLiveRelay(server, { ...liveOptions, origins, finalizationResults,
    allowLiveUpgrade: livePublicOnly ? liveEnabled : !authentication.enabled,
    ...(livePublicOnly && liveEnabled ? { authorizeUpgrade: input => liveSessionStore.consume(input) } : {}),
    onMinimalCompleted: async (intake, context) => {
      const patientCase = await persist(intake, { ...context, enrichmentStatus: 'pending' });
      return { patientCase };
    },
    onEnriched: async (intake, context) => ({ patientCase: await caseStore.updateEnrichment({
      caseId: context.caseId, intake, status: 'succeeded', patientUid: context.patientUid,
    }) }),
    onEnrichmentFailed: async context => ({ patientCase: await caseStore.updateEnrichment({
      caseId: context.caseId, status: 'failed', errorCategory: context.errorCategory, patientUid: context.patientUid,
    }) }),
    onCompleted: async (intake, context) => {
      const patientCase = await persist(intake, context);
      if (isEmergencyWorkflow(patientCase.workflowStatus)) throw new CaseStoreError('EMERGENCY_HANDOFF_BLOCKED', 409);
      // Intake completion creates no execution intent, approval, or connector job.
      return { patientCase };
    },
    onEmergency: (intake, context) => persist(intake, context, true) });
  async function shutdown() {
    await notifications?.close();
    clearInterval(regionalTimer);
    await regional?.close();
    clearInterval(operationsTimer);
    await operations?.close();
    clearInterval(clinicalTimer);
    await Promise.all([...clinicalCases.values()].map(service => service.close()));
    // Termination emits each socket's close event, releasing its relay timers/session.
    const socketsClosed = new Promise(resolve => live.close(resolve));
    for (const client of live.clients) client.terminate();
    const serverClosed = server.listening
      ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      : Promise.resolve();
    await Promise.all([socketsClosed, serverClosed]);
    await Promise.allSettled([...writes]);
    await caseStore.close?.();
    await liveSessionStore?.close?.();
    await authentication.close?.();
    await careTwin?.close?.();
    await predictive?.close?.();
    await simulation?.close?.();
  }
  return { server, shutdown, simulation, careTwin, predictive };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const readiness = process.env.NODE_ENV === 'production' ? startupReadiness(() => verifyStartupDependencies()) : null;
  const { server, shutdown } = createApiServer({ ...(readiness ? { isReady: readiness.isReady } : {}), clinicalEnabled: process.env.M8_ENABLED === 'true', operationsEnabled: process.env.M10_ENABLED === 'true', regionalEnabled: process.env.M11_ENABLED === 'true', notificationsEnabled: process.env.M12_ENABLED === 'true' });
  const port = process.env.PORT || 8080;
  server.listen(port, '0.0.0.0', () => console.log(`SmartCareOps API listening locally on port ${port}`));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

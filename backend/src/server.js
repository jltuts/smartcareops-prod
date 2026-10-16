import { createServer } from 'node:http';
import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { attachLiveRelay } from './live.js';
import { createFacilityCoordinator, FacilityCoordinationError } from './facility-coordination.js';
import { serveHospital } from './agent/portal.js';
import { runHandoff } from './agent/loop.js';
import { createConfiguredCaseStore } from './cases/firestore.js';
import { caseEndpoint } from './cases/http.js';
import { environmentMetadata } from './environment.js';
import { routingEndpoint } from './cases/routing-http.js';
import { dispatcherEndpoint } from './cases/dispatcher-http.js';
import { isEmergencyWorkflow } from '../../shared/emergency.js';
import { CaseStoreError, Workflow } from './cases/store.js';
import { ambulanceEndpoint } from './ambulance/http.js';
import { configuredClinicalStore } from './clinical/storage.js';
import { createClinicalService } from './clinical/service.js';
import { createClinicalModel } from './clinical/model.js';
import { clinicalEndpoint } from './clinical/http.js';
import { createClinicalModelCutover } from './agent-platform/clinical-cutover.js';
import { createConfiguredManagedClinicalModel } from './agent-platform/clinical-managed-client.js';
import { createResourceService } from './resources/service.js';
import { configuredOperationsStore } from './operations/storage.js';
import { createOperationsService } from './operations/service.js';
import { operationsEndpoint } from './operations/http.js';
import { createConfiguredOperationsBoundaryReader } from './events/operations-boundary.js';
import { configuredRegionalStore } from './regional/storage.js';
import { createRegionalService } from './regional/service.js';
import { regionalEndpoint } from './regional/http.js';
import { configuredNotificationCenter } from './notifications/service.js';
import { notificationEndpoint } from './notifications/http.js';
import { createFirestoreCaseNoticeStore } from './notifications/case-notices.js';
import { caseNoticesEndpoint } from './notifications/case-notices-http.js';
import { appointmentEndpoint } from './cases/appointment-http.js';
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
import { createConfiguredPatternStore } from './simulation/pattern-store.js';
import { createPatternService } from './simulation/pattern-service.js';
import { patternEndpoint } from './simulation/pattern-http.js';
import { createMedicineImageAnalyzer } from './medicine/model.js';
import { medicineEndpoint } from './medicine/http.js';
import { adminEndpoint } from './admin/http.js';
import { createConfiguredAdminDataStore } from './admin/data-store.js';
import { createExtractor } from './intake/extractor.js';
import { createConfiguredChatIntakeStore, createMemoryChatIntakeStore } from './chat-intake/store.js';
import { createChatIntakeService } from './chat-intake/service.js';
import { chatIntakeEndpoint } from './chat-intake/http.js';
import { createGeminiLiveTokenProvider } from './live-token.js';
import { createDirectVoiceCompletionService, directVoiceCompletionEndpoint } from './direct-voice-completion.js';
import { createConfiguredLabReportStore } from './lab-reports/storage.js';
import { labReportEndpoint } from './lab-reports/http.js';
import { createLabReportAnalyzer } from './lab-reports/model.js';

try { if (process.env.NODE_ENV !== 'production') loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to load backend/.env'); }

export function createApiServer({ liveOptions = {}, liveSessionOptions = {}, liveSessionStore = createConfiguredLiveSessionStore(), liveSessionEnabled = process.env.LIVE_SESSION_ENABLED === 'true', liveWebSocketUrl = process.env.LIVE_WEBSOCKET_URL, livePublicOnly = process.env.SERVICE_MODE === 'live-transport', agentRun = runHandoff, caseStore = createConfiguredCaseStore(), finalizationResults = caseStore.storage === 'firestore' ? createConfiguredFinalizationResults() : createFinalizationResults(), isReady = () => caseStore.storage !== 'unavailable', authOptions = {}, clinicalService, clinicalEnabled = false, managedClinicalModel, clinicalAgentEnvironment = process.env, operationsService, operationsEnabled = false, regionalService, regionalEnabled = false, notificationService, notificationEnvironment = process.env, notificationsEnabled = false, caseNoticeStore = null, labReportStore: injectedLabReportStore, labReportAnalyzer, simulationService, simulationStore, simulationEnabled = process.env.M15_ENABLED === 'true', careTwinService, careTwinStore, careTwinEnabled = process.env.M16_ENABLED === 'true', predictiveService, predictiveStore, predictiveEnabled = process.env.M17_ENABLED === 'true', patternService, patternStore, patternEnabled = process.env.M18_ENABLED === 'true', medicineAnalyzer, medicineLogger, facilityCoordinator: injectedFacilityCoordinator, hospitalConnectors, hospitalTargets, adminDataStore: injectedAdminDataStore, adminResetControl, chatIntakeStore: injectedChatIntakeStore, chatExtractor } = {}) {
  console.info('[environment]', JSON.stringify(environmentMetadata(caseStore.storage)));
  const readCase = caseEndpoint(caseStore);
  const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173').split(',').map(value => value.trim());
  const liveEnabled = liveSessionEnabled && !!liveSessionStore;
  const userProfileStore = authOptions.userProfileStore || createConfiguredUserProfileStore(authOptions.env || process.env);
  const authentication = createAuthentication({ ...authOptions, userProfileStore, allowedOrigins: origins, liveAvailable: liveEnabled });
  const configuredAdminStore = caseStore.storage === 'firestore' && process.env.CASE_STORE === 'firestore' ? createConfiguredAdminDataStore(process.env) : null;
  const resetControl = adminResetControl || configuredAdminStore;
  const adminDataStore = injectedAdminDataStore || (!livePublicOnly ? configuredAdminStore : null);
  let purgeInProgress = false, liveRelay, activeApiRequests = 0, chatHttp = async () => false, voiceCompletionHttp = async () => false;
  const apiDrainWaiters = [];
  const waitForApiDrain = () => activeApiRequests === 0 ? Promise.resolve() : new Promise(resolve => apiDrainWaiters.push(resolve));
  const writes = new Set(), backgroundWrites = new Set();
  const canWrite = generation => !purgeInProgress && (!resetControl || resetControl.canWrite(generation));
  const assertWriterCurrent = async generation => {
    if (await canWrite(generation)) return;
    const error = new Error('ADMIN_DATA_RESET_IN_PROGRESS'); error.code = 'ADMIN_DATA_RESET_IN_PROGRESS'; throw error;
  };
  const runBackground = operation => {
    if (purgeInProgress) return;
    const work = Promise.resolve().then(async () => { if (await canWrite()) return operation(); }).catch(() => {});
    backgroundWrites.add(work); void work.finally(() => backgroundWrites.delete(work));
  };
  // Each API instance performs one bounded, idempotent staging-orphan pass.
  // Referenced case evidence and all committed objects are always preserved.
  if (!livePublicOnly && typeof caseStore.cleanupPatientEvidence === 'function') runBackground(() => caseStore.cleanupPatientEvidence());
  const runPurge = async ({ adminUid }, operation) => {
    if (purgeInProgress) { const error = new Error('PURGE_ALREADY_RUNNING'); error.code = 'PURGE_ALREADY_RUNNING'; throw error; }
    purgeInProgress = true;
    let controlState, completed = false;
    try {
      controlState = await resetControl?.beginReset({ adminUid });
      liveRelay?.closeIntakes();
      await waitForApiDrain();
      await Promise.allSettled([...backgroundWrites, ...writes]);
      const result = await operation(); completed = result !== null; return result;
    } finally {
      try { if (controlState) await resetControl.finishReset({ purgeId: controlState.purgeId, completed, adminUid }); }
      finally { purgeInProgress = false; }
    }
  };
  const adminHttp = adminEndpoint(userProfileStore, origins, adminDataStore, { runPurge });
  const getResetState = () => resetControl?.getResetState?.() || Promise.resolve({ status: 'idle', generation: 0 });
  const createEphemeralToken = liveSessionOptions.createEphemeralToken || (!livePublicOnly && !liveOptions.connect
    ? createGeminiLiveTokenProvider({ apiKey: liveOptions.apiKey || process.env.GEMINI_API_KEY, model: liveOptions.model || process.env.GEMINI_LIVE_MODEL }) : null);
  const createLiveSession = liveSessionEndpoint(liveSessionStore, { webSocketUrl: liveWebSocketUrl, createEphemeralToken, allowedOrigins: origins, getResetState, ...liveSessionOptions });
  const hospitalCredential = randomUUID();
  const hospitalHandoff = createHospitalHandoff({ store: caseStore,
    connectors: hospitalConnectors || { rest: createRestConnector({ endpoint: () => `http://127.0.0.1:${server.address().port}/internal/hospital-demo/cases`, credential: hospitalCredential }),
      computer_use: createComputerUseConnector({ run: agentRun, portalUrl: () => `http://127.0.0.1:${server.address().port}/hospital-demo` }) },
    targets: hospitalTargets || { 'HOSP-001': { connector: process.env.HOSPITAL_HANDOFF_CONNECTOR || 'rest', version: 'fictional-hospital-v1' } } });
  const hospitalApi = demoHospitalEndpoint({ store: caseStore, credential: hospitalCredential });
  const resolveAvailableSpecialties = async () => {
    try { return await userProfileStore.listVerifiedSpecialties?.() || new Set(); }
    catch { return new Set(); }
  };
  const routing = routingEndpoint(caseStore, origins, { resolvePatientIdentity: uid => userProfileStore.getPatientIdentity(uid), resolveAvailableSpecialties });
  const reportStore = injectedLabReportStore || (!livePublicOnly ? createConfiguredLabReportStore(process.env, { caseStorage: caseStore.storage }) : null);
  const labReports = labReportEndpoint({ caseStore, reportStore, analyze: labReportAnalyzer || createLabReportAnalyzer(), origins, authEnabled: authentication.enabled });
  const dispatcher = dispatcherEndpoint(caseStore, origins);
  const ambulance = ambulanceEndpoint(caseStore, origins);
  const recordM60Telemetry = async event => console.info('[m60-clinical]', JSON.stringify({
    ...(typeof event.mode === 'string' ? { mode: event.mode } : {}),
    ...(typeof event.status === 'string' ? { status: event.status } : {}),
    ...(typeof event.caseId === 'string' ? { caseId: event.caseId } : {}),
    ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
    ...(typeof event.errorCode === 'string' ? { errorCode: event.errorCode } : {}),
  }));
  const selectedClinicalModel = createClinicalModelCutover({ currentModel: createClinicalModel(),
    managedModel: managedClinicalModel || createConfiguredManagedClinicalModel(clinicalAgentEnvironment, { recordTelemetry: recordM60Telemetry }),
    env: clinicalAgentEnvironment, recordTelemetry: recordM60Telemetry });
  const makeClinical = caseId => createClinicalService({ store: configuredClinicalStore(process.env, { readFleet: () => caseStore.listAmbulances(), readCase: id => caseStore.getCase(id), captureCase: notificationsEnabled }), caseStore, notificationsEnabled, caseId, hospitalHandoff, labReportStore: reportStore, model: selectedClinicalModel,
    requireCaseReviewForActions: process.env.M55_CASE_LIFECYCLE_SOURCE_ENABLED === 'true',
    resources: process.env.M9_ENABLED === 'true' ? createResourceService({ mode: process.env.RESOURCE_MODE || 'simulation', mapsMode: process.env.MAPS_MODE || 'simulation' }) : null });
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
  }, origins, { authorizeDoctorCase: (user, id) => caseStore.isDoctorCaseAllowed(id, user.specialties), authEnabled: authentication.enabled });
  const operations = operationsService || (operationsEnabled ? createOperationsService({ store: configuredOperationsStore(process.env, caseStore), caseStore, notificationsEnabled,
    capacityEventsEnabled: process.env.M57_OPERATIONS_CAPACITY_SOURCE_ENABLED === 'true', readDemoBoundary: createConfiguredOperationsBoundaryReader(process.env) }) : null);
  const operationsHttp = operationsEndpoint(operations, origins, caseStore);
  const regional = regionalService || (regionalEnabled ? createRegionalService({ store: configuredRegionalStore(process.env, caseStore), caseStore, notificationsEnabled }) : null);
  const regionalHttp = regionalEndpoint(regional, origins);
  const simulationStateStore = simulationStore || ((simulationEnabled || careTwinEnabled || predictiveEnabled || patternEnabled) ? createConfiguredSimulationStore(process.env) : null);
  const simulation = simulationService || (simulationEnabled ? createSimulationService(simulationStateStore) : null);
  const simulationHttp = simulationEndpoint(simulation, origins, { enabled: simulationEnabled });
  const careTwin = careTwinService || (careTwinEnabled ? createCareTwinService({ simulationStore: simulationStateStore, store: careTwinStore || createConfiguredCareTwinStore(process.env) }) : null);
  const careTwinHttp = careTwinEndpoint(careTwin, origins, { enabled: careTwinEnabled });
  const predictive = predictiveService || (predictiveEnabled ? createPredictiveService({ simulationStore: simulationStateStore, store: predictiveStore || createConfiguredPredictiveStore(process.env) }) : null);
  const predictiveHttp = predictiveEndpoint(predictive, origins, { enabled: predictiveEnabled });
  const patternStateStore = patternStore || (patternEnabled ? createConfiguredPatternStore(process.env) : null);
  const patterns = patternService || (patternEnabled ? createPatternService({ simulationStore: simulationStateStore, store: patternStateStore }) : null);
  const patternHttp = patternEndpoint(patterns, origins, { enabled: patternEnabled });
  const notifications = notificationService || (notificationsEnabled && !livePublicOnly ? configuredNotificationCenter(notificationEnvironment, caseStore, { clinical, operations, regional }, patternStateStore) : null);
  const notificationsHttp = notificationEndpoint(notifications, origins);
  const caseNotices = caseNoticeStore || (process.env.M55_CASE_NOTICES_ENABLED === 'true' && caseStore.storage === 'firestore'
    ? createFirestoreCaseNoticeStore(new Firestore({ projectId: process.env.FIREBASE_PROJECT_ID, databaseId: '(default)' })) : null);
  const caseNoticesHttp = caseNotices ? caseNoticesEndpoint({ store: caseNotices, caseStore }) : null;
  const appointmentHttp = appointmentEndpoint(caseStore, origins);
  const medicineHttp = medicineEndpoint({ sessionStore: liveSessionStore, analyze: medicineAnalyzer || createMedicineImageAnalyzer(), logger: medicineLogger });
  let regionalTimer;
  let operationsTimer;
  let clinicalTimer;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (livePublicOnly && !(request.method === 'GET' && ['/health', '/healthz', '/readyz'].includes(pathname))) {
      response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Not found' })); return;
    }
    if (pathname.startsWith('/api/') && pathname !== '/api/admin/purge') {
      let reset;
      try { reset = await getResetState(); }
      catch { response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ code: 'DATA_RESET_STATE_UNAVAILABLE', message: 'Data writes are temporarily unavailable.' })); return; }
      if (purgeInProgress || reset.status === 'purging') {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30' }); response.end(JSON.stringify({ code: 'PURGE_IN_PROGRESS', message: 'The test-data reset is in progress. Retry shortly.' })); return;
      }
      request.resetGeneration = Number.isSafeInteger(reset.generation) ? reset.generation : 0;
    }
    const trackApi = pathname.startsWith('/api/') && pathname !== '/api/admin/purge';
    if (trackApi) {
      activeApiRequests++;
      response.once('finish', () => { activeApiRequests--; if (activeApiRequests === 0) apiDrainWaiters.splice(0).forEach(resolve => resolve()); });
    }
    if (await authentication.handle(request, response)) return;
    if (pathname.startsWith('/api/admin/')) { void adminHttp(request, response); return; }
    if (pathname.startsWith('/api/patterns')) { void patternHttp(request, response); return; }
    if (pathname.startsWith('/api/predictive')) { void predictiveHttp(request, response); return; }
    if (pathname.startsWith('/api/caretwin')) { void careTwinHttp(request, response); return; }
    if (pathname.startsWith('/api/simulation')) { void simulationHttp(request, response); return; }
    if (await createLiveSession(request, response)) return;
    if (await voiceCompletionHttp(request, response)) return;
    if (await chatHttp(request, response)) return;
    if (await medicineHttp(request, response)) return;
    if (await appointmentHttp(request, response)) return;
    if (caseNoticesHttp && await caseNoticesHttp(request, response)) return;
    if (new URL(request.url, 'http://localhost').pathname === '/internal/hospital-demo/cases') { void hospitalApi(request, response); return; }
    if (request.url.startsWith('/api/notifications')) { void notificationsHttp(request, response); return; }
    if (await labReports(request, response)) return;
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
    if (regional) { regionalTimer = setInterval(() => runBackground(() => regional.tick()), 2000); regionalTimer.unref(); runBackground(() => regional.tick()); }
    if (operations) { operationsTimer = setInterval(() => runBackground(() => operations.tick()), 2000); operationsTimer.unref(); runBackground(() => operations.tick()); }
    if (clinical || clinicalEnabled) { const tick = () => { for (const service of clinicalCases.values()) runBackground(() => service.tick()); }; clinicalTimer = setInterval(tick, 2000); clinicalTimer.unref(); tick(); }
  });

  const persist = (intake, { caseId, patientUid, intakeSessionId, resetGeneration, fictionalConfirmed = false, enrichmentStatus = null, intakeSource = 'live_intake' }, emergency = false) => {
    const context = { intakeSessionId, uid: patientUid, patientCaseId: caseId };
    const work = Promise.resolve().then(() => assertWriterCurrent(resetGeneration)).then(() => Promise.all([
      intakeSessionId && patientUid ? liveSessionStore?.getMedication?.(context) : null,
      intakeSessionId && patientUid ? liveSessionStore?.getMedicineImage?.(context) : null,
      intakeSessionId && patientUid ? liveSessionStore?.getPatientEvidence?.(context) : [],
    ])).then(async ([medication, medicationImage, patientEvidence]) => {
      let patientCase = await caseStore.createCase({ caseId, intake, emergency, patientUid, fictionalConfirmed, submittedForReview: !emergency,
        intakeSource, enrichmentStatus, medication, medicationImage, patientEvidence });
      if (medicationImage) await liveSessionStore?.discardMedicineImage?.(context);
      if (patientEvidence?.length) await liveSessionStore?.discardPatientEvidence?.(context);
      if (!emergency && patientCase.workflowStatus === Workflow.REVIEW && patientCase.enrichmentStatus !== 'pending') {
        try { patientCase = await caseStore.routeCase(caseId, { availableSpecialties: await resolveAvailableSpecialties() }); }
        catch { /* Persisted review remains visible without a fabricated route. */ }
      }
      return patientCase;
    });
    writes.add(work); void work.finally(() => writes.delete(work)).catch(() => {});
    return work;
  };
  const appointmentStore = liveSessionStore?.saveAppointmentRequest && liveSessionStore?.getAppointmentRequest ? {
    get: ({ intakeSessionId, patientUid, caseId }) => liveSessionStore.getAppointmentRequest({ intakeSessionId, uid: patientUid, patientCaseId: caseId }),
    submit: async ({ intakeSessionId, patientUid, caseId, idempotencyKey, selection, resourceVersion }) => {
      const saved = await liveSessionStore.saveAppointmentRequest({ intakeSessionId, uid: patientUid, patientCaseId: caseId, idempotencyKey, selection, resourceVersion });
      if (!saved) throw new FacilityCoordinationError('FACILITY_AUTH_REQUIRED', 403);
      if (saved.conflict) throw new FacilityCoordinationError('APPOINTMENT_CONFLICT');
      return saved;
    },
  } : undefined;
  const facilityCoordinator = injectedFacilityCoordinator || createFacilityCoordinator({ caseStore, ...(appointmentStore ? { appointmentStore } : {}),
    ...(simulationStateStore ? { networkState: () => simulationStateStore.get() } : {}) });
  const chatStore = !livePublicOnly ? (injectedChatIntakeStore || (caseStore.storage === 'memory' ? createMemoryChatIntakeStore() : createConfiguredChatIntakeStore())) : null;
  let resolvedChatExtractor = chatExtractor;
  const extractChat = input => { resolvedChatExtractor ||= createExtractor(process.env.GEMINI_API_KEY); return resolvedChatExtractor(input); };
  const voiceCompletionService = createDirectVoiceCompletionService({ liveSessionStore, caseStore, extract: extractChat, persist });
  voiceCompletionHttp = directVoiceCompletionEndpoint(voiceCompletionService, origins);
  const finishChat = async (intake, context, emergency = false) => {
    const result = await finalizationResults.create({ uid: context.patientUid, caseId: context.caseId });
    try {
      const patientCase = await persist(intake, context, emergency);
      const status = emergency ? 'EMERGENCY_ESCALATED' : 'COMPLETED';
      await result.resolve({ type: emergency ? 'emergency-escalation' : 'intake-complete', status, snapshot: intake, patientCase });
      return { patientCase, finalizationId: result.ticket };
    } catch (error) {
      await result.resolve({ type: 'finalization-error', status: 'FAILED', error: { code: 'CHAT_FINALIZATION_FAILED', stage: 'persistence', provider: 'backend' } });
      throw error;
    }
  };
  const chatService = !livePublicOnly && chatStore ? createChatIntakeService({ store: chatStore, liveSessionStore, extract: extractChat, facilityCoordinator,
    onComplete: (intake, context) => finishChat(intake, context, false), onEmergency: (intake, context) => finishChat(intake, context, true) }) : null;
  chatHttp = chatIntakeEndpoint(chatService, origins);
  const attachAppointment = async (patientCase, context) => {
    const appointmentRequest = await facilityCoordinator.getAppointment?.({ intakeSessionId: context.intakeSessionId, patientUid: context.patientUid });
    return appointmentRequest ? caseStore.saveAppointmentRequest({ caseId: context.caseId, patientUid: context.patientUid, appointmentRequest }) : patientCase;
  };
  const live = liveRelay = attachLiveRelay(server, { ...liveOptions, origins, finalizationResults, medicationStore: liveSessionStore, facilityCoordinator,
    allowLiveUpgrade: livePublicOnly ? liveEnabled : !authentication.enabled,
    ...(livePublicOnly && liveEnabled ? { authorizeUpgrade: async input => {
      if (purgeInProgress) return null;
      const identity = await liveSessionStore.consume(input);
      return identity && await canWrite(identity.resetGeneration) ? identity : null;
    } } : {}),
    onMinimalCompleted: async (intake, context) => {
      const patientCase = await persist(intake, { ...context, enrichmentStatus: 'pending' });
      return { patientCase };
    },
    onEnriched: async (intake, context) => {
      await assertWriterCurrent(context.resetGeneration);
      let patientCase = await caseStore.updateEnrichment({ caseId: context.caseId, intake, status: 'succeeded', patientUid: context.patientUid });
      if (patientCase.workflowStatus === Workflow.REVIEW) {
        try { patientCase = await caseStore.routeCase(context.caseId, { availableSpecialties: await resolveAvailableSpecialties() }); }
        catch { /* Keep the persisted review available with an honest routing-pending state. */ }
      }
      return { patientCase: await attachAppointment(patientCase, context) };
    },
    onEnrichmentFailed: async context => {
      await assertWriterCurrent(context.resetGeneration);
      return { patientCase: await caseStore.updateEnrichment({
      caseId: context.caseId, status: 'failed', errorCategory: context.errorCategory, patientUid: context.patientUid,
    }) };
    },
    onCompleted: async (intake, context) => {
      let patientCase = await persist(intake, context);
      if (isEmergencyWorkflow(patientCase.workflowStatus)) throw new CaseStoreError('EMERGENCY_HANDOFF_BLOCKED', 409);
      patientCase = await attachAppointment(patientCase, context);
      // Intake completion creates no execution intent, approval, or connector job.
      return { patientCase };
    },
    onEmergency: (intake, context) => persist(intake, context, true),
    onSessionEnded: ({ intakeSessionId, patientUid }) => liveSessionStore?.end?.({ intakeSessionId, uid: patientUid }) });
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
    await reportStore?.close?.();
    await liveSessionStore?.close?.();
    await chatService?.close?.();
    await authentication.close?.();
    for (const store of new Set([adminDataStore, resetControl])) await store?.close?.();
    await careTwin?.close?.();
    await predictive?.close?.();
    await patterns?.close?.();
    await simulation?.close?.();
    await facilityCoordinator?.close?.();
  }
  return { server, shutdown, simulation, careTwin, predictive, patterns };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const readiness = process.env.NODE_ENV === 'production' ? startupReadiness(() => verifyStartupDependencies()) : null;
  const { server, shutdown } = createApiServer({ ...(readiness ? { isReady: readiness.isReady } : {}), clinicalEnabled: process.env.M8_ENABLED === 'true', operationsEnabled: process.env.M10_ENABLED === 'true', regionalEnabled: process.env.M11_ENABLED === 'true', notificationsEnabled: process.env.M12_ENABLED === 'true' });
  const port = process.env.PORT || 8080;
  server.listen(port, '0.0.0.0', () => console.log(`SmartCareOps API listening locally on port ${port}`));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

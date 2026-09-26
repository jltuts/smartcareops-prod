// Opt-in real Gemini + DEV Firestore verification. Never resets the M8 workspace.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import '../src/server.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { createClinicalService } from '../src/clinical/service.js';
import { createResourceService } from '../src/resources/service.js';
import { digest } from '../src/clinical/contracts.js';
import { clinicalModel } from '../src/clinical/model.js';

const caseId = process.env.M8_CASE_ID, origin = 'http://127.0.0.1:4179';
const checkpointUrl = new URL('../../.m9-progress.json', import.meta.url);
const evidenceUrl = new URL('../../docs/m9-agent-tools-verification.json', import.meta.url);
let stage = 'preflight', child, vite, browser, checkpoint;
const events = [];
const log = record => { events.push(record); console.log('[m9-verification]', JSON.stringify(record)); };
const hash = value => digest(canonical(value));
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const save = () => writeFile(checkpointUrl, JSON.stringify(checkpoint, null, 2) + '\n');
const waitFor = async check => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('Verification timeout');
};
async function startBackend() {
  child = fork(fileURLToPath(new URL('./m8-verification-worker.js', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, M8_ENABLED: 'true', M9_ENABLED: 'true', RESOURCE_MODE: 'simulation', MAPS_MODE: 'simulation', M8_CASE_ID: caseId, ALLOWED_ORIGINS: origin } });
  const message = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error('Backend exited before startup'); })]);
  return `http://127.0.0.1:${message.port}`;
}
async function stopBackend() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('stop'); await exited; } child = null; }
async function startUi(base) {
  vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4179, strictPort: true, proxy: { '/api/clinical': { target: base }, '/api/doctor': { target: base } } } });
  await vite.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage(); await page.goto(origin + '/doctor'); return page;
}
async function closeUi() { await browser?.close(); browser = null; await vite?.close(); vite = null; }
function snapshotsFor(view, plan) { return view.resourceSnapshots.filter(s => plan.resourceSnapshotIds.includes(s.snapshotId)); }
function verifyResources(view, plan, beds) {
  const snapshots = snapshotsFor(view, plan), names = new Set(snapshots.map(s => s.toolName));
  for (const name of ['get_patient_location_context', 'find_nearby_hospitals', 'get_hospital_capabilities', 'get_hospital_capacity', 'find_available_specialists', 'calculate_ambulance_route']) assert(names.has(name), 'Required investigation missing');
  assert(snapshots.every(s => s.result.source === 'simulation' && s.result.simulation));
  const capacity = snapshots.find(s => s.toolName === 'get_hospital_capacity' && s.result.hospitalId === 'HOSP-001'); assert.equal(capacity?.result.monitoredBedsAvailable, beds);
  const alternative = snapshots.find(s => s.toolName === 'get_hospital_capacity' && s.result.hospitalId === 'HOSP-003'); assert(alternative?.result.monitoredBedsAvailable > 0);
  assert([...plan.observations, ...plan.hypotheses, ...plan.risks].some(item => item.evidenceRefs.some(ref => ref === capacity.snapshotId || ref === capacity.executionId)), 'Capacity evidence must be cited');
  return { revision: plan.version, resourceVersion: capacity.result.resourceVersion, hospitalId: 'HOSP-001', monitoredBedsAvailable: beds, alternativeHospital: 'HOSP-003', alternativeMonitoredBeds: alternative.result.monitoredBedsAvailable, normalizedSnapshots: snapshots.length, capacityEvidenceCited: true };
}
async function main() {
  assert(process.argv.includes('--run')); assert.equal(process.env.APP_ENV, 'development'); assert.notEqual(process.env.NODE_ENV, 'production');
  assert.equal(process.env.CASE_STORE, 'firestore'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107'); assert(!process.env.FIRESTORE_EMULATOR_HOST);
  const store = configuredClinicalStore(), cases = createConfiguredCaseStore();
  try {
    const before = await store.read(caseId), patient = await cases.getCase(caseId); assert.equal(patient?.source, 'smartcareops_demo');
    try { checkpoint = JSON.parse(await readFile(checkpointUrl, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!checkpoint) {
      assert(before.meta && Object.keys(before.plans).length >= 2 && Object.keys(before.receipts).length > 0, 'Existing completed M8 workspace required');
      assert(!before.resourceEnvironment, 'Existing M9 resources require inspection; never reset');
      assert(before.meta.runCount <= 6 && before.meta.modelCalls <= 8, 'Insufficient existing workspace budget');
      assert(!before.meta.active, 'Existing worker must be idle');
      checkpoint = { caseId, baselinePlans: Object.fromEntries(Object.entries(before.plans).map(([id, plan]) => [id, hash(plan)])), receiptsHash: hash(before.receipts), originalCaseHash: hash(patient), fleetHash: hash(await cases.listAmbulances()),
        firstVersion: Object.keys(before.plans).length + 1, observation: { requestId: 'm9-dev-deterioration', observations: [
          { type: 'spo2', value: 86, unit: '%', source: 'fictional_device', observedAt: new Date().toISOString(), status: 'reported', correctionOf: null },
          { type: 'symptom_update', value: 'Fictional follow-up: shortness of breath has increased since the previous observations.', unit: '', source: 'fictional_patient', observedAt: new Date().toISOString(), status: 'reported', correctionOf: null },
        ] } };
      await save();
    }
    assert.equal(checkpoint.caseId, caseId);
    for (const [id, expected] of Object.entries(checkpoint.baselinePlans)) assert.equal(hash(before.plans[id]), expected);
    assert.equal(hash(before.receipts), checkpoint.receiptsHash);
    const service = createClinicalService({ store, caseStore: cases, caseId, resources: createResourceService() });
    await service.append(checkpoint.observation); // Stable request ID: recovery does not append twice.
    if (process.argv.includes('--resume-schema-fix')) await service.requestRun('m9-schema-fix');
    if (process.argv.includes('--resume-token-fix')) await service.requestRun('m9-token-fix');
    log({ stage, existingM8PlansPreserved: true, existingReceiptPreserved: true, newObservationPersistedBeforeWorker: true, firstM9Revision: checkpoint.firstVersion });
  } finally { await store.close(); await cases.close(); }

  let base = await startBackend();
  const read = async () => { const response = await fetch(base + '/api/clinical'); assert.equal(response.status, 200); return response.json(); };
  const post = (path, input) => fetch(base + '/api/clinical' + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const waitPlan = version => waitFor(async () => {
    const view = await read(), plan = view.plans.find(p => p.version === version);
    if (plan) return { view, plan };
    const latest = view.runs.filter(r => r.inputVersions.observations === view.meta.observationVersion).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
    assert(latest?.status !== 'failed' || view.events.some(e => ['pending', 'processing'].includes(e.status)), 'Model run failed; inspect safe run status before explicit retry');
    return null;
  });
  stage = 'real_gemini_resource_plan_v1';
  const first = await waitPlan(checkpoint.firstVersion); const firstFacts = verifyResources(first.view, first.plan, 2);
  const oldApproval = first.view.approvals.find(a => a.revisionId === first.plan.revisionId); assert(oldApproval, 'Deterioration plan should require demo clinician review');
  checkpoint.staleApprovalId = oldApproval.approvalId;
  const planStore = configuredClinicalStore(); try { checkpoint.firstPlanHash ||= hash((await planStore.read(caseId)).plans[first.plan.revisionId]); } finally { await planStore.close(); }
  await save(); log({ stage, ...firstFacts, approvalRequired: true });
  let page = await startUi(base); await page.getByRole('heading', { name: 'Operational resources · Simulation' }).waitFor();
  await page.locator(`[data-revision="${first.plan.version}"]`).getByText(/^Monitored beds: 2 ·/).waitFor();
  await page.locator(`[data-revision="${first.plan.version}"]`).getByText(/ · ETA /).first().waitFor();
  await page.screenshot({ path: '.m9-doctor-v1.png', fullPage: true });
  log({ stage: 'doctor_resource_ui_v1', succeeded: true, simulationLabels: true, distanceAndEta: true });
  await closeUi(); await stopBackend();

  stage = 'capacity_update_before_new_process';
  const changeStore = configuredClinicalStore(), changeCases = createConfiguredCaseStore();
  try {
    const service = createClinicalService({ store: changeStore, caseStore: changeCases, caseId, resources: createResourceService() });
    const input = { requestId: 'm9-dev-capacity', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 1 };
    await service.changeCapacity(input); await service.changeCapacity(input);
    await assert.rejects(service.decide(checkpoint.staleApprovalId, 'approved'), { code: 'STALE_APPROVAL' });
    await assert.rejects(service.execute(checkpoint.staleApprovalId), { code: 'STALE_APPROVAL' });
    const pending = await service.view(); assert.equal(pending.resourceEnvironment.version, 2); assert.equal(pending.meta.ready, false);
    log({ stage, hospitalId: 'HOSP-001', before: 2, after: 0, resourceVersion: 'm9-demo:2', eventDurable: true, duplicateUpdateDidNotIncrement: true, staleApprovalRejected: true, staleExecutionBlocked: true });
  } finally { await changeStore.close(); await changeCases.close(); }
  base = await startBackend(); stage = 'real_gemini_resource_plan_v2';
  const second = await waitPlan(checkpoint.firstVersion + 1); const secondFacts = verifyResources(second.view, second.plan, 0);
  assert(JSON.stringify([second.plan.observations, second.plan.changeSummary, second.plan.hypotheses, second.plan.recommendedActions]).includes('HOSP-003'), 'Alternative should be evaluated in the plan');
  for (const approval of second.view.approvals.filter(a => a.status === 'pending')) assert.equal((await post(`/approvals/${approval.approvalId}`, { decision: 'rejected' })).status, 200);
  assert.equal((await post('/observations', checkpoint.observation)).status, 200);
  assert.equal((await post('/resources/capacity', { requestId: 'm9-dev-capacity', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 1 })).status, 200);
  page = await startUi(base); await page.getByRole('heading', { name: `PLAN UPDATED · Revision ${second.plan.version} · current` }).waitFor();
  await page.getByRole('heading', { name: `Revision ${first.plan.version} · superseded` }).waitFor();
  await page.locator(`[data-revision="${second.plan.version}"]`).getByText(/^Monitored beds: 0 ·/).waitFor();
  await page.screenshot({ path: '.m9-doctor-v2.png', fullPage: true });
  log({ stage, ...secondFacts, alternativeEvaluated: true, doctorUi: true, pendingNewActionsRejected: true });
  await closeUi(); await stopBackend();

  stage = 'fresh_client_durable_readback';
  const freshStore = configuredClinicalStore(), freshCases = createConfiguredCaseStore();
  try {
    const durable = await freshStore.read(caseId);
    for (const [id, expected] of Object.entries(checkpoint.baselinePlans)) assert.equal(hash(durable.plans[id]), expected);
    assert.equal(hash(durable.plans[first.plan.revisionId]), checkpoint.firstPlanHash);
    assert.equal(hash(durable.receipts), checkpoint.receiptsHash);
    assert.equal(hash(await freshCases.getCase(caseId)), checkpoint.originalCaseHash);
    assert.equal(hash(await freshCases.listAmbulances()), checkpoint.fleetHash);
    assert.equal(Object.keys(durable.plans).length, checkpoint.firstVersion + 1);
    assert.equal(durable.events.resource_m9_dev_capacity?.status ?? durable.events['resource_m9-dev-capacity']?.status, 'completed');
    assert.equal(durable.resourceEnvironment.version, 2);
    log({ stage, succeeded: true, separateBackendProcesses: 2, originalM8PlansUnchanged: true, m9FirstPlanImmutable: true, originalCaseUnchanged: true, fleetUnchanged: true, receiptsUnchanged: true, receiptCount: Object.keys(durable.receipts).length, duplicateExecution: false, resourceEventCompleted: true });
  } finally { await freshStore.close(); await freshCases.close(); }
  await writeFile(evidenceUrl, JSON.stringify({ verifiedAt: new Date().toISOString(), succeeded: true, environment: 'development', projectId: process.env.FIREBASE_PROJECT_ID, database: '(default)', caseId, model: clinicalModel(), simulation: true, events }, null, 2) + '\n');
}
try { await main(); }
catch { log({ stage, succeeded: false, message: 'Verification stopped; existing durable state preserved. Inspect before resuming; never reset or retry model effects blindly.' }); process.exitCode = 1; }
finally { await closeUi(); await stopBackend(); }

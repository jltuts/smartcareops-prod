// Opt-in real DEV scenario using explicit fictional aggregate data only.
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
import { configuredOperationsStore } from '../src/operations/storage.js';
import { configuredRegionalStore } from '../src/regional/storage.js';
import { createRegionalService } from '../src/regional/service.js';
import { publishHospitalPressure } from '../src/operations/pressure.js';
import { digest } from '../src/clinical/contracts.js';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
const history = state => ({ plans: state.plans, observations: state.observations, receipts: state.receipts, executions: state.toolExecutions, snapshots: state.snapshots || {}, resourceSnapshots: state.resourceSnapshots });
const checkpointUrl = new URL('../../.m11-progress.json', import.meta.url), evidenceUrl = new URL('../../docs/m11-outbreak-intelligence-verification.json', import.meta.url);
const origin = 'http://127.0.0.1:4181'; let child, vite, browser, checkpoint, stage = 'preflight';
const save = () => writeFile(checkpointUrl, JSON.stringify(checkpoint, null, 2) + '\n');
const log = value => console.log('[m11-verification]', JSON.stringify({ stage, ...value }));
async function startBackend(readOnly = false) {
  child = fork(fileURLToPath(new URL('./m11-verification-worker.js', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, M11_ENABLED: 'true', M11_READ_ONLY: String(readOnly), M10_ENABLED: 'false', M8_ENABLED: 'false', ALLOWED_ORIGINS: origin } });
  const value = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error('Backend startup failed'); })]); return `http://127.0.0.1:${value.port}`;
}
async function stopBackend() { if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.send('stop'); await stopped; } child = null; }
async function closeUi() { await browser?.close(); browser = null; await vite?.close(); vite = null; }
async function ui(base) {
  vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4181, strictPort: true, proxy: { '/api/regional': { target: base }, '/api/operations': { target: base } } } });
  await vite.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage(); await page.goto(origin + '/command-center'); return page;
}
async function waitForPlan(base, minimum) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const response = await fetch(base + '/api/regional'); assert(response.ok); const view = await response.json();
    if (view.meta.ready && view.plans.length >= minimum) return view;
    if (view.meta.lastError) { log({ safeError: view.meta.lastError.code }); throw new Error('Regional model failed'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  } throw new Error('Regional plan timeout');
}
async function main() {
  assert(process.argv.includes('--run')); assert.equal(process.env.APP_ENV, 'development'); assert.notEqual(process.env.NODE_ENV, 'production');
  assert.equal(process.env.CASE_STORE, 'firestore'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107'); assert(!process.env.FIRESTORE_EMULATOR_HOST);
  const cases = createConfiguredCaseStore(), clinical = configuredClinicalStore(), hospital = configuredOperationsStore(process.env, cases), store = configuredRegionalStore(process.env, cases), service = createRegionalService({ store, caseStore: cases });
  try {
    const oldClinical = await clinical.read(process.env.M8_CASE_ID), oldHospital = await hospital.read('OPS-HOSP-001');
    try { checkpoint = JSON.parse(await readFile(checkpointUrl, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!checkpoint) {
      assert.equal((await store.read('REGION-DEMO-001')).meta, null, 'Existing regional workspace requires inspection; never reset');
      assert.equal(oldHospital.meta.currentRevisionId, 'OPS-PLAN-3'); assert.equal(oldHospital.resourceEnvironment.hospitals.find(h => h.hospitalId === 'HOSP-003').capacity.monitoredBedsAvailable, 1);
      checkpoint = { clinicalHash: hash(history(oldClinical)), hospitalHash: hash(history(oldHospital)), fleetHash: hash(await cases.listAmbulances()),
        windowEnd: new Date().toISOString(), baselineResourceVersion: oldHospital.resourceEnvironment.version }; await save();
    }
    assert.equal(hash(history(oldClinical)), checkpoint.clinicalHash); assert.equal(hash(history(oldHospital)), checkpoint.hospitalHash);
    assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
    stage = 'hospital_handoff_and_regional_seed'; const signal = await publishHospitalPressure(hospital); assert(signal); checkpoint.hospitalSignal = signal.eventId;
    await service.seed({ requestId: 'm11-demo', windowEnd: checkpoint.windowEnd }); await save();
    if (process.argv.includes('--retry-model')) await service.requestRun('m11-explicit-model-retry');
    if (!checkpoint.plan1) {
      stage = 'regional_plan_v1'; const base = await startBackend(), first = await waitForPlan(base, 1), plan = first.plans.at(-1);
      assert.equal(first.currentSnapshot.aggregate.respiratoryCases, 7); assert.equal(first.currentSnapshot.aggregate.previousWindowRespiratoryCases, 3); assert.equal(first.currentSnapshot.aggregate.hospitalsAffected, 3);
      assert.equal(first.currentSnapshot.aggregate.zeroMonitoredHospitals, 1); assert.equal(first.resourceEvidence.length, 10); assert.equal(plan.assessment.signal, 'Possible emerging respiratory cluster');
      assert(first.events.some(item => item.type === 'regional.hospital_signal.received')); assert(first.approvals.filter(item => item.status === 'pending').length >= 2);
      const page = await ui(base); await page.getByRole('heading', { name: `Regional plan ${plan.revisionId}`, exact: true }).waitFor();
      await page.getByRole('button', { name: 'Approve regional simulation' }).first().click(); await page.locator('#regional-workspace').getByText('fictional_rehearsal_recorded', { exact: false }).first().waitFor({ timeout: 30000 });
      await page.screenshot({ path: fileURLToPath(new URL('../../.m11-plan-v1.png', import.meta.url)), fullPage: true }); await closeUi(); await stopBackend();
      const confirmed = await service.view(); checkpoint.plan1 = plan.revisionId; checkpoint.plan1Hash = hash(plan); checkpoint.receipts = Object.fromEntries(confirmed.receipts.map(item => [item.receiptId, hash(item)]));
      checkpoint.staleApprovalId = confirmed.approvals.find(item => item.status === 'pending').approvalId; await save(); log({ revision: checkpoint.plan1, signal: plan.assessment.signal, uiApproval: true });
    }
    stage = 'regional_change'; const before = await service.view(), oldApproval = before.approvals.find(item => item.approvalId === checkpoint.staleApprovalId);
    if (oldApproval.status === 'pending') await service.decide(oldApproval.approvalId, 'approved');
    await service.changeCapacity({ requestId: 'm11-hosp003-zero', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: checkpoint.baselineResourceVersion });
    await assert.rejects(service.decide(oldApproval.approvalId, 'approved')); await assert.rejects(service.execute(oldApproval.planRevisionId, oldApproval.actionId)); log({ hospitalId: 'HOSP-003', monitoredBeds: '1 -> 0', staleApprovalBlocked: true });
    stage = 'regional_plan_v2_fresh_process'; const base = await startBackend(), second = await waitForPlan(base, 2), plan2 = second.plans.at(-1);
    assert.equal(second.currentSnapshot.aggregate.zeroMonitoredHospitals, 2); assert.equal(hash(second.plans.find(item => item.revisionId === checkpoint.plan1)), checkpoint.plan1Hash);
    assert.equal(second.events.find(item => item.eventId === 'capacity_m11-hosp003-zero').status, 'completed');
    for (const [id, expected] of Object.entries(checkpoint.receipts)) assert.equal(hash(second.receipts.find(item => item.receiptId === id)), expected);
    const overflow = plan2.assessment.supportingEvidence.find(item => item.kind === 'overflow_options'); assert(overflow.summary.includes('HOSP-002')); assert(!overflow.summary.includes('HOSP-003'));
    assert.equal(plan2.assessment.signal, 'Possible emerging respiratory cluster');
    const page = await ui(base); await page.getByRole('heading', { name: `Regional plan ${plan2.revisionId}`, exact: true }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL('../../.m11-plan-v2.png', import.meta.url)), fullPage: true }); await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); await page.screenshot({ path: fileURLToPath(new URL('../../.m11-mobile.png', import.meta.url)), fullPage: true });
    await closeUi(); await stopBackend(); checkpoint.plan2 = plan2.revisionId; checkpoint.plan2Hash = hash(plan2); await save();
    stage = 'fresh_client_readback'; const durable = await store.read('REGION-DEMO-001'), durableHash = hash({ plans: durable.plans, receipts: durable.receipts, resources: durable.resourceSnapshots });
    for (const receipt of Object.values(durable.receipts)) await service.execute(receipt.planRevisionId, receipt.actionId);
    for (let i = 0; i < 2; i++) { const freshCases = createConfiguredCaseStore(), fresh = configuredRegionalStore(process.env, freshCases);
      try { const state = await fresh.read('REGION-DEMO-001'); assert.equal(hash({ plans: state.plans, receipts: state.receipts, resources: state.resourceSnapshots }), durableHash);
        assert(Object.values(state.toolExecutions).every(item => item.attempt === 1)); assert.equal(state.meta.lease, null); }
      finally { await fresh.close(); await freshCases.close(); }
    }
    assert.equal(hash(history(await clinical.read(process.env.M8_CASE_ID))), checkpoint.clinicalHash); assert.equal(hash(history(await hospital.read('OPS-HOSP-001'))), checkpoint.hospitalHash); assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
    const evidence = { milestone: 'M11', scope: 'fictional/demo', status: 'PASS', verifiedAt: new Date().toISOString(), project: process.env.FIREBASE_PROJECT_ID, workspaceId: 'REGION-DEMO-001', hospitals: ['HOSP-001', 'HOSP-002', 'HOSP-003'],
      model: 'gemini-3.6-flash', windowHours: 18, windowEnd: checkpoint.windowEnd, windowMethod: durable.snapshots[`REG-SNAPSHOT-${durable.meta.snapshotVersion}`].windowMethod,
      planV1: { revisionId: checkpoint.plan1, respiratoryCensus: 7, previousRespiratoryCensus: 3, hospitalsAffected: 3, zeroMonitoredHospitals: 1, uiApproval: true },
      trigger: { hospitalId: 'HOSP-003', monitoredBedsBefore: 1, monitoredBedsAfter: 0, durableEventProcessed: true },
      planV2: { revisionId: checkpoint.plan2, zeroMonitoredHospitals: 2, overflowOptions: ['HOSP-002'], signal: plan2.assessment.signal },
      safeLanguage: 'backend-rendered controlled evidence statements; no unrestricted model prose', hospitalSignalConsumed: checkpoint.hospitalSignal, immutableV1: true, staleApprovalBlocked: true,
      completedReceiptsPreserved: true, duplicateExecutionPrevented: true, receiptCount: Object.keys(durable.receipts).length, resourceEvidenceCount: Object.keys(durable.resourceSnapshots).length,
      freshBackendProcesses: 2, freshFirestoreClients: 2, ui: { desktop: true, mobile: true, noHorizontalOverflow: true }, clinicalHistoryPreserved: true, hospitalHistoryPreserved: true, fleetPreserved: true,
      runCount: durable.meta.runCount, modelCalls: durable.meta.modelCalls, catalogVersion: durable.resourceEnvironment.resourceVersion, m12: 'NOT STARTED' };
    await writeFile(evidenceUrl, JSON.stringify(evidence, null, 2) + '\n'); log({ status: 'PASS', planV1: checkpoint.plan1, planV2: checkpoint.plan2, receipts: evidence.receiptCount });
  } finally { await closeUi(); await stopBackend(); await service.close(); await cases.close(); await clinical.close(); await hospital.close(); }
}
main().catch(() => { log({ status: 'FAIL', safeMessage: 'Verification stopped. Inspect safe persisted evidence and checkpoint before retry.' }); process.exitCode = 1; });

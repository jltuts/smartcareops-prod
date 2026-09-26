// Explicit --run only. Four fictional fixtures; no real patients or external effects.
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
import { createOperationsService } from '../src/operations/service.js';
import { digest } from '../src/clinical/contracts.js';
import { routingIntake } from '../tests/routing-fixtures.js';
import { emergencyIntake } from '../tests/safety-fixtures.js';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
const checkpointUrl = new URL('../../.m10-progress.json', import.meta.url), evidenceUrl = new URL('../../docs/m10-hospital-operations-verification.json', import.meta.url);
const origin = 'http://127.0.0.1:4180'; let child, vite, browser, checkpoint, stage = 'preflight';
const save = () => writeFile(checkpointUrl, JSON.stringify(checkpoint, null, 2) + '\n');
const log = detail => console.log('[m10-verification]', JSON.stringify({ stage, ...detail }));
async function startBackend() {
  child = fork(fileURLToPath(new URL('./m10-verification-worker.js', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, M10_ENABLED: 'true', M8_ENABLED: 'false', ALLOWED_ORIGINS: origin } });
  const message = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error('Backend startup failed'); })]);
  return `http://127.0.0.1:${message.port}`;
}
async function stopBackend() { if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.send('stop'); await stopped; } child = null; }
async function closeUi() { await browser?.close(); browser = null; await vite?.close(); vite = null; }
async function ui(base) {
  vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4180, strictPort: true, proxy: { '/api/operations': { target: base } } } });
  await vite.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage(); await page.goto(origin + '/command-center'); return page;
}
async function waitForPlan(base, minimum) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const response = await fetch(base + '/api/operations'); assert(response.ok); const view = await response.json();
    if (view.meta.ready && view.plans.length >= minimum) return view;
    if (view.meta.lastError) { log({ safeError: view.meta.lastError.code }); throw new Error('Hospital model run failed'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Plan verification timed out');
}
const clinicalHistory = state => ({ plans: state.plans, receipts: state.receipts, observations: state.observations, toolExecutions: state.toolExecutions });
async function main() {
  assert(process.argv.includes('--run')); assert.equal(process.env.APP_ENV, 'development'); assert.notEqual(process.env.NODE_ENV, 'production');
  assert.equal(process.env.CASE_STORE, 'firestore'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107'); assert(!process.env.FIRESTORE_EMULATOR_HOST);
  const cases = createConfiguredCaseStore(), clinical = configuredClinicalStore(), store = configuredOperationsStore(process.env, cases), service = createOperationsService({ store, caseStore: cases });
  try {
    const oldClinical = await clinical.read(process.env.M8_CASE_ID);
    try { checkpoint = JSON.parse(await readFile(checkpointUrl, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!checkpoint) {
      assert.equal((await store.read('OPS-HOSP-001')).meta, null, 'Existing operations workspace requires inspection; never reset');
      checkpoint = { clinicalHash: hash(clinicalHistory(oldClinical)), fleetHash: hash(await cases.listAmbulances()), baselineResourceVersion: oldClinical.resourceEnvironment.version,
        caseIds: ['SC-10000000-0000-4000-8000-000000000001', 'SC-10000000-0000-4000-8000-000000000002', 'SC-10000000-0000-4000-8000-000000000003', 'SC-10000000-0000-4000-8000-000000000004'] }; await save();
    }
    assert.equal(hash(clinicalHistory(oldClinical)), checkpoint.clinicalHash); assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
    stage = 'seed_four_fictional_cases';
    const intakes = [routingIntake([['wheezing', 'confirmed'], ['shortness of breath', 'confirmed']]), routingIntake([['cough', 'confirmed']]), emergencyIntake('severe difficulty breathing'), routingIntake()];
    for (const [index, caseId] of checkpoint.caseIds.entries()) { await cases.createCase({ caseId, intake: intakes[index] }); await service.enroll({ caseId, status: index === 2 ? 'incoming' : 'active' }); }
    if (!checkpoint.plan1) await service.changeCapacity({ requestId: 'm10-baseline', hospitalId: 'HOSP-001', monitoredBedsAvailable: 1, expectedVersion: checkpoint.baselineResourceVersion });
    if (process.argv.includes('--retry-model')) await service.requestRun('m10-explicit-model-retry');
    if (!checkpoint.plan1) {
      stage = 'plan_v1'; const base = await startBackend(), first = await waitForPlan(base, 1), plan = first.plans.at(-1);
      assert.equal(first.currentSnapshot.capacity.monitoredBedsAvailable, 1); assert.deepEqual(first.currentSnapshot.counts, { active: 4, emergency: 1, respiratory: 3, incoming: 1 });
      assert(first.resourceEvidence.some(item => item.result.hospitalId === 'HOSP-003')); assert(first.approvals.filter(item => item.status === 'pending').length >= 2, 'Two rehearsal proposals required to demonstrate completed and stale actions');
      const page = await ui(base); await page.getByRole('heading', { name: `Current plan ${plan.revisionId}`, exact: true }).waitFor();
      await page.getByRole('button', { name: 'Approve simulation' }).first().click();
      await page.getByText('fictional_rehearsal_recorded', { exact: false }).first().waitFor({ timeout: 30000 });
      await page.screenshot({ path: fileURLToPath(new URL('../../.m10-plan-v1.png', import.meta.url)), fullPage: true });
      await closeUi(); await stopBackend();
      const confirmed = await service.view(); checkpoint.plan1 = plan.revisionId; checkpoint.plan1Hash = hash(confirmed.plans.find(item => item.revisionId === checkpoint.plan1));
      checkpoint.receipts = Object.fromEntries(confirmed.receipts.map(item => [item.receiptId, hash(item)])); checkpoint.staleApprovalId = confirmed.approvals.find(item => item.status === 'pending').approvalId;
      checkpoint.v1 = { revisionId: plan.revisionId, status: plan.assessment.status, counts: first.currentSnapshot.counts, monitoredBeds: 1, resourceVersion: first.currentSnapshot.resourceVersion,
        approvedSimulation: true, ui: true, model: process.env.GEMINI_CLINICAL_MODEL || 'gemini-3.6-flash' }; await save(); log(checkpoint.v1);
    }
    stage = 'capacity_change';
    const beforeChange = await service.view(), oldApproval = beforeChange.approvals.find(item => item.approvalId === checkpoint.staleApprovalId);
    if (oldApproval.status === 'pending') await service.decide(oldApproval.approvalId, 'approved');
    const v1 = beforeChange.plans.find(item => item.revisionId === checkpoint.plan1);
    await service.changeCapacity({ requestId: 'm10-zero', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: Number(v1.resourceVersion.split(':')[1]) });
    await assert.rejects(service.decide(checkpoint.staleApprovalId, 'approved'), { code: 'OPERATIONS_STALE_APPROVAL' });
    await assert.rejects(service.execute(checkpoint.plan1, oldApproval.actionId), { code: 'OPERATIONS_STALE_ACTION' });
    log({ monitoredBeds: '1 -> 0', staleApprovalBlocked: true });
    stage = 'plan_v2_fresh_backend'; const base = await startBackend(), second = await waitForPlan(base, 2), plan2 = second.plans.at(-1);
    assert.equal(second.currentSnapshot.capacity.monitoredBedsAvailable, 0); assert.equal(hash(second.plans.find(item => item.revisionId === checkpoint.plan1)), checkpoint.plan1Hash);
    for (const [receiptId, expected] of Object.entries(checkpoint.receipts)) assert.equal(hash(second.receipts.find(item => item.receiptId === receiptId)), expected);
    const evidence = second.resourceEvidence.filter(item => plan2.evidenceRefs.includes(item.evidenceId));
    assert(evidence.some(item => item.result.hospitalId === 'HOSP-003' && item.result.monitoredBedsAvailable > 0));
    assert.equal(second.events.find(item => item.eventId === 'capacity_m10-zero').status, 'completed');
    assert.equal(second.approvals.find(item => item.approvalId === checkpoint.staleApprovalId).status, 'superseded');
    const page = await ui(base); await page.getByRole('heading', { name: `Current plan ${plan2.revisionId}`, exact: true }).waitFor();
    await page.getByText(`${checkpoint.plan1} · Snapshot`, { exact: false }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL('../../.m10-plan-v2.png', import.meta.url)), fullPage: true });
    await closeUi(); await stopBackend();
    checkpoint.plan2 = plan2.revisionId; checkpoint.plan2Hash = hash(plan2); await save();
    stage = 'fresh_client_durability'; let durable;
    for (let index = 0; index < 2; index++) {
      const freshCases = createConfiguredCaseStore(), freshStore = configuredOperationsStore(process.env, freshCases), freshService = createOperationsService({ store: freshStore, caseStore: freshCases });
      try {
        await freshService.tick(); const state = await freshStore.read('OPS-HOSP-001');
        assert.equal(hash(state.plans[checkpoint.plan1]), checkpoint.plan1Hash); assert.equal(hash(state.plans[checkpoint.plan2]), checkpoint.plan2Hash);
        const next = hash({ plans: state.plans, receipts: state.receipts, evidence: state.resourceSnapshots }); if (durable) assert.equal(next, durable); durable = next;
        assert(Object.values(state.toolExecutions).every(item => item.attempt === 1));
      } finally { await freshService.close(); await freshCases.close(); }
    }
    assert.equal(hash(clinicalHistory(await clinical.read(process.env.M8_CASE_ID))), checkpoint.clinicalHash); assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
    const result = { milestone: 'M10', scope: 'fictional/demo', status: 'PASS', verifiedAt: new Date().toISOString(), project: process.env.FIREBASE_PROJECT_ID, workspaceId: 'OPS-HOSP-001',
      planV1: checkpoint.v1, capacityChange: { before: 1, after: 0, durableEventProcessed: true },
      planV2: { revisionId: plan2.revisionId, status: plan2.assessment.status, resourceVersion: plan2.resourceVersion, alternatives: ['HOSP-003'], ui: true },
      freshBackendProcess: true, freshFirestoreClients: 2, immutableV1: true, staleApprovalBlocked: true, completedReceiptsPreserved: true, duplicateExecutionPrevented: true,
      clinicalHistoryPreserved: true, ambulanceFleetPreserved: true, noRealOperations: true, m11: 'NOT STARTED' };
    await writeFile(evidenceUrl, JSON.stringify(result, null, 2) + '\n'); log({ result: 'PASS' });
  } finally { await closeUi(); await stopBackend(); await service.close(); await cases.close(); await clinical.close(); }
}
main().catch(async () => { log({ result: 'FAIL', message: 'Verification stopped; inspect safe persisted state and checkpoint before retry.' }); process.exitCode = 1; });

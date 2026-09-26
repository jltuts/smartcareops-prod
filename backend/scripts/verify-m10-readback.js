// --run reads existing fictional evidence. Optional explicit --refine-alternative
// appends one bounded Gemini reassessment; it never resets an existing workspace.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import '../src/server.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { configuredOperationsStore } from '../src/operations/storage.js';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { createOperationsService } from '../src/operations/service.js';
import { digest } from '../src/clinical/contracts.js';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
const checkpointUrl = new URL('../../.m10-progress.json', import.meta.url), evidenceUrl = new URL('../../docs/m10-hospital-operations-verification.json', import.meta.url);
let child, browser, vite;
async function main() {
  assert(process.argv.includes('--run') && process.env.APP_ENV === 'development' && process.env.CASE_STORE === 'firestore' && process.env.NODE_ENV !== 'production');
  assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107');
  const checkpoint = JSON.parse(await readFile(checkpointUrl, 'utf8')), evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
  const cases = createConfiguredCaseStore(), store = configuredOperationsStore(process.env, cases), service = createOperationsService({ store, caseStore: cases }), clinical = configuredClinicalStore();
  try {
    const before = await store.read('OPS-HOSP-001'), previousHashes = Object.fromEntries(Object.entries(before.plans).map(([id, plan]) => [id, hash(plan)])), receiptHashes = Object.fromEntries(Object.entries(before.receipts).map(([id, value]) => [id, hash(value)]));
    if (process.argv.includes('--refine-alternative') && !checkpoint.alternativeRefined) {
      await service.requestRun('m10-alternative-evidence-refinement'); await service.tick();
      const after = await store.read('OPS-HOSP-001'); assert.equal(after.meta.ready, true, 'Refined model assessment unavailable');
      assert(Object.keys(after.plans).length > Object.keys(before.plans).length);
      checkpoint.intermediatePlan = checkpoint.plan2; checkpoint.plan2 = after.meta.currentRevisionId; checkpoint.plan2Hash = hash(after.plans[checkpoint.plan2]); checkpoint.alternativeRefined = true;
      await writeFile(checkpointUrl, JSON.stringify(checkpoint, null, 2) + '\n');
    }
    const state = await store.read('OPS-HOSP-001'), plan = state.plans[checkpoint.plan2];
    assert.equal(hash(state.plans[checkpoint.plan1]), checkpoint.plan1Hash); assert.equal(hash(plan), checkpoint.plan2Hash);
    for (const [id, expected] of Object.entries(previousHashes)) assert.equal(hash(state.plans[id]), expected);
    for (const [id, expected] of Object.entries(receiptHashes)) assert.equal(hash(state.receipts[id]), expected);
    const alternative = Object.values(state.resourceSnapshots).find(item => plan.evidenceRefs.includes(item.evidenceId) && item.toolName === 'get_hospital_capacity' && item.result.hospitalId === 'HOSP-003');
    assert(alternative?.result.monitoredBedsAvailable > 0);
    assert([...plan.assessment.observations, ...plan.assessment.operationalRisks, ...plan.assessment.bottlenecks].some(item => item.summary.includes('HOSP-003') && item.evidenceRefs.includes(alternative.evidenceId)));
    assert.equal(state.approvals[checkpoint.staleApprovalId].status, 'superseded');
    const old = state.approvals[checkpoint.staleApprovalId]; await assert.rejects(service.decide(old.approvalId, 'approved')); await assert.rejects(service.execute(old.planRevisionId, old.actionId));
    for (const receipt of Object.values(state.receipts)) await service.execute(receipt.planRevisionId, receipt.actionId);
    const resultHash = hash({ plans: state.plans, receipts: state.receipts, evidence: state.resourceSnapshots });
    for (let index = 0; index < 2; index++) {
      const freshCases = createConfiguredCaseStore(), fresh = configuredOperationsStore(process.env, freshCases);
      try { const read = await fresh.read('OPS-HOSP-001'); assert.equal(hash({ plans: read.plans, receipts: read.receipts, evidence: read.resourceSnapshots }), resultHash); }
      finally { await fresh.close(); await freshCases.close(); }
    }
    const oldClinical = await clinical.read(process.env.M8_CASE_ID);
    assert.equal(hash({ plans: oldClinical.plans, receipts: oldClinical.receipts, observations: oldClinical.observations, toolExecutions: oldClinical.toolExecutions }), checkpoint.clinicalHash);
    assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
    const origin = 'http://127.0.0.1:4180';
    child = fork(fileURLToPath(new URL('./m10-verification-worker.js', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, M10_ENABLED: 'true', M10_READ_ONLY: 'true', M8_ENABLED: 'false', ALLOWED_ORIGINS: origin } });
    const [{ port }] = await once(child, 'message');
    vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4180, strictPort: true, proxy: { '/api/operations': { target: `http://127.0.0.1:${port}` } } } });
    await vite.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage();
    await page.goto(origin + '/command-center'); await page.getByRole('heading', { name: `Current plan ${plan.revisionId}`, exact: true }).waitFor();
    assert.equal(await page.getByText('Coming in a future milestone').count(), 0); await page.getByRole('heading', { name: 'Hospital Operations — HOSP-001', exact: true }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL('../../.m10-final-ui.png', import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: fileURLToPath(new URL('../../.m10-final-mobile.png', import.meta.url)), fullPage: true });
    Object.assign(evidence, { verifiedAt: new Date().toISOString(), planV2: { ...evidence.planV2, revisionId: plan.revisionId, status: plan.assessment.status, alternativeCapacityCited: true, changeSummary: plan.assessment.changeSummary },
      retainedIntermediateRevision: checkpoint.intermediatePlan || null, finalFreshClients: 2, finalReceiptCount: Object.keys(state.receipts).length, finalResourceEvidenceCount: Object.keys(state.resourceSnapshots).length,
      runCount: state.meta.runCount, modelCalls: state.meta.modelCalls, finalUi: { desktop: true, mobile: true, noHorizontalOverflow: true, readOnlyBackendProcess: true }, finalReadbackPassed: true });
    await writeFile(evidenceUrl, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify({ status: 'PASS', revision: plan.revisionId, alternativeCited: true, receipts: Object.keys(state.receipts).length, safeChangeSummary: plan.assessment.changeSummary }));
  } finally {
    await browser?.close(); await vite?.close(); if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.send('stop'); await stopped; }
    await service.close(); await cases.close(); await clinical.close();
  }
}
main().catch(error => { console.error(JSON.stringify({ status: 'FAIL', safeCode: error.code || 'VERIFICATION_FAILED' })); process.exitCode = 1; });

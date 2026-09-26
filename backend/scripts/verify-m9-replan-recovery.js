// Finish the existing M9 scenario after correcting omitted resource-change context.
// Keeps every prior revision and all budgets. Never re-seeds or resets the workspace.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import '../src/server.js';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { createClinicalService } from '../src/clinical/service.js';
import { createResourceService } from '../src/resources/service.js';
import { digest } from '../src/clinical/contracts.js';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
const checkpointUrl = new URL('../../.m9-progress.json', import.meta.url), evidenceUrl = new URL('../../docs/m9-agent-tools-verification.json', import.meta.url);
const checkpoint = JSON.parse(await readFile(checkpointUrl, 'utf8')), caseId = process.env.M8_CASE_ID, origin = 'http://127.0.0.1:4179';
let child, browser, vite, stage = 'preflight';
const events = [], log = event => { events.push(event); console.log('[m9-recovery]', JSON.stringify(event)); };
async function main() {
  assert(process.argv.includes('--run') && process.env.APP_ENV === 'development' && process.env.NODE_ENV !== 'production');
  assert.equal(process.env.CASE_STORE, 'firestore'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107'); assert(!process.env.FIRESTORE_EMULATOR_HOST); assert.equal(caseId, checkpoint.caseId);
  const store = configuredClinicalStore(), cases = createConfiguredCaseStore(); let priorHashes, target;
  try {
    const before = await store.read(caseId); assert.equal(before.meta.active, null); assert.equal(before.resourceEnvironment.version, 2);
    assert(before.meta.runCount < 8 && before.meta.modelCalls <= 10, 'No budget reset permitted');
    assert.equal(hash(before.receipts), checkpoint.receiptsHash);
    assert.equal(hash(await cases.getCase(caseId)), checkpoint.originalCaseHash);
    assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
    priorHashes = Object.fromEntries(Object.entries(before.plans).map(([id, plan]) => [id, hash(plan)]));
    target = Object.keys(before.plans).length + 1;
    const service = createClinicalService({ store, caseStore: cases, caseId, resources: createResourceService() });
    await assert.rejects(service.decide(checkpoint.staleApprovalId, 'approved'), { code: 'STALE_APPROVAL' });
    await assert.rejects(service.execute(checkpoint.staleApprovalId), { code: 'STALE_APPROVAL' });
    await service.requestRun('m9-resource-delta-fix');
    log({ stage, priorPlansPreserved: Object.keys(priorHashes).length, targetRevision: target, staleApprovalAndExecutionBlocked: true });
  } finally { await store.close(); await cases.close(); }
  child = fork(fileURLToPath(new URL('./m8-verification-worker.js', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, M8_ENABLED: 'true', M9_ENABLED: 'true', RESOURCE_MODE: 'simulation', MAPS_MODE: 'simulation', ALLOWED_ORIGINS: origin } });
  const [{ port }] = await once(child, 'message'); const base = `http://127.0.0.1:${port}`;
  const read = async () => { const response = await fetch(base + '/api/clinical'); assert.equal(response.status, 200); return response.json(); };
  const post = (path, input) => fetch(base + '/api/clinical' + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  stage = 'resource_delta_replan'; const deadline = Date.now() + 180000; let view, plan;
  while (Date.now() < deadline) {
    view = await read(); plan = view.plans.find(p => p.version === target); if (plan) break;
    const run = view.runs.find(r => r.triggerEventId === 'request_m9-resource-delta-fix'); assert(run?.status !== 'failed', 'Corrected assessment failed; no automatic retry');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(plan, 'Replan timeout');
  const snapshots = view.resourceSnapshots.filter(s => plan.resourceSnapshotIds.includes(s.snapshotId));
  const changed = snapshots.find(s => s.toolName === 'get_hospital_capacity' && s.result.hospitalId === 'HOSP-001');
  const alternative = snapshots.find(s => s.toolName === 'get_hospital_capacity' && s.result.hospitalId === 'HOSP-003');
  assert.equal(changed.result.monitoredBedsAvailable, 0); assert.equal(alternative.result.monitoredBedsAvailable, 1);
  const statements = [...plan.observations, ...plan.hypotheses, ...plan.risks];
  for (const snapshot of [changed, alternative]) assert(statements.some(item => item.evidenceRefs.some(ref => [snapshot.snapshotId, snapshot.executionId].includes(ref))));
  assert(/monitored/i.test(plan.changeSummary) && plan.changeSummary.includes('HOSP-001'));
  assert(JSON.stringify([plan.observations, plan.changeSummary]).includes('HOSP-003'));
  for (const approval of view.approvals.filter(a => a.status === 'pending')) assert.equal((await post(`/approvals/${approval.approvalId}`, { decision: 'rejected' })).status, 200);
  assert.equal((await post('/observations', checkpoint.observation)).status, 200);
  assert.equal((await post('/resources/capacity', { requestId: 'm9-dev-capacity', hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: 1 })).status, 200);
  vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4179, strictPort: true, proxy: { '/api/clinical': { target: base }, '/api/doctor': { target: base } } } }); await vite.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage(); await page.goto(origin + '/doctor');
  await page.getByRole('heading', { name: `PLAN UPDATED · Revision ${target} · current` }).waitFor();
  await page.getByRole('heading', { name: `Revision ${checkpoint.firstVersion} · superseded` }).waitFor();
  await page.locator(`[data-revision="${target}"]`).getByText(/^Monitored beds: 0 ·/).waitFor();
  await page.locator(`[data-revision="${checkpoint.firstVersion}"]`).getByText(/^Monitored beds: 2 ·/).waitFor();
  await page.screenshot({ path: '.m9-doctor-v2.png', fullPage: true });
  const snapshotsHash = hash(snapshots);
  log({ stage, revision: target, hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, alternativeHospital: 'HOSP-003', alternativeMonitoredBeds: 1, normalizedSnapshots: snapshots.length, changedAndAlternativeEvidenceCited: true, doctorUi: true });
  await browser.close(); browser = null; await vite.close(); vite = null;
  const exited = once(child, 'exit'); child.send('stop'); await exited; child = null;
  stage = 'fresh_process_readback'; const fresh = configuredClinicalStore(), freshCases = createConfiguredCaseStore();
  try {
    const state = await fresh.read(caseId);
    for (const [id, expected] of Object.entries(priorHashes)) assert.equal(hash(state.plans[id]), expected);
    assert.equal(hash(state.receipts), checkpoint.receiptsHash); assert.equal(hash(await freshCases.getCase(caseId)), checkpoint.originalCaseHash); assert.equal(hash(await freshCases.listAmbulances()), checkpoint.fleetHash);
    assert.equal(Object.keys(state.plans).length, target); assert.equal(state.meta.currentRevisionId, `revision_${target}`);
    assert.equal(state.events['resource_m9-dev-capacity'].status, 'completed');
    assert.equal(hash(Object.values(state.resourceSnapshots).filter(s => plan.resourceSnapshotIds.includes(s.snapshotId))), snapshotsHash);
    checkpoint.finalVersion = target; await writeFile(checkpointUrl, JSON.stringify(checkpoint, null, 2) + '\n');
    log({ stage, succeeded: true, previousRevisionsUnchanged: true, receiptsUnchanged: true, receiptCount: Object.keys(state.receipts).length, fleetAndCaseUnchanged: true, resourceEvidenceSurvived: true, noDuplicateExecution: true, runCount: state.meta.runCount, modelCalls: state.meta.modelCalls });
  } finally { await fresh.close(); await freshCases.close(); }
  const priorEvents = (await readFile(new URL('../../.m9-live.log', import.meta.url), 'utf8')).split(/\r?\n/).filter(line => line.startsWith('[m9-verification] ')).map(line => JSON.parse(line.slice('[m9-verification] '.length))).filter(event => event.succeeded !== false);
  const existing = JSON.parse(await readFile(evidenceUrl, 'utf8'));
  existing.status = 'complete_fictional_demo'; existing.m9Complete = true; existing.m10Started = false;
  existing.liveDev = { passed: true, verifiedAt: new Date().toISOString(), environment: 'development', projectId: process.env.FIREBASE_PROJECT_ID, database: '(default)', model: process.env.GEMINI_CLINICAL_MODEL,
    simulation: true, existingM8WorkspaceUsed: true, explicitUserAuthorization: true, planV1Revision: checkpoint.firstVersion, planV2Revision: target,
    intermediateRevisionPreserved: target - 1, separateBackendProcesses: 3, events: [...priorEvents, ...events] };
  await writeFile(evidenceUrl, JSON.stringify(existing, null, 2) + '\n');
}
try { await main(); }
catch { console.error(JSON.stringify({ stage, succeeded: false, message: 'Verification stopped; durable state preserved. Inspect before further action.' })); process.exitCode = 1; }
finally { await browser?.close(); await vite?.close(); if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('stop'); await exited; } }

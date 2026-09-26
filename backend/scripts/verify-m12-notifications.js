// Explicitly opt-in fictional DEV acceptance; checkpoints never reset existing workspaces.
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
import { createClinicalService } from '../src/clinical/service.js';
import { createOperationsService } from '../src/operations/service.js';
import { createRegionalService } from '../src/regional/service.js';
import { publishHospitalPressure } from '../src/operations/pressure.js';
import { digest } from '../src/clinical/contracts.js';
import { validateMessage } from '../src/notifications/contracts.js';
const caseId = 'SC-10000000-0000-4000-8000-000000000001', origin = 'http://127.0.0.1:4182';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
const checkpointFile = new URL('../../.m12-progress.json', import.meta.url);
let child, browser, vite, checkpoint, stage = 'preflight';
const log = data => console.log('[m12-verification]', JSON.stringify({ stage, ...data }));
const save = () => writeFile(checkpointFile, JSON.stringify(checkpoint, null, 2) + '\n');
const preserved = state => Object.fromEntries(['plans', 'receipts', 'observations', 'resourceSnapshots'].map(key => [key, Object.fromEntries(Object.entries(state[key]).map(([id, value]) => [id, hash(value)]))]));
function unchanged(state, baseline) { for (const [bucket, items] of Object.entries(baseline)) for (const [id, expected] of Object.entries(items)) assert.equal(hash(state[bucket][id]), expected, `${bucket}/${id} changed`); }
async function stop() { await browser?.close(); browser = null; await vite?.close(); vite = null; if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('stop'); await exited; } child = null; }
async function start(phase) {
  child = fork(fileURLToPath(new URL('./m12-verification-worker.js', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, M12_ENABLED: 'true', M12_PHASE: phase, M12_CLINICAL_CASE_ID: caseId, M9_ENABLED: 'false', ALLOWED_ORIGINS: origin } });
  const value = await Promise.race([once(child, 'message').then(([v]) => v), once(child, 'exit').then(() => { throw new Error('worker startup'); })]); return `http://127.0.0.1:${value.port}`;
}
async function wait(base, predicate) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { const response = await fetch(base + '/api/notifications'); assert(response.ok); const value = await response.json(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error('notification timeout');
}
async function ui(base, path) {
  vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4182, strictPort: true, proxy: Object.fromEntries(['/api/notifications', '/api/clinical', '/api/operations', '/api/regional', '/api/doctor', '/api/cases'].map(key => [key, { target: base }])) } });
  await vite.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage(); await page.goto(origin + path); return page;
}
async function approveUi(base, notice, screenshot) {
  const page = await ui(base, '/command-center'), card = page.locator(`[data-notification-id="${notice.notificationId}"]`);
  await card.getByRole('button', { name: 'Approve simulated notice', exact: true }).click();
  await card.getByText('Simulated notification delivered', { exact: false }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: fileURLToPath(new URL(`../../.m12-${screenshot}.png`, import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
}
async function main() {
  assert(process.argv.includes('--run')); assert.equal(process.env.APP_ENV, 'development'); assert.equal(process.env.CASE_STORE, 'firestore'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107'); assert(!process.env.FIRESTORE_EMULATOR_HOST);
  const cases = createConfiguredCaseStore(), clinicalStore = configuredClinicalStore(process.env, { captureCase: true }), hospitalStore = configuredOperationsStore(process.env, cases), regionalStore = configuredRegionalStore(process.env, cases);
  const clinical = createClinicalService({ store: clinicalStore, caseStore: cases, caseId, notificationsEnabled: true }), hospital = createOperationsService({ store: hospitalStore, caseStore: cases, notificationsEnabled: true }), regional = createRegionalService({ store: regionalStore, caseStore: cases, notificationsEnabled: true });
  try {
    try { checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!checkpoint) {
      assert.equal((await clinicalStore.read(caseId)).meta, null, 'Existing workspace requires inspection, never reset');
      const patient = await cases.getCase(caseId); assert.equal(patient.source, 'smartcareops_demo');
      checkpoint = { originalCase: hash(patient), fleet: hash(await cases.listAmbulances()), clinicalHistory: preserved(await clinicalStore.read(process.env.M8_CASE_ID)), hospitalHistory: preserved(await hospitalStore.read('OPS-HOSP-001')), regionalHistory: preserved(await regionalStore.read('REGION-DEMO-001')), baselineVersion: (await regionalStore.read('REGION-DEMO-001')).resourceEnvironment.version }; await save();
    }
    if (!checkpoint.clinical) {
      stage = 'clinical'; await clinical.append({ requestId: 'm12-fictional-deterioration', observations: [{ type: 'spo2', value: 90, unit: '%', source: 'fictional_device', observedAt: '2026-09-23T16:00:00.000Z', status: 'reported', correctionOf: null }] });
      const base = await start('clinical'), view = await wait(base, v => v.notifications.some(n => n.toolName === 'notify_doctor' && n.status === 'sent'));
      const page = await ui(base, '/doctor'); await page.getByRole('region', { name: 'Simulated notification center' }).getByText('Simulated notification delivered', { exact: false }).first().waitFor();
      await stop(); checkpoint.clinical = view.notifications.find(n => n.toolName === 'notify_doctor'); await save(); log({ doctorDelivered: true, revision: checkpoint.clinical.sourceRevisionId });
    }
    if (!checkpoint.hospital) {
      stage = 'hospital'; await hospital.requestRun('m12-hospital-notifications'); const base = await start('hospital');
      const view = await wait(base, v => v.notifications.some(n => n.toolName === 'notify_hospital_operations' && n.scope === 'hospital' && n.status === 'sent') && v.notifications.some(n => n.scope === 'hospital' && n.toolName === 'notify_command_center' && n.canApprove));
      const notice = view.notifications.find(n => n.scope === 'hospital' && n.toolName === 'notify_command_center' && n.canApprove); await approveUi(base, notice, 'hospital'); await stop();
      await publishHospitalPressure(hospitalStore); checkpoint.hospital = notice; await save(); log({ operationsDelivered: true, commandCenterApprovedInUi: true });
    }
    if (!checkpoint.regional) {
      stage = 'regional'; await regional.requestRun('m12-regional-notifications'); const base = await start('regional');
      const view = await wait(base, v => v.notifications.some(n => n.toolName === 'notify_participating_hospital' && n.canApprove));
      const notice = view.notifications.find(n => n.toolName === 'notify_participating_hospital' && n.canApprove); await approveUi(base, notice, 'regional'); await stop();
      const state = await regionalStore.read('REGION-DEMO-001'); checkpoint.regional = notice; checkpoint.stale = Object.values(state.notifications).find(n => n.toolName === 'notify_command_center' && n.status === 'pending'); assert(checkpoint.stale);
      checkpoint.delivered = preserved(state); await save(); log({ participatingHospitalApprovedInUi: true, receipt: state.notifications[notice.notificationId].receiptId });
    }
    if (!checkpoint.replan) {
      stage = 'evidence_change'; await regional.changeCapacity({ requestId: 'm12-hosp002-pressure', hospitalId: 'HOSP-002', monitoredBedsAvailable: 3, expectedVersion: checkpoint.baselineVersion });
      const staleState = await regionalStore.read('REGION-DEMO-001'), approval = Object.values(staleState.approvals).find(a => a.actionId === checkpoint.stale.sourceActionId && a.planRevisionId === checkpoint.stale.sourceRevisionId);
      await assert.rejects(regional.decide(approval.approvalId, 'approved')); await assert.rejects(regional.execute(approval.planRevisionId, approval.actionId));
      const base = await start('regional'); await wait(base, v => v.notifications.some(n => n.scope === 'regional' && n.sourceRevisionId !== checkpoint.regional.sourceRevisionId && n.status === 'pending'));
      await stop(); const state = await regionalStore.read('REGION-DEMO-001'); assert.equal(state.notifications[checkpoint.stale.notificationId].status, 'superseded'); unchanged(state, checkpoint.delivered);
      checkpoint.replan = state.meta.currentRevisionId; await save(); log({ replan: checkpoint.replan, staleBlocked: true });
    }
    stage = 'fresh_clients'; const states = [await clinicalStore.read(caseId), await hospitalStore.read('OPS-HOSP-001'), await regionalStore.read('REGION-DEMO-001')];
    unchanged(await clinicalStore.read(process.env.M8_CASE_ID), checkpoint.clinicalHistory); unchanged(states[1], checkpoint.hospitalHistory); unchanged(states[2], checkpoint.regionalHistory); unchanged(states[2], checkpoint.delivered);
    assert.equal(hash(await cases.getCase(caseId)), checkpoint.originalCase); assert.equal(hash(await cases.listAmbulances()), checkpoint.fleet);
    for (const state of states) { const notices = Object.values(state.notifications); for (const notice of notices) { validateMessage(notice.toolName, notice); if (notice.status === 'sent') { assert(state.receipts[notice.receiptId]); assert.equal(Object.values(state.receipts).filter(r => r.notificationId === notice.notificationId).length, 1); } } assert(Object.values(state.followups).length); }
    for (let i = 0; i < 2; i++) {
      const freshCases = createConfiguredCaseStore(), stores = [configuredClinicalStore(process.env, { captureCase: true }), configuredOperationsStore(process.env, freshCases), configuredRegionalStore(process.env, freshCases)];
      try { for (const [index, id] of [caseId, 'OPS-HOSP-001', 'REGION-DEMO-001'].entries()) { const state = await stores[index].read(id); for (const bucket of ['plans', 'notifications', 'receipts', 'followups', 'resourceSnapshots']) assert.equal(hash(state[bucket]), hash(states[index][bucket])); } }
      finally { await Promise.all(stores.map(store => store.close())); await freshCases.close(); }
    }
    // Explicit retries of completed regional deliveries return the original receipt.
    const receipt = states[2].receipts[states[2].notifications[checkpoint.regional.notificationId].receiptId]; await regional.execute(receipt.planRevisionId, receipt.actionId); await regional.execute(receipt.planRevisionId, receipt.actionId);
    assert.equal(hash((await regionalStore.read('REGION-DEMO-001')).receipts), hash(states[2].receipts));
    const evidence = { milestone: 'M12', scope: 'fictional/demo', status: 'DEV_PASS', verifiedAt: new Date().toISOString(), project: process.env.FIREBASE_PROJECT_ID, model: 'gemini-3.6-flash', clinical: states[0].notifications[checkpoint.clinical.notificationId], hospital: states[1].notifications[checkpoint.hospital.notificationId], regional: states[2].notifications[checkpoint.regional.notificationId], replan: checkpoint.replan, clinicalOriginalHistoryPreserved: true, hospitalOriginalHistoryPreserved: true, regionalOriginalHistoryPreserved: true, originalCaseAndFleetPreserved: true, staleApprovalBlocked: true, pendingSuperseded: true, deliveredReceiptsPreserved: true, duplicateDeliveryPrevented: true, followupsDurable: true, freshBackendProcesses: 4, freshFirestoreClients: 6, uiApproval: true, mobileNoOverflow: true, notifications: states.map(s => ({ subjectId: Object.values(s.notifications)[0].subjectId, total: Object.keys(s.notifications).length, sent: Object.values(s.notifications).filter(n => n.status === 'sent').length, followups: Object.keys(s.followups).length })), m13: 'NOT STARTED' };
    await writeFile(new URL('../../docs/m12-notifications-agent-actions-verification.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n'); log({ status: 'DEV_PASS' });
  } finally { await stop(); await Promise.all([clinical.close(), hospital.close(), regional.close()]); await cases.close(); }
}
main().catch(error => { log({ status: 'FAIL', code: error.code || 'VERIFICATION_FAILED', safeMessage: error instanceof assert.AssertionError ? error.message.slice(0, 180) : 'Inspect bounded persisted state before retry.' }); process.exitCode = 1; });

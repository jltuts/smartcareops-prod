import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import '../src/server.js'; // Loads local .env without exposing values.
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { createClinicalService } from '../src/clinical/service.js';
import { clinicalModel } from '../src/clinical/model.js';

const caseId = process.env.M8_CASE_ID || 'SC-a55abe82-6164-46a1-98d7-6fa3995741d7';
const origin = 'http://127.0.0.1:4178', events = [];
let stage = 'configuration', child, vite, browser;
const log = record => { events.push(record); console.log('[m8-verification]', JSON.stringify(record)); };
const waitFor = async check => {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 250)); }
  throw new Error('Verification timeout');
};
const observation = (type, value, unit, observedAt) => ({ type, value, unit, observedAt, source: type === 'symptom_update' ? 'fictional_patient' : 'fictional_device', status: 'reported', correctionOf: null });
const setA = { requestId: 'm8-dev-setA', observations: [
  observation('temperature', 38.1, '°C', '2026-09-22T09:00:00.000Z'), observation('heart_rate', 92, 'bpm', '2026-09-22T09:00:00.000Z'),
  observation('blood_pressure', { systolic: 118, diastolic: 76 }, 'mmHg', '2026-09-22T09:00:00.000Z'), observation('spo2', 94, '%', '2026-09-22T09:00:00.000Z'),
  observation('temperature', 39.2, '°C', '2026-09-22T10:00:00.000Z'), observation('heart_rate', 118, 'bpm', '2026-09-22T10:00:00.000Z'),
  observation('blood_pressure', { systolic: 96, diastolic: 62 }, 'mmHg', '2026-09-22T10:00:00.000Z'), observation('spo2', 88, '%', '2026-09-22T10:00:00.000Z'),
  observation('symptom_update', 'Increasing shortness of breath.', '', '2026-09-22T10:00:00.000Z'),
] };
const setB = { requestId: 'm8-dev-setB', observations: [observation('spo2', 87, '%', '2026-09-22T11:00:00.000Z'), observation('symptom_update', 'Shortness of breath persists during the fictional observation period.', '', '2026-09-22T11:00:00.000Z')] };
async function startBackend() {
  child = fork(fileURLToPath(new URL('./m8-verification-worker.js', import.meta.url)), [], { windowsHide: true,
    env: { ...process.env, M8_ENABLED: 'true', M8_CASE_ID: caseId, ALLOWED_ORIGINS: origin }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const message = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error('Backend exited before startup'); })]);
  return `http://127.0.0.1:${message.port}`;
}
async function stopBackend() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('stop'); await exited; } child = null; }
async function startUi(base) {
  vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4178, strictPort: true,
    proxy: { '/api/clinical': { target: base }, '/api/doctor': { target: base } } } }); await vite.listen();
}
async function main() {
  assert(process.argv.includes('--run')); assert.equal(process.env.APP_ENV, 'development'); assert.notEqual(process.env.NODE_ENV, 'production');
  assert.equal(process.env.CASE_STORE, 'firestore'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107'); assert(!process.env.FIRESTORE_EMULATOR_HOST);
  const cases = createConfiguredCaseStore(), store = configuredClinicalStore();
  let original, originalFleet;
  try {
    stage = 'preflight'; original = await cases.getCase(caseId); assert(original?.source === 'smartcareops_demo'); originalFleet = await cases.listAmbulances();
    const previous = await store.read(caseId); assert(!previous.meta, 'Existing M8 workspace is never reset. Inspect it instead of blindly repeating verification.');
    log({ stage, succeeded: true, projectId: process.env.FIREBASE_PROJECT_ID, database: '(default)', caseId, model: clinicalModel() });
    stage = 'persist_observations_before_process_start'; const service = createClinicalService({ store, caseStore: cases, caseId }); await service.append(setA);
    const pending = await service.view(); assert.equal(pending.events[0].status, 'pending'); assert.equal(pending.runs.length, 0);
    log({ stage, observations: pending.observations.length, eventPending: true });
  } finally { await store.close(); await cases.close(); }
  let base = await startBackend();
  let read = async () => { const response = await fetch(base + '/api/clinical'); assert.equal(response.status, 200); return response.json(); };
  const post = (path, body) => fetch(base + '/api/clinical' + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  stage = 'real_gemini_plan_v1';
  const first = await waitFor(async () => { const view = await read(); if (view.runs.some(r => r.status === 'failed')) throw new Error('Clinical model failed'); return view.plans.length ? view : null; });
  assert.equal(first.plans[0].version, 1); assert(first.approvals.some(a => a.status === 'pending')); const approvalId = first.approvals.find(a => a.status === 'pending').approvalId;
  await waitFor(async () => (await read()).executions.some(e => e.planRevisionId && !e.approvalId && e.status === 'succeeded'));
  log({ stage, revision: 1, investigationTools: first.runs[0].toolExecutionIds.length, approvalId, readOnlyActionExecuted: true });
  stage = 'doctor_approval_and_receipt'; await startUi(base); browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage();
  await page.goto(origin + '/doctor'); await page.getByRole('heading', { name: 'Revision 1 · current' }).waitFor();
  await page.getByRole('button', { name: 'Approve simulated action' }).click();
  const executed = await waitFor(async () => { const view = await read(); return view.receipts.length === 1 ? view : null; });
  await page.getByRole('button', { name: 'Refresh clinical plan' }).click(); await page.getByText('Verified receipt:', { exact: false }).waitFor();
  await page.screenshot({ path: '.m8-doctor-v1.png', fullPage: true });
  const receiptId = executed.receipts[0].receiptId; assert.equal(executed.executions.filter(e => e.approvalId && e.status === 'succeeded').length, 1);
  log({ stage, doctorUi: true, reviewer: 'demo_doctor', receiptId, executionSucceeded: true, simulation: true });
  await browser.close(); browser = null; await vite.close(); vite = null; await stopBackend();
  stage = 'separate_process_restart_and_duplicate_event'; base = await startBackend();
  assert.equal((await read()).receipts[0].receiptId, receiptId); assert.equal((await post('/observations', setA)).status, 200);
  assert.equal((await read()).receipts.length, 1); assert.equal((await read()).plans.length, 1);
  log({ stage, sameReceipt: true, receiptCount: 1, planCount: 1, monitoringActive: (await read()).monitoring.status === 'active' });
  stage = 'new_observation_replan'; assert.equal((await post('/observations', setB)).status, 200);
  const second = await waitFor(async () => { const view = await read(); if (view.runs.some(r => r.status === 'failed')) throw new Error('Clinical replan failed'); return view.plans.length === 2 ? view : null; });
  assert.equal(second.plans[0].status, 'superseded'); assert.equal(second.plans[1].status, 'current'); assert.equal(second.receipts.length, 1);
  assert.equal((await post(`/approvals/${approvalId}`, { decision: 'approved' })).status, 409);
  // Leave new high-impact recommendations explicitly rejected; no unattended new effect.
  for (const approval of second.approvals.filter(a => a.status === 'pending')) assert.equal((await post(`/approvals/${approval.approvalId}`, { decision: 'rejected' })).status, 200);
  await startUi(base); browser = await chromium.launch({ channel: 'msedge', headless: true }); const secondPage = await browser.newPage(); await secondPage.goto(origin + '/doctor');
  await secondPage.getByRole('heading', { name: 'PLAN UPDATED · Revision 2 · current' }).waitFor(); await secondPage.screenshot({ path: '.m8-doctor-v2.png', fullPage: true });
  log({ stage, revision: 2, priorRevisionSuperseded: true, staleApprovalRejected: true, completedActionPreserved: true, receiptCount: 1, doctorUi: true });
  await browser.close(); browser = null; await vite.close(); vite = null; await stopBackend();
  stage = 'fresh_client_durable_readback'; const freshStore = configuredClinicalStore(), freshCases = createConfiguredCaseStore();
  try {
    const durable = await freshStore.read(caseId); assert.equal(Object.keys(durable.plans).length, 2); assert.equal(Object.keys(durable.receipts).length, 1);
    assert.equal(durable.meta.currentRevisionId, 'revision_2'); assert.equal(durable.monitoring.main.status, 'active');
    assert.deepEqual(await freshCases.getCase(caseId), original); assert.deepEqual(await freshCases.listAmbulances(), originalFleet);
    log({ stage, succeeded: true, originalCaseUnchanged: true, fleetUnchanged: true, receiptId });
  } finally { await freshStore.close(); await freshCases.close(); }
  await writeFile(new URL('../../docs/m8-clinical-verification.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), environment: 'development', projectId: process.env.FIREBASE_PROJECT_ID, database: '(default)', caseId, model: clinicalModel(), simulation: true, events }, null, 2) + '\n');
}
try { await main(); }
catch { console.error('[m8-verification]', JSON.stringify({ stage, succeeded: false, message: 'Verification stopped. Existing durable state was preserved; inspect before resuming.' })); process.exitCode = 1; }
finally { await browser?.close(); await vite?.close(); await stopBackend(); }

// One opt-in fictional transcript replay through production completion wiring,
// real extraction, Firestore routing, Doctor UI and independent durable read-back.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { createApiServer } from '../src/server.js'; // loads server-side .env
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { newCaseId } from '../src/cases/store.js';
import { environmentMetadata } from '../src/environment.js';
const events = [];
const log = detail => { events.push(detail); console.log('[m5-verification]', JSON.stringify(detail)); };
const waitFor = async check => {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Verification wait expired'); await new Promise(resolve => setTimeout(resolve, 25)); }
};
async function main() {
  if (environmentMetadata('firestore').environment !== 'development') throw new Error('Verification requires development environment.');
  if (!process.argv.includes('--run') || process.env.NODE_ENV === 'production' || process.env.CASE_STORE !== 'firestore' || process.env.FIREBASE_PROJECT_ID !== 'gen-lang-client-0710663107' || process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Cloud verification configuration unavailable.');
  const preflight = createConfiguredCaseStore();
  try { await preflight.getCase(newCaseId()); log({ stage: 'firestore_preflight', succeeded: true, ...environmentMetadata(preflight.storage) }); }
  finally { await preflight.close(); }
  let callbacks, liveSocket, patientCaseId, routedAt, browser, vite;
  const uiOrigin = 'http://127.0.0.1:4175';
  process.env.ALLOWED_ORIGINS = [process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5173', uiOrigin].join(',');
  const api = createApiServer({ liveOptions: {
    // Only speech is replayed. Production extractor, completion, persistence,
    // capability checks and M5 routing remain real.
    connect: async options => {
      callbacks = options.callbacks;
      queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput() {}, close() {} };
    },
  } });
  try {
    api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
    const base = `http://127.0.0.1:${api.server.address().port}`;
    const origin = 'http://127.0.0.1:5173';
    liveSocket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { origin });
    const messages = [];
    liveSocket.on('message', raw => messages.push(JSON.parse(raw)));
    await once(liveSocket, 'open'); liveSocket.send(JSON.stringify({ type: 'start' }));
    await waitFor(() => messages.some(m => m.type === 'ready'));
    const emit = content => callbacks.onmessage({ serverContent: content });
    for (const [question, answer] of [
      ['What is your name?', 'My name is Demo Alex.'],
      ['What brings you here?', 'I feel dizzy.'],
      ['When did it start?', 'It started yesterday.'],
      ['Are you having chest pain?', 'No, I do not have chest pain.'],
      ['Are you having difficulty breathing?', 'No, I am not having difficulty breathing.'],
      ['What is your blood pressure?', 'My blood pressure is 120 over 80.'],
      ["Is there anything else you would like to add?", 'No, nothing else.'],
    ]) {
      emit({ outputTranscription: { text: question }, turnComplete: true });
      emit({ inputTranscription: { text: answer, finished: true } });
    }
    emit({ outputTranscription: { text: 'Thank you, Demo Alex. Your intake is complete.' }, turnComplete: true });
    await waitFor(() => messages.some(m => m.type === 'completion-pending'));
    const pending = messages.find(m => m.type === 'completion-pending');
    liveSocket.send(JSON.stringify({ type: 'completion-settled', id: pending.id }));
    const deadline = Date.now() + 120000; let finalized;
    while (Date.now() < deadline) {
      const response = await fetch(base + '/api/intake-finalization', { headers: { Authorization: `Bearer ${pending.resultTicket}` } });
      if (response.status !== 202) { assert.equal(response.status, 200); finalized = await response.json(); break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (finalized?.status !== 'COMPLETED') { log({ stage: 'finalization', succeeded: false, code: finalized?.error?.code || 'FINALIZATION_UNKNOWN' }); throw new Error('Finalization failed'); }
    patientCaseId = finalized.patientCase.caseId;
    const first = await (await fetch(base + '/api/cases/' + patientCaseId)).json();
    assert.equal(first.storage, 'firestore'); assert.equal(first.workflowStatus, 'intake_completed');
    assert.deepEqual(first.reportedFacts, finalized.snapshot);
    log({ stage: 'case_created_and_read', caseId: patientCaseId, storage: first.storage, workflowStatus: first.workflowStatus });
    vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4175, strictPort: true, proxy: { '/api/cases': { target: base }, '/api/doctor': { target: base } } } });
    await vite.listen();
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
    const page = await browser.newPage();
    await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), patientCaseId);
    await page.goto(uiOrigin + '/patient');
    await page.getByRole('button', { name: 'Route to doctor', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#patient-case-routing')?.textContent === 'Routing: Neurology', null, { timeout: 30000 });
    const routed = await (await fetch(base + '/api/cases/' + patientCaseId)).json();
    assert.equal(routed.routing.specialty, 'neurology'); assert.equal(routed.workflowStatus, 'routed_to_doctor');
    assert.deepEqual(routed.reportedFacts, first.reportedFacts); assert.equal(routed.handoffStatus, first.handoffStatus);
    routedAt = routed.routing.routedAt;
    log({ stage: 'route_persisted', caseId: patientCaseId, routing: routed.routing, workflowStatus: routed.workflowStatus, snapshotUnchanged: true });
    const repeated = await fetch(base + '/api/cases/' + patientCaseId + '/route', { method: 'POST', headers: { Origin: uiOrigin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(repeated.status, 200); assert.equal((await repeated.json()).routing.routedAt, routedAt);
    log({ stage: 'duplicate_route', timestampPreserved: true });
    await page.goto(uiOrigin + '/doctor');
    await page.waitForFunction(() => /^\d+ routed case/.test(document.querySelector('#doctor-message')?.textContent));
    const open = page.getByRole('button', { name: `Open case ${patientCaseId}`, exact: true });
    // Bounded queue pages, even when the DEV project already has many demo cases.
    while (!await open.count() && await page.getByRole('button', { name: 'Load more cases' }).isVisible()) {
      await page.getByRole('button', { name: 'Load more cases' }).click();
      await page.waitForFunction(() => !document.querySelector('#doctor-message').textContent.startsWith('Loading'));
    }
    await open.click({ timeout: 30000 });
    await page.waitForFunction(id => document.querySelector('#doctor-detail-heading')?.textContent === `Case ${id}`, patientCaseId);
    assert.ok((await page.locator('#doctor-detail').innerText()).includes('Neurology'));
    log({ stage: 'doctor_ui', caseId: patientCaseId, visible: true, detailVerified: true });
    await page.screenshot({ path: '.m5-doctor.png', fullPage: true });
    await page.reload();
    await page.waitForFunction(() => /^\d+ routed case/.test(document.querySelector('#doctor-message')?.textContent));
    while (!await open.count() && await page.getByRole('button', { name: 'Load more cases' }).isVisible()) {
      await page.getByRole('button', { name: 'Load more cases' }).click();
      await page.waitForFunction(() => !document.querySelector('#doctor-message').textContent.startsWith('Loading'));
    }
    await open.click();
    await page.waitForFunction(id => document.querySelector('#doctor-detail-heading')?.textContent === `Case ${id}`, patientCaseId);
    assert.ok((await page.locator('#doctor-detail').innerText()).includes('Neurology'));
    const detail = await (await fetch(base + '/api/doctor/cases/' + patientCaseId)).json();
    assert.equal(detail.routing.routedAt, routedAt); assert.equal(detail.routing.specialty, 'neurology');
    log({ stage: 'refresh_read_back', caseId: patientCaseId, succeeded: true });
  } finally {
    await browser?.close(); await vite?.close(); liveSocket?.close(); await api.shutdown();
  }
  const fresh = createConfiguredCaseStore();
  try {
    const durable = await fresh.getDoctorCase(patientCaseId);
    assert.equal(durable.storage, 'firestore'); assert.equal(durable.routing.specialty, 'neurology'); assert.equal(durable.routing.routedAt, routedAt);
    log({ stage: 'durable_read_after_server_shutdown', caseId: patientCaseId, specialty: durable.routing.specialty, succeeded: true });
  } finally { await fresh.close(); }
  await writeFile(new URL('../../docs/m5-routing-verification.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), environment: 'development', projectId: process.env.FIREBASE_PROJECT_ID, database: '(default)', speech: 'fictional transcript replay; real extraction and completion', events }, null, 2) + '\n');
}
main().catch(() => { log({ stage: 'failed', safeMessage: 'Fictional M5 verification did not complete. Inspect safe diagnostics.' }); process.exitCode = 1; });

// Opt-in DEV verification. Speech is replayed; Gemini extraction, validation,
// Safety Engine, production persistence, HTTP and Dispatcher browser are real.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { createApiServer } from '../src/server.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { newCaseId } from '../src/cases/store.js';
import { environmentMetadata } from '../src/environment.js';
import { emergencyMessage } from '../src/emergency.js';

const events = [];
let stage = 'configuration';
const log = detail => { events.push(detail); console.log('[m6-verification]', JSON.stringify(detail)); };
const waitFor = async check => {
  const deadline = Date.now() + 120000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Verification timeout'); await new Promise(resolve => setTimeout(resolve, 100)); }
};
async function main() {
  if (!process.argv.includes('--run') || environmentMetadata('firestore').environment !== 'development' || process.env.NODE_ENV === 'production' || process.env.CASE_STORE !== 'firestore' || process.env.FIREBASE_PROJECT_ID !== 'gen-lang-client-0710663107' || process.env.FIRESTORE_EMULATOR_HOST) throw new Error('DEV verification configuration unavailable');
  stage = 'preflight';
  const preflight = createConfiguredCaseStore();
  try { await preflight.getCase(newCaseId()); log({ stage: 'firestore_preflight', succeeded: true, ...environmentMetadata(preflight.storage) }); }
  finally { await preflight.close(); }
  const origin = 'http://127.0.0.1:4176';
  process.env.ALLOWED_ORIGINS = [process.env.ALLOWED_ORIGINS || '', origin].filter(Boolean).join(',');
  let callbacks, socket, browser, vite, caseId, triggeredAt, acknowledgedAt, geminiClosed = 0;
  const messages = [], backendInstructions = [];
  const api = createApiServer({ liveOptions: { connect: async options => {
    callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
    return { sendRealtimeInput: value => backendInstructions.push(value), close() { geminiClosed++; } };
  } } });
  try {
    api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
    const base = `http://127.0.0.1:${api.server.address().port}`;
    const post = path => fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    stage = 'validated_emergency_intake';
    socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { origin });
    socket.on('message', raw => messages.push(JSON.parse(raw)));
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'start' }));
    await waitFor(() => messages.some(event => event.type === 'ready'));
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ outputTranscription: { text: 'What is your name?' }, turnComplete: true });
    emit({ inputTranscription: { text: 'My name is Demo Jordan.', finished: true } });
    await waitFor(() => messages.some(event => event.type === 'intake-update' && event.intake?.patient?.name));
    emit({ outputTranscription: { text: 'Are you having chest pain right now?' }, turnComplete: true });
    emit({ inputTranscription: { text: 'I have severe chest pain right now.', finished: true } });
    await waitFor(() => messages.some(event => event.type === 'emergency-escalation'));
    const escalation = messages.find(event => event.type === 'emergency-escalation');
    caseId = escalation.patientCase.caseId;
    let saved;
    await waitFor(async () => {
      const response = await fetch(base + '/api/cases/' + caseId);
      if (!response.ok) return false;
      saved = await response.json(); return saved.emergency?.status === 'pending_dispatcher';
    });
    assert.equal(saved.workflowStatus, 'emergency_pending_dispatcher'); assert.equal(saved.storage, 'firestore');
    assert.equal(saved.emergency.reasonCode, 'chest_pain_red_flag'); assert.deepEqual(saved.reportedFacts, escalation.snapshot);
    triggeredAt = saved.emergency.triggeredAt;
    log({ stage: 'emergency_persisted', caseId, workflowStatus: saved.workflowStatus, emergency: saved.emergency, snapshotUnchanged: true });
    stage = 'terminal_voice';
    assert.equal(backendInstructions.filter(value => value.text?.includes(emergencyMessage)).length, 1);
    emit({ outputTranscription: { text: emergencyMessage }, turnComplete: true });
    await waitFor(() => messages.some(event => event.type === 'emergency-playback-ready'));
    const closed = once(socket, 'close'); socket.send(JSON.stringify({ type: 'emergency-settled', id: escalation.id })); await closed;
    const count = messages.length;
    emit({ inputTranscription: { text: 'Thank you. Goodbye.', finished: true }, outputTranscription: { text: emergencyMessage }, turnComplete: true });
    assert.equal(messages.length, count); assert.equal(geminiClosed, 1);
    assert.equal(messages.filter(event => event.type === 'emergency-escalation').length, 1);
    assert.equal(messages.filter(event => event.type === 'intake-complete').length, 0);
    log({ stage: 'terminal_session', closingInstructions: 1, geminiClosed: true, webSocketClosed: true, laterSpeechIgnored: true });
    stage = 'doctor_routing_skipped';
    const skipped = await post(`/api/cases/${caseId}/route`); assert.equal(skipped.status, 200);
    const unchanged = await skipped.json(); assert.equal(unchanged.workflowStatus, 'emergency_pending_dispatcher'); assert.equal(unchanged.routing, null);
    assert.equal(unchanged.emergency.triggeredAt, triggeredAt);
    assert.equal((await fetch(base + '/api/doctor/cases/' + caseId)).status, 404);
    log({ stage: 'doctor_routing_skipped', caseId, succeeded: true });
    const evaluated = await post(`/api/cases/${caseId}/evaluate-emergency`); assert.equal(evaluated.status, 200);
    assert.equal((await evaluated.json()).emergency.triggeredAt, triggeredAt);
    log({ stage: 'duplicate_evaluation', originalTriggerPreserved: true });
    stage = 'dispatcher_ui';
    vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { host: '127.0.0.1', port: 4176, strictPort: true, proxy: { '/api/cases': { target: base }, '/api/dispatcher': { target: base } } } });
    await vite.listen(); browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
    const page = await browser.newPage();
    await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
    await page.goto(origin + '/patient');
    await page.waitForFunction(() => document.querySelector('#patient-case-emergency-status')?.textContent === 'Status: Pending dispatcher');
    assert.equal(await page.getByRole('button', { name: 'Route to doctor', exact: true }).isVisible(), false);
    const findCase = async () => {
      await page.waitForFunction(() => /^\d+ emergency case/.test(document.querySelector('#dispatcher-message')?.textContent));
      const open = page.getByRole('button', { name: `Open emergency case ${caseId}`, exact: true });
      while (!await open.count() && await page.getByRole('button', { name: 'Load more emergencies' }).isVisible()) {
        await page.getByRole('button', { name: 'Load more emergencies' }).click();
        await page.waitForFunction(() => !document.querySelector('#dispatcher-message').textContent.startsWith('Loading'));
      }
      await open.click();
      await page.waitForFunction(id => document.querySelector('#dispatcher-detail-heading')?.textContent === `Case ${id}`, caseId);
    };
    await page.goto(origin + '/dispatcher'); await findCase();
    assert.ok((await page.locator('#dispatcher-detail').innerText()).includes('Pending dispatcher'));
    await page.reload(); await findCase();
    assert.ok((await page.locator('#dispatcher-detail').innerText()).includes('Pending dispatcher'));
    log({ stage: 'dispatcher_pending_refresh', caseId, visible: true, detailVerified: true });
    stage = 'acknowledgement';
    await page.getByRole('button', { name: `Acknowledge ${caseId}`, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#dispatcher-action')?.textContent === 'Dispatcher acknowledged. No emergency response has been dispatched.');
    const acknowledged = await (await fetch(base + '/api/dispatcher/cases/' + caseId)).json();
    assert.equal(acknowledged.workflowStatus, 'emergency_acknowledged'); assert.equal(acknowledged.emergency.acknowledgedBy, 'demo_dispatcher');
    acknowledgedAt = acknowledged.emergency.acknowledgedAt;
    assert.ok(acknowledgedAt); assert.equal(acknowledged.emergency.triggeredAt, triggeredAt); assert.deepEqual(acknowledged.reportedFacts, saved.reportedFacts);
    const duplicate = await post(`/api/dispatcher/cases/${caseId}/acknowledge`); assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).emergency.acknowledgedAt, acknowledgedAt);
    log({ stage: 'acknowledgement_persisted', caseId, emergency: acknowledged.emergency, originalTriggerPreserved: true, duplicateTimestampPreserved: true });
    await page.reload(); await findCase();
    assert.ok((await page.locator('#dispatcher-detail').innerText()).includes('Dispatcher acknowledged'));
    await page.screenshot({ path: '.m6-dispatcher.png', fullPage: true });
    await page.goto(origin + '/patient');
    await page.waitForFunction(() => document.querySelector('#patient-case-emergency-status')?.textContent === 'Status: Dispatcher acknowledged');
    log({ stage: 'acknowledged_refresh', dispatcherVisible: true, patientVisible: true });
  } finally { await browser?.close(); await vite?.close(); socket?.close(); await api.shutdown(); }
  stage = 'durable_read';
  const fresh = createConfiguredCaseStore();
  try {
    const durable = await fresh.getDispatcherCase(caseId);
    assert.equal(durable.storage, 'firestore'); assert.equal(durable.workflowStatus, 'emergency_acknowledged');
    assert.equal(durable.emergency.triggeredAt, triggeredAt); assert.equal(durable.emergency.acknowledgedAt, acknowledgedAt);
    log({ stage: 'durable_read_after_server_shutdown', caseId, status: durable.emergency.status, succeeded: true });
  } finally { await fresh.close(); }
  await writeFile(new URL('../../docs/m6-emergency-verification.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), environment: 'development', projectId: process.env.FIREBASE_PROJECT_ID, database: '(default)', speech: 'fictional transcript replay; real extraction, validation and terminal relay; no microphone or generated closing audio claimed', events }, null, 2) + '\n');
}
main().catch(() => { log({ stage: 'failed', failedStage: stage, safeMessage: 'Fictional M6 verification did not complete. Inspect safe diagnostics.' }); process.exitCode = 1; });

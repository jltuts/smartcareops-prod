// One opt-in fictional transcript replay through production completion wiring,
// real extraction, Firestore, M3 relay/browser and independent durable read-back.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { createApiServer } from '../src/server.js'; // loads server-side .env
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { newCaseId } from '../src/cases/store.js';
import { environmentMetadata } from '../src/environment.js';
const log = detail => console.log('[m4-verification]', JSON.stringify(detail));
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
  let callbacks, liveSocket, agentSocket, input, patientCaseId, hospitalReceipt;
  const api = createApiServer({ liveOptions: {
    // Only speech is replayed. Production extractor, completion, persistence,
    // capability checks and all M3 execution remain real.
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
    const checkStore = createConfiguredCaseStore();
    try {
      const duplicate = await checkStore.createCase({ caseId: patientCaseId, intake: finalized.snapshot });
      assert.equal(duplicate.createdAt, first.createdAt);
      log({ stage: 'duplicate_completion', sameCase: duplicate.caseId === patientCaseId, originalTimestampPreserved: true });
    } finally { await checkStore.close(); }
    agentSocket = new WebSocket(base.replace('http:', 'ws:') + '/api/agent/handoff', { origin });
    input = createInterface({ input: process.stdin }); let approval;
    input.on('line', line => {
      if (approval && ['approve', 'decline'].includes(line.trim())) {
        agentSocket.send(JSON.stringify({ type: 'confirm', id: approval, approved: line.trim() === 'approve' })); approval = undefined;
      }
    });
    const finished = new Promise((resolve, reject) => {
      let complete = false;
      agentSocket.on('message', raw => {
        const event = JSON.parse(raw);
        if (event.status === 'case_status') log({ stage: 'handoff_persisted', caseId: patientCaseId, workflowStatus: event.patientCase.workflowStatus, handoffStatus: event.patientCase.handoffStatus });
        if (event.status === 'confirmation') { approval = event.id; log({ stage: 'confirmation_required', instruction: 'Enter approve or decline.' }); }
        if (event.status === 'completed') { complete = true; resolve(event); }
        if (event.status === 'failed') reject(new Error('Handoff failed'));
      });
      agentSocket.on('error', () => reject(new Error('Handoff socket failed')));
      agentSocket.on('close', () => { if (!complete) reject(new Error('Handoff not completed')); });
    });
    void finished.catch(() => {});
    await once(agentSocket, 'open');
    agentSocket.send(JSON.stringify({ type: 'start', fictional: true, intake: finalized.snapshot, completionToken: finalized.completionToken }));
    const completed = await finished; hospitalReceipt = completed.caseId;
    const saved = await (await fetch(base + '/api/cases/' + patientCaseId)).json();
    assert.equal(saved.handoffStatus, 'completed'); assert.equal(saved.handoffReceipt.caseId, hospitalReceipt);
    assert.deepEqual(saved.reportedFacts, first.reportedFacts);
    log({ stage: 'receipt_read_back', caseId: patientCaseId, hospitalReceipt, snapshotUnchanged: true });
  } finally {
    input?.close(); liveSocket?.close(); agentSocket?.close(); await api.shutdown();
  }
  // The original API and client have been shut down. This is a fresh Firestore
  // client read, not a cache hit or memory-store fallback.
  const fresh = createConfiguredCaseStore();
  try {
    const durable = await fresh.getCase(patientCaseId);
    assert.equal(durable.storage, 'firestore'); assert.equal(durable.workflowStatus, 'handoff_completed');
    assert.equal(durable.handoffReceipt.caseId, hospitalReceipt);
    log({ stage: 'durable_read_after_server_shutdown', caseId: patientCaseId, hospitalReceipt, succeeded: true });
  } finally { await fresh.close(); }
}
main().catch(() => { log({ stage: 'failed', safeMessage: 'Fictional Firestore verification did not complete. Inspect safe diagnostics.' }); process.exitCode = 1; });

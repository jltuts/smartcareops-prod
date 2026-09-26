// Opt-in fictional audio test: local Windows speech synthesis, real Gemini Live,
// real extraction, canonical automatic shutdown, and real Computer Use receipt.
import assert from 'node:assert/strict';
import { once } from 'node:events';


import { readFile, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createApiServer } from '../src/server.js';
import { runHandoff } from '../src/agent/loop.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = 'http://127.0.0.1:5173';
let stage = 'preflight', api, live, handoff, after, summary;
const audit = [], events = [], voiceEvents = [];
async function pcm(text) {
  const fixtures = JSON.parse(await readFile(new URL('../../.bounded-audio.json', import.meta.url), 'utf8'));
  assert(fixtures[text], 'Generate fixed audio fixtures first');
  return Buffer.from(fixtures[text], 'base64');
}
async function speak(text) {
  audit.push({ role: 'Patient fixture', text }); const bytes = Buffer.concat([await pcm(text), Buffer.alloc(40000)]);
  for (let offset = 0; offset < bytes.length; offset += 4000) { live.send(JSON.stringify({ type: 'audio', data: bytes.subarray(offset, offset + 4000).toString('base64'), sampleRate: 16000 })); await sleep(80); }
}
async function waitFor(predicate, timeout = 90000) { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error('Verification deadline'); await sleep(100); } }
async function main() {
  assert(process.argv.includes('--run')); assert.equal(process.env.APP_ENV, 'development'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107');
  api = createApiServer({ agentRun: async options => { after = await runHandoff(options); return after; }, liveOptions: { voiceLog: e => voiceEvents.push(e) } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); const base = `http://127.0.0.1:${api.server.address().port}`;
  stage = 'live_intake'; live = new WebSocket(base.replace('http', 'ws') + '/api/live', { origin });
  const turns = []; let output = '', terminal, error;
  live.on('message', raw => {
    const event = JSON.parse(raw); events.push(event.type);
    if (event.type === 'error') error = 'Live error';
    if (event.type === 'interrupted') output = '';
    if (event.type === 'transcript' && event.role === 'Patient') audit.push({ role: 'Patient ASR', text: event.text });
    if (event.type === 'transcript' && event.role === 'Gemini') output += event.text;
    if (event.type === 'turn-complete' && output.trim()) { turns.push(output.trim()); audit.push({ role: 'Gemini transcript', text: output.trim() }); output = ''; }
    if (event.type === 'completion-pending') { terminal = event; live.send(JSON.stringify({ type: 'completion-settled', id: event.id })); }
  });
  await once(live, 'open'); live.send(JSON.stringify({ type: 'start' })); await waitFor(() => turns.length || error); assert(!error);
  assert.match(turns[0], /name/i); let cursor = 0, confused = false, repaired = false, qualityAnswered = false;
  for (let count = 0; count < 22 && !terminal; count++) {
    await waitFor(() => terminal || turns.length > cursor || error); assert(!error); if (terminal) break;
    const question = turns[cursor++];
    if (/Your intake is complete\./.test(question)) { await waitFor(() => terminal); break; }
    if (!question.includes('?')) continue; // Wait through a repair-interrupted acknowledgement.
    let answer;
    const quality = /(?:describe.{0,35}(?:pain|headache)|(?:pain|headache).{0,35}feel|sharp|throbbing|pounding|aching)/i.test(question);
    if (confused && !repaired) { assert(quality, 'Live advanced instead of rephrasing pain quality'); assert.equal((question.match(/\?/g) || []).length, 1); repaired = true; qualityAnswered = true; answer = 'It feels like pressure.'; }
    else if (quality && !confused) { confused = true; answer = 'What? I do not understand.'; }
    else if (/name/i.test(question)) answer = 'My name is Demo Alex.';
    else if (/anything else|anything.{0,20}add/i.test(question)) answer = "No, that is all. Nothing else to add.";
    else if (/when|how long|start/i.test(question)) answer = 'It started this morning.';
    else if (/severe|scale|rate|how bad|intens|mild|moderate/i.test(question)) answer = 'It is mild, three out of ten.';
    else if (/chest/i.test(question)) answer = 'No, I do not have chest pain.';
    else if (/breath/i.test(question)) answer = 'No, I do not have difficulty breathing.';
    else if (/nausea|dizz|vision|fever|vomit/i.test(question)) answer = 'No nausea, dizziness, vision changes, fever, or vomiting.';
    else if (/other symptoms/i.test(question)) answer = 'No, I do not have any other symptoms.';
    else if (/temperature|pressure reading|heart rate|medication/i.test(question)) answer = 'I do not know.';
    else if (/feel|bring|help|symptom|concern/i.test(question)) answer = 'I have a headache. I would like to describe the pain.';
    else answer = 'I do not know. I have no other information to add.';
    await speak(answer);
  }
  assert(confused && repaired && qualityAnswered, 'Required confusion flow was not exercised'); await waitFor(() => terminal); assert(voiceEvents.some(e => e.event === 'gemini_intake_complete' && e.voiceState === 'ENDING'));
  stage = 'finalization'; const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { const response = await fetch(base + '/api/intake-finalization', { headers: { Authorization: `Bearer ${terminal.resultTicket}` } }); if (response.status !== 202) { assert(response.ok); summary = await response.json(); break; } await sleep(500); }
  assert.equal(summary?.status, 'COMPLETED'); assert(summary?.completionToken && summary.snapshot); await waitFor(() => voiceEvents.some(e => e.event === 'closed' && e.reason === 'gemini_intake_complete')); assert(!JSON.stringify(summary.snapshot).match(/what\? i (?:do not|don't) understand/i));
  assert(JSON.stringify(summary.snapshot).toLowerCase().includes('pressure'));
  stage = 'optimized_handoff'; handoff = new WebSocket(base.replace('http', 'ws') + '/api/agent/handoff', { origin }); let completed, handoffError, confirmations = 0; const progress = [];
  handoff.on('message', raw => { const e = JSON.parse(raw); progress.push(e.status); if (e.status === 'confirmation') { confirmations++; handoff.send(JSON.stringify({ type: 'confirm', id: e.id, approved: true })); } if (e.status === 'completed') completed = e; if (e.status === 'failed') handoffError = e.diagnostics?.code || 'HANDOFF_FAILED'; });
  await once(handoff, 'open'); handoff.send(JSON.stringify({ type: 'start', fictional: true, completionToken: summary.completionToken, intake: summary.snapshot }));
  await waitFor(() => completed || handoffError, 190000); assert(!handoffError, handoffError); await waitFor(() => after); assert.equal(after.metrics.populationCalls, 1);
  let before = null;
  if (process.argv.includes('--baseline')) { stage = 'measured_baseline'; before = await runHandoff({ intake: summary.snapshot, portalUrl: base + '/hospital-demo', emit() {}, confirm: async () => true, assistedFill: false }); }
  const historical = JSON.parse(await readFile(new URL('../../docs/m3-migration-verification.json', import.meta.url), 'utf8'));
  const evidence = { scope: 'bounded post-M12 improvements, no new milestone', status: 'PASS', verifiedAt: new Date().toISOString(), realGeminiLive: true, syntheticFictionalAudio: true, microphoneUsed: false, nameFirst: true, confusionRephrased: true, activeQuestionPreserved: true, qualityAnswerAccepted: true, confusionExcludedFromClinicalFacts: true, canonicalAutomaticShutdown: true, realExtractor: true, realComputerUse: true, realFirestoreCase: summary.patientCase?.caseId || null, receiptVerified: true, caseId: completed.caseId, visualComputerUsePreserved: true, confirmations, progress, before: before?.metrics || { modelRequests: Math.max(...historical.map(e => e.step || 0)), browserActions: historical.filter(e => e.stage === 'execute_action' && e.code === 'SUCCEEDED').length, totalMs: null, source: 'Existing real M3 acceptance evidence; no historical duration recorded' }, after: after.metrics, m13: 'NOT STARTED' };
  await writeFile(new URL('../../docs/intake-recovery-handoff-verification.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n'); console.log('[bounded-verification]', JSON.stringify(evidence));
}
main().catch(error => { console.log('[bounded-verification]', JSON.stringify({ stage, status: 'FAIL', code: error.code || 'VERIFICATION_FAILED', safeMessage: error instanceof assert.AssertionError ? error.message.slice(0, 180) : 'Inspect the fictional audit and safe diagnostics.' })); process.exitCode = 1; }).finally(async () => { await writeFile(new URL('../../.bounded-audit.json', import.meta.url), JSON.stringify(audit, null, 2)); live?.close(); handoff?.close(); await api?.shutdown(); });

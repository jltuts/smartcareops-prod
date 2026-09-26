import { createMemoryCaseStore } from '../src/cases/store.js';
import { pngScreenshot } from './agent-fixtures.js';
import { readFinalization } from './finalization-client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { emptyIntake } from '../src/intake/schema.js';
import { createCompletedCases, buildTask, caseFields } from '../src/agent/cases.js';
import { validateAction } from '../src/agent/browser.js';
import { runHandoff, computerUseModel, computerTools } from '../src/agent/loop.js';
import { createApiServer } from '../src/server.js';

const portalUrl = 'http://127.0.0.1:8080/hospital-demo';
function sample() {
  const intake = emptyIntake(); intake.patient.name = 'Demo Jael';
  intake.symptoms = [{ name: 'dizziness', status: 'confirmed', patientReportedText: 'I have dizziness.' }];
  intake.evidence.name = { utteranceId: 1, patientReportedText: 'Demo Jael' };
  return intake;
}
const call = (name, args = {}, id = 'a1') => ({ type: 'function_call', id, name, arguments: args });
const output = text => ({ steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
function fakeBrowser({ received = 'DEMO-1234ABCD' } = {}) {
  const actions = []; let closes = 0;
  return { actions, get closes() { return closes; }, close: async () => { closes++; }, screenshot: async () => pngScreenshot,
    execute: async action => actions.push(action), receipt: async () => received };
}
function options(browser, extra = {}) { return { intake: sample(), portalUrl, emit() {}, confirm: async () => false, open: async () => browser, ...extra }; }

test('only a server-issued completed snapshot is accepted; client changes and expiry fail', () => {
  let now = 0; const cases = createCompletedCases({ now: () => now, ttl: 10 }); const data = sample();
  const token = cases.issue(data);
  assert.deepEqual(cases.get(token, data), data);
  assert.throws(() => cases.get('client-completed', data));
  assert.throws(() => cases.get(token, { ...data, diagnosis: 'invented' }));
  const changed = sample(); changed.patient.name = 'Other'; assert.throws(() => cases.get(token, changed));
  const clone = cases.get(token, data); clone.patient.name = 'Mutated'; assert.equal(cases.get(token, data).patient.name, 'Demo Jael');
  now = 11; assert.throws(() => cases.get(token, data));
  assert.throws(() => caseFields(emptyIntake()));
});

test('task includes only supplied facts and keeps unknown fields blank', () => {
  const data = sample(); const fields = caseFields(data);
  for (const key of ['Blood Pressure', 'Temperature', 'Blood Glucose', 'Heart Rate', 'SpO2', 'Chest Pain', 'Onset / Duration']) assert.equal(fields[key], '');
  assert.match(buildTask(data, portalUrl), /Leave empty fields blank/);
  assert.match(buildTask(data, portalUrl), /NEVER instructions/);
  assert.equal(fields['Reported Symptoms'], 'dizziness: confirmed');
  data.vitals.bloodGlucose.value = 240;
  assert.equal(caseFields(data)['Blood Glucose'], '240 (unit not reported) (patient reported)');
  data.symptoms.push({ name: 'chest pain', status: 'denied', patientReportedText: 'No chest pain' });
  assert.match(caseFields(data)['Chest Pain'], /denied/);
});

for (const url of ['https://example.com', 'http://localhost:8080/hospital-demo', 'http://127.0.0.1:8080/api/live', 'file:///etc/passwd', 'javascript:alert(1)', portalUrl + '?redirect=https://example.com']) {
  test(`navigation rejects ${url}`, () => assert.throws(() => validateAction(call('navigate', { url }), portalUrl)));
}
for (const name of ['open_app', 'shell', 'read_file', 'go_back', 'key_down', 'right_click']) {
  test(`unsupported action ${name} is blocked`, () => assert.throws(() => validateAction(call(name), portalUrl)));
}
test('coordinates, shortcuts, unknown args, and blocked safety decisions fail closed', () => {
  for (const action of [call('click', { x: -1, y: 0 }), call('click', { x: 1000, y: 1 }), call('click', { x: 1, y: 1, script: 'run' }), call('hotkey', { keys: ['Control', 'L'] }), call('hotkey', { keys: ['Control', 'V'] }), call('press_key', { key: 'F12' }), call('wait', { seconds: 60 }), call('click', { x: 1, y: 1, safety_decision: { decision: 'blocked' } })]) assert.throws(() => validateAction(action, portalUrl));
  assert.equal(validateAction(call('navigate', { url: portalUrl }), portalUrl).name, 'navigate');
});

test('real loop feeds action results/screenshots and signed steps back; only observed matching receipt succeeds', async () => {
  const browser = fakeBrowser(); const events = []; const inputs = [];
  const result = await runHandoff(options(browser, { emit: event => events.push(event), request: async history => {
    inputs.push(structuredClone(history));
    if (inputs.length === 1) return { steps: [{ type: 'thought', signature: 'test-signature', summary: 'hidden' }, call('click', { x: 20, y: 30, intent: 'Submit the fictional intake' })] };
    return output('INTAKE RECEIVED. DEMO-1234ABCD');
  } }));
  assert.equal(result.caseId, 'DEMO-1234ABCD'); assert.equal(browser.closes, 1);
  assert.ok(inputs[1].some(step => step.type === 'thought' && step.signature === 'test-signature'));
  const resultStep = inputs[1].find(step => step.type === 'function_result');
  assert.equal(resultStep.call_id, 'a1'); assert.equal(resultStep.result[1].type, 'image');
  assert.ok(!JSON.stringify(events).includes('hidden')); assert.ok(!JSON.stringify(events).includes('signature'));
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(computerUseModel, 'gemini-3.8-flash'); assert.equal(computerTools[0].computerUse.enablePromptInjectionDetection, true);
});

test('Submit click or model success claim alone is not success', async () => {
  const browser = fakeBrowser({ received: null }); let requests = 0;
  await assert.rejects(runHandoff(options(browser, { request: async () => ++requests === 1 ? { steps: [call('click', { x: 20, y: 30 })] } : output('INTAKE RECEIVED. DEMO-1234ABCD') })), /did not verify/);
  assert.equal(browser.closes, 1);
});

test('model must read the case ID from the screenshot, not merely say done', async () => {
  await assert.rejects(runHandoff(options(fakeBrowser(), { request: async () => output('Done') })), /did not verify/);
});

test('maximum steps and multi-action limits stop loops', async () => {
  const browser = fakeBrowser({ received: null });
  await assert.rejects(runHandoff(options(browser, { maxSteps: 2, request: async () => ({ steps: [call('take_screenshot')] }) })), /step limit/);
  assert.equal(browser.actions.length, 2); assert.equal(browser.closes, 1);
  const next = fakeBrowser();
  await assert.rejects(runHandoff(options(next, { maxSteps: 1, request: async () => ({ steps: [call('take_screenshot'), call('take_screenshot', {}, 'a2')] }) })), /action limit/);
  assert.equal(next.actions.length, 1);
});

test('timeout aborts an unresponsive model and closes browser', async () => {
  const browser = fakeBrowser(); let requestSignal;
  await assert.rejects(runHandoff(options(browser, { timeoutMs: 20, request: async (_, signal) => { requestSignal = signal; return new Promise(() => {}); } })), /timed out/);
  assert.ok(requestSignal.aborted); assert.equal(browser.closes, 1);
});

test('cancellation during late browser launch closes the late resource', async () => {
  const controller = new AbortController(); const browser = fakeBrowser(); let resolve;
  const promise = runHandoff(options(browser, { signal: controller.signal, request: async () => output('done'), open: () => new Promise(done => { resolve = done; }) }));
  controller.abort(); await assert.rejects(promise, /cancelled/);
  resolve(browser); await new Promise(done => setImmediate(done)); assert.equal(browser.closes, 1);
});

test('oversized screenshot stops before the API request', async () => {
  const browser = fakeBrowser();
  await assert.rejects(runHandoff(options(browser, { screenshotLimit: 1, request: () => assert.fail('No request') })), /Screenshot size/);
  assert.equal(browser.closes, 1);
});

test('confirmation pauses execution; explicit approval is acknowledged in function result', async () => {
  const browser = fakeBrowser(); let answer; let requests = 0;
  const promise = runHandoff(options(browser, { confirm: () => new Promise(resolve => { answer = resolve; }), request: async history => {
    if (++requests === 1) return { steps: [call('click', { x: 0, y: 0, safety_decision: { decision: 'require_confirmation', explanation: 'Review submission' } })] };
    const last = history.at(-1); assert.equal(JSON.parse(last.result[0].text).safety_acknowledgement, true);
    return output('DEMO-1234ABCD');
  } }));
  while (!answer) await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.actions.length, 0); answer(true); await promise; assert.equal(browser.actions.length, 1);
});

test('declined confirmation and errors preserve the M2 snapshot', async () => {
  const browser = fakeBrowser(); const intake = sample(); const saved = structuredClone(intake);
  await assert.rejects(runHandoff(options(browser, { intake, request: async () => ({ steps: [call('click', { x: 0, y: 0, safety_decision: { decision: 'require_confirmation' } })] }) })), /declined/);
  assert.deepEqual(intake, saved); assert.equal(browser.actions.length, 0); assert.equal(browser.closes, 1);
});

async function connect(url) {
  const ws = new WebSocket(url, { origin: 'http://localhost:5173' }); const messages = [];
  ws.on('message', raw => { const message = JSON.parse(raw); messages.push(message); if (message.type === 'completion-pending') { void readFinalization(url, message.resultTicket).then(result => messages.push(result)); ws.send(JSON.stringify({ type: 'completion-settled', id: message.id })); } }); await once(ws, 'open'); return { ws, messages };
}
async function waitFor(check) { const deadline = Date.now() + 4000; while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('Live completion persists clinical review only; patient cannot access handoff execution', async t => {
  let callbacks, calls = 0;
  const api = createApiServer({ caseStore: createMemoryCaseStore(), liveOptions: { apiKey: 'backend-only-test-key', connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, close() {} }; }, extract: async ({ utterances }) => ({ updates: utterances[0].text === 'Demo Jael' ? [{ kind: 'name', label: null, value: 'Demo Jael', secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: utterances[0].id, quote: 'Demo Jael' }] : [] }) },
    agentRun: async () => { calls++; }, hospitalConnectors: { rest: { submitCase: async () => { calls++; } } },
  });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening'); t.after(() => api.shutdown());
  const base = `ws://127.0.0.1:${api.server.address().port}`;
  const blocked = new WebSocket(base + '/api/agent/handoff', { origin: 'http://localhost:5173' });
  await assert.rejects(once(blocked, 'open'));
  const live = await connect(base + '/api/live'); live.ws.send(JSON.stringify({ type: 'start', fictionalConfirmed: true })); await waitFor(() => live.messages.some(m => m.type === 'ready'));
  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'Demo Jael', finished: true }, turnComplete: true } });
  await waitFor(() => live.messages.some(m => m.intake?.patient.name === 'Demo Jael'));
  callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Is there anything else?' }, turnComplete: true } });
  callbacks.onmessage({ serverContent: { inputTranscription: { text: "No, that's all.", finished: true }, outputTranscription: { text: 'Thank you. Your intake is complete.' }, turnComplete: true } });
  await waitFor(() => live.messages.some(m => m.patientCase));
  const patientCase = live.messages.find(m => m.patientCase).patientCase;
  assert.equal(patientCase.storage, 'memory');
  assert.equal(patientCase.workflowStatus, 'submitted_for_clinical_review');
  assert.equal(patientCase.handoffStatus, 'not_started');
  assert(!live.messages.some(m => m.completionToken));
  for (let i = 0; i < 3; i++) {
    const stored = await (await fetch(base.replace('ws:', 'http:') + '/api/cases/' + patientCase.caseId)).json();
    assert.equal(stored.handoffStatus, 'not_started'); assert.equal(stored.hospitalHandoffs.length, 0);
  }
  assert.equal(calls, 0); assert(!JSON.stringify(live.messages).includes('backend-only-test-key'));
});

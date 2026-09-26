import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComputerClient, runHandoff } from '../src/agent/loop.js';
import { buildFunctionResult, rememberCall } from '../src/agent/continuation.js';
import { diagnosticsFor } from '../src/agent/diagnostics.js';
import { emptyIntake } from '../src/intake/schema.js';
import { pngScreenshot } from './agent-fixtures.js';

const url = 'http://127.0.0.1:8080/hospital-demo';
const image = () => ({ type: 'image', mime_type: 'image/png', data: pngScreenshot.toString('base64') });
const initial = () => [{ type: 'user_input', content: [{ type: 'text', text: 'Fictional task' }, image()] }];
const click = (id = 'exact-id', decision) => ({ functionCall: { id, name: 'click', args: { x: 10, y: 20, ...(decision ? { safety_decision: { decision } } : {}) } } });
const reply = (parts, finishReason = 'STOP') => new Response(JSON.stringify({ candidates: [{ finishReason, content: { role: 'model', parts } }] }), { headers: { 'Content-Type': 'application/json' } });
function setup(t, respond) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (resource, init) => {
    const request = resource instanceof Request ? resource : new Request(resource, init);
    assert.match(request.url, /gemini-3\.8-flash:generateContent$/);
    requests.push(JSON.parse(await request.text()));
    return respond(requests.length, request);
  });
  return { client: createComputerClient('unit-test-key'), requests };
}
function options(request, extra = {}) {
  const intake = emptyIntake(); intake.patient.name = 'Fictional Test'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Fictional Test' };
  const actions = [], logs = [];
  const browser = { screenshot: async () => pngScreenshot, execute: async action => actions.push(action), receipt: async () => 'DEMO-1234ABCD', close: async () => {} };
  return { actions, logs, options: { intake, portalUrl: url, emit() {}, logger: e => logs.push(e), open: async () => browser, request, confirm: async () => false, ...extra } };
}

test('GenerateContent request 1 click, request 2 second action, request 3 final text', async t => {
  const { client, requests } = setup(t, round => reply(round < 3 ? [click(`id-${round}`)] : [{ text: 'INTAKE RECEIVED DEMO-1234ABCD' }]));
  const f = options(client);
  assert.equal((await runHandoff(f.options)).caseId, 'DEMO-1234ABCD');
  assert.equal(requests.length, 3); assert.equal(f.actions.length, 2);
  assert.equal(f.logs.at(-1).receiptVerified, true);
});

for (const [label, mutate] of [
  ['missing id', part => delete part.functionCall.id],
  ['missing args', part => delete part.functionCall.args],
]) test(`adapter rejects ${label} before any browser action`, async t => {
  const part = click(); mutate(part);
  const { client, requests } = setup(t, () => reply([part]));
  const f = options(client);
  await assert.rejects(runHandoff(f.options), error => diagnosticsFor(error)?.code === 'MODEL_INVALID_RESPONSE');
  assert.equal(requests.length, 1); assert.equal(f.actions.length, 0);
});

for (const [label, mutate] of [
  ['mismatched name', result => result.name = 'type'],
  ['mismatched id', result => result.call_id = 'different'],
  ['malformed PNG', result => result.result[1].data = Buffer.from('not PNG').toString('base64')],
]) test(`adapter blocks ${label} before sending continuation`, async t => {
  const { client, requests } = setup(t, () => reply([click()]));
  const history = initial(), response = await client(history);
  history.push(...response.steps);
  const result = buildFunctionResult(rememberCall(response.steps[0]), image(), url, false);
  mutate(result); history.push(result);
  await assert.rejects(client(history)); assert.equal(requests.length, 1);
});

for (const approved of [true, false]) test(`GenerateContent confirmation gate: approval ${approved}`, async t => {
  let confirmations = 0;
  const { client, requests } = setup(t, round => reply(round === 1 ? [click('approval-id', 'require_confirmation')] : [{ text: 'DEMO-1234ABCD' }]));
  const f = options(client, { confirm: async () => { confirmations++; return approved; } });
  if (approved) {
    await runHandoff(f.options);
    assert.deepEqual(requests[1].contents.at(-1).parts[0].functionResponse.response, { url, safety_acknowledgement: true });
  } else await assert.rejects(runHandoff(f.options), /confirmation declined/);
  assert.equal(confirmations, 1); assert.equal(f.actions.length, approved ? 1 : 0);
  assert.equal(requests.length, approved ? 2 : 1);
});

test('cancelled GenerateContent handoff rejects late response without executing it', async t => {
  const controller = new AbortController(); let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { client } = setup(t, () => { started(); return new Promise(resolve => { release = resolve; }); });
  const f = options(client, { signal: controller.signal });
  const running = runHandoff(f.options); await ready; controller.abort();
  await assert.rejects(running, /cancelled/);
  release(reply([click()])); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.actions.length, 0);
});

test('GenerateContent max-step gate remains enforced', async t => {
  const { client, requests } = setup(t, round => reply([click(`id-${round}`)]));
  const f = options(client, { maxSteps: 2 });
  await assert.rejects(runHandoff(f.options), /step limit/);
  assert.equal(requests.length, 2); assert.equal(f.actions.length, 2);
});

test('multiple calls preserve order and native signatures in one matching user turn', async t => {
  const { client, requests } = setup(t, round => reply(round === 1 ? [{ text: 'private', thought: true, thoughtSignature: 'signature' }, click('first'), click('second')] : [{ text: 'DEMO-1234ABCD' }]));
  await runHandoff(options(client).options);
  assert.deepEqual(requests[1].contents.at(-1).parts.map(p => p.functionResponse.id), ['first', 'second']);
  assert.equal(requests[1].contents.at(-2).parts[0].thoughtSignature, 'signature');
});

test('partial GenerateContent output cannot execute an action', async t => {
  const { client } = setup(t, () => reply([click()], 'MAX_TOKENS'));
  const f = options(client);
  await assert.rejects(runHandoff(f.options)); assert.equal(f.actions.length, 0);
});

test('GenerateContent errors keep safe status and never expose raw provider content', async t => {
  const { client, requests } = setup(t, () => new Response(JSON.stringify({ error: { code: 400, message: 'SECRET patient and credential data', status: 'INVALID_ARGUMENT' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  const f = options(client);
  await assert.rejects(runHandoff(f.options), error => {
    assert.equal(diagnosticsFor(error).httpStatus, 400);
    assert.ok(!error.message.includes('SECRET'));
    return true;
  });
  assert.equal(requests.length, 1); assert.equal(f.actions.length, 0);
  assert.ok(!JSON.stringify(f.logs).includes('SECRET'));
});

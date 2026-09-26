import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComputerClient, runHandoff, computerUseModel } from '../src/agent/loop.js';
import { rememberCall, buildFunctionResult, continuationMetadata, assertContinuation, isPng } from '../src/agent/continuation.js';
import { safeApiError } from '../src/agent/api-diagnostics.js';
import { diagnosticsFor } from '../src/agent/diagnostics.js';
import { emptyIntake } from '../src/intake/schema.js';
import { pngScreenshot } from './agent-fixtures.js';

const portalUrl = 'http://127.0.0.1:8080/hospital-demo';
const screenshot = () => ({ type: 'image', data: pngScreenshot.toString('base64'), mime_type: 'image/png' });
const call = (id = 'abc123', decision) => ({ type: 'function_call', name: 'click', id, arguments: { x: 1, y: 2, ...(decision ? { safety_decision: { decision } } : {}) } });
const receipt = { type: 'model_output', content: [{ type: 'text', text: 'DEMO-1234ABCD' }] };
function fixture(extra = {}) {
  const intake = emptyIntake(); intake.patient.name = 'Fictional Test'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Fictional Test' };
  const actions = [], logs = [];
  const browser = { screenshot: async () => pngScreenshot, execute: async action => actions.push(action), receipt: async () => 'DEMO-1234ABCD', close: async () => {} };
  return { browser, actions, logs, options: { intake, portalUrl, emit() {}, logger: entry => logs.push(entry), open: async () => browser, confirm: async () => false, ...extra } };
}

test('installed SDK serializes four GenerateContent loop requests with exact IDs, PNGs and native signed history', async t => {
  const requests = [];
  const modelSteps = [call(), call('next-2'), call('next-3')];
  const signedThought = { text: 'never log this', thought: true, thoughtSignature: 'signed-test-token' };
  t.mock.method(globalThis, 'fetch', async (resource, init) => {
    assert.match(resource instanceof Request ? resource.url : String(resource), /:generateContent$/);
    const request = JSON.parse(resource instanceof Request ? await resource.text() : init.body); requests.push(request);
    const index = requests.length - 1, action = modelSteps[index];
    const parts = action ? [signedThought, { functionCall: { name: action.name, id: action.id, args: action.arguments } }] : [{ text: 'DEMO-1234ABCD' }];
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const f = fixture({ request: createComputerClient('fake-unit-test-key') });
  await runHandoff(f.options);
  assert.equal(requests.length, 4); assert.equal(f.actions.length, 3);
  for (let i = 1; i < requests.length; i++) {
    const request = requests[i];
    assert.equal(Object.hasOwn(request, 'input'), false);
    assert.equal(Object.hasOwn(request, 'previous_interaction_id'), false);
    const original = request.contents.at(-2).parts[1].functionCall;
    const result = request.contents.at(-1).parts[0].functionResponse;
    assert.equal(result.id, modelSteps[i - 1].id); assert.equal(result.id, original.id);
    assert.equal(result.name, original.name); assert.equal(result.name, 'click');
    assert.deepEqual(result.response, { url: portalUrl });
    assert.deepEqual(result.parts, [{ inlineData: { mimeType: 'image/png', data: screenshot().data } }]);
    assert.deepEqual(request.contents.filter(turn => turn.role === 'model').map(turn => turn.parts[0]), Array(i).fill(signedThought));
    assert.deepEqual(request.contents.slice(0, requests[i - 1].contents.length), requests[i - 1].contents);
    assert.ok(!JSON.stringify(request).includes('function_result'));
  }
  const metadata = f.logs.filter(entry => entry.stage === 'model_request_prepare');
  assert.ok(metadata.length >= 3);
  assert.ok(metadata.every(entry => entry.callIdMatchesPrevious && entry.functionNameMatchesPrevious && entry.screenshotValid && entry.originalCallUnchanged));
  assert.ok(f.logs.every(entry => entry.transport === 'generate_content'));
  const logs = JSON.stringify(f.logs);
  for (const hidden of ['fake-unit-test-key', 'signed-test-token', 'never log this', screenshot().data, 'abc123']) assert.ok(!logs.includes(hidden));
});

for (const [label, mutate] of [
  ['missing call_id', result => { delete result.call_id; }],
  ['wrong call_id', result => { result.call_id = 'wrong'; }],
  ['wrong name', result => { result.name = 'type'; }],
  ['JPEG MIME', result => { result.result[1].mime_type = 'image/jpeg'; }],
  ['JPEG bytes relabelled PNG', result => { result.result[1].data = Buffer.from([255, 216, 255]).toString('base64'); }],
  ['malformed base64', result => { result.result[1].data += '!!'; }],
  ['missing screenshot', result => { result.result.pop(); }],
  ['wrong URL', result => { result.result[0].text = JSON.stringify({ url: 'http://example.com' }); }],
  ['object instead of text JSON', result => { result.result[0].text = { url: portalUrl }; }],
  ['extra unsupported field', result => { result.arguments = {}; }],
  ['unnecessary acknowledgement', result => { result.result[0].text = JSON.stringify({ url: portalUrl, safety_acknowledgement: true }); }],
]) {
  test(`continuation gate rejects ${label}`, () => {
    const original = call(), saved = rememberCall(original), result = buildFunctionResult(saved, screenshot(), portalUrl, false);
    mutate(result);
    assert.throws(() => assertContinuation(continuationMetadata(saved, result, portalUrl, false, undefined, original)), /continuation could not be validated/);
  });
}

for (const [label, mutate] of [
  ['id', action => { action.id = 'wrong'; }],
  ['name', action => { action.name = 'type'; }],
]) {
  test(`loop blocks changed response ${label} before request 2`, async () => {
    let requests = 0;
    const f = fixture({ request: async () => { requests++; return { steps: [call()] }; } });
    f.browser.execute = async action => mutate(action);
    await assert.rejects(runHandoff(f.options), error => diagnosticsFor(error)?.code === 'MODEL_INVALID_RESPONSE');
    assert.equal(requests, 1);
  });
}

test('missing SDK response id blocks execution and next request (call_id is not the response field)', async () => {
  let requests = 0;
  const f = fixture({ request: async () => { requests++; const action = call(); delete action.id; action.call_id = 'abc123'; return { steps: [action] }; } });
  await assert.rejects(runHandoff(f.options), /Unsupported browser action/);
  assert.equal(requests, 1); assert.equal(f.actions.length, 0);
});

test('malformed post-action screenshot blocks request 2', async () => {
  let requests = 0, shots = 0;
  const f = fixture({ request: async () => { requests++; return { steps: [call()] }; } });
  f.browser.screenshot = async () => ++shots === 1 ? pngScreenshot : Buffer.from('not a PNG');
  await assert.rejects(runHandoff(f.options), error => diagnosticsFor(error)?.code === 'SCREENSHOT_FAILED');
  assert.equal(requests, 1);
  assert.equal(isPng(pngScreenshot.subarray(0, -1)), false);
});

test('required acknowledgement cannot be omitted or fabricated without approval', () => {
  const original = call('abc123', 'require_confirmation'), saved = rememberCall(original);
  const result = buildFunctionResult(saved, screenshot(), portalUrl, true);
  assert.doesNotThrow(() => assertContinuation(continuationMetadata(saved, result, portalUrl, true, undefined, original)));
  assert.throws(() => assertContinuation(continuationMetadata(saved, result, portalUrl, false, undefined, original)));
  result.result[0].text = JSON.stringify({ url: portalUrl });
  assert.throws(() => assertContinuation(continuationMetadata(saved, result, portalUrl, true, undefined, original)));
});

for (const [decision, approve, expectedRequests] of [['allowed', false, 2], ['regular', false, 2], ['require_confirmation', true, 2], ['require_confirmation', false, 1]]) {
  test(`loop safety ${decision}, approval ${approve}`, async () => {
    let requests = 0, confirmations = 0;
    const f = fixture({ confirm: async () => { confirmations++; return approve; }, request: async history => {
      if (++requests === 1) return { steps: [call('abc123', decision)] };
      const state = JSON.parse(history.at(-1).result[0].text);
      assert.equal(Object.hasOwn(state, 'safety_acknowledgement'), decision === 'require_confirmation');
      if (decision === 'require_confirmation') assert.equal(state.safety_acknowledgement, true);
      return { steps: [receipt] };
    } });
    if (expectedRequests === 1) await assert.rejects(runHandoff(f.options), /confirmation declined/);
    else await runHandoff(f.options);
    assert.equal(requests, expectedRequests);
    assert.equal(confirmations, decision === 'require_confirmation' ? 1 : 0);
    assert.equal(f.actions.length, expectedRequests - 1);
  });
}

test('safe API body diagnostics preserve the observed 400 without leaking unrecognized text', () => {
  const message = 'Computer Use Model requires function response to contain an image of mime_type image/png in the data.inline_data field.';
  for (const error of [{ status: 400, error: { code: 'invalid_request', message } }, { statusCode: 400, body: JSON.stringify({ error: { code: 'invalid_request', message } }) }]) {
    assert.deepEqual(safeApiError(error), { httpStatus: 400, apiErrorCode: 'invalid_request', apiErrorMessage: message });
  }
  const unsafe = { status: 400, error: { code: 'secret-credential', message: `Authorization: Bearer secret-credential; password: input; ${screenshot().data}; https://example.com?key=secret-credential` }, headers: { Authorization: 'secret-credential' } };
  const safe = safeApiError(unsafe);
  assert.equal(safe.apiErrorCode, null);
  for (const secret of ['secret-credential', 'password', 'input', screenshot().data, 'example.com']) assert.ok(!JSON.stringify(safe).includes(secret));
});

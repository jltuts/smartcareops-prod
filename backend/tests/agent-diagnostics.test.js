import { pngScreenshot } from './agent-fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHandoff } from '../src/agent/loop.js';
import { createAgentDiagnostics, diagnosticsFor, tagAgentError } from '../src/agent/diagnostics.js';
import { emptyIntake } from '../src/intake/schema.js';

const portalUrl = 'http://127.0.0.1:8080/hospital-demo';
const secret = 'never-log-this-secret';
const action = { type: 'function_call', id: 'a', name: 'click', arguments: { x: 10, y: 10, intent: 'Focus Patient Name input field' } };
const output = { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'DEMO-1234ABCD' }] }] };
function fixture(extra = {}) {
  const intake = emptyIntake(); intake.patient.name = 'Fictional Diagnostic Test'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Fictional Diagnostic Test' };
  const logs = []; const events = []; let rounds = 0;
  const browser = { close: async () => {}, screenshot: async () => pngScreenshot, execute: async () => {}, receipt: async () => 'DEMO-1234ABCD' };
  return { logs, events, browser, options: { intake, portalUrl, logger: entry => logs.push(entry), emit: event => events.push(event), confirm: async () => false, open: async () => browser, request: async () => ++rounds === 1 ? { steps: [action] } : output, ...extra } };
}

test('second model failure retains preceding action context without leaking SDK data', async () => {
  let rounds = 0;
  const f = fixture({ request: async () => { if (++rounds === 1) return { steps: [action] }; throw Object.assign(new Error(`Authorization: Bearer ${secret}`), { status: 400, headers: { secret } }); } });
  await assert.rejects(runHandoff(f.options), error => {
    const d = diagnosticsFor(error);
    assert.equal(d.stage, 'model_request'); assert.equal(d.code, 'MODEL_REQUEST_FAILED');
    assert.equal(d.step, 2); assert.equal(d.actionType, 'click'); assert.equal(d.intent, action.arguments.intent);
    assert.equal(d.modelCallStarted, true); assert.equal(d.modelCallSucceeded, false);
    assert.equal(d.actionExecuted, true); assert.equal(d.screenshotCaptured, true);
    assert.equal(d.verificationSucceeded, null); assert.equal(d.receiptVerified, false);
    return true;
  });
  assert.ok(!JSON.stringify(f.logs).includes(secret));
  assert.ok(f.logs.some(d => d.stage === 'post_action_screenshot' && d.code === 'SUCCEEDED'));
});

for (const [stage, code] of Object.entries({ browser_launch: 'BROWSER_LAUNCH_FAILED', portal_navigation: 'PORTAL_NAVIGATION_FAILED', screenshot: 'SCREENSHOT_FAILED', model_request: 'MODEL_REQUEST_FAILED', parse_response: 'MODEL_INVALID_RESPONSE', validate_action: 'ACTION_NOT_ALLOWED', execute_action: 'ACTION_EXECUTION_FAILED', verify_action: 'ACTION_VERIFICATION_FAILED', receipt_verification: 'RECEIPT_VERIFICATION_FAILED', prepare: 'UNKNOWN_AGENT_ERROR' })) {
  test(`safe classification: ${code}`, () => {
    const logs = []; const d = createAgentDiagnostics(`https://user:${secret}@example.com/?token=${secret}`, entry => logs.push(entry));
    d.action({ name: secret, arguments: { intent: secret } }); d.mark(stage);
    const result = d.fail(new Error(secret));
    assert.equal(result.code, code); assert.equal(result.url, null);
    assert.ok(!JSON.stringify(logs).includes(secret));
  });
}

for (const code of ['CANCELLED', 'TIMEOUT', 'PORTAL_STATE_MISMATCH']) {
  test(`explicit ${code} survives stage classification`, () => {
    const d = createAgentDiagnostics(portalUrl, () => {}); d.mark('execute_action');
    assert.equal(d.fail(tagAgentError(new Error(secret), code)).code, code);
  });
}

test('actual boundaries classify screenshot, parsing, validation, execution and receipt failures', async () => {
  for (const [code, configure] of [
    ['BROWSER_LAUNCH_FAILED', f => { f.options.open = async () => { throw new Error(secret); }; }],
    ['SCREENSHOT_FAILED', f => { f.browser.screenshot = async () => { throw new Error(secret); }; }],
    ['MODEL_INVALID_RESPONSE', f => { f.options.request = async () => ({ steps: null }); }],
    ['ACTION_NOT_ALLOWED', f => { f.options.request = async () => ({ steps: [{ ...action, name: secret }] }); }],
    ['ACTION_EXECUTION_FAILED', f => { f.browser.execute = async () => { throw new Error(secret); }; }],
    ['RECEIPT_VERIFICATION_FAILED', f => { f.options.request = async () => output; f.browser.receipt = async () => null; }],
  ]) {
    const f = fixture(); configure(f);
    await assert.rejects(runHandoff(f.options), error => diagnosticsFor(error)?.code === code);
    assert.ok(!JSON.stringify(f.logs).includes(secret));
    assert.ok(!f.events.some(event => event.status === 'completed'));
  }
});

test('successful run logs receipt verification and preserves model history', async () => {
  const f = fixture(); await runHandoff(f.options);
  assert.equal(f.logs.at(-1).receiptVerified, true);
  assert.ok(!JSON.stringify(f.logs).includes(secret));
});

test('Gemini status categories use structured metadata only', () => {
  for (const [status, category] of [[429, 'RATE_LIMIT'], [503, 'SERVICE_UNAVAILABLE'], [403, 'AUTH_ERROR'], [400, 'GEMINI_ERROR'], [504, 'TIMEOUT']]) {
    const d = createAgentDiagnostics(portalUrl, () => {}); d.mark('model_request');
    assert.equal(d.fail(Object.assign(new Error(secret), { status })).errorCategory, category);
  }
});

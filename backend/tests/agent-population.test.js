import test from 'node:test';
import assert from 'node:assert/strict';
import { runHandoff } from '../src/agent/loop.js';
import { validateAction } from '../src/agent/browser.js';
import { pngScreenshot } from './agent-fixtures.js';
import { emptyIntake } from '../src/intake/schema.js';
const portalUrl = 'http://127.0.0.1:8080/hospital-demo';
const fill = (extra = {}) => ({ type: 'function_call', id: 'fill1', name: 'populate_validated_intake', arguments: { observed_form: 'fictional_hospital_intake', ...extra } });
function fixture(request) {
  const intake = emptyIntake(); intake.patient.name = 'Demo Alex'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Demo Alex' };
  const seen = [], events = [], browser = { screenshot: async () => pngScreenshot, populateValidated: async fields => { seen.push(fields); return { fieldsVerified: 11 }; }, execute: async () => ({ receiptVisible: true }), receipt: async () => 'DEMO-1234ABCD', close: async () => {} };
  return { seen, events, options: { intake, portalUrl, open: async () => browser, request, emit: e => events.push(e), confirm: async () => false, logger() {} } };
}
test('population accepts only explicit visual confirmation and no model data or selectors', () => {
  validateAction(fill(), portalUrl);
  for (const extra of [{ observed_form: 'other' }, { fields: { name: 'injected' } }, { selector: '#submit' }, { url: 'https://invalid.test' }]) assert.throws(() => validateAction(fill(extra), portalUrl));
});
test('helper population is followed by screenshot review, model submit and verified receipt', async () => {
  let count = 0; const f = fixture(async history => {
    if (++count === 1) return { steps: [fill()] };
    if (count === 2) { assert.equal(history.at(-1).name, 'populate_validated_intake'); assert.equal(history.at(-1).result[1].mime_type, 'image/png'); return { steps: [{ type: 'function_call', id: 'submit', name: 'click', arguments: { x: 500, y: 900 } }] }; }
    return { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'INTAKE RECEIVED DEMO-1234ABCD' }] }] };
  });
  const result = await runHandoff(f.options); assert.equal(f.seen.length, 1); assert.equal(f.seen[0]['Patient Name'], 'Demo Alex'); assert.equal(f.seen[0]['Temperature'], '');
  assert.equal(result.metrics.modelRequests, 3); assert.equal(result.metrics.browserActions, 1); assert.equal(result.metrics.populationCalls, 1); assert.equal(result.metrics.fieldsVerified, 11);
  for (const status of ['opening', 'validating', 'populating', 'reviewing', 'verifying', 'completed']) assert(f.events.some(e => e.status === status));
});
test('population cannot batch submission, repeat, bypass confirmation or run when disabled', async () => {
  const mixed = fixture(async () => ({ steps: [fill(), { type: 'function_call', id: 'submit', name: 'click', arguments: { x: 1, y: 1 } }] })); await assert.rejects(runHandoff(mixed.options)); assert.equal(mixed.seen.length, 0);
  const repeat = fixture(async () => ({ steps: [fill()] })); await assert.rejects(runHandoff(repeat.options)); assert.equal(repeat.seen.length, 1);
  const denied = fixture(async () => ({ steps: [fill({ safety_decision: { decision: 'require_confirmation' } })] })); await assert.rejects(runHandoff(denied.options)); assert.equal(denied.seen.length, 0);
  const disabled = fixture(async () => ({ steps: [fill()] })); await assert.rejects(runHandoff({ ...disabled.options, assistedFill: false })); assert.equal(disabled.seen.length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizationFailure, FinalizationError } from '../src/intake/finalization.js';
import { createIntakeSession } from '../src/intake/session.js';
import { mergeIntake } from '../src/intake/validate.js';
import { emptyIntake } from '../src/intake/schema.js';

for (const [error, code] of [[{ status: 429 }, 'RATE_LIMIT'], [{ status: 503 }, 'SERVICE_UNAVAILABLE'], [{ name: 'TimeoutError' }, 'EXTRACTION_TIMEOUT'], [new Error('secret-key'), 'EXTRACTION_FAILED']]) {
  test(`drain preserves safe classified failure ${code}`, async t => {
    const session = createIntakeSession({ send() {}, log() {}, extract: async () => { throw error; } });
    t.after(() => session.close());
    session.accept({ inputTranscription: { text: 'My name is JL.', finished: true } });
    await assert.rejects(session.drain(), e => {
      assert.ok(e instanceof FinalizationError);
      assert.equal(e.detail.code, code);
      assert.deepEqual(e.detail.utteranceIds, [1]);
      assert.doesNotMatch(JSON.stringify(e.detail), /secret-key/);
      return true;
    });
  });
}
test('all finalization categories have safe messages', () => {
  for (const code of ['RATE_LIMIT','SERVICE_UNAVAILABLE','EXTRACTION_TIMEOUT','EXTRACTION_FAILED','INVALID_RESPONSE','VALIDATION_FAILED','UNRESOLVED_CLARIFICATION','EMPTY_INTAKE','CANCELLED','FINALIZATION_UNKNOWN']) {
    const detail = finalizationFailure(code, 'finalization', [1], { message: 'secret', apiKey: 'secret' });
    assert.equal(detail.code, code); assert.ok(detail.developerMessage); assert.ok(detail.userMessage);
    assert.doesNotMatch(JSON.stringify(detail), /secret/);
  }
});
test('arbitrary validation reason cannot leak through developer diagnostics', () => {
  const detail = finalizationFailure('VALIDATION_FAILED', 'validation', [6], { reason: 'secret-key' });
  assert.doesNotMatch(JSON.stringify(detail), /secret-key/);
  assert.match(detail.developerMessage, /Reason: invalid schema/);
});
test('closing during an active drain reports cancellation rather than an unknown failure', async () => {
  let started;
  const active = new Promise(resolve => { started = resolve; });
  const session = createIntakeSession({ send() {}, log() {}, extract: async () => { started(); return new Promise(() => {}); } });
  session.accept({ inputTranscription: { text: 'My name is JL.', finished: true } });
  const draining = session.drain();
  await active;
  session.close();
  await assert.rejects(draining, error => error.detail.code === 'CANCELLED' && error.detail.stage === 'drain');
});
test('one utterance supports two facts; empty updates preserve both', () => {
  const u = { id: 1, role: 'Patient', text: 'My blood pressure is 190 over 45 and my blood sugar is 195 mg/dL.' };
  const base = { label:null, secondaryValue:null, unit:null, qualitative:null, status:null, evidenceId:1, quote:u.text };
  const intake = mergeIntake(emptyIntake(), { updates: [
    { ...base, kind:'bloodPressure', value:190, secondaryValue:45 },
    { ...base, kind:'bloodGlucose', value:195, unit:'mg/dL' },
  ] }, [u]);
  assert.equal(intake.vitals.bloodPressure.diastolic,45);
  assert.equal(intake.vitals.bloodGlucose.value,195);
  assert.deepEqual(mergeIntake(intake,{updates:[]},[u]),intake);
});

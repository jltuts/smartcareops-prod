import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractor } from '../src/intake/extractor.js';
import { createIntakeSession } from '../src/intake/session.js';
import { supportedNoisyOnset } from '../src/intake/onset-asr.js';
import { mergeIntake } from '../src/intake/validate.js';
import { emptyIntake } from '../src/intake/schema.js';

const question = 'When did the dizziness start?';
const utterance = text => ({ id: 1, role: 'Patient', text, question });
for (const text of ['yesterday shark suddenly', 'yesterday television', 'yesterday football', 'yesterday ... [irrelevant words]', 'Yesterday SHARK   suddenly.']) {
  test(`onset question retains only temporal evidence: ${text}`, async t => {
    const extract = createExtractor('fictional', undefined, { request() { assert.fail('known contamination must not reach the model'); } });
    const session = createIntakeSession({ extract, send() {} });
    t.after(() => session.close());
    session.accept({ outputTranscription: { text: question }, turnComplete: true });
    session.accept({ inputTranscription: { text, finished: true } });
    const snapshot = await session.drain();
    assert.equal(snapshot.onset.value, 'yesterday');
    assert.equal(snapshot.onset.patientReportedText, text, 'original transcript remains auditable');
    assert.deepEqual(Object.keys(snapshot.evidence), ['onset']);
    assert.deepEqual(snapshot.symptoms, []);
    assert.deepEqual(snapshot.redFlags, []);
    assert.deepEqual(snapshot.additionalNotes, []);
    assert.deepEqual(snapshot.vitals, emptyIntake().vitals);
  });
}

test('onset rule does not delete arbitrary words, uncertainty, medical reports or corrections', () => {
  for (const text of ['maybe yesterday television', 'not yesterday football', 'yesterday but actually today', 'yesterday after football', 'yesterday I watched television', 'yesterday and my chest hurts', 'yesterday arbitrary words', 'yesterday football chest pain']) {
    assert.equal(supportedNoisyOnset(utterance(text)), null, text);
  }
  for (const question of ['What did you watch?', 'When did the dizziness start? Do you have chest pain?', 'Did the dizziness start yesterday?']) {
    assert.equal(supportedNoisyOnset({ ...utterance('yesterday football'), question }), null);
  }
});

test('strict validator prevents quarantined background tokens becoming notes or symptoms', () => {
  const u = utterance('yesterday football');
  const base = { label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: 1, quote: u.text };
  for (const fact of [{ kind: 'note', value: u.text }, { kind: 'symptom', label: 'football', status: 'confirmed' }, { kind: 'onset', value: u.text }]) {
    assert.throws(() => mergeIntake(emptyIntake(), { updates: [{ ...base, ...fact }] }, [u]));
  }
});

test('mixed batch excludes background evidence from model while retaining independent BP', async () => {
  const u = utterance('yesterday shark suddenly');
  const bp = { id: 2, role: 'Patient', text: 'My blood pressure is 145/90.' };
  const extract = createExtractor('fictional', undefined, { request: async options => {
    assert.deepEqual(JSON.parse(options.input).newPatientUtterances, [bp]);
    return { output_text: JSON.stringify({ updates: [
      { kind: 'note', label: '', value: u.text, secondaryValue: '', unit: '', qualitative: '', status: '', evidenceId: 1, quote: u.text },
      { kind: 'bloodPressure', label: '', value: '145', secondaryValue: '90', unit: '', qualitative: '', status: '', evidenceId: 2, quote: bp.text },
    ] }) };
  } });
  const patch = await extract({ utterances: [u, bp], intake: emptyIntake() });
  const snapshot = mergeIntake(emptyIntake(), patch, [u, bp]);
  assert.equal(snapshot.onset.value, 'yesterday');
  assert.equal(snapshot.vitals.bloodPressure.systolic, 145);
  assert.deepEqual(snapshot.additionalNotes, []);
});

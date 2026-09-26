import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractor } from '../src/intake/extractor.js';
import { createIntakeSession } from '../src/intake/session.js';
import { createCompletionState } from '../src/completion.js';
import { createCompletedCases } from '../src/agent/cases.js';
import { needsClarification } from '../src/intake/validate.js';

const wire = (u, fact) => ({ kind: '', label: '', value: '', secondaryValue: '', unit: '', qualitative: '', status: '', evidenceId: u.id, quote: u.text, ...fact });
const cases = [
  ['reported symptoms and short clinical denials', [
    ['What is your name?', 'My name is JL.', [{ kind: 'name', value: 'JL' }]],
    ['What brings you here?', "I'm feeling dizzy.", [{ kind: 'symptom', label: 'dizzy', status: 'confirmed' }]],
    ['When did it start?', 'It started yesterday.', [{ kind: 'onset', value: 'yesterday' }]],
    ['Are you having chest pain?', 'No.', [{ kind: 'symptom', label: 'chest pain', status: 'denied' }]],
    ['Are you having difficulty breathing?', 'No.', [{ kind: 'symptom', label: 'difficulty breathing', status: 'denied' }]],
    ['What is your blood pressure?', 'My blood pressure is 145 over 90.', [{ kind: 'bloodPressure', value: '145', secondaryValue: '90' }]],
  ], snapshot => {
    assert.equal(snapshot.patient.name, 'JL');
    assert.equal(snapshot.onset.value, 'yesterday');
    assert.deepEqual(snapshot.symptoms.map(s => s.status), ['confirmed', 'denied', 'denied']);
    assert.equal(snapshot.vitals.bloodPressure.diastolic, 90);
  }],
  ['malformed unit attempts followed by valid correction', [
    ['What is your blood sugar?', 'My blood sugar is 190.', [{ kind: 'bloodGlucose', value: '190' }]],
    ...['mmol', 'MG something', 'm l d l'].map(text => ['What unit is your blood sugar reading in?', text, []]),
    ['What unit is your blood sugar reading in?', 'MGDL', [{ kind: 'bloodGlucose', unit: 'mg/dL' }]],
  ], snapshot => {
    assert.equal(snapshot.vitals.bloodGlucose.value, 190);
    assert.equal(snapshot.vitals.bloodGlucose.unit, 'mg/dL');
  }],
  ['two facts from one utterance followed by a no-op', [
    ['What readings do you have?', 'My blood pressure is 190 over 45 and my blood sugar is 195 mg/dL.', [
      { kind: 'bloodPressure', value: '190', secondaryValue: '45' },
      { kind: 'bloodGlucose', value: '195', unit: 'mg/dL' },
    ]],
    ['Did you hear that?', 'Okay.', []],
  ], snapshot => {
    assert.equal(snapshot.vitals.bloodPressure.diastolic, 45);
    assert.equal(snapshot.vitals.bloodGlucose.value, 195);
  }],
];
for (const [name, turns, verify] of cases) {
  test(`finalization wire regression: ${name}`, async t => {
    const completion = createCompletionState(), tokens = createCompletedCases();
    const requests = [];
    const extract = createExtractor('fake', undefined, { request: async args => {
      const { newPatientUtterances } = JSON.parse(args.input);
      requests.push(...newPatientUtterances);
      return { output_text: JSON.stringify({ updates: newPatientUtterances.flatMap(u => turns[u.id - 1][2].map(fact => wire(u, fact))) }) };
    } });
    const session = createIntakeSession({ extract, send() {} });
    t.after(() => { session.close(); tokens.clear(); });
    const accept = content => session.accept(content, completion.observe(content));
    for (const [question, text] of [...turns, ['Is there anything else?', 'No, nothing at all.']]) {
      accept({ outputTranscription: { text: question }, turnComplete: true });
      accept({ inputTranscription: { text, finished: true } });
    }
    accept({ outputTranscription: { text: 'Thank you. Your intake is complete.' }, turnComplete: true });
    const snapshot = await session.drain();
    assert.equal(requests.length, turns.length);
    verify(snapshot);
    assert.equal(needsClarification(snapshot), false);
    assert.ok(Object.keys(snapshot.evidence).length);
    assert.equal(completion.complete(completion.id), true);
    const token = tokens.issue(snapshot);
    assert.deepEqual(tokens.get(token, snapshot), snapshot);
    assert.equal(completion.complete(completion.id), false);
  });
}

for (const output of ['{', '{"updates":null}', '{"updates":[{}]}']) {
  test(`malformed wire response blocks finalization: ${output}`, async t => {
    const extract = createExtractor('fake', undefined, { request: async () => ({ output_text: output }) });
    const session = createIntakeSession({ extract, send() {}, log() {} });
    t.after(() => session.close());
    session.accept({ inputTranscription: { text: 'My name is JL.', finished: true } });
    await assert.rejects(session.drain(), error => error.detail.code === 'INVALID_RESPONSE' && error.detail.utteranceIds[0] === 1);
  });
}

test('validation reason survives finalization without forwarding arbitrary diagnostic text', async t => {
  const session = createIntakeSession({ send() {}, log() {}, extract: async ({ utterances }) => ({ updates: [
    { ...wire(utterances[0], { kind: 'bloodGlucose', value: 190, unit: 'mg/dL' }), label: null, secondaryValue: null, qualitative: null, status: null },
  ] }) });
  t.after(() => session.close());
  session.accept({ inputTranscription: { text: 'My blood sugar is 190.', finished: true } });
  await assert.rejects(session.drain(), error => error.detail.code === 'VALIDATION_FAILED' && /unsupported unit/.test(error.detail.developerMessage));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyIntake } from '../src/intake/schema.js';
import { mergeIntake, needsClarification } from '../src/intake/validate.js';
import { createIntakeSession } from '../src/intake/session.js';
import { createCompletionState } from '../src/completion.js';
import { createCompletedCases } from '../src/agent/cases.js';

const patch = (u, extra) => ({ updates: [{ kind: 'bloodGlucose', label: null, value: null, secondaryValue: null,
  unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text, ...extra }] });
const numeric = { id: 1, role: 'Patient', text: 'My blood sugar is 190 mmol.', question: '' };
const initial = () => mergeIntake(emptyIntake(), patch(numeric, { value: 190 }), [numeric]);

test('MGDL clarifies an evidenced glucose number without weakening numeric or context validation', () => {
  const prior = initial();
  assert.equal(needsClarification(prior), true);
  const u = { id: 2, role: 'Patient', text: 'MGDL', question: 'What unit is your blood sugar reading in?' };
  const next = mergeIntake(prior, patch(u, { unit: 'mg/dL' }), [u]);
  assert.equal(next.vitals.bloodGlucose.value, 190);
  assert.equal(next.vitals.bloodGlucose.unit, 'mg/dL');
  assert.equal(needsClarification(next), false);
  assert.equal(next.evidence['vitals.bloodGlucose'].valueEvidence.patientReportedText, numeric.text);
  assert.equal(prior.vitals.bloodGlucose.unit, null);
  assert.throws(() => mergeIntake(emptyIntake(), patch(u, { unit: 'mg/dL' }), [u]));
  assert.throws(() => mergeIntake(prior, patch(u, { unit: 'mg/dL', value: 190 }), [u]));
  for (const text of ['mmol', 'MG something', 'maybe MGDL']) {
    const bad = { ...u, text };
    assert.throws(() => mergeIntake(prior, patch(bad, { unit: 'mg/dL' }), [bad]));
  }
  assert.throws(() => mergeIntake(prior, patch(u, { unit: 'mg/dL' }), [{ ...u, question: 'What is your name?' }]));
});

test('explicit mmol/L clarification preserves the reading and clears the malformed-unit requirement', () => {
  const u = { id: 2, role: 'Patient', text: 'mmol/L', question: 'What unit is your blood sugar reading in?' };
  const next = mergeIntake(initial(), patch(u, { unit: 'mmol/L' }), [u]);
  assert.equal(next.vitals.bloodGlucose.value, 190);
  assert.equal(next.vitals.bloodGlucose.unit, 'mmol/L');
  assert.equal(needsClarification(next), false);
  assert.equal(next.evidence['vitals.bloodGlucose'].valueEvidence.utteranceId, 1);
});

test('numeric glucose, malformed attempts, MGDL and pure final confirmation drain to one token', async t => {
  const state = createCompletionState();
  const cases = createCompletedCases();
  const logs = [], requests = [];
  const facts = [
    ['My name is JL.', { kind: 'name', value: 'JL' }],
    ["I'm feeling dizzy.", { kind: 'symptom', label: 'dizzy', status: 'confirmed' }],
    ['It started yesterday.', { kind: 'onset', value: 'yesterday' }],
    ["I don't have chest pain.", { kind: 'symptom', label: 'chest pain', status: 'denied' }],
    ["I don't have difficulty breathing.", { kind: 'symptom', label: 'difficulty breathing', status: 'denied' }],
    ["I don't have thirst.", { kind: 'symptom', label: 'thirst', status: 'denied' }],
  ];
  const session = createIntakeSession({ send() {}, log: x => logs.push(x), extract: async ({ utterances }) => {
    requests.push(...utterances);
    return { updates: utterances.flatMap(u => {
      const fact = facts.find(([text]) => text === u.text);
      if (fact) return patch(u, fact[1]).updates;
      if (u.text === 'My blood sugar is 190.') return patch(u, { value: 190 }).updates;
      if (u.text === 'MGDL') return patch(u, { unit: 'mg/dL' }).updates;
      if (u.text === 'My blood pressure is 190/60.') return patch(u, { kind: 'bloodPressure', value: 190, secondaryValue: 60 }).updates;
      return [];
    }) };
  } });
  t.after(() => { session.close(); cases.clear(); });
  const accept = content => session.accept(content, state.observe(content));
  for (const [question, text] of [
    ...facts.map(([text]) => ['', text]),
    ['What is your blood pressure?', 'My blood pressure is 190/60.'],
    ['What is your blood sugar reading?', 'My blood sugar is 190.'],
    ['What unit is your blood sugar reading in?', 'mmol'],
    ['What unit is your blood sugar reading in?', 'MG something'],
    ['What unit is your blood sugar reading in?', 'MGDL'],
    ['Is there anything else?', 'No, nothing at all.'],
  ]) {
    accept({ outputTranscription: { text: question }, turnComplete: true });
    accept({ inputTranscription: { text, finished: true } });
  }
  accept({ outputTranscription: { text: 'Thank you, JL. Your intake is complete.' }, turnComplete: true });
  const snapshot = await session.drain();
  assert.deepEqual(logs.filter(item => item.code !== 'SYMPTOM_GROUNDING'), []);
  assert.ok(logs.filter(item => item.code === 'SYMPTOM_GROUNDING').every(item =>
    typeof item.multilingual === 'boolean' && !Object.hasOwn(item, 'label') && !Object.hasOwn(item, 'text')));
  assert.equal(requests.length, 11);
  assert.equal(snapshot.patient.name, 'JL');
  assert.equal(snapshot.onset.value, 'yesterday');
  assert.equal(snapshot.symptoms.find(s => s.name === 'dizzy').status, 'confirmed');
  for (const name of ['chest pain', 'difficulty breathing', 'thirst']) {
    assert.equal(snapshot.symptoms.find(s => s.name === name).status, 'denied');
  }
  assert.deepEqual(snapshot.vitals.bloodGlucose, { value: 190, unit: 'mg/dL', qualitative: null, source: 'patient_reported' });
  assert.equal(snapshot.vitals.bloodPressure.systolic, 190);
  assert.equal(snapshot.vitals.bloodPressure.diastolic, 60);
  assert.equal(needsClarification(snapshot), false);
  assert.equal(state.complete(state.id), true);
  const token = cases.issue(snapshot);
  assert.deepEqual(cases.get(token, snapshot), snapshot);
  assert.equal(state.complete(state.id), false);
});

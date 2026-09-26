import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeSession } from '../src/intake/session.js';
import { createExtractor } from '../src/intake/extractor.js';
import { createCompletedCases, caseFields } from '../src/agent/cases.js';

// Reconstruction of the reported JN intake; the original API responses were not saved.
const turns = [
  ['What is your name?', 'My name is JN.', { kind: 'name', value: 'JN' }],
  ['What brings you here?', "I'm feeling dizzy.", { kind: 'symptom', label: 'dizzy', status: 'confirmed' }],
  ['When did it start?', 'It started yesterday.', { kind: 'onset', value: 'yesterday' }],
  ['Are you having chest pain?', "I don't have chest pain.", { kind: 'symptom', label: 'chest pain', status: 'denied' }],
  ['Are you having difficulty breathing?', "I don't have difficulty breathing.", { kind: 'symptom', label: 'difficulty breathing', status: 'denied' }],
  ['What was your blood pressure?', 'My blood pressure was 145 over 90.', { kind: 'bloodPressure', value: 145, secondaryValue: 90 }],
  ["Is there anything else you'd like to add before we finish?", 'No.', null],
];

test('JN intake drains validated facts before issuing a matching handoff snapshot', async t => {
  const real = process.env.INTAKE_REAL_DIAGNOSTIC === '1';
  const messages = [], failures = [], batches = [];
  const actual = real ? createExtractor(process.env.GEMINI_API_KEY) : async ({ utterances }) => ({
    updates: utterances.flatMap(u => {
      const fact = turns[u.id - 1][2];
      return fact ? [{ kind: '', label: null, value: null, secondaryValue: null, unit: null,
        qualitative: null, status: null, evidenceId: u.id, quote: u.text, ...fact }] : [];
    }),
  });
  const session = createIntakeSession({ delay: 0,
    send: message => messages.push(message),
    log: detail => { failures.push(detail); if (real) t.diagnostic(JSON.stringify(detail)); },
    extract: async args => {
      const ids = args.utterances.map(u => u.id);
      batches.push(ids);
      if (real) t.diagnostic(`Extraction queued: ${ids.join(',')}`);
      const patch = await actual(args);
      if (real) t.diagnostic(`Extraction response: ${JSON.stringify(patch)}`);
      return patch;
    },
  });
  t.after(() => session.close());
  session.start();
  for (const [question, text] of turns) {
    session.accept({ outputTranscription: { text: question }, turnComplete: true });
    session.accept({ inputTranscription: { text, finished: true } });
    // Exercise individual real requests and the final in-flight drain.
    if (real && text !== 'No.') {
      const previous = messages.length;
      const deadline = Date.now() + 50000;
      while (!messages.slice(previous).some(m => m.type === 'intake-status' && m.status !== 'updating')) {
        assert.ok(Date.now() < deadline, 'Extraction diagnostic deadline');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  let snapshot;
  try { snapshot = await session.drain(); }
  catch (error) {
    if (real) t.diagnostic(`Retained snapshot: ${JSON.stringify(messages.filter(m => m.type === 'intake-update').at(-1)?.intake)}`);
    throw error;
  }
  if (real) t.diagnostic(`Completed snapshot: ${JSON.stringify(snapshot)}`);
  assert.deepEqual(failures.filter(item => item.code !== 'SYMPTOM_GROUNDING'), []);
  assert.ok(failures.filter(item => item.code === 'SYMPTOM_GROUNDING').every(item =>
    ['patient_utterance', 'question_context'].includes(item.labelSource) &&
    ['exact', 'approved_normalization', 'short_answer_question'].includes(item.matchCategory) &&
    typeof item.multilingual === 'boolean' && !Object.hasOwn(item, 'label') && !Object.hasOwn(item, 'text')));
  assert.ok(batches.length);
  assert.equal(snapshot.patient.name || snapshot.patient.preferredName, 'JN');
  assert.equal(snapshot.symptoms.find(s => ['dizziness', 'dizzy'].includes(s.name))?.status, 'confirmed');
  assert.equal(snapshot.onset.value, 'yesterday');
  for (const name of ['chest pain', 'difficulty breathing']) {
    const fact = snapshot.symptoms.find(s => s.name === name) ||
      snapshot.redFlags.find(s => s.type === `current ${name}`);
    assert.equal(fact?.status, 'denied');
  }
  assert.deepEqual(snapshot.vitals.bloodPressure, { systolic: 145, diastolic: 90, source: 'patient_reported' });
  const cases = createCompletedCases();
  t.after(() => cases.clear());
  const token = cases.issue(snapshot);
  assert.deepEqual(cases.get(token, snapshot), snapshot);
  if (real) t.diagnostic('Handoff token issued and matching snapshot verified (token omitted).');
  assert.equal(caseFields(snapshot)['Blood Pressure'], '145/90 (patient reported)');
  assert.deepEqual(messages.filter(m => m.type === 'intake-update').at(-1).intake, snapshot);
});

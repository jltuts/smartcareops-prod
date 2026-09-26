import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBatch } from '../src/intake/batch-validation.js';
import { emptyIntake, normalizePatch } from '../src/intake/schema.js';
import { needsClarification } from '../src/intake/validate.js';

const utterances = [
  { id: 4, role: 'Patient', text: 'No. No.', question: 'Are you having difficulty breathing?' },
  { id: 5, role: 'Patient', text: 'yesterday shark suddenly', question: 'When did the dizziness start?' },
  { id: 6, role: 'Patient', text: 'Yes, my blood pressure is 145/90.' },
];
const update = (id, fact) => ({ label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: id, quote: utterances.find(u => u.id === id).text, ...fact });
const breathing = update(4, { kind: 'symptom', label: 'difficulty breathing', status: 'denied' });
const onset = update(5, { kind: 'onset', value: 'yesterday' });
const bp = update(6, { kind: 'bloodPressure', value: 145, secondaryValue: 90 });

test('exact noisy batch accepts denial and BP independently of malformed onset', () => {
  const result = mergeBatch(emptyIntake(), { updates: [breathing, { ...onset, status: 'unclear' }, bp] }, utterances);
  assert.equal(result.acceptedCount, 2);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.rejected[0].diagnostic, {
    updateIndex: 1, updateType: 'onset', topLevelKeys: ['label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'evidenceId', 'quote', 'kind'],
    field: 'status', fieldPath: 'onset.status', expected: 'null', receivedType: 'string', normalizedBeforeValidation: true,
    explicitNull: false, evidenceShapeValid: true, received: 'unclear', missingFields: [], unexpectedFields: [], utteranceId: 5, reason: 'invalid schema',
  });
  assert.equal(result.intake.symptoms[0].status, 'denied');
  assert.deepEqual(result.intake.vitals.bloodPressure, { systolic: 145, diastolic: 90, source: 'patient_reported' });
  assert.equal(result.intake.onset.value, null);
  assert.equal(result.intake.onset.clarificationRequested, true);
  assert.equal(needsClarification(result.intake), false);
});

test('malformed duplicate cannot replace evidenced onset or create clarification', () => {
  const result = mergeBatch(emptyIntake(), { updates: [onset, { ...onset, status: 'unclear' }, bp] }, utterances);
  assert.equal(result.intake.onset.value, 'yesterday');
  assert.equal(result.intake.onset.clarificationRequested, undefined);
  assert.equal(needsClarification(result.intake), false);
});

test('wire normalization isolates an invalid type without weakening other candidates', () => {
  const wire = [breathing, onset, bp].map(u => Object.fromEntries(Object.entries(u).map(([k,v]) => [k, k === 'evidenceId' ? v : v === null ? '' : String(v)])));
  wire[1].status = null;
  const result = mergeBatch(emptyIntake(), normalizePatch({ updates: wire }, { independent: true }), utterances);
  assert.equal(result.acceptedCount, 2);
  assert.equal(result.rejected[0].diagnostic.expected, 'string');
  assert.equal(result.intake.vitals.bloodPressure.systolic, 145);
});

test('unrelated success retains required rejection; same field repair clears it', () => {
  let result = mergeBatch(emptyIntake(), { updates: [{ ...bp, secondaryValue: null }, onset] }, utterances);
  assert.equal(needsClarification(result.intake), true);
  result = mergeBatch(result.intake, { updates: [breathing] }, utterances);
  assert.equal(needsClarification(result.intake), true);
  result = mergeBatch(result.intake, { updates: [bp] }, utterances);
  assert.equal(needsClarification(result.intake), false);
});

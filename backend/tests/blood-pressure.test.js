import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePatch, emptyIntake } from '../src/intake/schema.js';
import { mergeIntake } from '../src/intake/validate.js';

const wire = (text, value = '190', secondaryValue = '80', extra = {}) => ({ updates: [{ kind: 'bloodPressure', label: '', value, secondaryValue, unit: '', qualitative: '', status: '', evidenceId: 6, quote: text, ...extra }] });
for (const [text, systolic, diastolic] of [['My blood pressure is 190/80.', 190, 80], ['My blood pressure is 190 over 80.', 190, 80], ['BP is 145/90.', 145, 90], ['Yes, my blood pressure is 190/80.', 190, 80]]) {
  test(`evidenced BP wire update: ${text}`, () => {
    const intake = mergeIntake(emptyIntake(), normalizePatch(wire(text, String(systolic), String(diastolic))), [{ id: 6, role: 'Patient', text, question: 'Is there anything else?' }]);
    assert.deepEqual(intake.vitals.bloodPressure, { systolic, diastolic, source: 'patient_reported' });
  });
}
for (const text of ['My blood pressure is 190.', 'My blood pressure is unknown.']) {
  test(`missing BP evidence cannot invent the second value: ${text}`, () => {
    assert.throws(() => mergeIntake(emptyIntake(), normalizePatch(wire(text)), [{ id: 6, role: 'Patient', text }]));
  });
}
test('invalid BP metadata reports its exact safe field and type', () => {
  const text = 'Yes, my blood pressure is 190/80.';
  assert.throws(() => mergeIntake(emptyIntake(), normalizePatch(wire(text, '190', '80', { status: 'confirmed' })), [{ id: 6, role: 'Patient', text }]), error =>
    error.field === 'status' && error.expected === 'null' && error.receivedType === 'string');
});

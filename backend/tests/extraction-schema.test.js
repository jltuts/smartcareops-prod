import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBatch } from '../src/intake/batch-validation.js';
import { emptyIntake, normalizePatch, normalizationFailure, patchSchema } from '../src/intake/schema.js';

const utterance = (text, question = 'What symptoms are you having?', id = 1) => ({ id, role: 'Patient', text, question });
const wire = (u, values = {}) => ({
  kind: 'symptom', label: 'dizzy', value: '', secondaryValue: '', unit: '', qualitative: '', status: 'confirmed',
  evidenceId: u.id, quote: u.text, ...values,
});

test('structured-output schema closes the provider update shape', () => {
  assert.equal(patchSchema.additionalProperties, false);
  assert.equal(patchSchema.properties.updates.items.additionalProperties, false);
  assert.deepEqual(patchSchema.properties.updates.items.required, ['kind', 'label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'evidenceId', 'quote']);
  for (const field of ['label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'quote']) {
    assert.equal(patchSchema.properties.updates.items.properties[field].type, 'string');
  }
});

test('provider-shaped unsupported symptom is rejected at the evidence-aware label path', () => {
  const u = utterance('I feel dizzy.');
  const patch = normalizePatch({ updates: [wire(u, { label: 'headache' })] }, { independent: true });
  const result = mergeBatch(emptyIntake(), patch, [u]);
  assert.equal(result.acceptedCount, 0);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.rejected[0].diagnostic, {
    updateIndex: 0,
    updateType: 'symptom',
    topLevelKeys: ['kind', 'label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'evidenceId', 'quote'],
    field: 'label',
    fieldPath: 'symptom.label',
    expected: 'literal patient-evidenced label',
    receivedType: 'string',
    normalizedBeforeValidation: true,
    explicitNull: false,
    evidenceShapeValid: true,
    missingFields: [],
    unexpectedFields: [],
    labelSource: null,
    matchCategory: 'unsupported',
    multilingual: false,
    utteranceId: 1,
    reason: 'invalid schema',
  });
});

test('complete wire response normalizes before evidence validation', () => {
  const u = utterance('I feel dizzy.');
  const patch = normalizePatch({ updates: [wire(u)] }, { independent: true });
  const result = mergeBatch(emptyIntake(), patch, [u]);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.intake.symptoms[0].status, 'confirmed');
});

test('omitted and null wire placeholders fail according to the required string contract', () => {
  const u = utterance('I feel dizzy.');
  const base = { kind: 'symptom', label: 'dizzy', status: 'confirmed', evidenceId: u.id, quote: u.text };
  for (const candidate of [base, { ...base, value: null, secondaryValue: null, unit: null, qualitative: null }]) {
    const patch = normalizePatch({ updates: [candidate] }, { independent: true });
    assert.ok(patch.updates[0][normalizationFailure]);
    assert.equal(mergeBatch(emptyIntake(), patch, [u]).unresolved.length, 1);
  }
});

test('unexpected provider fields remain rejected and expose only safe structural diagnostics', () => {
  const u = utterance('I feel dizzy.');
  const patch = normalizePatch({ updates: [wire(u, { confidence: 'high' })] }, { independent: true });
  const result = mergeBatch(emptyIntake(), patch, [u]);
  assert.equal(result.acceptedCount, 0);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.rejected[0].diagnostic.unexpectedFields, ['confidence']);
  assert.equal(result.rejected[0].diagnostic.fieldPath, 'symptom.update');
});

test('invalid enum and ambiguous evidence fail conservatively or remain unclear', () => {
  const u = utterance('Maybe.', 'Are you feeling dizzy?');
  const invalid = normalizePatch({ updates: [wire(u, { status: 'likely' })] }, { independent: true });
  assert.equal(mergeBatch(emptyIntake(), invalid, [u]).unresolved.length, 1);
  const unclear = normalizePatch({ updates: [wire(u, { status: 'unclear' })] }, { independent: true });
  const result = mergeBatch(emptyIntake(), unclear, [u]);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.intake.symptoms[0].status, 'unclear');
});

test('denied red flag and patient-reported blood pressure preserve existing safety rules', () => {
  const noChest = utterance('No.', 'Are you having chest pain?', 1);
  const bp = utterance('My blood pressure is 180 over 90.', 'What is your blood pressure?', 2);
  const patch = normalizePatch({ updates: [
    wire(noChest, { kind: 'redFlag', label: 'current chest pain', status: 'denied' }),
    wire(bp, { kind: 'bloodPressure', label: '', value: '180', secondaryValue: '90', status: '' }),
  ] }, { independent: true });
  const result = mergeBatch(emptyIntake(), patch, [noChest, bp]);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.intake.redFlags[0].status, 'denied');
  assert.deepEqual(result.intake.vitals.bloodPressure, { systolic: 180, diastolic: 90, source: 'patient_reported' });
  assert.equal(result.intake.redFlags.some(flag => flag.status === 'confirmed'), false);
});

test('real-world symptom labels remain directly evidence grounded without synonym inflation', () => {
  const fixtures = [
    ['I feel dizzy.', 'dizzy', 'confirmed'],
    ['I have a fever.', 'fever', 'confirmed'],
    ['I feel sick.', 'sick', 'confirmed'],
    ['I have nausea.', 'nausea', 'confirmed'],
    ['No chest pain.', 'chest pain', 'denied'],
    ['No difficulty breathing.', 'difficulty breathing', 'denied'],
  ];
  for (const [text, label, status] of fixtures) {
    const u = utterance(text);
    const result = mergeBatch(emptyIntake(), normalizePatch({ updates: [wire(u, { label, status })] }, { independent: true }), [u]);
    assert.equal(result.unresolved.length, 0, `${text} should ground ${label}`);
    assert.equal(result.intake.symptoms[0].status, status);
  }
  for (const [text, inflated] of [['I feel dizzy.', 'vertigo'], ['I have a fever.', 'febrile illness'], ['I feel sick.', 'nausea']]) {
    const u = utterance(text);
    const result = mergeBatch(emptyIntake(), normalizePatch({ updates: [wire(u, { label: inflated })] }, { independent: true }), [u]);
    assert.equal(result.unresolved.length, 1, `${inflated} must not be inferred from ${text}`);
    assert.equal(result.rejected[0].diagnostic.fieldPath, 'symptom.label');
  }
});

test('explicit short multilingual answers use only one simple question as evidence', () => {
  for (const [text, question, label, status] of [
    ['No.', 'Are you having chest pain?', 'chest pain', 'denied'],
    ['Sí.', 'Are you feeling dizzy?', 'dizzy', 'confirmed'],
    ['Non.', 'Avez-vous de la nausée?', 'nausée', 'denied'],
  ]) {
    const u = utterance(text, question);
    const result = mergeBatch(emptyIntake(), normalizePatch({ updates: [wire(u, { label, status })] }, { independent: true }), [u]);
    assert.equal(result.unresolved.length, 0, `${text} should be grounded only by its simple question`);
    assert.equal(result.intake.symptoms[0].status, status);
  }
  const ambiguous = utterance('Sí.', 'Are you dizzy or nauseated?');
  const unclear = mergeBatch(emptyIntake(), normalizePatch({ updates: [wire(ambiguous, { label: 'dizzy' })] }, { independent: true }), [ambiguous]);
  assert.equal(unclear.unresolved.length, 0);
  assert.equal(unclear.intake.symptoms[0].status, 'unclear');
});

test('extractor contract requires patient wording and forbids clinical synonym expansion', async () => {
  const { extractionInstruction } = await import('../src/intake/extractor.js');
  assert.match(extractionInstruction, /patient's shortest literal symptom phrase/);
  assert.match(extractionInstruction, /Never output vertigo/);
  assert.match(extractionInstruction, /febrile illness for fever/);
  assert.match(extractionInstruction, /nausea for sick/);
  assert.match(extractionInstruction, /Preserve coherent multilingual symptom wording in its original language/);
  assert.match(patchSchema.properties.updates.items.properties.label.description, /Never canonicalize or use a diagnostic\/clinical synonym/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSymptomGrounding, canonicalizeSymptom } from '../src/intake/symptom-grounding.js';
import { emptyIntake } from '../src/intake/schema.js';
import { mergeIntake } from '../src/intake/validate.js';
import { evaluateRouting } from '../src/cases/routing.js';
import { createMemoryCaseStore, newCaseId, Workflow } from '../src/cases/store.js';
import { mergeBatch } from '../src/intake/batch-validation.js';

const utterance = (text, question = '', id = 1) => ({ id, role: 'Patient', text, question });
const symptom = (u, label, status = 'confirmed') => ({ kind: 'symptom', label, value: null, secondaryValue: null, unit: null,
  qualitative: null, status, evidenceId: u.id, quote: u.text });
const merge = (u, label, status) => mergeIntake(emptyIntake(), { updates: [symptom(u, label, status)] }, [u]);

test('literal symptom wording is preserved and canonicalized only by the closed backend map', () => {
  for (const [text, label, canonicalConcept] of [
    ['I feel dizzy.', 'dizzy', 'dizziness'],
    ['I have a fever.', 'fever', 'fever'],
    ['I am short of breath.', 'short of breath', 'shortness of breath'],
  ]) {
    const intake = merge(utterance(text), label);
    assert.equal(intake.symptoms[0].name, label);
    assert.equal(intake.symptoms[0].canonicalConcept, canonicalConcept);
  }
  const unknown = merge(utterance('I feel fluttery.'), 'fluttery');
  assert.equal(unknown.symptoms[0].name, 'fluttery');
  assert.equal(Object.hasOwn(unknown.symptoms[0], 'canonicalConcept'), false);
  assert.equal(canonicalizeSymptom('fluttery'), null);
});

test('unsupported clinical synonyms remain rejected and expose structural-only grounding diagnostics', () => {
  const u = utterance('I feel dizzy.');
  assert.throws(() => merge(u, 'vertigo'), error => error.field === 'label' && error.labelSource === null &&
    error.matchCategory === 'unsupported' && error.multilingual === false);
});

test('accepted grounding diagnostics contain categories without patient values', () => {
  const u = utterance('I feel dizzy.');
  const result = mergeBatch(emptyIntake(), { updates: [symptom(u, 'dizzy')] }, [u]);
  assert.deepEqual(result.groundingDiagnostics, [{ updateIndex: 0, updateType: 'symptom', fieldPath: 'symptom.label',
    labelSource: 'patient_utterance', matchCategory: 'approved_normalization', multilingual: false }]);
  assert.equal(JSON.stringify(result.groundingDiagnostics).includes('dizzy'), false);
});

test('brief question context is bounded by the existing answer grammar and compound answers stay unclear', () => {
  const yes = utterance('Yes.', 'Are you feeling dizzy?');
  const grounding = analyzeSymptomGrounding(yes, 'dizzy');
  assert.deepEqual({ source: grounding.labelSource, category: grounding.matchCategory }, { source: 'question_context', category: 'short_answer_question' });
  assert.equal(merge(yes, 'dizzy').symptoms[0].canonicalConcept, 'dizziness');
  assert.throws(() => merge(utterance('Yes, I have.', 'Are you feeling dizzy?'), 'dizzy'));
  const compound = merge(utterance('Yes.', 'Are you dizzy or nauseated?'), 'dizzy');
  assert.equal(compound.symptoms[0].status, 'unclear');
});

test('multilingual short answers and denials remain conservative', () => {
  const spanish = utterance('Sí.', 'Are you feeling dizzy?');
  assert.equal(analyzeSymptomGrounding(spanish, 'dizzy').multilingual, true);
  assert.equal(merge(spanish, 'dizzy').symptoms[0].status, 'confirmed');
  const french = utterance('Non.', 'Avez-vous de la nausée?');
  const denied = merge(french, 'nausée', 'denied');
  assert.equal(denied.symptoms[0].status, 'denied');
  assert.equal(Object.hasOwn(denied.symptoms[0], 'canonicalConcept'), false);
});

test('routing prefers backend canonical concepts and otherwise keeps the existing conservative fallback', () => {
  const dizziness = merge(utterance('I feel dizzy.'), 'dizzy');
  assert.equal(evaluateRouting(dizziness).specialty, 'neurology');
  const unknown = merge(utterance('I feel fluttery.'), 'fluttery');
  assert.equal(evaluateRouting(unknown).specialty, 'general_medicine');
});

test('normal grounded intake persists exactly once for clinical review', async t => {
  const store = createMemoryCaseStore(); t.after(() => store.close());
  const intake = merge(utterance('I feel dizzy.'), 'dizzy');
  const caseId = newCaseId();
  const created = await store.createCase({ caseId, intake, submittedForReview: true, patientUid: 'patient-grounding-test' });
  const repeated = await store.createCase({ caseId, intake, submittedForReview: true, patientUid: 'patient-grounding-test' });
  assert.equal(created.workflowStatus, Workflow.REVIEW);
  assert.equal(repeated.caseId, created.caseId);
  assert.equal(repeated.reportedFacts.symptoms[0].name, 'dizzy');
  assert.equal(repeated.reportedFacts.symptoms[0].canonicalConcept, 'dizziness');
});

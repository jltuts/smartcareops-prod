import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionEngine, questionControl, selectComplaintPath } from '../src/intake/question-engine.js';
import { answerStates, questionSets, validateQuestionSets } from '../src/intake/question-sets.js';
import { emptyIntake } from '../src/intake/schema.js';

test('reviewed question catalog has stable unique IDs and complete structured contracts', () => {
  assert.equal(validateQuestionSets(), true);
  assert.equal(new Set(questionSets.map(item => item.id)).size, questionSets.length);
  assert(questionSets.every(item => item.requiredFacts.length && item.supportedAnswerStates.every(state => answerStates.includes(state))));
  assert(questionSets.every(item => (item.prompt.match(/\?/g) || []).length === 1));
});

test('complaint selection is deterministic and does not diagnose', () => {
  assert.equal(selectComplaintPath('My left shoulder hurts'), 'musculoskeletal_shoulder');
  assert.equal(selectComplaintPath('I have a spreading rash'), 'skin');
  assert.equal(selectComplaintPath('Chest pressure since this morning'), 'chest');
  assert.equal(selectComplaintPath('I am short of breath'), 'breathing');
  assert.equal(selectComplaintPath('I feel unwell'), 'general');
  assert.doesNotMatch(JSON.stringify(questionSets), /rotator|supraspinatus|fracture|dislocation|diagnos/i);
});

test('shoulder path asks one question at a time, omits supplied onset and severity, and prioritizes safety', () => {
  const engine = createQuestionEngine();
  assert.equal(engine.start().question.id, 'core.name');
  assert.equal(engine.accept({ text: 'JL', utteranceId: 1 }).question.id, 'core.main_concern');
  const next = engine.accept({ text: 'Severe left shoulder pain since yesterday limits lifting', utteranceId: 2 });
  assert.equal(next.question.id, 'shoulder.deformity');
  const state = engine.snapshot();
  assert.equal(state.path, 'musculoskeletal_shoulder');
  assert.equal(state.answers['core.onset'].suppliedWithMainConcern, true);
  assert.equal(state.answers['core.severity'].suppliedWithMainConcern, true);
  assert.equal(state.answers['shoulder.area_side'].suppliedWithMainConcern, true);
  assert.equal((questionControl(next).match(/\?/g) || []).length, 1);
});

test('chest and breathing safety questions precede routine follow-up', () => {
  for (const [concern, expected] of [['Chest pain this morning', 'chest.current'], ['I have trouble breathing', 'breathing.severe_now']]) {
    const engine = createQuestionEngine(); engine.start(); engine.accept({ text: 'JL', utteranceId: 1 });
    assert.equal(engine.accept({ text: concern, utteranceId: 2 }).question.id, expected);
    assert.equal(engine.facilityEligible(), false);
  }
});

test('unknown, skip, denial, ambiguity, confusion, and bounded clarification are explicit states', () => {
  const engine = createQuestionEngine(); engine.start();
  assert.equal(engine.accept({ text: "I don't know", utteranceId: 1 }).question.id, 'core.main_concern');
  assert.equal(engine.snapshot().answers['core.name'].state, 'does_not_know');
  let result = engine.accept({ text: 'What?', utteranceId: 2 }); assert.equal(result.type, 'clarify');
  result = engine.clarify('confusion'); assert.equal(result.type, 'clarify');
  result = engine.clarify('confusion'); assert.notEqual(result.question?.id, 'core.main_concern');
  assert.equal(engine.snapshot().answers['core.main_concern'].state, 'unclear');

  const skin = createQuestionEngine(); skin.start(); skin.accept({ text: 'JL', utteranceId: 1 }); skin.accept({ text: 'A rash', utteranceId: 2 });
  assert.equal(skin.accept({ text: 'No', utteranceId: 3 }).question.id, 'skin.breathing');
  assert.equal(skin.snapshot().answers['skin.face_throat'].state, 'denied');
});

test('validated emergency snapshot terminally interrupts the plan', () => {
  const engine = createQuestionEngine(); engine.start(); engine.accept({ text: 'JL', utteranceId: 1 }); engine.accept({ text: 'Chest pain', utteranceId: 2 });
  const intake = emptyIntake();
  intake.redFlags.push({ type: 'current chest pain', status: 'confirmed', patientReportedText: 'Yes' });
  intake.evidence['redFlags.current chest pain'] = { utteranceId: 3, patientReportedText: 'Yes' };
  engine.syncIntake(intake);
  assert.equal(engine.emergency, true); assert.equal(engine.activeQuestion, null); assert.equal(engine.facilityEligible(), false);
});

test('persisted state resumes the same active question and ignores replayed utterances', () => {
  const first = createQuestionEngine(); first.start(); first.accept({ text: 'JL', utteranceId: 1 }); first.accept({ text: 'A spreading rash', utteranceId: 2 });
  const id = first.activeQuestion.id;
  const resumed = createQuestionEngine({ state: first.snapshot() });
  assert.equal(resumed.start().question.id, id);
  assert.equal(resumed.accept({ text: 'No', utteranceId: 2 }).type, 'none');
  assert.equal(resumed.activeQuestion.id, id);
});

test('multiple complaints choose the higher-priority supported safety path and routine completion is backend-owned', () => {
  const engine = createQuestionEngine(); engine.start(); engine.accept({ text: 'JL', utteranceId: 1 });
  assert.equal(engine.accept({ text: 'My shoulder hurts and I also have chest pressure', utteranceId: 2 }).question.id, 'chest.current');
  assert.equal(engine.completionEligible(), false);
  const required = createQuestionEngine(); required.start();
  required.accept({ text: 'JL', utteranceId: 1 });
  assert.equal(required.accept({ text: 'Skip', utteranceId: 2 }).type, 'clarify');
  assert.equal(required.snapshot().answers['core.main_concern'], undefined);
});

test('final opportunity uses the same finish intent as completion orchestration', () => {
  const state = { version: 1, revision: 0, path: 'general', activeQuestionId: 'core.final_addition', answers: {}, asked: ['core.final_addition'], processedUtteranceIds: [], clarificationCounts: {}, status: 'ready_to_finish', emergency: false };
  const completed = createQuestionEngine({ state });
  assert.equal(completed.accept({ text: 'No, nothing else.', utteranceId: 1 }).type, 'complete');
  assert.equal(completed.snapshot().status, 'ready_to_complete');

  const additional = createQuestionEngine({ state });
  assert.equal(additional.accept({ text: 'No, but I also feel nauseous.', utteranceId: 2 }).type, 'repeat_final');
  assert.equal(additional.activeQuestion.id, 'core.final_addition');
});

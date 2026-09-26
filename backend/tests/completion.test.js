import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionState } from '../src/completion.js';

const say = (state, text) => state.observe({ outputTranscription: { text }, turnComplete: true });
const answer = (state, text) => state.observe({ inputTranscription: { text, finished: true } });
const final = 'Thank you, JL. Your intake is complete.';
function confirm(state) { say(state, 'Is there anything else?'); answer(state, "No, that's all."); }

for (const text of ['No nada...', 'No nada de amor.', 'No.', 'Nope.', 'Nah.', 'All done.', 'Know nothing at all.', '  Um, KNOW   nothing at all! Thank you. ', 'No thanks.', 'No thank you.', "No, that's all.", "That's all.",
  'Nothing else.', 'Nothing more.', 'No, nothing else.', 'No, nothing at all.', 'Nothing at all.',
  'No and nothing else.', 'No, and nothing else.', 'No nothing else.', 'Nope, nothing else.', "No and that's all.", 'Nah um nothing more.', 'No thank you and all done.', 'No uh that is all.',
  "I'm done.", "That's everything.", '  Um, WELL — NO, nothing at all! Thank you.  ', 'Okay, that’s everything…']) {
  test(`finished intent requires final-question context: ${text}`, () => {
    const state = createCompletionState();
    assert.equal(answer(state, text).finishedConfirmation, false);
    assert.equal(say(state, final).pending, false);
    say(state, "Is there anything else you'd like to add?");
    assert.equal(answer(state, text).finishedConfirmation, true);
    assert.equal(say(state, final).pending, true);
    assert.equal(state.complete(state.id), true);
    assert.equal(state.complete(state.id), false);
    assert.deepEqual(say(state, final), {});
  });
}

for (const text of ['No and I have chest pain.', 'No and I also have chest pain.', 'No, but one more thing.', 'No and actually...', 'No, I forgot something.', 'No, but my blood sugar is 190.', 'No and', 'No, I also have chest pain.', 'Nothing else except dizziness.', "I'm not done.", 'No, wait.',
  'No thanks, but I feel dizzy.', 'Well, no, one more thing.', 'No, one more thing.',
  'No, but I have chest pain.', 'Know, actually I forgot something.', 'Know.', 'I know nothing at all.',
  'No, I forgot my blood sugar.', 'Nothing else except my blood pressure.', 'One more thing.', 'No nada but my chest hurts.', 'No nada de dolor.']) {
  test(`additional or unfinished intent cannot finalize: ${text}`, () => {
    const state = createCompletionState();
    say(state, "Is there anything else you'd like to add?");
    assert.equal(answer(state, text).finishedConfirmation, false);
    assert.equal(say(state, final).pending, false);
    assert.equal(state.complete(state.id), false);
  });
}

for (const wording of ['Thank you, Jael. We have finished your intake.', "Thanks, Jael. That's everything recorded.", 'Your intake is now complete.']) {
  test(`confirmed completion accepts wording variation: ${wording}`, () => {
    const state = createCompletionState(); confirm(state);
    assert.equal(say(state, wording).pending, true);
    const id = state.id;
    assert.deepEqual(say(state, wording), {});
    assert.equal(state.id, id);
    assert.equal(state.complete(id), true);
    assert.equal(state.interrupt(), false);
    assert.deepEqual(answer(state, 'Hold on.'), {});
  });
}

test('final audio turn can complete without an output transcript', () => {
  const state = createCompletionState(); confirm(state);
  assert.equal(state.observe({ turnComplete: true }).pending, false, 'Patient-only turn is not a model response');
  state.observe({ modelTurn: { parts: [] } });
  assert.equal(state.observe({ turnComplete: true }).pending, true);
});

test('additional facts require another closing question and explicit confirmation', () => {
  const state = createCompletionState();
  assert.equal(say(state, final).pending, false);
  say(state, 'Is there anything else?');
  answer(state, 'Yes, my blood pressure was 145 over 90.');
  assert.equal(state.state, 'collecting');
  assert.equal(say(state, final).pending, false);
  answer(state, 'No.'); // A denial to an unrelated question is not permission to finish.
  assert.equal(say(state, final).pending, false);
  confirm(state);
  assert.equal(say(state, final).pending, true);
  const id = state.id;
  assert.equal(state.complete(id), true);
  assert.equal(state.complete(id), false);
  assert.deepEqual(say(state, final), {});
});

test('a question, garbled negative, or speech during final output never permits completion', () => {
  const state = createCompletionState();
  say(state, 'Is there anything else?'); answer(state, '아, no.');
  assert.equal(say(state, final).pending, false);
  confirm(state);
  assert.equal(say(state, final + ' Any questions?').pending, false);
  assert.equal(say(state, final).pending, false, 'A new question consumes the previous permission to finish');
  confirm(state);
  state.observe({ outputTranscription: { text: 'Thank you, JL.' } });
  answer(state, 'Wait.');
  assert.equal(say(state, ' Your intake is complete.').pending, false);
});

for (const text of ['Hold on.', 'Wait.', 'One more thing.', 'I forgot something.', 'Actually...', 'Are you still there?']) {
  test(`${text} cancels pending completion and invalidates its acknowledgement`, () => {
    const state = createCompletionState(); confirm(state); say(state, final);
    const id = state.id;
    assert.equal(answer(state, text).cancelled, true);
    assert.equal(state.state, 'collecting');
    assert.equal(state.complete(id), false);
    assert.equal(say(state, final).pending, false);
    confirm(state); say(state, final);
    assert.equal(state.complete(id), false);
    assert.equal(state.complete(state.id), true);
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionState } from '../src/completion.js';
import { createIntakeSession } from '../src/intake/session.js';
import { emptyIntake } from '../src/intake/schema.js';

for (const text of ['No.', "No, that's all.", 'No, nothing at all.', 'Nothing else.', "That's everything."]) {
  for (const boundary of ['finished', 'turnComplete', 'output']) {
    test(`pure confirmation is an extraction no-op: ${text} (${boundary})`, async t => {
      const state = createCompletionState();
      const session = createIntakeSession({ send() {}, extract: async () => assert.fail('No extraction for pure confirmation') });
      t.after(() => session.close());
      const accept = content => { const transition = state.observe(content); session.accept(content, transition); return transition; };
      accept({ outputTranscription: { text: "Is there anything else you'd like to add?" }, turnComplete: true });
      accept({ inputTranscription: { text, finished: boundary === 'finished' } });
      if (boundary === 'turnComplete') accept({ turnComplete: true });
      const final = { outputTranscription: { text: 'Thank you, JL. Your intake is complete.' }, turnComplete: true };
      assert.equal(accept(final).pending, true);
      assert.deepEqual(await session.drain(), emptyIntake());
      assert.equal(state.complete(state.id), true);
      assert.equal(state.complete(state.id), false);
    });
  }
}

for (const [question, text] of [
  ['Anything else?', 'No, but my chest hurts.'],
  ['Anything else?', 'Nothing else except my blood sugar is 190.'],
  ['Anything else?', 'No, wait, I forgot my blood pressure.'],
  ['Anything else?', "That's all, but I have a fever."],
  ['Are you having chest pain?', 'No.'],
]) {
  test(`actual answers still require strict extraction validation: ${text}`, async t => {
    let calls = 0;
    const logs = [];
    const state = createCompletionState();
    const session = createIntakeSession({ send() {}, log: item => logs.push(item), extract: async ({ utterances }) => {
      calls++; assert.equal(utterances[0].text, text);
      return { updates: [], unsupported: true }; // Must not bypass atomic validation.
    } });
    t.after(() => session.close());
    for (const content of [{ outputTranscription: { text: question }, turnComplete: true }, { inputTranscription: { text, finished: true } }]) {
      session.accept(content, state.observe(content));
    }
    await assert.rejects(session.drain(), /Final extraction failed/);
    assert.equal(calls, 1);
    assert.equal(logs[0].code, 'INVALID_RESPONSE');
  });
}

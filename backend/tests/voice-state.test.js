import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceState } from '../src/voice-state.js';

test('only the finalized canonical assistant sentence ends voice, independent of patient grammar', () => {
  const voice = createVoiceState();
  for (const text of ['No.', 'No and nothing else.', 'Your intake is complete.']) assert.equal(voice.observe({ inputTranscription: { text, finished: true }, turnComplete: true }), false);
  assert.equal(voice.observe({ outputTranscription: { text: 'Thank you JL. Your intake ' } }), false);
  assert.equal(voice.observe({ outputTranscription: { text: 'is complete.' }, generationComplete: true }), false);
  assert.equal(voice.state, 'ACTIVE');
  assert.equal(voice.observe({ turnComplete: true }), true);
  assert.equal(voice.state, 'ENDING');
  assert.equal(voice.observe({ interrupted: true, inputTranscription: { text: 'Wait.' } }), false);
  assert.equal(voice.state, 'ENDING');
  voice.close(); voice.close();
  assert.equal(voice.state, 'CLOSED');
  assert.equal(voice.observe({ outputTranscription: { text: 'Your intake is complete.' }, turnComplete: true }), false);
});

test('interrupted fragments and other wording never end voice; canonical sentence anywhere in finalized turn does', () => {
  const voice = createVoiceState();
  voice.observe({ outputTranscription: { text: 'Your intake is complete.' } });
  assert.equal(voice.observe({ interrupted: true, turnComplete: true }), false);
  for (const text of ['We have finished.', 'Your intake is now complete.', 'Your intake is incomplete.']) assert.equal(voice.observe({ outputTranscription: { text }, turnComplete: true }), false);
  assert.equal(voice.observe({ outputTranscription: { text: 'Your intake is complete. Any questions?' }, turnComplete: true }), true);
});

test('authorized completion split across finalized transcript messages ends voice once', () => {
  const events = [], voice = createVoiceState(event => events.push(event));
  assert.equal(voice.observe({ outputTranscription: { text: 'Thank you, Louis. Your' }, turnComplete: true }, true), false);
  assert.equal(voice.state, 'ACTIVE');
  assert.equal(voice.observe({ outputTranscription: { text: 'intake is complete.' }, turnComplete: true }, true), true);
  assert.equal(voice.state, 'ENDING');
  assert.equal(voice.observe({ outputTranscription: { text: 'Is there anything else?' }, turnComplete: true }, true), false);
  assert.deepEqual(events, [{ event: 'gemini_intake_complete', voiceState: 'ENDING' }]);
});

for (const sentence of ['Your intake is complete.', 'Your intake is complete!', 'Your intake is complete?', 'Your intake is complete', 'YOUR INTAKE IS COMPLETE']) {
  test(`terminal phrase accepts punctuation variation: ${sentence}`, () => {
    const events = [];
    const voice = createVoiceState(event => events.push(event));
    assert.equal(voice.observe({ outputTranscription: { text: sentence } }), false);
    assert.equal(voice.state, 'ACTIVE');
    assert.equal(voice.observe({ turnComplete: true }), true);
    assert.equal(voice.state, 'ENDING');
    assert.equal(voice.observe({ outputTranscription: { text: sentence }, turnComplete: true }), false);
    assert.deepEqual(events, [{ event: 'gemini_intake_complete', voiceState: 'ENDING' }]);
  });
}

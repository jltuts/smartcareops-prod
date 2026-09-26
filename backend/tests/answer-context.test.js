import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeSession } from '../src/intake/session.js';
import { createAnswerContext } from '../src/intake/answer-context.js';

for (const [question, text, label] of [
  ['Are you having chest pain?', "No, I don't have chess playing.", 'chest pain'],
  ['Are you having severe difficulty breathing?', "I don't have any severe reading difficulty.", 'severe difficulty breathing'],
  ['Are you having chest pain?', 'Er ist ganz dein.', 'chest pain'],
  ['Are you having chest pain?', '아, no.', 'chest pain'],
  ['Are you having chest pain?', '你好。', 'chest pain'],
]) {
  test(`question context quarantines ${text} and requests one clarification`, async t => {
    const messages = [], questions = []; let calls = 0;
    const session = createIntakeSession({ send: m => messages.push(m), onClarification: q => questions.push(q), extract: async () => { calls++; throw new Error('Quarantined text must not reach extraction'); } });
    t.after(() => session.close());
    session.accept({ outputTranscription: { text: question }, turnComplete: true });
    session.accept({ inputTranscription: { text, finished: true } });
    session.accept({ turnComplete: true });
    const snapshot = await session.drain();
    assert.equal(calls, 0);
    assert.equal(snapshot.symptoms[0].name, label);
    assert.equal(snapshot.symptoms[0].status, 'unclear');
    assert.equal(snapshot.additionalNotes.length, 0);
    assert.equal(questions.length, 1);
    assert.equal(questions[0], `Sorry, I didn't catch that. ${question}`);
    assert.equal(messages.filter(m => m.type === 'intake-update').length, 1);
  });
}

test('honest uncertainty remains unclear without a repeated repair request', async t => {
  const session = createIntakeSession({ send() {}, onClarification: () => assert.fail('Do not repeatedly ask an unsure patient'), extract: async () => assert.fail('No model inference required for uncertainty') });
  t.after(() => session.close());
  session.accept({ outputTranscription: { text: 'Are you having chest pain?' }, turnComplete: true });
  session.accept({ inputTranscription: { text: "I'm not sure.", finished: true } });
  assert.equal((await session.drain()).symptoms[0].status, 'unclear');
});

test('an older in-flight extraction cannot replace a newer garbled answer with a denial', async t => {
  let release; const requests = [];
  const session = createIntakeSession({ delay: 1, send() {}, extract: ({ utterances }) => {
    requests.push(utterances);
    return new Promise(resolve => { release = () => resolve({ updates: ['symptom', 'redFlag'].map(kind => ({ kind, label: kind === 'symptom' ? 'chest pain' : 'current chest pain', value: null, secondaryValue: null, unit: null, qualitative: null, status: 'denied', evidenceId: utterances[0].id, quote: utterances[0].text })) }); });
  } });
  t.after(() => session.close());
  const ask = () => session.accept({ outputTranscription: { text: 'Are you having chest pain?' }, turnComplete: true });
  ask(); session.accept({ inputTranscription: { text: 'No.', finished: true } });
  const deadline = Date.now() + 2000;
  while (!release) { if (Date.now() > deadline) throw new Error('No extraction'); await new Promise(resolve => setTimeout(resolve, 5)); }
  ask(); session.accept({ inputTranscription: { text: "No, I don't have chess playing.", finished: true } });
  const done = session.drain(); release(); const snapshot = await done;
  assert.equal(requests.length, 1);
  assert.equal(snapshot.symptoms[0].status, 'unclear');
  assert.equal(snapshot.redFlags[0].status, 'unclear');
});

test('isolated artifacts outside a clinical question create no facts', async t => {
  const session = createIntakeSession({ send() {}, extract: async () => assert.fail('Artifact was queued') });
  t.after(() => session.close());
  session.accept({ outputTranscription: { text: 'What would you like to add?' }, turnComplete: true });
  session.accept({ inputTranscription: { text: '你好。', finished: true } });
  assert.deepEqual((await session.drain()).evidence, {});
});

test('explicit language preferences and coherent multilingual question/answer context remain supported', () => {
  const assess = createAnswerContext();
  assert.equal(assess('Please speak Korean.', 'Are you having chest pain?'), undefined);
  assert.equal(assess('아니요.', '가슴 통증이 있나요?'), undefined);
  const consistent = createAnswerContext();
  assert.equal(consistent('没有。', '你有胸痛吗？'), undefined);
  const names = createAnswerContext();
  assert.equal(names('지민', 'What is your name?'), undefined);
  const english = createAnswerContext();
  assert.equal(english('你好。', 'Are you having chest pain?').blocked, true);
  assert.equal(english('你好。', 'Are you having chest pain?').blocked, true, 'Repeated artifacts alone do not establish clinical meaning');
});

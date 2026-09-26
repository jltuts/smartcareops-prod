import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeSession } from '../src/intake/session.js';
import { emptyIntake } from '../src/intake/schema.js';
import { mergeIntake, needsClarification } from '../src/intake/validate.js';
import { pendingClarifications } from '../../shared/intake-clarifications.js';

const update = (id, text, extra = {}) => ({ kind: 'symptom', label: 'chest pain', value: null, secondaryValue: null, unit: null, qualitative: null, status: 'denied', evidenceId: id, quote: text, ...extra });
const say = (session, question, text) => {
  session.accept({ outputTranscription: { text: question }, turnComplete: true });
  session.accept({ inputTranscription: { text, finished: true } });
};

for (const unrelated of [false, true]) {
  test(`invalid candidate recovery clears only its evidence-linked repair; unrelated=${unrelated}`, async t => {
    const messages = [], logs = [];
    let reject = true;
    const session = createIntakeSession({ send: m => messages.push(m), log: m => logs.push(m), extract: async ({ utterances }) => ({
      updates: [update(utterances.at(-1).id, utterances.at(-1).text, reject ? { status: null } : {})],
    }) });
    t.after(() => session.close());
    if (unrelated) say(session, 'Are you having severe difficulty breathing?', 'I have reading difficulty.');
    say(session, 'Are you having chest pain?', 'I have chess playing.');
    const initial = structuredClone(messages.at(-1).intake);
    assert.equal(pendingClarifications(initial).length, unrelated ? 2 : 1);
    assert.equal(needsClarification(initial), true);
    say(session, 'Are you having chest pain?', 'Nope.');
    await assert.rejects(session.drain(), e => e.detail.code === 'INVALID_RESPONSE' && /Field: status/.test(e.detail.developerMessage));
    const { validationClarifications, ...facts } = messages.filter(m => m.type === 'intake-update').at(-1).intake;
    assert.deepEqual(facts, initial, 'invalid status never commits');
    assert.equal(validationClarifications.length, 1);
    assert.equal(logs[0].field, 'status');
    reject = false;
    session.resume();
    say(session, 'Are you having chest pain?', 'Nope.');
    const snapshot = await session.drain();
    assert.equal(snapshot.symptoms.find(s => s.name === 'chest pain').status, 'denied');
    assert.equal(snapshot.redFlags.find(s => s.type === 'current chest pain').status, 'denied');
    assert.equal(pendingClarifications(snapshot).length, unrelated ? 1 : 0);
    assert.equal(needsClarification(snapshot), unrelated);
    if (unrelated) assert.equal(snapshot.redFlags.find(s => s.type === 'severe difficulty breathing').status, 'unclear');
  });
}

test('clinical Nope is denied, while uncertain or compound answers remain unclear', () => {
  for (const [text, question, expected] of [
    ['Nope.', 'Are you having chest pain?', 'denied'],
    ['Maybe.', 'Are you having chest pain?', 'unclear'],
    ['Nope.', 'Are you having chest pain or difficulty breathing?', 'unclear'],
  ]) {
    const next = mergeIntake(emptyIntake(), { updates: [update(1, text)] }, [{ id: 1, role: 'Patient', text, question }]);
    assert.equal(next.symptoms[0].status, expected);
  }
});

test('a successful unrelated no-op cannot clear a current required repair', async t => {
  const session = createIntakeSession({ send() {}, extract: async () => ({ updates: [] }) });
  t.after(() => session.close());
  say(session, 'Are you having chest pain?', 'I have chess playing.');
  say(session, 'Anything else?', 'Okay.');
  const snapshot = await session.drain();
  assert.equal(needsClarification(snapshot), true);
  assert.equal(pendingClarifications(snapshot).length, 1);
});

test('a structurally malformed provider update retries without creating a stale clinical clarification', async t => {
  let calls = 0;
  const session = createIntakeSession({ delay: 60000, send() {}, extract: async ({ utterances }) => {
    calls++;
    if (calls === 1) return { updates: [{ kind: 'symptom', label: 'dizziness', value: null, secondaryValue: null, unit: null, qualitative: null, evidenceId: utterances[0].id, quote: utterances[0].text }] };
    return { updates: [update(utterances[0].id, utterances[0].text)] };
  } });
  t.after(() => session.close());
  say(session, 'Are you having chest pain?', 'Nope.');
  await assert.rejects(session.drain(), error => error.detail.code === 'INVALID_RESPONSE');
  assert.equal(session.diagnostics.clarificationState, 'none');
  assert.deepEqual(session.diagnostics.unresolvedCategories, []);
  session.resume();
  const snapshot = await session.drain();
  assert.equal(calls, 2);
  assert.equal(needsClarification(snapshot), false);
  assert.equal(snapshot.symptoms.find(item => item.name === 'chest pain').status, 'denied');
});

test('confusion followed by a rephrased valid answer clears active-question state before finalization', async t => {
  const session = createIntakeSession({ delay: 60000, send() {}, extract: async ({ utterances }) => ({ updates: [update(utterances[0].id, utterances[0].text)] }) });
  t.after(() => session.close());
  say(session, 'Are you having chest pain?', 'What?');
  assert.equal(session.diagnostics.clarificationState, 'active_question');
  say(session, 'To rephrase, are you having chest pain right now?', 'Nope.');
  const snapshot = await session.drain();
  assert.equal(session.diagnostics.activeQuestion, false);
  assert.equal(session.diagnostics.clarificationState, 'none');
  assert.equal(snapshot.symptoms.find(item => item.name === 'chest pain').status, 'denied');
});

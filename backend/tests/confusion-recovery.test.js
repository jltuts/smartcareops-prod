import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeSession } from '../src/intake/session.js';
import { createExtractor } from '../src/intake/extractor.js';
import { emptyIntake } from '../src/intake/schema.js';
import { mergeIntake } from '../src/intake/validate.js';
import { isConfusion } from '../src/intake/confusion.js';
const question = 'Could you describe the pain? Is it sharp, dull, throbbing, or something else?';
const output = (session, text) => session.accept({ outputTranscription: { text }, turnComplete: true });
const input = (session, text) => session.accept({ inputTranscription: { text, finished: true } });
const note = (id, text) => ({ kind: 'note', label: null, value: text, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: id, quote: text });
for (const text of ['What?', '¿Qué? ¿Qué es eso?', "I don't understand.", 'Sorry?', 'What do you mean?', 'Can you explain?', 'Could you explain that?', 'Could you explain that please?', "I don't understand the question."]) test(`confusion retains question and excludes all clinical evidence: ${text}`, async () => {
  const repairs = [], batches = [], sent = [];
  const session = createIntakeSession({ delay: 60000, send: e => sent.push(e), onClarification: q => repairs.push(q), extract: async batch => { batches.push(batch); return { updates: batch.utterances.map(u => note(u.id, u.text)) }; } });
  output(session, question); input(session, text); assert.equal(session.awaitingQuestionClarification, true);
  assert.match(repairs[0], /What does the pain feel like/); assert.equal((repairs[0].match(/\?/g) || []).length, 1);
  assert.equal(batches.length, 0); assert.equal(sent.filter(e => e.type === 'intake-update').length, 0);
  // Even if the Live model drifts, the backend retains the original context.
  output(session, 'Are you having dizziness?'); input(session, 'It feels like pressure.');
  const intake = await session.drain(); assert.equal(batches[0].utterances[0].question, question); assert.equal(intake.additionalNotes[0], 'It feels like pressure.');
  assert.equal(JSON.stringify(intake).includes(text), false); assert.equal(session.awaitingQuestionClarification, false); session.close();
});
test('unanswered confusion prevents structured finalization; explicit inability releases the question', async () => {
  const session = createIntakeSession({ delay: 60000, send() {}, extract: async () => ({ updates: [] }) });
  output(session, question); input(session, 'What?'); await assert.rejects(session.drain()); session.resume();
  input(session, "I don't know how to describe it."); const intake = await session.drain(); assert.deepEqual(intake.symptoms, []); assert.deepEqual(intake.additionalNotes, []); assert.equal(session.awaitingQuestionClarification, false); session.close();
});
test('extractor bypasses confusion and evidence validation rejects forged confusion facts', async () => {
  const utterances = [{ id: 1, role: 'Patient', text: '¿Qué? ¿Qué es eso?', question }];
  const extract = createExtractor('test', undefined, { request: () => assert.fail('Confusion must not reach extractor API') });
  assert.deepEqual(await extract({ utterances, intake: emptyIntake() }), { updates: [] });
  assert.throws(() => mergeIntake(emptyIntake(), { updates: [note(1, utterances[0].text)] }, utterances));
});
test('mixed clinical answers, explicit inability and names are not quarantined', () => {
  for (const text of ['What? I have chest pain.', "I don't know how to describe it.", 'No chest pain.', 'It feels like pressure.', 'My name is Que.', 'I feel confused and dizzy.']) assert.equal(isConfusion(text), false);
});

test('repeated and fragmented confusion keeps the original question until an answer', async () => {
  const batches = [], repairs = [];
  const session = createIntakeSession({ delay: 60000, send() {}, onClarification: q => repairs.push(q), extract: async batch => { batches.push(batch); return { updates: [] }; } });
  try {
    output(session, question);
    session.accept({ inputTranscription: { text: 'I don\'t ' } });
    session.accept({ inputTranscription: { text: 'understand.', finished: true } });
    output(session, repairs[0]); input(session, '¿Qué?');
    assert.equal(session.awaitingQuestionClarification, true);
    assert.equal(repairs.length, 2);
    input(session, "I don't know how to describe it.");
    const intake = await session.drain();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].utterances.length, 1);
    assert.equal(batches[0].utterances[0].question, question);
    assert.equal(session.awaitingQuestionClarification, false);
    assert.deepEqual(intake, emptyIntake());
  } finally { session.close(); }
});

test('confusion cannot support symptoms, denials, notes or reported evidence', () => {
  for (const text of ['What?', '¿Qué? ¿Qué es eso?', "I don't understand."]) {
    const utterances = [{ id: 1, role: 'Patient', text, question }];
    for (const update of [note(1, text), ...['confirmed', 'denied', 'unclear'].map(status => ({ ...note(1, text), kind: 'symptom', label: 'headache', value: null, status }))]) {
      assert.throws(() => mergeIntake(emptyIntake(), { updates: [update] }, utterances), error => error.reason === 'missing evidence');
    }
  }
});

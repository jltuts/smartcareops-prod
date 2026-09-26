import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyIntake, normalizePatch } from '../src/intake/schema.js';
import { mergeIntake, needsClarification } from '../src/intake/validate.js';
import { createIntakeSession } from '../src/intake/session.js';

const utterance = (text, question = '', id = 1) => ({ id, role: 'Patient', text, question });
const update = (kind, quote, extra = {}) => ({ kind, label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: 1, quote, ...extra });
const merge = (items, speech, state = emptyIntake()) => mergeIntake(state, { updates: items }, speech);

for (const [text, question, label] of [
  ["I don't know chess piece.", 'Are you having chest pain?', 'chest pain'],
  ["I don't have any severe reading difficulty.", 'Are you having severe difficulty breathing?', 'severe difficulty breathing'],
  ['아, no.', 'Are you having chest pain?', 'chest pain'],
]) {
  test(`garbled answer stays unclear: ${text}`, () => {
    const state = merge([update('symptom', text, { label, status: 'denied' })], [utterance(text, question)]);
    assert.equal(state.symptoms[0].status, 'unclear');
    assert.equal(state.symptoms[0].patientReportedText, text);
    assert.equal(needsClarification(state), true);
    const clarified = merge([update('symptom', 'No.', { label, status: 'denied', evidenceId: 2 })], [utterance('No.', question, 2)], state);
    assert.equal(clarified.symptoms[0].status, 'denied');
    assert.equal(needsClarification(clarified), false);
    assert.throws(() => merge([update('symptom', text, { label: 'reading difficulty', status: 'confirmed' })], [utterance(text, question)]));
  });
}

test('malformed glucose unit preserves the number but requires explicit clarification', () => {
  const text = 'My blood sugar was 190 mmol.';
  const state = merge([update('bloodGlucose', text, { value: 190, unit: 'mmol/L' })], [utterance(text)]);
  assert.deepEqual(state.vitals.bloodGlucose, { value: 190, unit: null, qualitative: null, source: 'patient_reported' });
  assert.equal(needsClarification(state), true);
  for (const unit of ['mg/dL', 'mmol/L']) {
    const clarified = `My blood glucose was 190 ${unit}.`;
    const result = merge([update('bloodGlucose', clarified, { value: 190, unit, evidenceId: 2 })], [utterance(clarified, '', 2)], state);
    assert.equal(result.vitals.bloodGlucose.unit, unit);
    assert.equal(needsClarification(result), false);
  }
});

test('an honestly uncertain clarification may remain unclear without another forced clarification', () => {
  const text = 'Not sure.';
  const state = merge([update('symptom', text, { label: 'chest pain', status: 'unclear' })], [utterance(text, 'Are you having chest pain?')]);
  assert.equal(state.symptoms[0].status, 'unclear');
  assert.equal(needsClarification(state), false);
});
test('wire normalization parses only numeric vital strings and preserves unknown keys for rejection', () => {
  const wire = { kind: 'bloodGlucose', label: '', value: '240', secondaryValue: '', unit: '', qualitative: '', status: '', evidenceId: 1, quote: 'My sugar is 240' };
  const normalized = normalizePatch({ updates: [wire] });
  assert.equal(normalized.updates[0].value, 240);
  assert.equal(normalized.updates[0].unit, null);
  assert.throws(() => normalizePatch({ updates: [{ ...wire, value: '240 mg/dL' }] }));
  assert.throws(() => mergeIntake(emptyIntake(), normalizePatch({ updates: [wire], diagnosis: 'test' }), [utterance(wire.quote)]));
});
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('quota errors identify the failed batch without secrets and retain the last valid summary', async t => {
  const messages = [], logs = [];
  let fail = false;
  const session = createIntakeSession({ delay: 1, send: m => messages.push(m), log: details => logs.push(details), extract: async ({ utterances }) => {
    if (fail) throw Object.assign(new Error('https://example?key=secret-do-not-log'), { status: 429 });
    return { updates: [update('name', utterances[0].text, { value: 'JL', evidenceId: utterances[0].id })] };
  } });
  t.after(() => session.close()); session.start();
  session.accept({ inputTranscription: { text: 'My name is JL.', finished: true } });
  await until(() => messages.at(-1).status === 'current');
  const previous = structuredClone(messages.findLast(m => m.type === 'intake-update').intake);
  fail = true;
  session.accept({ inputTranscription: { text: "I'm feeling dizzy.", finished: true } });
  await until(() => messages.at(-1).status === 'rate-limited');
  assert.deepEqual(logs, [{
    stage: 'extraction', provider: 'gemini', code: 'RATE_LIMIT', httpStatus: 429,
    finalizationCode: 'RATE_LIMIT', utteranceIds: [2], updateCount: 0,
    acceptedCount: 0, rejectedCount: 0, reason: 'RATE_LIMIT',
  }]);
  assert.deepEqual(messages.findLast(m => m.type === 'intake-update').intake, previous);
  assert.equal(messages.filter(m => m.type === 'intake-update').length, 2);
  assert.doesNotMatch(JSON.stringify({ messages, logs }), /secret-do-not-log/);
});

test('patient name and preferred name retain patient evidence', () => {
  const text = 'My name is Mark Lewis Garcia.';
  const result = merge([update('name', text, { value: 'Mark Lewis Garcia' }), update('preferredName', text, { value: 'Mark' })], [utterance(text)]);
  assert.equal(result.patient.name, 'Mark Lewis Garcia');
  assert.equal(result.patient.preferredName, 'Mark');
  assert.equal(result.evidence.name.patientReportedText, text);
});

test('confirmed and denied symptoms are separate and sourced', () => {
  const result = merge([
    update('symptom', 'I have a cough.', { label: 'cough', status: 'confirmed' }),
    update('symptom', 'No fever.', { label: 'fever', status: 'denied', evidenceId: 2 }),
  ], [utterance('I have a cough.'), utterance('No fever.', '', 2)]);
  assert.deepEqual(result.symptoms.map(item => item.status), ['confirmed', 'denied']);
});

for (const response of ['Yes.', 'No.', 'Maybe.', 'Both.']) {
  test(`compound-question ${response} cannot confirm or deny individual symptoms`, () => {
    const result = merge(['chest pain', 'difficulty breathing'].map(label => update('symptom', response, { label, status: 'confirmed' })),
      [utterance(response, 'Do you have chest pain or difficulty breathing?')]);
    assert.ok(result.symptoms.every(item => item.status === 'unclear'));
  });
}

test('single symptom clarification resolves ambiguity without replacing other facts', () => {
  let state = merge([update('symptom', 'Yes.', { label: 'chest pain', status: 'confirmed' })], [utterance('Yes.', 'Chest pain or difficulty breathing?')]);
  state = merge([update('symptom', 'No.', { label: 'chest pain', status: 'denied', evidenceId: 2 })], [utterance('No.', 'Do you have chest pain?', 2)], state);
  assert.equal(state.symptoms[0].status, 'denied');
});

test('uncertain denial remains unclear', () => {
  const text = "I don't think I have fever.";
  const state = merge([update('symptom', text, { label: 'fever', status: 'denied' })], [utterance(text)]);
  assert.equal(state.symptoms[0].status, 'unclear');
});

test('reported numeric vitals retain their values, units and source', () => {
  const reports = [
    ['temperature', 'My temperature is 38.5 degrees Celsius.', { value: 38.5, unit: '°C' }],
    ['bloodPressure', 'My blood pressure is 120 over 80.', { value: 120, secondaryValue: 80 }],
    ['heartRate', 'My pulse is 90.', { value: 90 }],
    ['spo2', 'My oxygen saturation is 97.', { value: 97 }],
    ['bloodGlucose', 'My sugar is 240.', { value: 240 }],
  ];
  const result = merge(reports.map(([kind, quote, values], index) => update(kind, quote, { ...values, evidenceId: index + 1 })), reports.map(([, text], index) => utterance(text, '', index + 1)));
  assert.equal(result.vitals.temperature.value, 38.5);
  assert.equal(result.vitals.bloodPressure.diastolic, 80);
  assert.equal(result.vitals.heartRate.unit, 'bpm');
  assert.equal(result.vitals.spo2.value, 97);
  assert.equal(result.vitals.bloodGlucose.value, 240);
  assert.equal(result.vitals.bloodGlucose.unit, null);
  assert.ok(Object.values(result.vitals).every(item => item.source === 'patient_reported'));
});

test('qualitative glucose stays qualitative; invented numbers and units are rejected', () => {
  const text = 'I think my blood sugar is high';
  const result = merge([update('bloodGlucose', text, { qualitative: 'patient reports high' })], [utterance(text)]);
  assert.deepEqual(result.vitals.bloodGlucose, { value: null, unit: null, qualitative: 'patient reports high', source: 'patient_reported' });
  assert.throws(() => merge([update('bloodGlucose', text, { value: 240 })], [utterance(text)]));
  assert.throws(() => merge([update('bloodGlucose', 'My sugar is 240.', { value: 240, unit: 'mg/dL' })], [utterance('My sugar is 240.')]));
  assert.throws(() => merge([update('temperature', 'My sugar is 240.', { value: 240 })], [utterance('My sugar is 240.')]));
});

test('confirmed current chest pain is represented separately without interpreting urgency', () => {
  const text = 'I have chest pain right now';
  const result = merge([update('redFlag', text, { label: 'current chest pain', status: 'confirmed' })], [utterance(text)]);
  assert.deepEqual(result.redFlags, [{ type: 'current chest pain', status: 'confirmed', patientReportedText: text }]);
  assert.equal(result.symptoms.length, 0);
  assert.throws(() => merge([update('redFlag', 'I have difficulty breathing', { label: 'severe difficulty breathing', status: 'confirmed' })], [utterance('I have difficulty breathing')]));
});

test('unknown diagnosis fields, invalid enums, fabricated evidence and assistant evidence are rejected atomically', () => {
  const text = 'I have a cough';
  const good = update('symptom', text, { label: 'cough', status: 'confirmed' });
  const state = emptyIntake();
  for (const patch of [
    { updates: [good], diagnosis: 'Disease' },
    { updates: [good, { ...good, treatment: 'Medicine' }] },
    { updates: [{ ...good, status: 'likely' }] },
    { updates: [{ ...good, quote: 'Invented patient speech' }] },
  ]) assert.throws(() => mergeIntake(state, patch, [utterance(text)]));
  assert.throws(() => merge([good], [{ ...utterance(text), role: 'Gemini' }]));
  assert.deepEqual(state, emptyIntake());
});

test('updates merge, preserve untouched fields and ignore stale evidence', () => {
  let state = merge([update('name', 'Mark', { value: 'Mark', evidenceId: 2 })], [utterance('Mark', '', 2)]);
  state = merge([update('onset', 'Yesterday', { value: 'Yesterday', evidenceId: 3 })], [utterance('Yesterday', '', 3)], state);
  state = merge([update('name', 'John', { value: 'John' })], [utterance('John')], state);
  assert.equal(state.patient.name, 'Mark'); assert.equal(state.onset.value, 'Yesterday');
});

test('malformed extraction preserves state and retries on a later turn without ending the session', async t => {
  const messages = []; let calls = 0; let logs = 0;
  const session = createIntakeSession({ delay: 1, log: () => logs++, send: message => messages.push(message), extract: async ({ utterances }) => {
    calls++;
    if (calls === 2) return { diagnosis: 'forbidden' };
    const last = utterances.at(-1);
    return { updates: [update('name', last.text, { value: last.text, evidenceId: last.id })] };
  } });
  t.after(() => session.close()); session.start();
  session.accept({ inputTranscription: { text: 'Mark', finished: true } });
  await until(() => messages.some(message => message.intake?.patient.name === 'Mark'));
  session.accept({ inputTranscription: { text: 'John', finished: true } });
  await until(() => logs === 1);
  assert.equal(messages.filter(message => message.type === 'intake-update').at(-1).intake.patient.name, 'Mark');
  session.accept({ inputTranscription: { text: 'Jane', finished: true } });
  await until(() => messages.some(message => message.intake?.patient.name === 'Jane'));
  assert.equal(calls, 3);
});

test('new sessions are clean and late responses cannot leak after close', async () => {
  const messages = []; let resolve;
  const session = createIntakeSession({ delay: 1, send: message => messages.push(message), extract: () => new Promise(done => { resolve = done; }) });
  session.start(); session.accept({ inputTranscription: { text: 'Mark', finished: true } });
  await until(() => resolve);
  session.close(); resolve({ updates: [update('name', 'Mark', { value: 'Mark' })] });
  await new Promise(done => setTimeout(done, 10));
  assert.equal(messages.filter(message => message.type === 'intake-update').length, 1);
  const next = createIntakeSession({ send: message => messages.push(message), extract: async () => ({ updates: [] }) });
  next.start(); next.close();
  assert.deepEqual(messages.filter(message => message.type === 'intake-update').at(-1).intake, emptyIntake());
});

test('transcription fragments coalesce and a blocked extractor times out without blocking the voice path', async t => {
  const messages = []; const batches = [];
  const session = createIntakeSession({ delay: 5, timeoutMs: 20, log: () => {}, send: message => messages.push(message), extract: args => { batches.push(args.utterances); return new Promise(() => {}); } });
  t.after(() => session.close());
  session.accept({ outputTranscription: { text: 'Do you have chest pain or difficulty breathing?' }, turnComplete: true });
  session.accept({ inputTranscription: { text: 'Ye' } });
  session.accept({ inputTranscription: { text: 's.', finished: true } });
  session.accept({ turnComplete: true });
  await until(() => messages.some(message => message.status === 'unavailable'));
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].text, 'Yes.');
  assert.match(batches[0][0].question, /chest pain or difficulty breathing/);
});

test('isolated anomalous answers cannot supply inferred clinical symptoms; clarification can', () => {
  for (const text of ['Er ist ganz dein.', 'The purple clock eats Tuesday.']) {
    const state = emptyIntake();
    for (const kind of ['symptom', 'redFlag']) {
      assert.throws(() => merge([update(kind, text, { label: kind === 'symptom' ? 'chest pain' : 'current chest pain', status: 'confirmed' })],
        [utterance(text, 'Are you having chest pain?')], state));
    }
    assert.deepEqual(state, emptyIntake());
    const clarified = 'I have chest pain right now.';
    const result = merge([update('symptom', clarified, { label: 'chest pain', status: 'confirmed', evidenceId: 2 })],
      [utterance(clarified, "Sorry, I didn't catch that. Could you say that again?", 2)], state);
    assert.equal(result.symptoms[0].status, 'confirmed');
    assert.equal(result.evidence['symptoms.chest pain'].utteranceId, 2);
  }
});

test('coherent multilingual symptom evidence is not blocked by language', () => {
  const text = 'Tengo tos.';
  const result = merge([update('symptom', text, { label: 'tos', status: 'confirmed' })],
    [utterance(text, '¿Qué síntomas tiene?')]);
  assert.equal(result.symptoms[0].name, 'tos');
  assert.equal(result.symptoms[0].status, 'confirmed');
});

test('extraction prompt omits all facts from isolated incoherent input until clarified', async () => {
  const { extractionInstruction } = await import('../src/intake/extractor.js');
  assert.match(extractionInstruction, /honor an explicit language request or coherent sustained multilingual conversation/);
  assert.match(extractionInstruction, /Return no updates from that utterance, including no symptoms, red flags, onset, vitals, names, or notes/);
  assert.match(extractionInstruction, /wait for subsequent patient clarification and cite that clarified utterance instead/);
  assert.match(extractionInstruction, /Er ist ganz dein/);
  assert.match(extractionInstruction, /not chest pain, a symptom named after the text, or a verbatim note/);
});


test('literal dizzy evidence gains a deterministic canonical concept while preserving denial and uncertainty checks', () => {
  for (const [text, expected] of [["I'm feeling dizzy.", 'confirmed'], ["I'm not dizzy.", 'denied'], ['I might be dizzy.', 'unclear']]) {
    const result = merge([update('symptom', text, { label: 'dizzy', status: 'confirmed' })], [utterance(text)]);
    assert.equal(result.symptoms[0].status, expected);
    assert.equal(result.symptoms[0].canonicalConcept, 'dizziness');
  }
  assert.throws(() => merge([update('symptom', 'I have a cough.', { label: 'dizziness', status: 'confirmed' })], [utterance('I have a cough.')]));
});

test('draining flushes trailing transcript fragments and a timed-out request cannot finalize', async t => {
  const messages = []; let seen;
  const session = createIntakeSession({ delay: 10000, timeoutMs: 20, log() {}, send: message => messages.push(message), extract: ({ utterances }) => { seen = utterances; return new Promise(() => {}); } });
  t.after(() => session.close()); session.start();
  session.accept({ inputTranscription: { text: 'My name is Jael.' } });
  const drained = session.drain();
  assert.equal(session.drain(), drained);
  await assert.rejects(drained, /Final extraction failed/);
  assert.equal(seen[0].text, 'My name is Jael.');
  assert.equal(messages.at(-1).code, 'TIMEOUT');
  assert.equal(messages.at(-1).status, 'unavailable');
  assert.equal(messages.filter(m => m.type === 'intake-update').length, 1);
});

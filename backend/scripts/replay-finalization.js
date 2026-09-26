// Explicit opt-in only: one fictional replay through the real extractor.
import assert from 'node:assert/strict';
import { createExtractor } from '../src/intake/extractor.js';
import { createIntakeSession } from '../src/intake/session.js';
import { createCompletionState } from '../src/completion.js';
import { createCompletedCases } from '../src/agent/cases.js';
import { needsClarification } from '../src/intake/validate.js';
import { finalizationFailure, FinalizationError } from '../src/intake/finalization.js';
import { GoogleGenAI } from '@google/genai';

const completion = createCompletionState(), cases = createCompletedCases();
let stage = 'extraction';
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const extract = createExtractor(process.env.GEMINI_API_KEY, undefined, { request: async (...args) => {
  const response = await client.interactions.create(...args);
  try {
    const payload = JSON.parse(response.output_text);
    for (const [updateIndex, update] of (payload.updates || []).entries()) {
      const safe = {};
      for (const key of ['kind', 'label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'evidenceId', 'quote']) {
        const value = update[key];
        safe[key] = value === null || typeof value === 'number' || (typeof value === 'string' && (/^\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?$/.test(value) || ['', 'name', 'J', 'symptom', 'redFlag', 'onset', 'note', 'dizziness', 'chest pain', 'current chest pain', 'difficulty breathing', 'severe difficulty breathing', 'yesterday', 'bloodPressure', 'blood pressure', 'confirmed', 'denied', 'unclear', 'mmHg', 'mmhg', 'My name is J.', 'I feel dizzy.', 'No, no chest pain.', 'No. No.', 'yesterday shark suddenly', 'Yes, my blood pressure is 145/90.'].includes(value))) ? value : `[${typeof value} omitted]`;
      }
      console.info('Fictional replay candidate:', JSON.stringify({ updateIndex, ...safe }));
    }
  } catch { /* Never print malformed provider output. Normal validation handles it. */ }
  return response;
} });
const session = createIntakeSession({ extract, send() {}, log: detail => console.info('[intake]', detail) });
try {
  const accept = content => session.accept(content, completion.observe(content));
  for (const [question, text] of [
    ["Hello. I'm the SmartCareOps clinical intake assistant. May I have your name?", 'My name is J.'],
    ['What are you feeling today?', 'I feel dizzy.'],
    ['Have you had any chest pain with that?', 'No, no chest pain.'],
    ['Are you having any difficulty breathing?', 'No. No.'],
    ['When did the dizziness start?', 'yesterday shark suddenly'],
    ["Is there anything else you'd like to add before we finish?", 'Yes, my blood pressure is 145/90.'],
    ["Is there anything else you'd like to add before we finish?", 'No, nothing else.'],
  ]) {
    accept({ outputTranscription: { text: question }, turnComplete: true });
    accept({ inputTranscription: { text, finished: true } });
    if (text === 'No, no chest pain.') { await session.drain(); session.resume(); }
  }
  accept({ outputTranscription: { text: 'Thank you, J. Your intake is complete.' }, turnComplete: true });
  const snapshot = await session.drain();
  stage = 'snapshot-verification';
  assert.equal(snapshot.patient.name || snapshot.patient.preferredName, 'J');
  assert.ok(snapshot.symptoms.some(s => ['dizziness', 'dizzy'].includes(s.name) && s.status === 'confirmed'));
  assert.ok(snapshot.onset.value === 'yesterday' || snapshot.onset.value === null);
  for (const name of ['chest pain', 'difficulty breathing']) {
    assert.ok(snapshot.symptoms.some(s => s.name === name && s.status === 'denied') || snapshot.redFlags.some(s => s.type === `current ${name}` && s.status === 'denied'));
  }
  assert.equal(snapshot.vitals.bloodPressure.systolic, 145);
  assert.equal(snapshot.vitals.bloodPressure.diastolic, 90);
  assert.equal(needsClarification(snapshot), false);
  assert.equal(completion.complete(completion.id), true);
  const token = cases.issue(snapshot);
  assert.deepEqual(cases.get(token, snapshot), snapshot);
  console.info(JSON.stringify({ code: 'SUCCESS', stage: 'finalization', provider: 'gemini', expectedFactsVerified: true, onset: snapshot.onset, bloodPressure: snapshot.vitals.bloodPressure, remainingClarifications: 0, tokenIssued: true }));
} catch (error) {
  console.error(JSON.stringify(error instanceof FinalizationError ? error.detail : finalizationFailure('FINALIZATION_UNKNOWN', stage)));
  process.exitCode = 1;
} finally { session.close(); cases.clear(); }

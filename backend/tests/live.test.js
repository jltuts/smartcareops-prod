import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { attachLiveRelay, systemInstruction } from '../src/live.js';
import { readFinalization } from './finalization-client.js';
import { createFinalizationResults, createMemoryFinalizationDriver } from '../src/finalization-results.js';
import { createMemoryCaseStore } from '../src/cases/store.js';

const waitClosed = ws => ws.readyState === WebSocket.CLOSED ? Promise.resolve() : once(ws, 'close');

function assertClarificationRules(instruction) {
  assert.match(instruction, /Ask one clinical question at a time and wait for the patient's answer/);
  assert.match(instruction, /Do not combine multiple yes\/no clinical facts or possible symptoms/);
  assert.match(instruction, /Do not combine a symptom question with a timing question/);
  assert.match(instruction, /"yes", "no", "maybe", or another ambiguous short response, ask a clarification question before proceeding/);
  assert.match(instruction, /Never infer which specific symptom or fact the patient meant from an ambiguous answer to a compound question/);
  assert.match(instruction, /Do not treat that answer as confirmation or denial of any of the individual symptoms/);
  assert.match(instruction, /Confirm each clinically relevant symptom individually before treating it as reported/);
  assert.match(instruction, /If the patient remains unsure, leave the symptom unconfirmed/);
}

test('intake instruction requires individual questions, clarification, and no symptom inference', () => {
  assertClarificationRules(systemInstruction);
  assert.match(systemInstruction, /severe breathing difficulty and severe chest pain separately/);
  assert.match(systemInstruction, /Do not diagnose, prescribe medication/);
  assert.match(systemInstruction, /once enough basic intake information is collected, stop routine questions/);
});

function assertPatientFacingRules(instruction) {
  assert.match(instruction, /Ask exactly one question per turn/);
  assert.match(instruction, /Start every new intake session with only: "Hello\. I'm the SmartCareOps clinical intake assistant\. May I have your name\?"/);
  assert.match(instruction, /Wait for the patient's answer before asking about symptoms/);
  assert.match(instruction, /Never ask the name and symptoms in the same turn/);
  assert.match(instruction, /For "My name is Mark Lewis Garcia\.", respond: "Thank you, Mark\. What are you feeling today\?"/);
  assert.match(instruction, /What name would you like me to use\?/);
  assert.match(instruction, /Do not automatically use Mr\., Mrs\., Ms\., Dr\., or another title unless the patient explicitly provides or requests it/);
  assert.match(instruction, /Use the patient's name sparingly, not in every response/);
}

test('name-first opening waits for a reply and uses a preferred first name naturally', () => {
  assertPatientFacingRules(systemInstruction);
  const opening = systemInstruction.match(/Start every new intake session with only: "([^"]+)"/)[1];
  assert.equal((opening.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(opening, /symptom|feeling/i);
});

test('spoken examples exclude development language and closing is natural', () => {
  assert.match(systemInstruction, /Never use internal development terms in spoken or transcript responses: prototype, demo, hackathon, M1, milestone, test environment, or proof of concept/);
  // Inspect patient-facing examples, excluding the instruction that forbids these terms.
  for (const [quoted] of systemInstruction.matchAll(/"[^"]+"/g)) {
    assert.doesNotMatch(quoted, /\b(prototype|demo|hackathon|M\d+|milestone|test environment|proof[ -]of[ -]concept)\b/i);
  }
  assert.match(systemInstruction, /I have the basic information I need for your intake/);
  assert.match(systemInstruction, /Only if no urgent issue is confirmed or awaiting clarification/);
  assert.match(systemInstruction, /Is there anything else you'd like to add before we finish\?/);
});

test('confirmed emergency red flags override routine intake without diagnosis or false dispatch claims', () => {
  assert.match(systemInstruction, /If current chest pain or another emergency red flag/);
  assert.match(systemInstruction, /severe breathing difficulty, is clearly confirmed, stop normal intake immediately/);
  assert.match(systemInstruction, /takes priority over name collection and routine closing questions/);
  assert.match(systemInstruction, /Do not infer a red flag from an ambiguous compound-question answer/);
  assert.doesNotMatch(systemInstruction, /Please call your local emergency number now/);
  assert.match(systemInstruction, /Emergency escalation is pending/);
  assert.match(systemInstruction, /No dispatcher or emergency service has been contacted/);
  assert.match(systemInstruction, /The backend owns the local escalation state/);
});

test('ambiguous Yes prompt regression clarifies thirst before asking separately about urination', () => {
  // This checks the model instruction's regression example, not generated model behavior.
  assert.ok(systemInstruction.includes([
    'Gemini: "Have you had increased thirst or frequent urination?"',
    'Patient: "Yes."',
    'Gemini: "Just to clarify, have you been unusually thirsty?"',
    'Patient: "Yes."',
    'Gemini: "Have you also been urinating more often than usual?"',
  ].join('\n')));
  assert.match(systemInstruction, /Only thirst is confirmed at this point; wait for a separate answer about urination/);
});

async function fixture(t, options = {}) {
  const server = createServer();
  const relay = attachLiveRelay(server, { origins: ['http://localhost:5173'], extract: async () => ({ updates: [] }), ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const ws of relay.clients) ws.terminate();
    relay.close();
    await new Promise(resolve => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}/api/live`;
}

async function client(url, autoSettle = true) {
  const ws = new WebSocket(url, { origin: 'http://localhost:5173' });
  const messages = [];
  ws.on('message', data => {
    const message = JSON.parse(data); messages.push(message);
    if (message.type === 'completion-pending') {
      ws.finalizationResult = readFinalization(url, message.resultTicket).then(result => {
        if (result.snapshot) messages.push({ type: 'intake-update', intake: result.snapshot, transport: 'http' });
        messages.push({ ...result, transport: 'http' });
        return result;
      });
      if (autoSettle) ws.send(JSON.stringify({ type: 'completion-settled', id: message.id }));
    }
  });
  await once(ws, 'open');
  return { ws, messages };
}

for (const scenario of ['clean', 'strange', 'corrupted', 'unrecognized', 'validation', 'clarification']) {
  test(`canonical Gemini ending is irreversible: ${scenario}`, async t => {
    let callbacks, release, issued = 0, closed = 0;
    const inputs = [], voiceLogs = [], finalLogs = [];
    const url = await fixture(t, {
      apiKey: 'fake', voiceLog: d => voiceLogs.push(d), finalizationLog: d => finalLogs.push(d),
      onCompleted: () => { issued++; return 'one-token'; },
      connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput: input => inputs.push(input), close() { closed++; } }; },
      extract: ({ utterances }) => new Promise(resolve => { release = () => resolve({ updates: utterances.filter(u => u.id === 1).map(u => ({ kind: 'name', label: null, value: 'JL', secondaryValue: null, unit: null, qualitative: null, status: scenario === 'validation' ? 'confirmed' : null, evidenceId: u.id, quote: u.text })) }); }),
    });
    const { ws, messages } = await client(url, false);
    const waitFor = async check => { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); } };
    ws.send(JSON.stringify({ type: 'start' })); await waitFor(() => messages.some(m => m.type === 'ready'));
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: 'My name is JL.', finished: true } });
    if (scenario === 'clarification') {
      emit({ outputTranscription: { text: 'Are you having chest pain?' }, turnComplete: true });
      emit({ inputTranscription: { text: 'I have chess playing.', finished: true } });
    }
    emit({ outputTranscription: { text: 'Is there anything else?' }, turnComplete: true });
    emit({ inputTranscription: { text: ({ strange: 'No and nothing else.', corrupted: 'No nada de amor.', unrecognized: 'unrecognized background noise' })[scenario] || 'No.', finished: true } });
    emit({ outputTranscription: { text: 'Thank you, JL. Your intake is ' } });
    assert.equal(voiceLogs.length, 0, 'partial output never closes voice');
    emit({ outputTranscription: { text: 'complete.' }, generationComplete: true });
    assert.equal(voiceLogs.length, 0, 'generationComplete alone is not a finalized turn');
    emit({ turnComplete: true });
    await waitFor(() => messages.some(m => m.type === 'completion-pending'));
    assert.equal(closed, 0, 'upstream remains until final playback drains');
    const count = messages.length, inputCount = inputs.length;
    ws.send(JSON.stringify({ type: 'completion-interrupted', id: 1 }));
    ws.send(JSON.stringify({ type: 'audio', data: 'AAAAAA==', sampleRate: 16000 }));
    emit({ inputTranscription: { text: 'Thank you.', finished: true }, interrupted: true });
    emit({ outputTranscription: { text: 'Anything else?' }, turnComplete: true });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(messages.length, count); assert.equal(inputs.length, inputCount);
    ws.send(JSON.stringify({ type: 'completion-settled', id: 1 }));
    await waitClosed(ws);
    assert.equal(closed, 1); assert.equal(issued, 0, 'voice socket closes even while extraction is unresolved');
    assert.deepEqual(voiceLogs, [{ event: 'gemini_intake_complete', voiceState: 'ENDING' }, { event: 'closed', reason: 'gemini_intake_complete' }]);
    await waitFor(() => !!release); release();
    const result = await ws.finalizationResult;
    const failed = ['validation', 'clarification'].includes(scenario);
    assert.equal(result.status, failed ? 'FAILED' : 'COMPLETED');
    assert.equal(issued, failed ? 0 : 1);
    assert.deepEqual(finalLogs.map(item => item.stage), ['finalization_started', failed ? 'finalization_decision' : 'case_persistence']);
    assert.equal(finalLogs[0].finalTurnReceived, true);
    assert.equal(finalLogs.at(-1).outcome, failed ? 'failed' : 'succeeded');
    assert.equal(result.error?.code, scenario === 'validation' ? 'INVALID_RESPONSE' : scenario === 'clarification' ? 'UNRESOLVED_CLARIFICATION' : undefined);
    emit({ inputTranscription: { text: 'Goodbye.', finished: true }, outputTranscription: { text: 'Your intake is complete.' }, turnComplete: true });
    assert.equal(messages.filter(m => m.type === 'completion-reopened').length, 0);
    assert.equal(messages.filter(m => m.type === 'intake-complete').length, failed ? 0 : 1);
  });
}

for (const shutdown of ['client_disconnect', 'upstream_close']) {
  test(`canonical completion survives ${shutdown} while durable finalization creation is pending`, async t => {
    let callbacks, releaseCreate, createStarted = false, completed = 0;
    const records = new Map();
    const memory = createMemoryFinalizationDriver(records);
    const driver = {
      ...memory,
      async create(id, value) {
        createStarted = true;
        await new Promise(resolve => { releaseCreate = resolve; });
        await memory.create(id, value);
      },
    };
    const finalizationResults = createFinalizationResults({ driver, log() {} });
    const url = await fixture(t, {
      apiKey: 'fake', finalizationResults,
      onCompleted: () => {
        completed++;
        return { patientCase: { caseId: 'SC-10000000-0000-4000-8000-000000000099', workflowStatus: 'submitted_for_clinical_review', automaticHandoff: false } };
      },
      connect: async options => {
        callbacks = options.callbacks;
        queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
        return { sendRealtimeInput() {}, close() {} };
      },
      extract: async ({ utterances }) => ({ updates: utterances.map(u => ({ kind: 'name', label: null, value: 'JL', secondaryValue: null,
        unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text })) }),
    });
    const { ws, messages } = await client(url, false);
    const waitFor = async check => { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
    ws.send(JSON.stringify({ type: 'start' })); await waitFor(() => messages.some(m => m.type === 'ready'));
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: 'My name is JL.', finished: true } });
    emit({ outputTranscription: { text: 'Is there anything else?' }, turnComplete: true });
    emit({ inputTranscription: { text: 'No.', finished: true } });
    emit({ outputTranscription: { text: 'Thank you, JL. Your intake is complete.' }, turnComplete: true });
    await waitFor(() => createStarted);
    if (shutdown === 'upstream_close') callbacks.onclose({ code: 1000, reason: '' });
    ws.close(1000); await waitClosed(ws);
    releaseCreate();
    await waitFor(() => [...records.values()].some(record => record.state === 'SUCCEEDED'));
    const record = [...records.values()][0];
    assert.equal(completed, 1);
    assert.equal(record.result.patientCase.workflowStatus, 'submitted_for_clinical_review');
    assert.equal(record.result.patientCase.automaticHandoff, false);
    assert.equal(records.size, 1, 'disconnect and drain cannot duplicate the case/finalization');
  });
}

for (const providerOutcome of ['success', 'invalid_response', 'exception']) {
  test(`minimal case remains successful when enrichment is ${providerOutcome}`, async t => {
    let callbacks, minimalError, releaseExtraction;
    const caseStore = createMemoryCaseStore(), records = new Map();
    const finalizationResults = createFinalizationResults({ driver: createMemoryFinalizationDriver(records), log() {} });
    const url = await fixture(t, {
      apiKey: 'fake', finalizationResults,
      connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, close() {} }; },
      extract: async ({ utterances }) => {
        await new Promise(resolve => { releaseExtraction = resolve; });
        if (providerOutcome === 'exception') throw new Error('provider unavailable');
        if (providerOutcome === 'invalid_response') return { updates: [{ kind: 'symptom', label: 'unsupported clinical inference', value: null,
          secondaryValue: null, unit: null, qualitative: null, status: 'confirmed', evidenceId: utterances[0].id, quote: utterances[0].text }] };
        return { updates: utterances.filter(item => item.text.includes('dizzy')).map(item => ({ kind: 'symptom', label: 'dizzy', value: null,
          secondaryValue: null, unit: null, qualitative: null, status: 'confirmed', evidenceId: item.id, quote: item.text })) };
      },
      onMinimalCompleted: async (intake, context) => {
        try { return { patientCase: await caseStore.createCase({ caseId: context.caseId, intake,
          patientUid: 'patient-1', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'pending' }) }; }
        catch (error) { minimalError = error; throw error; }
      },
      onEnriched: async (intake, context) => ({ patientCase: await caseStore.updateEnrichment({ caseId: context.caseId, intake, status: 'succeeded', patientUid: 'patient-1' }) }),
      onEnrichmentFailed: async context => ({ patientCase: await caseStore.updateEnrichment({ caseId: context.caseId, status: 'failed',
        errorCategory: context.errorCategory, patientUid: 'patient-1' }) }),
    });
    const { ws, messages } = await client(url, false);
    const waitFor = async check => { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
    ws.send(JSON.stringify({ type: 'start' })); await waitFor(() => messages.some(item => item.type === 'ready'));
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: 'My name is JL.', finished: true } });
    emit({ outputTranscription: { text: 'What are you feeling today?' }, turnComplete: true });
    emit({ inputTranscription: { text: 'I feel dizzy.', finished: true } });
    emit({ outputTranscription: { text: 'Is there anything else?' }, turnComplete: true });
    emit({ inputTranscription: { text: 'No.', finished: true } });
    emit({ outputTranscription: { text: 'Thank you, JL. Your intake is complete.' }, turnComplete: true });
    await waitFor(() => messages.some(item => item.type === 'completion-pending') || minimalError);
    assert.ifError(minimalError);
    const pending = [...records.values()][0];
    assert.equal(pending.state, 'PENDING');
    assert.equal(pending.progress.patientCase.workflowStatus, 'submitted_for_clinical_review');
    assert.equal(pending.progress.patientCase.enrichmentStatus, 'pending');
    releaseExtraction();
    ws.send(JSON.stringify({ type: 'completion-settled', id: 1 })); await waitClosed(ws);
    const result = await ws.finalizationResult;
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.patientCase.workflowStatus, 'submitted_for_clinical_review');
    assert.equal(result.patientCase.enrichmentStatus, providerOutcome === 'success' ? 'succeeded' : 'failed');
    assert.equal(result.patientCase.automaticHandoff, null);
    assert.deepEqual(result.patientCase.hospitalHandoffs, []);
    assert.equal(records.size, 1);
    assert.equal((await caseStore.getPatientCase(result.patientCase.caseId, 'patient-1')).caseId, result.patientCase.caseId);
  });
}

test('explicit end before canonical completion still aborts in-flight extraction safely', async t => {
  let callbacks, extractionAborted = false;
  const url = await fixture(t, {
    apiKey: 'fake',
    connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, close() {} }; },
    extract: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { extractionAborted = true; reject(new Error('aborted')); }, { once: true })),
  });
  const { ws, messages } = await client(url, false);
  const waitFor = async check => { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  ws.send(JSON.stringify({ type: 'start' })); await waitFor(() => messages.some(m => m.type === 'ready'));
  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'My name is JL.', finished: true } } });
  await new Promise(resolve => setTimeout(resolve, 950));
  ws.send(JSON.stringify({ type: 'end' })); await waitClosed(ws);
  await waitFor(() => extractionAborted);
  assert.equal(messages.some(message => message.type === 'completion-pending'), false);
});

test('missing key is actionable without connecting upstream', async t => {
  const url = await fixture(t, { apiKey: '', connect: () => assert.fail('Must not connect') });
  const { ws, messages } = await client(url);
  ws.send(JSON.stringify({ type: 'start' }));
  await waitClosed(ws);
  assert.match(messages[0].message, /backend\/\.env/);
});

test('relays PCM and transcripts; end closes upstream; key never sent downstream', async t => {
  let callbacks;
  let config;
  const inputs = [];
  let closed = 0;
  const url = await fixture(t, {
    apiKey: 'test-server-only-secret',
    connect: async options => {
      callbacks = options.callbacks;
      config = options.config;
      queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput: value => inputs.push(value), close: () => closed++ };
    },
  });
  const { ws, messages } = await client(url);
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'start' }));
  await ready;
  assert.deepEqual(config.inputAudioTranscription, {});
  assert.deepEqual(config.outputAudioTranscription, {});
  assert.match(config.systemInstruction, /Do not diagnose/);
  assertClarificationRules(config.systemInstruction);
  assertPatientFacingRules(config.systemInstruction);
  assert.deepEqual(inputs[0], { text: 'Please greet the patient and ask only for their name. Then wait for their answer.' });
  ws.send(JSON.stringify({ type: 'audio', data: 'AAAAAA==', sampleRate: 48000 }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(inputs[1].audio.mimeType, 'audio/pcm;rate=48000');
  callbacks.onmessage({ serverContent: {
    inputTranscription: { text: 'Fever', finished: true },
    outputTranscription: { text: 'When did it start?' },
    modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }] },
    turnComplete: true,
  } });
  ws.send(JSON.stringify({ type: 'end' }));
  await waitClosed(ws);
  assert.deepEqual(messages.filter(message => !message.type.startsWith('intake-')).map(message => message.type), ['ready', 'transcript', 'transcript', 'audio', 'turn-complete']);
  assert.equal(closed, 1);
  assert.ok(!JSON.stringify(messages).includes('test-server-only-secret'));
});

test('ending while upstream connects closes the late session', async t => {
  let resolveConnection;
  let entered;
  const connecting = new Promise(resolve => { entered = resolve; });
  let closed = false;
  const url = await fixture(t, { apiKey: 'fake', connect: () => {
    entered();
    return new Promise(resolve => { resolveConnection = resolve; });
  } });
  const { ws } = await client(url);
  ws.send(JSON.stringify({ type: 'start' }));
  await connecting;
  ws.close();
  await waitClosed(ws);
  resolveConnection({ close: () => { closed = true; } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true);
});

test('SDK errors are sanitized', async t => {
  const url = await fixture(t, { apiKey: 'fake', connect: async () => { throw new Error('wss://example?key=secret-value'); } });
  const { ws, messages } = await client(url);
  ws.send(JSON.stringify({ type: 'start' }));
  await waitClosed(ws);
  assert.equal(messages[0].type, 'error');
  assert.ok(!JSON.stringify(messages).includes('secret-value'));
});

test('rejects browser origins outside the local allowlist', async t => {
  const url = await fixture(t);
  const ws = new WebSocket(url, { origin: 'https://untrusted.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
});

test('live transcript triggers validated intake updates and extraction failure leaves relay usable', async t => {
  let callbacks;
  let calls = 0;
  const url = await fixture(t, {
    apiKey: 'fake',
    connect: async options => {
      callbacks = options.callbacks;
      queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput() {}, close() {} };
    },
    extract: async ({ utterances }) => {
      calls++;
      if (calls > 1) throw new Error('fake extraction failure');
      return { updates: [{ kind: 'name', label: null, value: 'Mark', secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: utterances[0].id, quote: 'Mark' }] };
    },
  });
  const { ws, messages } = await client(url);
  t.after(() => ws.terminate());
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', check); reject(new Error('No intake update')); }, 3000);
    const check = () => { if (predicate()) { clearTimeout(timer); ws.off('message', check); resolve(); } };
    ws.on('message', check); check();
  });
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(() => messages.some(item => item.type === 'ready'));
  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'Mark', finished: true }, turnComplete: true } });
  await waitFor(() => messages.some(item => item.intake?.patient.name === 'Mark'));
  callbacks.onmessage({ serverContent: { inputTranscription: { text: 'I have a cough', finished: true }, turnComplete: true } });
  await waitFor(() => messages.some(item => item.status === 'unavailable'));
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(messages.filter(item => item.type === 'intake-update').at(-1).intake.patient.name, 'Mark');
  const received = once(ws, 'message');
  callbacks.onmessage({ serverContent: { outputTranscription: { text: 'When did it start?' } } });
  await received;
  assert.equal(messages.at(-1).type, 'transcript');
});

test('completion waits for the final uninterrupted turn and emits exactly once per session', async t => {
  let callbacks;
  let closed = 0;
  const url = await fixture(t, {
    apiKey: 'fake',
    extract: async ({ utterances }) => ({ updates: utterances.filter(u => u.text === 'My name is JL.').map(u => ({ kind: 'name', label: null, value: 'JL', secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text })) }),
    connect: async options => {
      callbacks = options.callbacks;
      queueMicrotask(() => callbacks.onmessage({ setupComplete: {} }));
      return { sendRealtimeInput() {}, close() { closed++; } };
    },
  });
  for (let run = 0; run < 3; run++) {
    const { ws, messages } = await client(url);
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'start' }));
    await ready;
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: 'My name is JL.', finished: true } });
    emit({ outputTranscription: { text: 'I have the basic information I need for your intake. Is there anything else?' }, turnComplete: true });
    emit({ outputTranscription: { text: 'Your intake is now complete.' }, turnComplete: true });
    emit({ inputTranscription: { text: 'Thank you. Your intake is complete.', finished: true }, turnComplete: true });
    emit({ outputTranscription: { text: 'Thank you. Your intake is complete.' } });
    emit({ interrupted: true, turnComplete: true });
    emit({ outputTranscription: { text: 'Is there anything else?' }, turnComplete: true });
    emit({ inputTranscription: { text: "No, that's all.", finished: true } });
    emit({ outputTranscription: { text: run === 2 ? 'Please call your local emergency number now, or ask someone nearby to call for you. I cannot contact emergency services for you. Thank you. Your intake is ' : run ? 'Thank you, JL. Your intake is ' : 'Thank you. Your intake is ' } });
    emit({ outputTranscription: { text: 'complete.' }, generationComplete: true });
    // A ping/pong is an ordered barrier for all preceding relay messages.
    const pong = once(ws, 'pong');
    ws.ping();
    await pong;
    assert.equal(messages.filter(item => item.type === 'intake-complete').length, 0);
    emit({ modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }] }, turnComplete: true });
    // Duplicate completion cannot create a second token.
    await new Promise(resolve => setTimeout(resolve, 30));
    emit({ outputTranscription: { text: 'Thank you. Your intake is complete.' }, turnComplete: true });
    callbacks.onclose();
    await waitClosed(ws);
    await ws.finalizationResult;
    assert.equal(messages.filter(item => item.type === 'intake-complete').length, 1);
    assert.deepEqual(messages.filter(item => !['intake-update', 'intake-status', 'completion-pending'].includes(item.type)).slice(-3).map(item => item.type), ['audio', 'turn-complete', 'intake-complete']);
    assert.equal(ws.readyState, WebSocket.CLOSED);
    ws.send(JSON.stringify({ type: 'end' }));
    await waitClosed(ws);
  }
  assert.equal(closed, 3);
});

test('routine prompt avoids repeated disclaimers and redundant symptom questions', () => {
  assert.match(systemInstruction, /Routine turns contain only a brief acknowledgement and the next single intake question/);
  assert.match(systemInstruction, /Never explain generic causes of dizziness or other symptoms/);
  assert.match(systemInstruction, /Omit diagnosis disclaimers and explanatory medical commentary after normal answers/);
  assert.match(systemInstruction, /Do not repeat generic medical disclaimers during routine intake or append warnings after normal questions/);
  assert.match(systemInstruction, /Never say this information is for collection only/);
  assert.match(systemInstruction, /Do not repeatedly say this is not medical advice or a diagnosis/);
  assert.match(systemInstruction, /Do not say please seek professional care or please see a healthcare professional after ordinary non-emergency answers/);
  assert.match(systemInstruction, /Do not list multiple symptoms inside one question or repeat a symptom with a severity qualifier/);
  assert.match(systemInstruction, /Ask "Are you having chest pain\?" and wait/);
  // Patient-facing examples, not a claim about stochastic model output.
  for (const [example] of systemInstruction.matchAll(/"[^"]+"/g)) {
    assert.doesNotMatch(example, /collection only|not medical advice|seek professional care|please see a healthcare professional/i);
    assert.doesNotMatch(example, /chest pain, severe chest pain|Besides the dizziness/i);
  }
});

test('closing prompt separates the optional question from the final response', () => {
  assert.match(systemInstruction, /After the closing question, STOP and WAIT for the patient's response/);
  assert.match(systemInstruction, /Never append a completion sentence to that question/);
  assert.ok(systemInstruction.includes('Patient: "No, that\'s all."\nGemini: "Thank you, JL. Your intake is complete."'));
  assert.match(systemInstruction, /"Thank you, \{preferredName\}\. Your intake is complete\."/);
  assert.match(systemInstruction, /"Thank you\. Your intake is complete\."/);
});

test('Live clarifies isolated transcription anomalies without blocking multilingual intake', () => {
  assert.match(systemInstruction, /Default to English unless the patient explicitly requests another language or clearly continues consistently in another language/);
  assert.match(systemInstruction, /"Sorry, I didn't catch that\. Could you say that again\?"/);
  assert.match(systemInstruction, /Then wait; do not infer symptoms from it/);
  assert.match(systemInstruction, /Er ist ganz dein/);
  assert.match(systemInstruction, /Do not block legitimate multilingual patients/);
});


for (const alreadyRunning of [false, true]) {
  test(`completion drains ${alreadyRunning ? 'in-flight and queued' : 'debounced'} extraction before issuing the M3 snapshot`, async t => {
    let callbacks; let snapshot;
    const requests = [];
    const statements = ["My name is Jael.", "I'm feeling dizzy.", "It started yesterday.", "I don't have chest pain.", "My blood pressure was 145 over 90."];
    const values = [
      { kind: 'name', value: 'Jael' },
      { kind: 'symptom', label: 'dizzy', status: 'confirmed' },
      { kind: 'onset', value: 'yesterday' },
      { kind: 'symptom', label: 'chest pain', status: 'denied' },
      { kind: 'bloodPressure', value: 145, secondaryValue: 90 },
    ];
    const url = await fixture(t, {
      apiKey: 'fake', onCompleted: intake => { snapshot = structuredClone(intake); return 'completed-case-token'; },
      connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, close() {} }; },
      extract: ({ utterances }) => new Promise(resolve => requests.push({ utterances, release: () => resolve({ updates: utterances.filter(u => statements.includes(u.text)).map(u => ({ kind: null, label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text, ...values[statements.indexOf(u.text)] })) }) })),
    });
    const { ws, messages } = await client(url);
    const waitFor = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
    const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'start' })); await ready;
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: statements[0], finished: true } });
    if (alreadyRunning) await waitFor(() => requests.length === 1);
    for (const text of statements.slice(1)) emit({ inputTranscription: { text, finished: true } });
    emit({ outputTranscription: { text: 'Is there anything else?', finished: true }, turnComplete: true });
    emit({ inputTranscription: { text: "No, that's all.", finished: true } });
    emit({ outputTranscription: { text: 'Thank you, Jael. Your intake is complete.' }, turnComplete: true });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(snapshot, undefined, 'No token before extraction settles');
    assert.equal(messages.some(m => m.type === 'intake-complete'), false);
    await waitFor(() => requests.length === 1); requests[0].release();
    if (alreadyRunning) {
      await waitFor(() => requests.length === 2);
      assert.equal(snapshot, undefined, 'The batch queued behind the active request must also finish');
      requests[1].release();
    }
    await waitFor(() => messages.some(m => m.type === 'intake-complete'));
    assert.equal(requests.flatMap(r => r.utterances).filter(u => statements.includes(u.text)).length, 5);
    assert.equal(requests.flatMap(r => r.utterances).length, 5, 'Pure final confirmation never reaches extraction');
    assert.equal(snapshot.patient.name, 'Jael');
    assert.equal(snapshot.symptoms.find(s => s.name === 'dizzy').status, 'confirmed');
    assert.equal(snapshot.onset.value, 'yesterday');
    assert.equal(snapshot.symptoms.find(s => s.name === 'chest pain').status, 'denied');
    assert.deepEqual(snapshot.vitals.bloodPressure, { systolic: 145, diastolic: 90, source: 'patient_reported' });
    assert.deepEqual(messages.filter(m => m.type === 'intake-update').at(-1).intake, snapshot);
    const completeIndex = messages.findIndex(m => m.type === 'intake-complete');
    assert.ok(messages.findLastIndex(m => m.type === 'intake-update') < completeIndex);
    assert.equal(messages[completeIndex].completionToken, 'completed-case-token');
    emit({ turnComplete: true });
    ws.send(JSON.stringify({ type: 'end' })); await waitClosed(ws);
    assert.equal(messages.filter(m => m.type === 'intake-complete').length, 1);
  });
}


for (const outcome of ['failure', 'quota', 'cancellation', 'invalid-bp']) {
  const cancel = outcome === 'cancellation';
  test(`final extraction ${outcome} never issues a completed handoff token`, async t => {
    let callbacks; let release; let issued = 0;
    const url = await fixture(t, {
      apiKey: 'fake', onCompleted: () => { issued++; return 'must-not-issue'; },
      connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, close() {} }; },
      extract: () => new Promise((resolve, reject) => { release = () => outcome === 'invalid-bp' ? resolve({ updates: [{ kind: 'bloodPressure', label: null, value: 190, secondaryValue: 80, unit: null, qualitative: null, status: 'confirmed', evidenceId: 1, quote: 'Yes, my blood pressure is 190/80.' }] }) : cancel ? resolve({ updates: [] }) : reject(Object.assign(new Error('Simulated extraction failure'), outcome === 'quota' ? { status: 429 } : {})); }),
    });
    const { ws, messages } = await client(url);
    const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'start' })); await ready;
    callbacks.onmessage({ serverContent: { inputTranscription: { text: outcome === 'invalid-bp' ? 'Yes, my blood pressure is 190/80.' : 'My name is Jael.', finished: true } } });
    callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Is there anything else?' }, turnComplete: true } });
    callbacks.onmessage({ serverContent: { inputTranscription: { text: "No, that's all.", finished: true }, outputTranscription: { text: 'Thank you, Jael. Your intake is complete.' }, turnComplete: true } });
    const deadline = Date.now() + 2000;
    while (!release) { if (Date.now() > deadline) throw new Error('No extraction'); await new Promise(resolve => setTimeout(resolve, 5)); }
    if (cancel) { ws.send(JSON.stringify({ type: 'end' })); await waitClosed(ws); release(); await ws.finalizationResult; }
    else { release(); await waitClosed(ws); const result = await ws.finalizationResult; assert.match(result.error.userMessage, /Clinical summary could not be finalized/); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(issued, 0); assert.ok(!messages.some(m => m.type === 'intake-complete'));
    if (outcome === 'invalid-bp') {
      const error = messages.find(m => m.type === 'finalization-error').error;
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.match(error.developerMessage, /Field: status.*Expected: null; received type: string/);
    }
  });
}

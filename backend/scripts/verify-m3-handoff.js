// Opt-in, one fictional transcript replay through the real M2 extractor, then
// the real M3 relay, GenerateContent transport and isolated hospital browser.
// No microphone/Live session is simulated as a real voice interaction.
import { loadEnvFile } from 'node:process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { createExtractor } from '../src/intake/extractor.js';
import { createIntakeSession } from '../src/intake/session.js';
import { createCompletionState } from '../src/completion.js';
import { needsClarification } from '../src/intake/validate.js';
import { createCompletedCases, caseFields } from '../src/agent/cases.js';
import { createAgentRelay } from '../src/agent/relay.js';
import { serveHospital } from '../src/agent/portal.js';

async function main() {
  if (!process.argv.includes('--run') || process.env.NODE_ENV === 'production') throw new Error('Diagnostic disabled.');
  try { loadEnvFile(new URL('../.env', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.env.NODE_ENV === 'production') throw new Error('Diagnostic disabled.');
  const completion = createCompletionState(), cases = createCompletedCases();
  const session = createIntakeSession({ extract: createExtractor(process.env.GEMINI_API_KEY), send() {}, log() {} });
  let server, relay, socket, input;
  try {
    const accept = content => session.accept(content, completion.observe(content));
    for (const [question, answer] of [
      ['What is your name?', 'My name is Demo Alex.'],
      ['What brings you here?', 'I feel dizzy.'],
      ['When did it start?', 'It started yesterday.'],
      ['Are you having chest pain?', 'No, I do not have chest pain.'],
      ['Are you having difficulty breathing?', 'No, I am not having difficulty breathing.'],
      ['What is your blood pressure?', 'My blood pressure is 120 over 80.'],
      ["Is there anything else you would like to add?", 'No, nothing else.'],
    ]) {
      accept({ outputTranscription: { text: question }, turnComplete: true });
      accept({ inputTranscription: { text: answer, finished: true } });
    }
    accept({ outputTranscription: { text: 'Thank you, Demo Alex. Your intake is complete.' }, turnComplete: true });
    const intake = await session.drain();
    if (needsClarification(intake) || !completion.complete(completion.id)) throw new Error('Intake did not finalize.');
    const fields = caseFields(intake);
    if (fields['Patient Name'] !== 'Demo Alex' || !fields['Reported Symptoms'] || !fields['Onset / Duration'] || !fields['Chest Pain'] || !fields['Shortness of Breath'] || !fields['Blood Pressure']) throw new Error('Expected fictional fields missing.');
    const completionToken = cases.issue(intake);
    console.log('[m3-verification]', JSON.stringify({ stage: 'intake_completed', realExtractor: true, transcriptReplay: true, populatedFields: Object.values(fields).filter(Boolean).length }));
    server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/hospital-demo') serveHospital(response);
      else { response.writeHead(404); response.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port, origin = 'http://127.0.0.1:5173';
    relay = createAgentRelay({ cases, origins: [origin], portalUrl: () => `http://127.0.0.1:${port}/hospital-demo` });
    server.on('upgrade', relay.upgrade);
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/agent/handoff`, { origin });
    input = createInterface({ input: process.stdin });
    let pending;
    input.on('line', line => {
      if (pending && ['approve', 'decline'].includes(line.trim())) {
        socket.send(JSON.stringify({ type: 'confirm', id: pending, approved: line.trim() === 'approve' })); pending = undefined;
      }
    });
    const finished = new Promise((resolve, reject) => {
      let completed = false;
      socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        // Only status enums and the fictional receipt ID enter this log.
        console.log('[m3-verification]', JSON.stringify({ stage: 'handoff_event', status: event.status, ...(event.status === 'completed' ? { caseId: event.caseId } : {}) }));
        if (event.status === 'confirmation') { pending = event.id; console.log('[m3-verification] Safety confirmation required; enter approve or decline.'); }
        if (event.status === 'completed') { completed = true; resolve(event); }
        if (event.status === 'failed') reject(new Error('Handoff failed; inspect safe agent diagnostics.'));
      });
      socket.on('error', () => reject(new Error('Verification socket failed.')));
      socket.on('close', () => { if (!completed) reject(new Error('Handoff closed before completion.')); });
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'start', fictional: true, completionToken, intake }));
    const event = await finished;
    console.log('[m3-verification]', JSON.stringify({ stage: 'completed', receiptVerified: true, caseIdVerified: true, caseId: event.caseId }));
  } finally {
    input?.close(); socket?.close(); session.close(); cases.clear();
    await relay?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  }
}
main().catch(() => { console.log('[m3-verification]', JSON.stringify({ stage: 'failed', safeErrorMessage: 'Verification did not complete; inspect safe diagnostics.' })); process.exitCode = 1; });

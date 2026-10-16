import { createIntakeSession } from './intake/session.js';
import { emergencyEscalation } from './emergency.js';
import { browserSignalsAccept, createOriginPolicy } from './origin.js';
import { deterministicEmergencyExtraction } from './chat-intake/deterministic-extraction.js';

const sessionPattern = /^[a-f0-9]{64}$/;
const idempotencyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roles = new Set(['Gemini', 'Patient']);

export class DirectVoiceCompletionError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

const existingCase = async (caseStore, caseId, uid) => {
  try { return await caseStore.getPatientCase(caseId, uid); }
  catch (error) { if (error?.code === 'CASE_NOT_FOUND') return null; throw error; }
};

function extractionTurns(turns, outcome) {
  const clean = turns.map(turn => ({ role: turn.role, text: turn.text.trim() }));
  if (outcome === 'completed') {
    const closingAnswer = clean.findLastIndex(turn => turn.role === 'Patient');
    if (closingAnswer >= 0) clean.splice(closingAnswer, 1);
  }
  return clean.filter(turn => turn.role === 'Patient' || turn.role === 'Gemini');
}

async function extractIntake(extract, turns, outcome) {
  const intake = createIntakeSession({
    extract,
    send() {},
    delay: 0,
    onPatientTurn: outcome === 'emergency' ? utterance => {
      const deterministic = deterministicEmergencyExtraction({ text: utterance.text, utteranceId: utterance.id });
      return deterministic.handled ? { validatedPatch: deterministic.patch } : undefined;
    } : undefined,
  });
  intake.start();
  try {
    for (const turn of turns) {
      if (turn.role === 'Gemini') {
        intake.accept({ outputTranscription: { text: turn.text, finished: true } });
        intake.accept({ turnComplete: true });
      } else {
        intake.accept({ inputTranscription: { text: turn.text, finished: true } });
      }
    }
    return await intake.drain();
  } finally {
    intake.close('direct_voice_completion');
  }
}

export function createDirectVoiceCompletionService({ liveSessionStore, caseStore, extract, persist }) {
  if (!liveSessionStore || !caseStore || typeof extract !== 'function' || typeof persist !== 'function') return null;
  const pending = new Map();
  return {
    async complete({ uid, intakeSessionId, idempotencyKey, turns, outcome, resetGeneration }) {
      if (!sessionPattern.test(intakeSessionId || '') || !idempotencyPattern.test(idempotencyKey || '')) throw new DirectVoiceCompletionError('INVALID_VOICE_COMPLETION', 400);
      const active = await liveSessionStore.resolveActive({ intakeSessionId, uid });
      if (!active) throw new DirectVoiceCompletionError('VOICE_SESSION_UNAVAILABLE', 409);
      const saved = await existingCase(caseStore, active.patientCaseId, uid);
      if (saved) return { status: saved.emergency ? 'EMERGENCY_ESCALATED' : 'COMPLETED', patientCase: saved };
      if (pending.has(intakeSessionId)) return pending.get(intakeSessionId);
      const work = (async () => {
        const replay = await existingCase(caseStore, active.patientCaseId, uid);
        if (replay) return { status: replay.emergency ? 'EMERGENCY_ESCALATED' : 'COMPLETED', patientCase: replay };
        const snapshot = await extractIntake(extract, extractionTurns(turns, outcome), outcome);
        const emergency = !!emergencyEscalation(snapshot);
        if (outcome === 'emergency' && !emergency) throw new DirectVoiceCompletionError('EMERGENCY_EVIDENCE_UNAVAILABLE', 409);
        const patientCase = await persist(snapshot, {
          caseId: active.patientCaseId, patientUid: uid, intakeSessionId, resetGeneration,
          fictionalConfirmed: true, intakeSource: 'live_intake',
        }, emergency);
        return { status: emergency ? 'EMERGENCY_ESCALATED' : 'COMPLETED', snapshot, patientCase };
      })().finally(() => pending.delete(intakeSessionId));
      pending.set(intakeSessionId, work);
      return work;
    },
  };
}

const safeMessage = code => ({
  INVALID_VOICE_COMPLETION: 'The completed intake could not be validated.',
  VOICE_SESSION_UNAVAILABLE: 'This voice intake session is no longer available.',
  EMERGENCY_EVIDENCE_UNAVAILABLE: 'The emergency report could not be validated for saving.',
})[code] || 'The intake is complete, but it could not be saved. Please retry.';

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new DirectVoiceCompletionError('INVALID_VOICE_COMPLETION', 400);
  let raw = '';
  for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 64 * 1024) throw new DirectVoiceCompletionError('INVALID_VOICE_COMPLETION', 400); }
  let value;
  try { value = JSON.parse(raw); } catch { throw new DirectVoiceCompletionError('INVALID_VOICE_COMPLETION', 400); }
  const keys = Object.keys(value || {});
  if (!value || Array.isArray(value) || keys.length !== 3 || keys.some(key => !['intakeSessionId', 'outcome', 'turns'].includes(key)) ||
      !sessionPattern.test(value.intakeSessionId || '') || !['completed', 'emergency'].includes(value.outcome) || !Array.isArray(value.turns) ||
      value.turns.length < 2 || value.turns.length > 40 || value.turns.some(turn => !turn || Object.keys(turn).length !== 2 || !roles.has(turn.role) ||
        typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > 2000)) throw new DirectVoiceCompletionError('INVALID_VOICE_COMPLETION', 400);
  return value;
}

export function directVoiceCompletionEndpoint(service, allowedOrigins = []) {
  const origins = createOriginPolicy(allowedOrigins);
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/api/intake/voice/complete') return false;
    try {
      if (request.method !== 'POST' || url.search) throw new DirectVoiceCompletionError('INVALID_VOICE_COMPLETION', 400);
      if (!service || !request.user?.roles?.includes('patient')) throw new DirectVoiceCompletionError('VOICE_COMPLETION_ACCESS_DENIED', 403);
      if (!origins.validate(request.headers.origin) || !browserSignalsAccept(request.headers)) throw new DirectVoiceCompletionError('VOICE_COMPLETION_ACCESS_DENIED', 403);
      const input = await readBody(request), idempotencyKey = request.headers['idempotency-key'];
      json(response, 200, await service.complete({ ...input, uid: request.user.uid, idempotencyKey, resetGeneration: request.resetGeneration }));
    } catch (error) {
      const known = error instanceof DirectVoiceCompletionError;
      if (!known) console.warn('[direct-voice-completion]', JSON.stringify({ outcome: 'unavailable', exceptionClass: error?.name || 'Error', exceptionCode: error?.code || null }));
      json(response, known ? error.status : 503, { code: known ? error.code : 'VOICE_COMPLETION_UNAVAILABLE', message: safeMessage(known ? error.code : 'VOICE_COMPLETION_UNAVAILABLE') });
    }
    return true;
  };
}

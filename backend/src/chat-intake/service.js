import { randomUUID } from 'node:crypto';
import { createQuestionEngine } from '../intake/question-engine.js';
import { emptyIntake } from '../intake/schema.js';
import { mergeBatch } from '../intake/batch-validation.js';
import { createAnswerContext } from '../intake/answer-context.js';
import { emergencyEscalation, emergencyFacilityMessage, emergencyMessage } from '../emergency.js';
import { deterministicChatExtraction } from './deterministic-extraction.js';
import { ChatIntakeStoreError } from './store.js';
import { isFinalAnswer } from '../completion.js';
import { evaluateRouting } from '../cases/routing.js';

const sessionPattern = /^[a-f0-9]{64}$/;
const idempotencyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finalNo = text => isFinalAnswer(text) || /^(?:nothing|none)[.!\s]*$/i.test(text);
const explicitNoFact = /^(?:i (?:do not|don't) know|not sure|unsure|i cannot tell|i can't tell|skip|i (?:would rather|prefer to) skip|i (?:do not|don't) want to (?:answer|say)|prefer not to say)[.!\s]*$/i;
const requestsDoctorAvailability = text => /\b(?:check|find|see|tell me|know)\b[\s\S]{0,60}\b(?:doctor|physician|specialist)s?\b[\s\S]{0,60}\b(?:available|availability|near(?:by| me)|close to me)\b|\b(?:doctor|physician|specialist)s?\b[\s\S]{0,60}\b(?:available|availability)\b[\s\S]{0,60}\b(?:near(?:by| me)|close to me)\b/iu.test(String(text || ''));
const requestsMedicineCamera = text => {
  const value = String(text || '');
  return /\b(?:medicine|medication|prescription)\b/iu.test(value) &&
    /\b(?:show|scan|camera|photo|picture|package|label)\b/iu.test(value);
};

const publicProgress = value => ({ phase: value.phase, status: value.status, path: value.path, answered: value.answered, total: value.total });
const publicHistory = record => (record.history || []).map(({ role, text }) => ({ role, text }));
const questionText = action => action?.question?.prompt || null;
const responseView = record => ({ sessionId: record.sessionId, revision: record.revision, status: record.status,
  progress: publicProgress(createQuestionEngine({ state: record.plan }).progress()), question: record.question,
  messages: publicHistory(record), intake: cloneIntake(record.intake), ...(record.finalizationId ? { finalizationId: record.finalizationId } : {}),
  ...(record.patientCase ? { patientCase: record.patientCase } : {}) });
const cloneIntake = intake => structuredClone(intake || emptyIntake());
const safeName = intake => (intake?.patient?.preferredName || intake?.patient?.name || '').trim().slice(0, 80);
const facilityAvailabilityText = (result, closingQuestion) => {
  const options = Array.isArray(result?.options) ? result.options.slice(0, 2) : [];
  if (!options.length) return `I couldn't find a nearby doctor shown as available in the current fictional hospital information. This is simulated information, not live hospital-verified availability or a confirmed referral. ${closingQuestion}`;
  const summaries = options.map(option => {
    const specialty = String(option.specialty || 'doctor').replaceAll('_', ' ');
    const distance = Number.isFinite(option.distanceMeters) ? `, about ${(option.distanceMeters / 1000).toFixed(1)} km away` : '';
    const timing = Number.isFinite(option.nextAvailableMinutes) ? `, with simulated next availability in about ${option.nextAvailableMinutes} minutes` : '';
    return `${option.hospitalName} lists a ${specialty} specialist as available${distance}${timing}`;
  });
  return `Based on the fictional hospital information currently available, ${summaries.join('; ')}. This is simulated information, not live hospital-verified availability or a confirmed referral. ${closingQuestion}`;
};
const medicineCameraGuidance = 'Yes. Under “What would you like to submit as clinical photo?”, select Medicine package. To use your camera, choose Use camera, hold the medicine package in view, choose Capture photo, review the image, then choose Use this photo; SmartCareOps will read the printed label automatically. To upload an existing image instead, choose Upload photo, select a clear photo of the printed package label, then choose Read medicine package. Review the medicine name and strength, describe in your own words how you actually take it, and confirm the complete entry before saving. Nothing is saved until you confirm it.';
const assistantText = ({ action, intake, previousQuestionId }) => {
  const prompt = questionText(action);
  if (!prompt) return null;
  if (action.type === 'clarify' && action.reason === 'transcript_unclear') return "Can you please say that again? I didn't catch that.";
  if (action.type === 'clarify') return `Sorry, I didn't understand that. ${prompt}`;
  if (action.type === 'repeat_final') return `Thank you. ${prompt}`;
  const name = previousQuestionId === 'core.name' ? safeName(intake) : '';
  return `${name ? `Thank you, ${name}. ` : ''}${prompt}`;
};

export function createChatIntakeService({ store, liveSessionStore, extract, onComplete, onEmergency, facilityCoordinator, now = () => Date.now(), ttlMs = 11 * 60_000 } = {}) {
  if (!store || !liveSessionStore || typeof extract !== 'function') return null;
  async function start({ uid, origin, resetGeneration = 0, resumeSessionId, intakeSessionId }) {
    if (sessionPattern.test(resumeSessionId || '')) {
      try { return responseView(await store.get({ sessionId: resumeSessionId, uid })); } catch (error) { if (error.code !== 'CHAT_SESSION_NOT_FOUND' && error.code !== 'CHAT_SESSION_EXPIRED') throw error; }
    }
    let identity;
    if (sessionPattern.test(intakeSessionId || '')) {
      const active = await liveSessionStore.resolveActive({ intakeSessionId, uid });
      if (!active) throw new ChatIntakeStoreError('CHAT_SESSION_UNAVAILABLE', 503);
      identity = { intakeSessionId, patientCaseId: active.patientCaseId };
    } else {
      const issued = await liveSessionStore.create({ uid, roles: ['patient'], origin, path: '/api/intake/chat', preferredLanguage: 'en', resetGeneration });
      if (!issued) throw new ChatIntakeStoreError('CHAT_SESSION_UNAVAILABLE', 503);
      identity = await liveSessionStore.consume({ token: issued.token, origin, path: '/api/intake/chat' });
      if (!identity) throw new ChatIntakeStoreError('CHAT_SESSION_UNAVAILABLE', 503);
    }
    let plan = await liveSessionStore.getQuestionPlan({ intakeSessionId: identity.intakeSessionId, uid });
    const priorIntake = await liveSessionStore.getIntakeSnapshot({ intakeSessionId: identity.intakeSessionId, uid });
    const engine = createQuestionEngine({ ...(plan ? { state: plan } : {}), onChange: value => { plan = value; } });
    const action = plan?.activeQuestionId ? { question: engine.activeQuestion } : engine.start(), createdAt = now();
    const record = { sessionId: identity.intakeSessionId, uid, patientCaseId: identity.patientCaseId, resetGeneration,
      channel: sessionPattern.test(intakeSessionId || '') ? 'voice_direct' : 'chat',
      revision: 0, status: 'collecting', plan, intake: cloneIntake(priorIntake), question: questionText(action),
      history: [{ id: randomUUID(), role: 'SmartCareOps', text: questionText(action) }], pending: null,
      createdAt, updatedAt: createdAt, expiresAt: createdAt + ttlMs };
    await liveSessionStore.saveQuestionPlan({ intakeSessionId: record.sessionId, uid, plan });
    await liveSessionStore.saveIntakeSnapshot({ intakeSessionId: record.sessionId, uid, intake: record.intake });
    await store.create(record); return responseView(record);
  }

  async function get({ sessionId, uid }) { if (!sessionPattern.test(sessionId || '')) throw new ChatIntakeStoreError('CHAT_SESSION_NOT_FOUND', 404); return responseView(await store.get({ sessionId, uid })); }

  async function submit({ sessionId, uid, idempotencyKey, expectedRevision, message }) {
    if (!sessionPattern.test(sessionId || '') || !idempotencyPattern.test(idempotencyKey || '') || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        typeof message !== 'string' || !message.trim() || message.trim().length > 2000) throw new ChatIntakeStoreError('INVALID_CHAT_MESSAGE', 400);
    message = message.trim();
    const begun = await store.begin({ sessionId, uid, idempotencyKey, expectedRevision, message });
    if (begun.replay) return begun.replay;
    const record = begun.record;
    try {
      let nextPlan;
      let engine = createQuestionEngine({ state: record.plan, onChange: value => { nextPlan = value; } });
      const activeQuestion = engine.activeQuestion || (engine.start().question), previousQuestionId = activeQuestion?.id;
      if (previousQuestionId === 'core.final_addition' && requestsDoctorAvailability(message)) {
        const intake = cloneIntake(record.intake), history = [...(record.history || []), { id: randomUUID(), role: 'Patient', text: message }];
        const specialty = evaluateRouting(intake).specialty;
        let text;
        try {
          const result = await facilityCoordinator?.lookup({ intake, patientUid: uid, intakeSessionId: sessionId, caseId: record.patientCaseId,
            requiredCapabilities: [specialty], specialty, maxResults: 2 });
          text = facilityAvailabilityText(result, activeQuestion.prompt);
        } catch {
          text = `Current fictional facility information is unavailable, so I can't confirm doctor availability. ${activeQuestion.prompt}`;
        }
        history.push({ id: randomUUID(), role: 'SmartCareOps', text });
        const progress = engine.progress(), nextPlan = engine.snapshot();
        const response = { sessionId, revision: record.revision + 1, status: 'collecting', progress: publicProgress(progress),
          question: activeQuestion.prompt, messages: publicHistory({ history }), intake };
        const committed = await store.commit({ sessionId, uid, idempotencyKey, message, response,
          next: { status: 'collecting', plan: nextPlan, intake, question: activeQuestion.prompt, history: history.slice(-80) } });
        return { ...response, revision: committed.revision };
      }
      if (previousQuestionId === 'core.final_addition' && requestsMedicineCamera(message)) {
        const intake = cloneIntake(record.intake);
        const history = [...(record.history || []),
          { id: randomUUID(), role: 'Patient', text: message },
          { id: randomUUID(), role: 'SmartCareOps', text: medicineCameraGuidance }];
        const progress = engine.progress(), nextPlan = engine.snapshot();
        const response = { sessionId, revision: record.revision + 1, status: 'collecting', progress: publicProgress(progress),
          question: activeQuestion.prompt, messages: publicHistory({ history }), intake };
        const committed = await store.commit({ sessionId, uid, idempotencyKey, message, response,
          next: { status: 'collecting', plan: nextPlan, intake, question: activeQuestion.prompt, history: history.slice(-80) } });
        return { ...response, revision: committed.revision };
      }
      const utteranceId = Math.max(0, ...(record.plan?.processedUtteranceIds || [])) + 1;
      const utterance = { id: utteranceId, role: 'Patient', text: message, question: activeQuestion?.prompt || record.question || '' };
      const guard = createAnswerContext()(message, utterance.question);
      let action, intake = cloneIntake(record.intake);
      if (guard?.blocked) action = engine.clarify('ambiguous');
      else {
        const engineText = activeQuestion?.id === 'core.final_addition' && finalNo(message) ? 'Nothing else' : message;
        action = engine.accept({ text: engineText, utteranceId });
        const deterministic = deterministicChatExtraction({ question: activeQuestion, text: message, utteranceId });
        const verifyVoiceConcern = record.channel === 'voice_direct' && activeQuestion?.id === 'core.main_concern' && deterministic.recognized === false;
        const patch = ['complete', 'clarify'].includes(action?.type) ? { updates: [] }
          : deterministic.handled && !verifyVoiceConcern ? deterministic.patch
            : await extract({ utterances: [utterance], intake: cloneIntake(intake), signal: undefined });
        const result = mergeBatch(intake, patch, [utterance]);
        const voiceConcernAccepted = !verifyVoiceConcern || patch.updates?.some(update => ['symptom', 'redFlag'].includes(update.kind));
        if (verifyVoiceConcern && !voiceConcernAccepted) {
          engine = createQuestionEngine({ state: record.plan, onChange: value => { nextPlan = value; } });
          action = engine.clarify('transcript_unclear');
          intake = cloneIntake(record.intake);
        } else {
          if (result.unresolved.length && !result.acceptedCount && action?.type !== 'clarify' && !explicitNoFact.test(message)) throw new ChatIntakeStoreError('CHAT_EXTRACTION_UNAVAILABLE', 503);
          intake = result.intake;
        }
      }
      const progress = engine.syncIntake(intake);
      nextPlan = engine.snapshot();
      let status = 'collecting', question = questionText(action), patientCase, finalizationId;
      const history = [...(record.history || []), { id: randomUUID(), role: 'Patient', text: message }];
      const context = { caseId: record.patientCaseId, patientUid: uid, intakeSessionId: sessionId, resetGeneration: record.resetGeneration, fictionalConfirmed: true, intakeSource: 'chat_intake' };
      if (engine.emergency || emergencyEscalation(intake)) {
        status = 'emergency'; question = null;
        const warning = emergencyMessage; history.push({ id: randomUUID(), role: 'SmartCareOps', text: warning });
        let facilityText;
        try { const result = await facilityCoordinator?.lookupEmergency({ intake, patientUid: uid, intakeSessionId: sessionId, caseId: record.patientCaseId }); facilityText = emergencyFacilityMessage(result?.options?.[0]); }
        catch { facilityText = emergencyFacilityMessage(null); }
        history.push({ id: randomUUID(), role: 'SmartCareOps', text: facilityText });
        const completed = await onEmergency?.(intake, context); patientCase = completed?.patientCase || completed;
        history.push({ id: randomUUID(), role: 'SmartCareOps', text: 'Your emergency case has been sent to the SmartCareOps command center for dispatcher review. No ambulance or hospital referral has been confirmed.' });
      } else if (action?.type === 'complete' || nextPlan.status === 'ready_to_complete' && previousQuestionId === 'core.final_addition' && finalNo(message)) {
        status = 'completed'; question = null;
        const name = safeName(intake); history.push({ id: randomUUID(), role: 'SmartCareOps', text: `Thank you${name ? `, ${name}` : ''}. Your intake is complete.` });
        const completed = await onComplete?.(intake, context); patientCase = completed?.patientCase || completed; finalizationId = completed?.finalizationId;
      } else {
        const text = assistantText({ action, intake, previousQuestionId });
        if (text) history.push({ id: randomUUID(), role: 'SmartCareOps', text });
      }
      const response = { sessionId, revision: record.revision + 1, status, progress: publicProgress(progress), question,
        messages: history.map(({ role, text }) => ({ role, text })), intake, ...(finalizationId ? { finalizationId } : {}), ...(patientCase ? { patientCase } : {}) };
      const committed = await store.commit({ sessionId, uid, idempotencyKey, message, response,
        next: { status, plan: nextPlan, intake, question, history: history.slice(-80), ...(finalizationId ? { finalizationId } : {}), ...(patientCase ? { patientCase } : {}) } });
      await Promise.all([
        liveSessionStore.saveQuestionPlan({ intakeSessionId: sessionId, uid, plan: nextPlan }),
        liveSessionStore.saveIntakeSnapshot({ intakeSessionId: sessionId, uid, intake }),
      ]);
      if (status !== 'collecting') await liveSessionStore.end({ intakeSessionId: sessionId, uid });
      return { ...response, revision: committed.revision };
    } catch (error) {
      await store.abort({ sessionId, uid, idempotencyKey }); throw error;
    }
  }

  async function cancel({ sessionId, uid }) {
    if (!sessionPattern.test(sessionId || '')) throw new ChatIntakeStoreError('CHAT_SESSION_NOT_FOUND', 404);
    await store.cancel({ sessionId, uid }); await liveSessionStore.end({ intakeSessionId: sessionId, uid }); return { status: 'cancelled' };
  }
  return { start, get, submit, cancel, close: () => store.close?.() };
}

import { finalizationFailure, FinalizationError, safeValidationReason, safeValidationField, safeValidationTypes } from './finalization.js';
import { emptyIntake, redFlagTypes } from './schema.js';
import { mergeBatch } from './batch-validation.js';
import { classifyExtractionError } from './errors.js';
import { createAnswerContext } from './answer-context.js';
import { pendingClarifications } from '../../../shared/intake-clarifications.js';
import { isConfusion, clarificationFor } from './confusion.js';

export function createIntakeSession({ extract, send, onValidated = () => {}, onClarification = () => {}, delay = 900, timeoutMs = 45000, log = details => console.warn('[intake] Update unavailable; previous state retained.', details) }) {
  let intake = emptyIntake();
  let pending = [];
  let sequence = 0;
  let question = '';
  let unansweredQuestion = null;
  let patientBuffer = '';
  let patientQuestion = '';
  let modelBuffer = '';
  let timer;
  let controller;
  let closed = false;
  let running = false;
  let inFlight;
  let draining = false;
  let completion;
  let lastFailure;
  let drainRevision = 0;
  let transcriptSegmentCount = 0;
  let finalTurnReceived = false;
  let closeSource = null;
  let extractionResultStatus = 'not_started';
  let schemaValidationStatus = 'not_started';
  const assessAnswer = createAnswerContext();
  const emit = status => send({ type: 'intake-status', status });
  function schedule() {
    if (closed || draining || running || timer || !pending.length) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  }
  function finishPatient(finishedConfirmation = false) {
    if (!patientBuffer.trim()) return;
    const utterance = { id: ++sequence, role: 'Patient', text: patientBuffer.trim(), question: patientQuestion };
    patientBuffer = ''; patientQuestion = '';
    // Only the completion controller authorizes this no-op. Earlier clinical work still drains.
    if (finishedConfirmation) return;
    if (isConfusion(utterance.text)) {
      unansweredQuestion = unansweredQuestion || utterance.question;
      onClarification(clarificationFor(unansweredQuestion), { reason: 'confusion', question: unansweredQuestion });
      return;
    }
    const guard = assessAnswer(utterance.text, utterance.question);
    if (guard?.blocked) {
      // No model can promote this quarantined utterance to a clinical fact.
      if (guard.label) {
        const key = `symptoms.${guard.label}`;
        const item = { name: guard.label, status: 'unclear', patientReportedText: utterance.text };
        const index = intake.symptoms.findIndex(s => s.name === guard.label);
        if (index < 0) intake.symptoms.push(item); else intake.symptoms[index] = item;
        intake.evidence[key] = { utteranceId: utterance.id, patientReportedText: utterance.text, clarificationRequested: !!guard.clarification };
        const flagType = guard.label === 'chest pain' ? 'current chest pain' : guard.label;
        if (redFlagTypes.includes(flagType)) {
          const flag = { type: flagType, status: 'unclear', patientReportedText: utterance.text };
          const flagIndex = intake.redFlags.findIndex(f => f.type === flagType);
          if (flagIndex < 0) intake.redFlags.push(flag); else intake.redFlags[flagIndex] = flag;
          intake.evidence[`redFlags.${flagType}`] = { ...intake.evidence[key], derivedFrom: key };
        }
        send({ type: 'intake-update', intake: structuredClone(intake) });
      }
      if (guard.clarification) onClarification(guard.clarification);
      return;
    }
    unansweredQuestion = null;
    pending.push(utterance);
    if (pending.length > 40) { pending = pending.slice(-40); emit('unavailable'); }
    schedule();
  }
  function flush() {
    if (inFlight) return inFlight;
    inFlight = runFlush().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  async function runFlush() {
    if (closed || running || !pending.length) return;
    running = true;
    const batch = pending.splice(0);
    controller = new AbortController();
    let deadline;
    let onAbort;
    const signal = controller.signal;
    let succeeded = false;
    let stage = 'extraction';
    let updateCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let timedOut = false;
    emit('updating');
    try {
      const expired = new Promise((_, reject) => {
        deadline = setTimeout(() => { timedOut = true; controller?.abort(); reject(new Error('Extraction timeout')); }, timeoutMs);
      });
      const cancelled = new Promise((_, reject) => { onAbort = () => reject(new Error('Extraction cancelled')); signal.addEventListener('abort', onAbort, { once: true }); });
      const patch = await Promise.race([extract({ utterances: batch, intake: structuredClone(intake), signal }), expired, cancelled]);
      if (closed) return;
      extractionResultStatus = 'received';
      stage = 'validation';
      updateCount = Array.isArray(patch?.updates) ? patch.updates.length : 0;
      const priorClarifications = pendingClarifications(intake);
      const result = mergeBatch(intake, patch, batch);
      schemaValidationStatus = result.rejected.length ? 'rejected' : 'valid';
      intake = result.intake;
      acceptedCount = result.acceptedCount;
      rejectedCount = result.rejected.length;
      for (const item of result.rejected) log({ stage: 'validation', code: 'INVALID_RESPONSE', ...item.diagnostic, updateCount, acceptedCount, rejectedCount });
      for (const grounding of result.groundingDiagnostics) log({ stage: 'validation', code: 'SYMPTOM_GROUNDING', ...grounding });
      const remaining = pendingClarifications(intake);
      send({ type: 'intake-update', intake: structuredClone(intake) });
      if (acceptedCount || !rejectedCount) onValidated(structuredClone(intake));
      if (result.unresolved.length) throw result.unresolved[0].error;
      // A successful retry supersedes a failed request only when it reprocesses
      // every failed utterance. Current field repairs are checked separately.
      if (lastFailure?.utteranceIds.every(id => batch.some(u => u.id === id))) lastFailure = undefined;
      emit(lastFailure ? 'unavailable' : 'current');
      succeeded = true;
      console.info('[intake]', { stage: 'merge', code: 'SUCCESS', provider: 'gemini', utteranceIds: batch.map(u => u.id), updateCount, acceptedCount, rejectedCount,
        resolvedClarifications: priorClarifications.filter(prior => !remaining.some(item => item.key === prior.key)).length, remainingClarifications: remaining.length });
    } catch (error) {
      if (!closed) {
        if (stage === 'extraction') extractionResultStatus = 'failed';
        if (stage === 'validation') schemaValidationStatus = 'rejected';
        const diagnostic = classifyExtractionError(timedOut ? { name: 'TimeoutError' } : stage === 'validation' ? { code: 'INVALID_RESPONSE' } : error);
        const code = stage === 'validation' ? (error.reason === 'invalid schema' ? 'INVALID_RESPONSE' : 'VALIDATION_FAILED') : ({ TIMEOUT: 'EXTRACTION_TIMEOUT', GEMINI_ERROR: 'EXTRACTION_FAILED', AUTH_ERROR: 'EXTRACTION_FAILED' }[diagnostic.code] || diagnostic.code);
        const reason = stage === 'validation' ? safeValidationReason(error.reason) : code;
        const field = stage === 'validation' ? safeValidationField(error.field) : undefined;
        const types = field ? safeValidationTypes(error) : {};
        lastFailure = finalizationFailure(code, stage, batch.map(u => u.id), { ...diagnostic, reason, field, ...types });
        log({ stage, ...diagnostic, finalizationCode: code, utteranceIds: batch.map(item => item.id), updateCount, acceptedCount, rejectedCount: rejectedCount || updateCount, reason, ...(field ? { field, ...types } : {}) }); // Never log raw errors, patient speech, or credentials.
        pending = [...batch, ...pending].slice(-40); // Retry at the next patient turn, not in a loop.
        send({ type: 'intake-status', status: diagnostic.code === 'RATE_LIMIT' ? 'rate-limited' : 'unavailable', code: diagnostic.code });
      }
    } finally {
      clearTimeout(deadline); signal.removeEventListener('abort', onAbort); controller = undefined; running = false;
    }
    // New turns received while a successful request was running are processed serially.
    if (pending.length && pending[0].id > batch.at(-1).id) schedule();
    return succeeded;
  }
  return {
    snapshot() { return structuredClone(intake); },
    get awaitingQuestionClarification() { return unansweredQuestion !== null; },
    get diagnostics() {
      const unresolved = pendingClarifications(intake);
      return { utteranceId: sequence, activeQuestion: unansweredQuestion !== null, clarificationState: unansweredQuestion !== null ? 'active_question' : unresolved.length ? 'evidence_linked' : 'none',
        transcriptSegmentCount, finalTurnReceived, extractionResultStatus, schemaValidationStatus,
        ...(closeSource ? { cancellationSource: closeSource, abortControllerCategory: 'intake_extraction' } : {}),
        unresolvedCategories: unresolved.map(item => item.key).filter(value => typeof value === 'string').slice(0, 12),
        remainingClarifications: unresolved.length, extractionPending: running || pending.length > 0 || !!patientBuffer.trim() };
    },
    markFinalTurnReceived() { finalTurnReceived = true; },
    start() { send({ type: 'intake-update', intake: emptyIntake() }); emit('waiting'); },
    accept(content, { finishedConfirmation = false } = {}) {
      if (closed || draining) return;
      if (content.inputTranscription) {
        if (content.inputTranscription.text) transcriptSegmentCount++;
        if (!patientBuffer) patientQuestion = unansweredQuestion ?? (modelBuffer.trim() || question);
        patientBuffer = (patientBuffer + (content.inputTranscription.text || '')).slice(0, 6000);
        if (content.inputTranscription.finished) finishPatient(finishedConfirmation);
      }
      if (content.outputTranscription?.text) {
        transcriptSegmentCount++;
        finishPatient(finishedConfirmation);
        modelBuffer = (modelBuffer + content.outputTranscription.text).slice(0, 6000);
      }
      if (content.turnComplete || content.interrupted) {
        finishPatient(finishedConfirmation);
        if (modelBuffer.trim() && unansweredQuestion === null) question = modelBuffer.trim();
        modelBuffer = '';
      }
    },
    drain() {
      if (completion) return completion;
      draining = true;
      finishPatient();
      clearTimeout(timer); timer = undefined;
      const revision = ++drainRevision;
      completion = (async () => {
        const activeSucceeded = inFlight ? await inFlight : true;
        if (closed || revision !== drainRevision) throw new FinalizationError(finalizationFailure('CANCELLED', 'drain'));
        if (!activeSucceeded) throw new FinalizationError(lastFailure || finalizationFailure('FINALIZATION_UNKNOWN', 'drain'));
        const queuedSucceeded = pending.length ? await flush() : true;
        if (closed || revision !== drainRevision) throw new FinalizationError(finalizationFailure('CANCELLED', 'drain'));
        if (!queuedSucceeded) throw new FinalizationError(lastFailure || finalizationFailure('FINALIZATION_UNKNOWN', 'drain'));
        if (pending.length) throw new FinalizationError(finalizationFailure('FINALIZATION_UNKNOWN', 'drain'));
        if (lastFailure) throw new FinalizationError(lastFailure);
        if (unansweredQuestion !== null) throw new FinalizationError(finalizationFailure('UNRESOLVED_CLARIFICATION', 'finalization'));
        return structuredClone(intake);
      })();
      return completion;
    },
    resume() { draining = false; completion = undefined; drainRevision++; schedule(); },
    close(source = 'session_cleanup') { closeSource = source; closed = true; clearTimeout(timer); controller?.abort(); pending = []; patientBuffer = ''; modelBuffer = ''; intake = emptyIntake(); },
  };
}

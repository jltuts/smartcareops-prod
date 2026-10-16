// Patient workflow hints only: these never authorize voice shutdown or snapshot
// issuance. voice-state.js owns the canonical Gemini terminal signal.
// No clinical interpretation is performed here.
const filler = '(?:and|uh|um|thanks|thank you)';
const finishPhrase = "(?:that's (?:all|it|everything)|that is all|nothing (?:else|more|at all)|everything|all done|i'm done)";
const finalAnswer = new RegExp(`^(?:(?:um|uh|well|okay|ok) )*(?:(?:no|nope|nah)(?: (?:${filler} )*${finishPhrase})?|no nada(?: de amor)?|know nothing at all|${finishPhrase})(?: (?:thanks|thank you))?$`);
const additionalIntent = /\b(?:wait|but|except|actually|forgot|one more thing|not done)\b/;
const normalizeAnswer = text => text.toLowerCase().replace(/[’‘]/g, "'")
  .replace(/[.,!?;:…—–-]/g, ' ').replace(/\s+/g, ' ').trim();
export function isFinalAnswer(text) {
  const normalized = normalizeAnswer(text);
  return !additionalIntent.test(normalized) && finalAnswer.test(normalized);
}
export function createCompletionState() {
  let state = 'collecting', answer = '', output = '', answeringFinal = false, approved = false, revision = 0, modelTurn = false;
  let finalConfirmationProcessed = false;
  function reopen() { state = 'collecting'; approved = false; revision++; }
  function finishAnswer() {
    if (!answer) return;
    // Only a reply begun in awaiting_final_confirmation can authorize finishing.
    // Keep the ASR homophone narrow: "know" alone is never treated as "no".
    finalConfirmationProcessed ||= answeringFinal;
    approved = answeringFinal && isFinalAnswer(answer);
    state = 'collecting'; answer = ''; answeringFinal = false;
    return approved;
  }
  return {
    get state() { return state; }, get id() { return revision; },
    get confirmed() { return approved || state === 'pending_completion' || state === 'completed'; },
    interrupt() { if (state === 'completed') return false; const pending = state === 'pending_completion'; reopen(); return pending; },
    observe(content) {
      if (state === 'completed') return {};
      // Once pending, repeated model output cannot change the confirmation state.
      if (state === 'pending_completion' && !content.interrupted && !content.inputTranscription?.text) return {};
      let cancelled = false, finishedConfirmation = false;
      finalConfirmationProcessed = false;
      if (content.interrupted) { cancelled = state === 'pending_completion'; reopen(); output = ''; modelTurn = false; }
      if (content.inputTranscription?.text) {
        if (!answer) answeringFinal = state === 'awaiting_final_confirmation';
        if (state === 'pending_completion') { cancelled = true; reopen(); }
        answer += content.inputTranscription.text;
      }
      if (content.inputTranscription?.finished || content.outputTranscription?.text) finishedConfirmation = !!finishAnswer();
      if (content.outputTranscription?.text) output += content.outputTranscription.text;
      if (content.outputTranscription?.text || content.modelTurn) modelTurn = true;
      let pending = false;
      if (content.turnComplete) {
        finishedConfirmation = !!finishAnswer() || finishedConfirmation;
        if (/\banything else\b[^?]*\?/i.test(output)) { state = 'awaiting_final_confirmation'; approved = false; }
        else if (approved && modelTurn && !output.includes('?')) { state = 'pending_completion'; approved = false; revision++; pending = true; }
        else if (output.trim()) approved = false;
        output = ''; modelTurn = false;
      }
      return { cancelled, pending, id: revision, finishedConfirmation, ...(finalConfirmationProcessed ? { finalConfirmationProcessed: true } : {}) };
    },
    complete(id) { if (state !== 'pending_completion' || id !== revision) return false; state = 'completed'; return true; },
  };
}

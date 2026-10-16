import { evaluateSafety } from '../safety/engine.js';
import { isFinalAnswer } from '../completion.js';
import { complaintPaths, questionById, questionSets } from './question-sets.js';

const completeStates = new Set(['answered', 'denied', 'unclear', 'does_not_know', 'skipped', 'not_applicable']);
const normalize = value => String(value || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
const confusion = text => /^(?:what|huh|sorry|pardon|what do you mean|i (?:do not|don't) understand|can you (?:explain|repeat)(?: that)?|que|qué|no entiendo)$/iu.test(normalize(text));
const unknown = text => /^(?:i (?:do not|don't) know|not sure|unsure|i cannot tell|i can't tell)$/i.test(normalize(text));
const skip = text => /^(?:skip|i (?:would rather|prefer to) skip|i (?:do not|don't) want to (?:answer|say)|prefer not to say)$/i.test(normalize(text));
const notApplicable = text => /^(?:not applicable|n a|does not apply|doesn't apply)$/i.test(normalize(text));
const yes = text => /^(?:yes|yeah|yep|correct|i am|i do|si|sí|oui)$/iu.test(normalize(text));
const no = text => /^(?:no|nope|nah|i am not|i do not|i don't|non)$/iu.test(normalize(text));
const finalNo = text => isFinalAnswer(text);

export function selectComplaintPath(text) {
  const value = normalize(text);
  if (/\b(?:chest pain|chest pressure|chest discomfort|pain in (?:my )?chest)\b/i.test(value)) return 'chest';
  if (/\b(?:short(?:ness)? of breath|difficulty breathing|breathing difficulty|trouble breathing|breathless|(?:cannot|can't|cant) breath(?:e)?|wheez)/i.test(value)) return 'breathing';
  if (/\b(?:rash|skin|hives|itch|blister|lesion|redness)\b/i.test(value)) return 'skin';
  if (/\b(?:shoulder|upper arm|muscle|joint)\b/i.test(value)) return 'musculoskeletal_shoulder';
  return 'general';
}

function explicitFacts(text, path) {
  const value = normalize(text), facts = new Set();
  if (/\b(?:today|yesterday|last night|this morning|ago|since|for \d+|week|month|day|hour|sudden|gradual)\b/i.test(value)) facts.add('onset');
  if (/\b(?:mild|moderate|severe|\d+\s*(?:\/|out of)\s*10|cannot|can't|unable|limits?|affect(?:s|ing)?|normal activit)/i.test(value)) facts.add('severityOrActivity');
  if (/\b(?:new|first time|recurr|again|known condition|usually|previously)\b/i.test(value)) facts.add('pattern');
  if (path === 'musculoskeletal_shoulder' && /\b(?:left|right|both)\b.*\bshoulder\b|\bshoulder\b.*\b(?:left|right|both)\b/i.test(value)) facts.add('bodyAreaSide');
  if (path === 'skin' && /\b(?:face|arm|leg|chest|back|hand|foot|neck|abdomen|stomach|all over)\b/i.test(value)) facts.add('skinLocation');
  return facts;
}

const freshState = () => ({ version: 1, revision: 0, path: null, activeQuestionId: null, answers: {}, asked: [], processedUtteranceIds: [], clarificationCounts: {}, status: 'collecting', emergency: false });
const validState = state => state && state.version === 1 && (!state.path || complaintPaths.includes(state.path)) && state.answers && typeof state.answers === 'object';

export function createQuestionEngine({ state, onChange = () => {} } = {}) {
  let plan = validState(state) ? structuredClone(state) : freshState();
  const persist = () => { plan.revision++; onChange(structuredClone(plan)); };
  const applicable = item => !plan.path ? item.id === 'core.name' || item.id === 'core.main_concern' : item.paths.includes(plan.path);
  const done = id => completeStates.has(plan.answers[id]?.state);
  const required = () => questionSets.filter(item => applicable(item) && item.completion.required);
  const safetyPending = () => required().some(item => item.phase === 'safety' && !done(item.id));
  function chooseNext() {
    if (plan.emergency) return null;
    if (!done('core.name')) return questionById['core.name'];
    if (!done('core.main_concern')) return questionById['core.main_concern'];
    const candidates = required().filter(item => item.id !== 'core.final_addition' && !done(item.id));
    candidates.sort((a, b) => b.safetyPriority - a.safetyPriority || a.order - b.order);
    return candidates[0] || (!done('core.final_addition') ? questionById['core.final_addition'] : null);
  }
  function activate(item = chooseNext()) {
    plan.activeQuestionId = item?.id || null;
    if (item && !plan.asked.includes(item.id)) plan.asked.push(item.id);
    plan.status = item?.phase === 'review' ? 'ready_to_finish' : item ? 'collecting' : 'ready_to_finish';
    persist();
    return item ? { type: 'question', question: item, progress: progress() } : { type: 'ready', progress: progress() };
  }
  function record(item, stateName, text, utteranceId, extra = {}) {
    plan.answers[item.id] = { state: stateName, patientReportedText: text, utteranceId, ...extra };
  }
  function progress() {
    const item = questionById[plan.activeQuestionId];
    return { phase: plan.emergency ? 'emergency' : item?.phase || plan.status, status: plan.status, path: plan.path,
      answered: Object.values(plan.answers).filter(answer => completeStates.has(answer.state)).length,
      total: required().length, activeQuestionId: plan.activeQuestionId };
  }
  return {
    start() { return activate(plan.activeQuestionId ? questionById[plan.activeQuestionId] : chooseNext()); },
    snapshot() { return structuredClone(plan); },
    progress,
    get activeQuestion() { return questionById[plan.activeQuestionId] || null; },
    get emergency() { return plan.emergency; },
    safetyPending,
    facilityEligible() { return !!plan.path && !plan.emergency && !safetyPending() && done('core.main_concern'); },
    completionEligible() { return plan.activeQuestionId === 'core.final_addition' || plan.status === 'ready_to_complete'; },
    syncIntake(intake) {
      if (evaluateSafety(intake).emergency && !plan.emergency) { plan.emergency = true; plan.status = 'emergency'; plan.activeQuestionId = null; persist(); }
      return progress();
    },
    clarify(reason = 'ambiguous') {
      const item = questionById[plan.activeQuestionId];
      if (!item) return { type: 'none', progress: progress() };
      const count = (plan.clarificationCounts[item.id] || 0) + 1; plan.clarificationCounts[item.id] = count;
      if (count <= 2) { plan.status = 'clarifying'; persist(); return { type: 'clarify', question: item, reason, progress: progress() }; }
      record(item, 'unclear', '', null, { reason: 'clarification_limit' });
      plan.status = 'collecting'; return activate();
    },
    accept({ text, utteranceId }) {
      if (plan.emergency || plan.processedUtteranceIds.includes(utteranceId)) return { type: 'none', progress: progress() };
      const item = questionById[plan.activeQuestionId];
      if (!item || typeof text !== 'string' || !text.trim()) return this.clarify('empty');
      if (Number.isInteger(utteranceId)) plan.processedUtteranceIds = [...plan.processedUtteranceIds, utteranceId].slice(-80);
      if (confusion(text)) return this.clarify('confusion');
      if (unknown(text)) record(item, 'does_not_know', text, utteranceId);
      else if (notApplicable(text)) record(item, 'not_applicable', text, utteranceId);
      else if (skip(text)) {
        if (item.completion.skippable) record(item, 'skipped', text, utteranceId);
        else return this.clarify('required');
      }
      else if (item.id === 'core.final_addition') {
        if (finalNo(text)) { record(item, 'denied', text, utteranceId); plan.activeQuestionId = null; plan.status = 'ready_to_complete'; persist(); return { type: 'complete', progress: progress() }; }
        record(item, 'answered', text, utteranceId); delete plan.answers[item.id]; plan.status = 'collecting'; persist(); return { type: 'repeat_final', question: item, progress: progress() };
      } else if (item.answerType === 'yes_no') {
        if (yes(text)) record(item, 'answered', text, utteranceId);
        else if (no(text)) record(item, 'denied', text, utteranceId);
        else return this.clarify('ambiguous');
      } else if (item.id === 'core.severity' && /^\d+$/.test(normalize(text))) {
        const rating = Number(normalize(text));
        if (!Number.isInteger(rating) || rating < 1 || rating > 10) return this.clarify('ambiguous');
        record(item, 'answered', text, utteranceId);
      } else if (normalize(text).length < 2) return this.clarify('ambiguous');
      else record(item, 'answered', text, utteranceId);
      if (item.id === 'core.main_concern') {
        plan.path = selectComplaintPath(text);
        for (const fact of explicitFacts(text, plan.path)) {
          const existing = questionSets.find(question => question.paths.includes(plan.path) && question.requiredFacts.includes(fact));
          if (existing && !plan.answers[existing.id]) record(existing, 'answered', text, utteranceId, { suppliedWithMainConcern: true });
        }
      }
      plan.status = 'collecting';
      return activate();
    },
  };
}

export function questionControl(action, languageLabel = 'the selected language') {
  if (!action?.question) return '';
  return `[SMARTCAREOPS BACKEND QUESTION — NOT PATIENT SPEECH] Stable question ${action.question.id} is the only authorized next clinical question. Ask exactly one natural question in ${languageLabel} with this meaning: ${JSON.stringify(action.question.prompt)}. Do not speak the ID, add another question, diagnose, or mark it answered. Then wait.`;
}

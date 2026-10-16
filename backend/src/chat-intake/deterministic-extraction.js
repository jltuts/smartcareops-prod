const affirmative = /^(?:yes|yeah|yep|correct|i am|i do|si|sí|oui)[.!\s]*$/iu;
const negative = /^(?:no|nope|nah|i am not|i do not|i don't|non)[.!\s]*$/iu;
const noFact = /^(?:i (?:do not|don't) know|not sure|unsure|i cannot tell|i can't tell|skip|i (?:would rather|prefer to) skip|i (?:do not|don't) want to (?:answer|say)|prefer not to say|not applicable|n\/?a|does not apply|doesn't apply)[.!\s]*$/iu;
const directBreathing = /\b(?:i\s+)?(?:cannot|can't|cant)\s+breath(?:e)?\b/i;
const directEmergencyRequest = /\b(?:i\s+)?(?:need|require)\s+(?:an?\s+)?(?:emergency|emergency help|emergency assistance|ambulance)\b|\b(?:call|send)\s+(?:an?\s+)?ambulance\b|\bthis is an emergency\b/i;
const temporal = /\b(?:today|yesterday|last night|this morning|ago|since|for \d+|week|month|day|hour|sudden|gradual)\b/i;

const answerConcepts = Object.freeze({
  'skin.systemic': { kind: 'symptom', label: 'fever' },
  'skin.face_throat': { kind: 'symptom', label: 'swelling' },
  'skin.breathing': { kind: 'symptom', label: 'difficulty breathing' },
  'chest.current': { kind: 'redFlag', label: 'current chest pain' },
  'chest.breathing': { kind: 'symptom', label: 'difficulty breathing' },
  'chest.fainting': { kind: 'redFlag', label: 'loss of consciousness' },
  'chest.sweating': { kind: 'symptom', label: 'unusual sweating' },
  'chest.spread': { kind: 'symptom', label: 'discomfort' },
  'breathing.severe_now': { kind: 'redFlag', label: 'severe difficulty breathing' },
  'breathing.fainting': { kind: 'redFlag', label: 'loss of consciousness' },
  'breathing.sudden': { kind: 'symptom', label: 'start suddenly' },
  'breathing.chest': { kind: 'redFlag', label: 'current chest pain' },
});

const base = (kind, utteranceId, quote) => ({ kind, label: null, value: null, secondaryValue: null, unit: null,
  qualitative: null, status: null, evidenceId: utteranceId, quote });
const textual = (kind, value, utteranceId, quote) => ({ ...base(kind, utteranceId, quote), value });
const clinical = (kind, label, status, utteranceId, quote) => ({ ...base(kind, utteranceId, quote), label, status });

export function deterministicEmergencyExtraction({ text, utteranceId }) {
  if (typeof text !== 'string' || !Number.isInteger(utteranceId)) return { handled: false, patch: null };
  const quote = text.trim();
  if (!quote) return { handled: false, patch: null };
  const updates = [];
  if (directBreathing.test(quote)) updates.push(clinical('redFlag', 'severe difficulty breathing', 'confirmed', utteranceId, quote));
  if (directEmergencyRequest.test(quote)) updates.push(clinical('redFlag', 'patient requested emergency assistance', 'confirmed', utteranceId, quote));
  return updates.length ? { handled: true, patch: { updates } } : { handled: false, patch: null };
}

function literalComplaint(text) {
  const patterns = [
    /\b(?:left|right|both)\s+shoulder pain\b/i,
    /\bpain (?:in|on|over) (?:my |the )?(?:left |right |both )?shoulders?\b/i,
    /\bshoulder pain\b/i,
    /\bchest (?:pain|pressure|discomfort)\b/i,
    /\b(?:shortness of breath|short of breath|difficulty breathing|breathing difficulty|trouble breathing|wheezing)\b/i,
    /\b(?:rash|hives|itching|blister|skin redness)\b/i,
    /\b(?:dizziness|dizzy|headache|numbness|tingling)\b/i,
    /\b(?:blood sugar|blood glucose|high glucose|low glucose)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[0]) return { label: match[0], recognized: true };
  }
  const firstClause = text.split(/[.!?;,]/, 1)[0].trim();
  const label = (firstClause || text.trim()).slice(0, 160).trim();
  return label ? { label, recognized: false } : null;
}

export function deterministicChatExtraction({ question, text, utteranceId }) {
  if (!question?.id || typeof text !== 'string' || !Number.isInteger(utteranceId)) return { handled: false, patch: null };
  const quote = text.trim();
  if (!quote) return { handled: false, patch: null };
  if (noFact.test(quote)) return { handled: true, patch: { updates: [] } };

  const updates = deterministicEmergencyExtraction({ text: quote, utteranceId }).patch?.updates || [];

  if (question.id === 'core.name') {
    if (quote.length > 80) return { handled: false, patch: null };
    updates.push(textual('name', quote, utteranceId, quote));
    return { handled: true, patch: { updates } };
  }

  if (question.id === 'core.main_concern') {
    const complaint = literalComplaint(quote);
    if (!complaint) return { handled: false, patch: null };
    updates.unshift(clinical('symptom', complaint.label, 'confirmed', utteranceId, quote));
    if (temporal.test(quote) && quote.length <= 300) updates.push(textual('onset', quote, utteranceId, quote));
    return { handled: true, recognized: complaint.recognized, patch: { updates } };
  }

  if (question.id === 'core.onset') {
    if (quote.length > 300) return { handled: false, patch: null };
    updates.push(textual('onset', quote, utteranceId, quote));
    return { handled: true, patch: { updates } };
  }

  if (question.answerType === 'yes_no') {
    const status = affirmative.test(quote) ? 'confirmed' : negative.test(quote) ? 'denied' : null;
    if (!status) return { handled: false, patch: null };
    const concept = answerConcepts[question.id];
    if (concept) updates.push(clinical(concept.kind, concept.label, status, utteranceId, quote));
    return { handled: true, patch: { updates } };
  }

  if (quote.length <= 300) {
    updates.push(textual('note', quote, utteranceId, quote));
    return { handled: true, patch: { updates } };
  }
  return { handled: false, patch: null };
}

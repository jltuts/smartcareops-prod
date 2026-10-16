import { kinds, redFlagTypes, normalizationFailure } from './schema.js';
import { pendingClarifications } from '../../../shared/intake-clarifications.js';
import { supportedNoisyOnset } from './onset-asr.js';
import { isConfusion } from './confusion.js';
import { analyzeSymptomGrounding, isBriefAnswer, isSingleQuestion } from './symptom-grounding.js';

const fields = ['kind', 'label', 'value', 'secondaryValue', 'unit', 'qualitative', 'status', 'evidenceId', 'quote'];
const normalize = text => text.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}.'%/]+/gu, ' ').trim();
const uncertain = /\b(maybe|possibly|might|not sure|i think|unsure|i guess|don't think|do not think|not certain)\b/i;
const negative = /\b(no|nope|not|never|without|deny|denies|don't|do not|non)\b/i;
const redFlagAliases = {
  'current chest pain': ['chest pain', 'pain in my chest'],
  'severe difficulty breathing': ['severe difficulty breathing', 'severe breathing difficulty', 'breathing difficulty severe', 'cannot breathe', "can't breathe", 'cannot breath', "can't breath", 'cant breathe', 'cant breath'],
  'loss of consciousness': ['loss of consciousness', 'passed out', 'fainted', 'unconscious'],
  'stroke-like symptoms': ['stroke-like symptoms'],
  'severe uncontrolled bleeding': ['severe uncontrolled bleeding', "bleeding won't stop", 'bleeding will not stop'],
  'patient requested emergency assistance': ['patient requested emergency assistance', 'need emergency', 'need an emergency', 'need emergency help', 'need emergency assistance', 'need an ambulance', 'call an ambulance', 'this is an emergency'],
};
const mentionsRedFlag = (text, label) => (redFlagAliases[label] || [label]).some(term => normalize(text).includes(normalize(term)));
const numbers = text => (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
function requireValue(condition, reason = 'invalid schema', field, expected, received) {
  if (!condition) {
    const error = new Error('Invalid intake update');
    Object.assign(error, { reason, field, expected,
      ...(arguments.length >= 5 ? { receivedType: received === null ? 'null' : Array.isArray(received) ? 'array' : typeof received } : {}) });
    throw error;
  }
}

// Narrow, question-relative transcription confusions; not a language blacklist.
function garbledAnswer(text, question) {
  return (/chest pain/i.test(question) && /chess (?:piece|playing)/i.test(text)) ||
    (/breath/i.test(question) && /reading difficulty/i.test(text)) ||
    (/chest pain|breath/i.test(question) && /^아\s*,?\s*no[.!\s]*$/u.test(text.trim()));
}
const malformedGlucoseUnit = text => /\bmmol\b/i.test(text) && !/\bmmol\s*\/\s*l\b/i.test(text);

export function needsClarification(intake) {
  return pendingClarifications(intake).length > 0;
}

export function mergeIntake(current, patch, utterances) {
  requireValue(object(patch) && Object.keys(patch).length === 1 && Array.isArray(patch.updates) && patch.updates.length <= 24);
  const next = structuredClone(current); // Atomic validation: a bad update never partially changes state.
  for (const update of patch.updates) {
    if (update?.[normalizationFailure]) throw update[normalizationFailure];
    requireValue(object(update) && Object.keys(update).length === fields.length && fields.every(key => Object.hasOwn(update, key)));
    requireValue(kinds.includes(update.kind), 'invalid schema', 'kind');
    requireValue(Number.isInteger(update.evidenceId), 'invalid schema', 'evidenceId');
    requireValue(typeof update.quote === 'string' && update.quote.length > 0 && update.quote.length <= 2000, 'invalid schema', 'quote');
    for (const field of ['label', 'unit', 'qualitative', 'status']) requireValue(update[field] === null || (typeof update[field] === 'string' && update[field].length <= 160), 'invalid schema', field);
    requireValue(update.value === null || (typeof update.value === 'string' && update.value.length <= 300) || (typeof update.value === 'number' && Number.isFinite(update.value)), 'invalid schema', 'value');
    requireValue(update.secondaryValue === null || (typeof update.secondaryValue === 'number' && Number.isFinite(update.secondaryValue)), 'invalid schema', 'secondaryValue');
    const utterance = utterances.find(item => item.id === update.evidenceId);
    requireValue(utterance && utterance.role === 'Patient' && utterance.text.includes(update.quote), 'missing evidence');
    requireValue(!isConfusion(utterance.text), 'missing evidence');
    const supportedOnset = supportedNoisyOnset(utterance);
    if (supportedOnset) requireValue(update.kind === 'onset' && typeof update.value === 'string' && update.value.toLowerCase() === supportedOnset.value, 'missing evidence', 'value', 'supported temporal fact', update.value);
    const quote = utterance.text; // Assess the full answer, not a cherry-picked positive fragment.
    const question = utterance.question || '';
    const answer = quote.trim().replace(/^(?:no[,.!\s]+)+(?=no\b)/i, '');
    const brief = isBriefAnswer(answer);
    const support = brief ? question : quote;
    const garbled = garbledAnswer(quote, question);
    const evidence = { utteranceId: utterance.id, patientReportedText: quote };
    let key = update.kind;
    if (['symptom', 'redFlag'].includes(update.kind)) {
      requireValue(typeof update.label === 'string' && update.label.trim().length > 0, 'invalid schema', 'label');
      requireValue(['confirmed', 'denied', 'unclear'].includes(update.status), 'invalid schema', 'status', 'confirmed | denied | unclear', update.status);
      for (const field of ['value', 'secondaryValue', 'unit', 'qualitative']) requireValue(update[field] === null, 'invalid schema', field, 'null', update[field]);
      const label = update.label.toLowerCase().trim();
      if (update.kind === 'redFlag') requireValue(redFlagTypes.includes(label));
      let canonicalConcept = null;
      if (update.kind === 'symptom') {
        const grounding = analyzeSymptomGrounding({ ...utterance, text: answer }, label);
        if (garbled) {
          grounding.supported = isSingleQuestion(question) && normalize(question).includes(normalize(label));
          grounding.labelSource = grounding.supported ? 'question_context' : null;
          grounding.matchCategory = grounding.supported ? 'short_answer_question' : 'unsupported';
        }
        if (!grounding.supported) {
          const error = new Error('Invalid intake update');
          Object.assign(error, { reason: 'invalid schema', field: 'label', expected: 'literal patient-evidenced label', receivedType: 'string',
            labelSource: null, matchCategory: 'unsupported', multilingual: grounding.multilingual });
          throw error;
        }
        // Compound questions can preserve ambiguity, but can never promote the
        // model-provided status to confirmed or denied.
        canonicalConcept = grounding.canonicalConcept;
      } else {
        requireValue(garbled ? isSingleQuestion(question) && mentionsRedFlag(question, label) : mentionsRedFlag(support, label),
          'invalid schema', 'label', 'patient-evidenced red-flag label', update.label);
      }
      let status = update.status;
      const explicitSevereBreathing = update.kind === 'redFlag' && label === 'severe difficulty breathing' &&
        /(?:^|[.!?]\s*)i\s+(?:cannot|can't|cant)\s+breath(?:e)?\b/i.test(quote);
      if (garbled || uncertain.test(quote) && !explicitSevereBreathing || (brief && (!isSingleQuestion(question) || /both|neither/i.test(quote)))) status = 'unclear';
      else if (negative.test(quote)) {
        // Mixed affirmative/negative statements require a narrower explicit clarification.
        status = /\b(and|but|however)\b|[,;]/i.test(answer) ? 'unclear' : 'denied';
      } else if (brief && /^(yes|yeah|yep|sure|correct|right|i do|i am)[.!\s]*$/i.test(quote.trim())) status = 'confirmed';
      else if (status === 'denied') status = 'unclear';
      // Current/severe red flags require explicit qualifiers, not mere symptom presence.
      if (update.kind === 'redFlag' && status === 'confirmed' && label === 'current chest pain' && !/\b(now|current|currently|right now|today|having|have|has)\b/i.test(support)) status = 'unclear';
      if (update.kind === 'redFlag' && status === 'confirmed' && label === 'current chest pain' && /\b(last year|used to|years ago|in the past|previously)\b/i.test(support)) status = 'unclear';
      const collection = update.kind === 'symptom' ? 'symptoms' : 'redFlags';
      const nameField = update.kind === 'symptom' ? 'name' : 'type';
      key = `${collection}.${label}`;
      if ((next.evidence[key]?.utteranceId || 0) > utterance.id) continue;
      const item = { [nameField]: label, ...(update.kind === 'symptom' && canonicalConcept ? { canonicalConcept } : {}), status, patientReportedText: quote };
      const index = next[collection].findIndex(entry => entry[nameField] === label);
      if (index < 0) { requireValue(next[collection].length < 50); next[collection].push(item); }
      else next[collection][index] = item;
      if (collection === 'symptoms' && status === 'denied') {
        // Resolve only guard-created mirrors of this exact earlier answer.
        // Never alter independently reported flags or infer a confirmed red flag.
        for (const flag of next.redFlags) {
          const flagKey = `redFlags.${flag.type}`;
          const prior = next.evidence[flagKey];
          if (flag.status === 'unclear' && prior?.derivedFrom === key && prior.utteranceId === next.evidence[key]?.utteranceId && prior.utteranceId <= utterance.id) {
            flag.status = 'denied'; flag.patientReportedText = quote;
            next.evidence[flagKey] = { ...evidence };
          }
        }
      }
    } else {
      requireValue(update.label === null, 'invalid schema', 'label', 'null', update.label);
      requireValue(update.status === null, 'invalid schema', 'status', 'null', update.status);
      if (['name', 'preferredName', 'onset', 'note'].includes(update.kind)) {
        requireValue(!garbled);
        requireValue(typeof update.value === 'string' && update.value.length > 0 && normalize(quote).includes(normalize(update.value)) && !brief, 'invalid schema', 'value', 'evidenced nonempty string', update.value);
        for (const field of ['secondaryValue', 'unit', 'qualitative']) requireValue(update[field] === null, 'invalid schema', field, 'null', update[field]);
        if ((next.evidence[key]?.utteranceId || 0) > utterance.id) continue;
        if (update.kind === 'name' || update.kind === 'preferredName') next.patient[update.kind] = update.value;
        if (update.kind === 'onset') next.onset = { value: update.value, patientReportedText: quote };
        if (update.kind === 'note' && !next.additionalNotes.includes(update.value)) {
          requireValue(next.additionalNotes.length < 30); next.additionalNotes.push(update.value);
        }
      } else {
        requireValue(update.value === null || typeof update.value === 'number', 'invalid schema', 'value', 'number or null', update.value);
        // A unit-only answer can clarify an already evidenced glucose reading.
        // Never borrow a number from the assistant or accept an unrelated short answer.
        const unitOnly = /^(?:mg\s*\/?\s*dl)[.!\s]*$/i.test(quote.trim()) ? 'mg/dL' : /^mmol\s*\/\s*l[.!\s]*$/i.test(quote.trim()) ? 'mmol/L' : null;
        if (update.kind === 'bloodGlucose' && update.value === null && unitOnly && update.unit === unitOnly &&
            isSingleQuestion(question) && /\b(glucose|sugar)\b/i.test(question) && /\bunit\b/i.test(question)) {
          requireValue(update.secondaryValue === null && update.qualitative === null);
          requireValue(next.vitals.bloodGlucose.value !== null && next.evidence['vitals.bloodGlucose']);
          key = 'vitals.bloodGlucose';
          if ((next.evidence[key]?.utteranceId || 0) > utterance.id) continue;
          const valueEvidence = next.evidence[key].valueEvidence || next.evidence[key];
          next.vitals.bloodGlucose.unit = unitOnly;
          next.evidence[key] = { ...evidence, valueEvidence };
          continue;
        }
        const vitalTerms = { temperature: /\b(temperature|temp|degrees|celsius|fahrenheit)\b|°[cf]/i, bloodPressure: /\b(blood pressure|bp)\b/i,
          heartRate: /\b(heart rate|pulse|bpm)\b/i, spo2: /\b(spo2|oxygen|saturation)\b/i, bloodGlucose: /\b(glucose|sugar)\b/i };
        requireValue(vitalTerms[update.kind].test(quote) || (isSingleQuestion(question) && vitalTerms[update.kind].test(question)));
        // Numbers must occur in the patient's evidence; no defaults or unit conversions.
        const reportedNumbers = numbers(quote);
        if (update.value !== null) requireValue(reportedNumbers.includes(update.value), 'missing numeric evidence');
        if (update.secondaryValue !== null) requireValue(reportedNumbers.includes(update.secondaryValue));
        const units = { '°C': /\b(celsius|centigrade|c)\b|°c/i, '°F': /\b(fahrenheit|f)\b|°f/i, 'mg/dL': /mg\s*\/\s*dl/i, 'mmol/L': /mmol\s*\/\s*l/i };
        const unit = update.kind === 'bloodGlucose' && malformedGlucoseUnit(quote) ? null : update.unit;
        if (unit !== null) requireValue(units[unit]?.test(quote), 'unsupported unit');
        if (update.kind !== 'bloodGlucose') requireValue(update.qualitative === null);
        if (update.kind !== 'bloodPressure') requireValue(update.secondaryValue === null);
        if (update.kind === 'temperature') requireValue(update.unit === null || ['°C', '°F'].includes(update.unit));
        if (update.kind === 'bloodGlucose') requireValue(unit === null || ['mg/dL', 'mmol/L'].includes(unit));
        if (['bloodPressure', 'heartRate', 'spo2'].includes(update.kind)) requireValue(update.unit === null, 'invalid schema', 'unit', 'null', update.unit);
        if (update.kind === 'bloodGlucose' && update.qualitative !== null) {
          requireValue(['patient reports high', 'patient reports low'].includes(update.qualitative));
          requireValue(new RegExp(`\\b${update.qualitative.endsWith('high') ? 'high' : 'low'}\\b`, 'i').test(quote));
        }
        requireValue(update.value !== null || update.qualitative !== null);
        if (update.kind === 'bloodPressure') {
          requireValue(typeof update.value === 'number', 'invalid schema', 'value', 'number', update.value);
          requireValue(typeof update.secondaryValue === 'number', 'invalid schema', 'secondaryValue', 'number', update.secondaryValue);
        }
        key = `vitals.${update.kind}`;
        if ((next.evidence[key]?.utteranceId || 0) > utterance.id) continue;
        if (update.kind === 'bloodPressure') next.vitals.bloodPressure = { systolic: update.value, diastolic: update.secondaryValue, source: 'patient_reported' };
        else next.vitals[update.kind] = {
          value: update.value, unit: update.kind === 'heartRate' ? 'bpm' : update.kind === 'spo2' ? '%' : unit,
          ...(update.kind === 'bloodGlucose' ? { qualitative: update.qualitative } : {}), source: 'patient_reported',
        };
      }
    }
    next.evidence[key] = evidence;
  }
  return next;
}

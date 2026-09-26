const normalize = text => String(text || '').toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}.'%/]+/gu, ' ').trim();

const shortAnswer = /^(yes|yeah|yep|no|nope|maybe|possibly|sure|correct|right|i do|i don't|i am|i am not|not sure|i think so|both|neither|sí|si|oui|non)[.!\s]*$/iu;

// Closed, non-expansive mappings applied only after literal evidence validation.
const canonicalConcepts = new Map([
  ['dizzy', 'dizziness'],
  ['dizziness', 'dizziness'],
  ['short of breath', 'shortness of breath'],
  ['shortness of breath', 'shortness of breath'],
  ['fever', 'fever'],
]);

export const isBriefAnswer = text => shortAnswer.test(String(text || '').trim());
export const isSingleQuestion = text => !!text && (text.match(/\?/g) || []).length <= 1 && !/\b(or|and|also|besides|other symptoms)\b|[,;]/i.test(text);
export const containsLiteralPhrase = (text, phrase) => !!normalize(phrase) && normalize(text).includes(normalize(phrase));
export const canonicalizeSymptom = label => canonicalConcepts.get(normalize(label)) || null;

export function analyzeSymptomGrounding(utterance, label) {
  const patientMatch = containsLiteralPhrase(utterance?.text, label);
  const brief = isBriefAnswer(utterance?.text);
  const questionMatch = brief && containsLiteralPhrase(utterance?.question, label);
  const labelSource = patientMatch ? 'patient_utterance' : questionMatch ? 'question_context' : null;
  const canonicalConcept = labelSource ? canonicalizeSymptom(label) : null;
  const multilingual = /[^\x00-\x7F]/.test(`${utterance?.text || ''}${utterance?.question || ''}`) || /^(oui|non)[.!\s]*$/i.test(String(utterance?.text || '').trim());
  return {
    supported: patientMatch || questionMatch,
    labelSource,
    matchCategory: !labelSource ? 'unsupported' : questionMatch && !patientMatch ? 'short_answer_question' : canonicalConcept && normalize(canonicalConcept) !== normalize(label) ? 'approved_normalization' : 'exact',
    multilingual,
    canonicalConcept,
    brief,
    singleQuestion: isSingleQuestion(utterance?.question || ''),
  };
}

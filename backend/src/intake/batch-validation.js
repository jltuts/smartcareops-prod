import { mergeIntake } from './validate.js';
import { kinds, normalizationFailure } from './schema.js';
import { analyzeSymptomGrounding } from './symptom-grounding.js';

const keyFor = update => ['symptom', 'redFlag'].includes(update?.kind)
  ? `${update.kind === 'symptom' ? 'symptoms' : 'redFlags'}.${typeof update.label === 'string' ? update.label.toLowerCase().trim() : '?'}`
  : ['name', 'preferredName', 'onset', 'note'].includes(update?.kind) ? update.kind
    : kinds.includes(update?.kind) ? `vitals.${update.kind}` : '?';

// The envelope and every individual fact stay strict. A rejected fact cannot
// discard independently validated facts from the same provider response.
export function mergeBatch(current, patch, utterances) {
  mergeIntake(current, { ...patch, updates: Array.isArray(patch?.updates) && patch.updates.length <= 24 ? [] : null }, utterances);
  let intake = structuredClone(current);
  const rejected = [];
  const groundingDiagnostics = [];
  let acceptedCount = 0;
  for (const [updateIndex, update] of patch.updates.entries()) {
    const key = keyFor(update);
    try {
      intake = mergeIntake(intake, { updates: [update] }, utterances);
      acceptedCount++;
      if (update.kind === 'symptom') {
        const utterance = utterances.find(item => item.id === update.evidenceId);
        const grounding = analyzeSymptomGrounding(utterance, update.label);
        groundingDiagnostics.push({ updateIndex, updateType: 'symptom', fieldPath: 'symptom.label',
          labelSource: grounding.supported ? grounding.labelSource : 'question_context',
          matchCategory: grounding.supported ? grounding.matchCategory : 'short_answer_question',
          multilingual: grounding.multilingual });
      }
      if (intake.validationClarifications) intake.validationClarifications = intake.validationClarifications.filter(item => item.key !== key || item.utteranceId > update.evidenceId);
      if (update.kind === 'onset') delete intake.onset.clarificationRequested;
    } catch (error) {
      const utteranceId = utterances.some(u => u.id === update?.evidenceId) ? update.evidenceId : undefined;
      const optional = update?.kind === 'onset' && utteranceId !== undefined;
      const received = update?.[error.field];
      const topLevelKeys = update && typeof update === 'object' && !Array.isArray(update)
        ? Object.keys(update).filter(name => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)).slice(0, 12)
        : [];
      const diagnostic = { updateIndex, updateType: kinds.includes(update?.kind) ? update.kind : 'invalid', topLevelKeys,
        field: error.field || 'update', fieldPath: `${kinds.includes(update?.kind) ? update.kind : 'update'}.${error.field || 'update'}`,
        expected: error.expected || 'valid evidenced update', receivedType: error.receivedType || (received === null ? 'null' : Array.isArray(received) ? 'array' : typeof received),
        normalizedBeforeValidation: !update?.[normalizationFailure], explicitNull: received === null,
        evidenceShapeValid: Number.isInteger(update?.evidenceId) && typeof update?.quote === 'string' && update.quote.length > 0,
        ...(received === null || typeof received === 'boolean' || (typeof received === 'number' && Number.isFinite(received)) || ['', 'confirmed', 'denied', 'unclear'].includes(received) ? { received } : {}),
        missingFields: Array.isArray(error.missingFields) ? error.missingFields : [], unexpectedFields: Array.isArray(error.unexpectedFields) ? error.unexpectedFields : [],
        ...(error.field === 'label' && update?.kind === 'symptom' ? {
          labelSource: ['patient_utterance', 'question_context'].includes(error.labelSource) ? error.labelSource : null,
          matchCategory: ['exact', 'approved_normalization', 'short_answer_question', 'unsupported'].includes(error.matchCategory) ? error.matchCategory : 'unsupported',
          multilingual: error.multilingual === true,
        } : {}),
        ...(utteranceId === undefined ? {} : { utteranceId }), reason: error.reason || 'invalid schema' };
      // A structurally incomplete provider object is an extraction failure, not
      // evidence that the patient gave an ambiguous clinical answer. It must be
      // retried, but must not create a clinical clarification marker that can
      // never be repaired because its field identity was never valid.
      const repairable = diagnostic.field !== 'update' && key !== '?';
      rejected.push({ error, diagnostic, key, utteranceId, optional, repairable });
      if (optional && !intake.onset.value) intake.onset.clarificationRequested = true;
      if (!optional && repairable) {
        intake.validationClarifications ||= [];
        if (!intake.validationClarifications.some(item => item.key === key && item.utteranceId === utteranceId)) intake.validationClarifications.push({ key, utteranceId });
      }
    }
  }
  // A later valid candidate in this very batch may repair an earlier rejection.
  const unresolved = rejected.filter(item => !item.optional && (!item.repairable || intake.validationClarifications?.some(p => p.key === item.key && p.utteranceId === item.utteranceId)));
  return { intake, acceptedCount, rejected, unresolved, groundingDiagnostics };
}

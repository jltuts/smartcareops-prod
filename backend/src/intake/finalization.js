export const finalizationMessage = 'Clinical summary could not be finalized. Previous valid information has been preserved.';
const reasons = {
  RATE_LIMIT: 'Gemini API quota or rate limit exceeded.', SERVICE_UNAVAILABLE: 'Gemini service unavailable.',
  EXTRACTION_TIMEOUT: 'Extraction deadline exceeded.', EXTRACTION_FAILED: 'Gemini extraction failed.',
  INVALID_RESPONSE: 'Invalid extraction JSON or schema.', VALIDATION_FAILED: 'Extraction evidence validation failed.',
  UNRESOLVED_CLARIFICATION: 'Required clarification remains unresolved.', EMPTY_INTAKE: 'No validated reported facts.',
  CANCELLED: 'Finalization cancelled.', FINALIZATION_UNKNOWN: 'Unexpected finalization failure.',
};
const validationReasons = new Set(['unsupported unit', 'invalid schema', 'missing evidence', 'missing numeric evidence', 'contradictory update', 'unresolved clarification']);
export const safeValidationReason = reason => validationReasons.has(reason) ? reason : 'invalid schema';
export const safeValidationField = field => ['kind', 'evidenceId', 'quote', 'label', 'unit', 'qualitative', 'status', 'value', 'secondaryValue'].includes(field) ? field : undefined;
export function safeValidationTypes(diagnostic) {
  return {
    ...(['null', 'number', 'number or null', 'string'].includes(diagnostic.expected) ? { expected: diagnostic.expected } : {}),
    ...(['null', 'array', 'string', 'number', 'object', 'undefined', 'boolean'].includes(diagnostic.receivedType) ? { receivedType: diagnostic.receivedType } : {}),
  };
}
export function finalizationFailure(code, stage, utteranceIds = [], diagnostic = {}) {
  code = Object.hasOwn(reasons, code) ? code : 'FINALIZATION_UNKNOWN';
  const reason = stage === 'validation' ? safeValidationReason(diagnostic.reason) : undefined;
  const field = stage === 'validation' ? safeValidationField(diagnostic.field) : undefined;
  const types = field ? safeValidationTypes(diagnostic) : {};
  return { code, stage, provider: 'gemini', utteranceIds: utteranceIds.filter(Number.isInteger),
    userMessage: finalizationMessage, developerMessage: reasons[code] + (reason ? ` Reason: ${reason}.` : '') + (field ? ` Field: ${field}.` : '') + (types.expected ? ` Expected: ${types.expected}; received type: ${types.receivedType}.` : ''),
    ...(Number.isInteger(diagnostic.httpStatus) ? { httpStatus: diagnostic.httpStatus } : {}) };
}
export class FinalizationError extends Error {
  constructor(detail) { super('Final extraction failed'); this.detail = detail; }
}

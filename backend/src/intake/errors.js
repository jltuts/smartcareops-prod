import { sanitizeGeminiError } from '../../../shared/gemini-resilience.mjs';

// The shared runner returns only sanitized diagnostics; retain them across the
// existing throwing extractor/session boundary without forwarding an SDK error.
export class GeminiExtractionError extends Error {
  constructor(diagnostic) { super('Gemini extraction failed'); this.diagnostic = diagnostic; }
}
export function classifyExtractionError(error) {
  return error instanceof GeminiExtractionError ? error.diagnostic : sanitizeGeminiError(error);
}

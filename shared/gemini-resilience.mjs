// Dependency-free reference. Route only Gemini request errors into this module.
const codes = new Set(['RATE_LIMIT', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'AUTH_ERROR', 'INVALID_RESPONSE', 'GEMINI_ERROR']);
const categories = new Set(['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'INVALID_RESPONSE']);
const safeHttp = value => Number.isInteger(Number(value)) && Number(value) >= 400 && Number(value) <= 599 ? Number(value) : undefined;

export function classifyGeminiError(error, { now = Date.now() } = {}) {
  // Google SDKs may expose a structured body or a JSON-encoded message.
  let body = error?.error;
  if (!body && typeof error?.message === 'string' && error.message.length < 65536) {
    try { body = JSON.parse(error.message)?.error; } catch { /* Not JSON. */ }
  }
  const httpStatus = [error?.status, error?.statusCode, error?.response?.status, body?.code, error?.code].map(safeHttp).find(v => v !== undefined);
  const category = [body?.status, error?.status, error?.code, error?.cause?.code].find(v => categories.has(v))
    || (typeof error?.message === 'string' && /\bRESOURCE_EXHAUSTED\b/.test(error.message.slice(0, 65536)) ? 'RESOURCE_EXHAUSTED' : undefined);
  const cancelled = error?.name === 'AbortError' && !['ETIMEDOUT', 'DEADLINE_EXCEEDED'].includes(category);
  let code = 'GEMINI_ERROR';
  if (!cancelled) {
    if (httpStatus === 429 || category === 'RESOURCE_EXHAUSTED') code = 'RATE_LIMIT';
    else if ([401, 403].includes(httpStatus) || ['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(category)) code = 'AUTH_ERROR';
    else if (error?.name === 'TimeoutError' || ['DEADLINE_EXCEEDED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(category) || httpStatus === 408) code = 'TIMEOUT';
    else if (httpStatus >= 500 || ['UNAVAILABLE', 'INTERNAL', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(category)) code = 'SERVICE_UNAVAILABLE';
    else if (error instanceof SyntaxError || category === 'INVALID_RESPONSE') code = 'INVALID_RESPONSE';
  }
  const headers = error?.response?.headers || error?.headers;
  const rawRetryAfter = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'] ?? headers?.['Retry-After'];
  let retryAfterMs;
  if (typeof rawRetryAfter === 'string' || typeof rawRetryAfter === 'number') {
    const text = String(rawRetryAfter).trim();
    const delay = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
    if (Number.isFinite(delay) && delay >= 0) retryAfterMs = delay;
  }
  return { provider: 'gemini', code, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(category ? { category } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

// Sanitization intentionally discards every free-text field, even an unknown secret.
export function sanitizeGeminiError(error, options) { return classifyGeminiError(error, options); }
export function isRetryable(classification) { return classification?.provider === 'gemini' && ['RATE_LIMIT', 'SERVICE_UNAVAILABLE'].includes(classification.code); }
export function getUserMessage(classification) {
  return classification?.code === 'TIMEOUT'
    ? 'The AI service took too long to respond. Please try again.'
    : 'The AI service is temporarily unavailable. Please try again shortly.';
}
export function getDeveloperMessage(classification) {
  const code = codes.has(classification?.code) ? classification.code : 'GEMINI_ERROR';
  const status = safeHttp(classification?.httpStatus);
  const detail = {
    RATE_LIMIT: 'Gemini API quota or rate limit exceeded. Check configured project usage and billing limits.',
    SERVICE_UNAVAILABLE: 'Gemini API or upstream transport is temporarily unavailable.',
    TIMEOUT: 'Gemini request deadline exceeded.',
    AUTH_ERROR: 'Gemini authentication or permission failed. Check server-side credential configuration and access.',
    INVALID_RESPONSE: 'Gemini response could not be parsed or validated.',
    GEMINI_ERROR: 'Gemini request failed or was cancelled.',
  }[code];
  return `${detail} (${code}${status ? `; HTTP ${status}` : ''})`;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
  const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

// This function never commits application state or calls downstream actions.
// validate must return a validated value (or throw); request must not mutate prior state.
export async function runGeminiRequest(request, {
  previousState, validate, signal, maxRetries = 0, idempotent = false,
  baseDelayMs = 500, maxDelayMs = 30000, maxTotalWaitMs = 60000,
  shouldRetry = () => true, wait = sleep, random = Math.random, now = Date.now,
} = {}) {
  if (typeof validate !== 'function') throw new TypeError('A response validator is required');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10 ||
      ![baseDelayMs, maxDelayMs, maxTotalWaitMs].every(v => Number.isFinite(v) && v >= 0)) throw new TypeError('Invalid retry bounds');
  let waited = 0;
  const failure = error => ({ ok: false, state: previousState, error });
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) return failure(classifyGeminiError({ name: 'AbortError' }));
    let classification;
    try {
      const response = await request({ attempt, signal });
      let value;
      try { value = await validate(response); }
      catch { return failure(classifyGeminiError({ code: 'INVALID_RESPONSE' })); }
      if (signal?.aborted) return failure(classifyGeminiError({ name: 'AbortError' }));
      return { ok: true, value };
    } catch (error) { classification = sanitizeGeminiError(error, { now: now() }); }
    if (signal?.aborted || !idempotent || attempt === maxRetries || !isRetryable(classification) || !shouldRetry(classification)) return failure(classification);
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    const delay = Math.max(backoff * (0.5 + Math.min(1, Math.max(0, random())) * 0.5), classification.retryAfterMs || 0);
    // Never shorten Retry-After to fit a budget: give up instead.
    if (!Number.isFinite(delay) || delay > maxDelayMs || waited + delay > maxTotalWaitMs) return failure(classification);
    waited += delay;
    try { await wait(delay, signal); }
    catch { return failure(classifyGeminiError({ name: 'AbortError' })); }
  }
}

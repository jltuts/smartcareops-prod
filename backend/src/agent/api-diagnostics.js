// Error bodies are untrusted: only recognized protocol messages enter logs.
// Never return unknown text, request data, credentials, headers or screenshot bytes.
const messages = new Set([
  'Computer Use Model requires function response to contain an image of mime_type image/png in the data.inline_data field.',
  'Request contains an invalid argument.',
]);
const codes = new Set(['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'NOT_FOUND', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INVALID_REQUEST', 'invalid_request_error', 'invalid_argument']);
for (const code of ['invalid_request', 'bad_request', 'BadRequest', 'INVALID_REQUEST_ERROR']) codes.add(code);

export function safeApiError(error) {
  const status = error?.status ?? error?.statusCode;
  let body = error?.error ?? error?.body;
  if (typeof body === 'string' && body.length <= 32000) { try { body = JSON.parse(body); } catch { body = null; } }
  body = body?.error ?? body;
  const code = body?.code;
  const message = typeof body?.message === 'string' ? body.message : '';
  // Only exact, recognized protocol messages are safe to return. A novel SDK
  // message could echo credentials or screenshot data in arbitrary positions.
  const safe = messages.has(message) ? message : '[API error message omitted: unrecognized free-form text]';
  return {
    httpStatus: Number.isInteger(status) && status >= 400 && status <= 599 ? status : null,
    apiErrorCode: Number.isInteger(code) && ((code >= 0 && code <= 16) || (code >= 400 && code <= 599)) ? code : codes.has(code) ? code : null,
    apiErrorMessage: safe,
  };
}

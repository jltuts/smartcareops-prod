import { browserSignalsAccept, createOriginPolicy } from '../origin.js';
import { ChatIntakeStoreError } from './store.js';

const sessionPattern = /^[a-f0-9]{64}$/;
const allowedKeys = new Set(['sessionId', 'expectedRevision', 'message']);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function body(request, limit = 4096) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ChatIntakeStoreError('INVALID_CHAT_REQUEST', 400);
  let raw = '';
  for await (const chunk of request) { raw += chunk.toString(); if (raw.length > limit) throw new ChatIntakeStoreError('INVALID_CHAT_REQUEST', 400); }
  try { const value = JSON.parse(raw || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new ChatIntakeStoreError('INVALID_CHAT_REQUEST', 400); }
}

const safeMessage = code => ({
  CHAT_SESSION_NOT_FOUND: 'This chat intake could not be found. Start a new chat intake.',
  CHAT_SESSION_EXPIRED: 'This chat intake expired. Start a new chat intake.',
  CHAT_SESSION_STALE: 'This chat changed in another request. Refresh the chat before sending again.',
  CHAT_MESSAGE_PENDING: 'Your previous answer is still being processed.',
  CHAT_RATE_LIMITED: 'Please wait before sending another answer.',
  CHAT_EXTRACTION_UNAVAILABLE: 'Your answer could not be processed. It was not added; please retry.',
  CHAT_SESSION_COMPLETE: 'This chat intake has already ended.',
  INVALID_CHAT_MESSAGE: 'Enter one answer of 2,000 characters or fewer.',
})[code] || 'Chat intake is temporarily unavailable. Your previous valid information was preserved.';

export function chatIntakeEndpoint(service, allowedOrigins = []) {
  const origins = createOriginPolicy(allowedOrigins);
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), sessionRoute = url.pathname === '/api/intake/chat/session', messageRoute = url.pathname === '/api/intake/chat/message';
    if (!sessionRoute && !messageRoute) return false;
    try {
      if (!service) throw new ChatIntakeStoreError('CHAT_UNAVAILABLE', 503);
      if (!request.user?.roles?.includes('patient')) throw new ChatIntakeStoreError('CHAT_ACCESS_DENIED', 403);
      const origin = origins.validate(request.headers.origin);
      if (!origin || !browserSignalsAccept(request.headers)) throw new ChatIntakeStoreError('ORIGIN_NOT_ALLOWED', 403);
      if (url.search) throw new ChatIntakeStoreError('INVALID_CHAT_REQUEST', 400);
      if (sessionRoute && request.method === 'POST') {
        const input = await body(request, 1024), keys = Object.keys(input);
        if (keys.some(key => !['resumeSessionId', 'intakeSessionId'].includes(key)) ||
            input.resumeSessionId !== undefined && !sessionPattern.test(input.resumeSessionId) ||
            input.intakeSessionId !== undefined && !sessionPattern.test(input.intakeSessionId) ||
            input.resumeSessionId && input.intakeSessionId) throw new ChatIntakeStoreError('INVALID_CHAT_REQUEST', 400);
        json(response, 201, await service.start({ uid: request.user.uid, origin, resetGeneration: request.resetGeneration,
          resumeSessionId: input.resumeSessionId, intakeSessionId: input.intakeSessionId })); return true;
      }
      if (sessionRoute && request.method === 'GET') {
        const sessionId = request.headers['x-smartcareops-chat-session-id'];
        json(response, 200, await service.get({ sessionId, uid: request.user.uid })); return true;
      }
      if (sessionRoute && request.method === 'DELETE') {
        const sessionId = request.headers['x-smartcareops-chat-session-id'];
        json(response, 200, await service.cancel({ sessionId, uid: request.user.uid })); return true;
      }
      if (messageRoute && request.method === 'POST') {
        const input = await body(request), keys = Object.keys(input);
        if (keys.length !== 3 || keys.some(key => !allowedKeys.has(key))) throw new ChatIntakeStoreError('INVALID_CHAT_REQUEST', 400);
        const idempotencyKey = request.headers['idempotency-key'];
        json(response, 200, await service.submit({ ...input, uid: request.user.uid, idempotencyKey })); return true;
      }
      throw new ChatIntakeStoreError('INVALID_CHAT_REQUEST', 400);
    } catch (error) {
      const known = error instanceof ChatIntakeStoreError;
      if (!known) console.warn('[chat-intake]', JSON.stringify({ outcome: 'unavailable', exceptionClass: error?.name || 'Error', exceptionCode: error?.code || null }));
      json(response, known ? error.status : 503, { code: known ? error.code : 'CHAT_UNAVAILABLE', message: safeMessage(known ? error.code : 'CHAT_UNAVAILABLE') });
      return true;
    }
  };
}

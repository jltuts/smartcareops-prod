import { PatternError } from './pattern-service.js';

const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
async function readJson(request) {
  let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 512) throw new PatternError('INVALID_PATTERN_REQUEST'); }
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new PatternError('INVALID_PATTERN_REQUEST');
  try {
    const parsed = body ? JSON.parse(body) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_PATTERN_REQUEST');
    return parsed;
  } catch { throw new PatternError('INVALID_PATTERN_REQUEST'); }
}

export function patternEndpoint(service, origins, { enabled = false } = {}) {
  return async (request, response) => {
    if (!enabled || !service) { json(response, 404, { code: 'NOT_FOUND' }); return; }
    try {
      if (request.method === 'GET' && request.url === '/api/patterns') { json(response, 200, await service.view()); return; }
      if (request.method !== 'POST' || !['/api/patterns/refresh', '/api/patterns/acknowledge'].includes(request.url)) throw new PatternError('INVALID_PATTERN_REQUEST');
      if (!origins.includes(request.headers.origin)) throw new PatternError('ORIGIN_NOT_ALLOWED', 403);
      const body = await readJson(request);
      if (request.url === '/api/patterns/refresh') {
        if (Object.keys(body).length) throw new PatternError('INVALID_PATTERN_REQUEST');
        json(response, 200, await service.refresh()); return;
      }
      if (Object.keys(body).length !== 1 || typeof body.alertId !== 'string') throw new PatternError('INVALID_PATTERN_REQUEST');
      json(response, 200, await service.acknowledge(body.alertId, request.user?.uid));
    } catch (error) {
      const known = error instanceof PatternError;
      json(response, known ? error.status : 503, { code: known ? error.code : 'PATTERN_UNAVAILABLE', message: 'Pattern intelligence is unavailable. Refresh to retry.' });
    }
  };
}

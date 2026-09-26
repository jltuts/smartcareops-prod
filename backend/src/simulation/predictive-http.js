import { PredictiveError } from './predictive-service.js';

const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
export function predictiveEndpoint(service, origins, { enabled = false } = {}) {
  return async (request, response) => {
    if (!enabled || !service) { json(response, 404, { code: 'NOT_FOUND' }); return; }
    try {
      if (request.method === 'GET' && request.url === '/api/predictive') { json(response, 200, { result: await service.view() }); return; }
      if (request.method !== 'POST' || request.url !== '/api/predictive/generate') throw new PredictiveError('INVALID_PREDICTIVE_REQUEST');
      if (!origins.includes(request.headers.origin)) throw new PredictiveError('ORIGIN_NOT_ALLOWED', 403);
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new PredictiveError('INVALID_PREDICTIVE_REQUEST');
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 32) throw new PredictiveError('INVALID_PREDICTIVE_REQUEST'); }
      if (body && body !== '{}') throw new PredictiveError('INVALID_PREDICTIVE_REQUEST');
      json(response, 200, { result: await service.generate() });
    } catch (error) {
      const known = error instanceof PredictiveError;
      json(response, known ? error.status : 503, { code: known ? error.code : 'PREDICTIVE_UNAVAILABLE', message: 'Predictive forecast is unavailable or could not be confirmed. Refresh to retry.' });
    }
  };
}

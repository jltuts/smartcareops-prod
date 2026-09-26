import { CareTwinError } from './caretwin-service.js';
import { CareTwinStoreError } from './caretwin-store.js';

const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
};
const parseBody = async request => {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 2048) throw new CareTwinError('INVALID_CARETWIN_REQUEST'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new CareTwinError('INVALID_JSON'); }
};
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new CareTwinError('INVALID_CARETWIN_REQUEST');
};

export function careTwinEndpoint(service, origins, { enabled = false } = {}) {
  return async (request, response) => {
    if (!enabled || !service) { json(response, 404, { code: 'NOT_FOUND' }); return; }
    try {
      if (request.method === 'GET' && request.url === '/api/caretwin') { json(response, 200, { result: await service.view() }); return; }
      if (request.method !== 'POST') throw new CareTwinError('INVALID_CARETWIN_REQUEST');
      if (!origins.includes(request.headers.origin)) throw new CareTwinError('ORIGIN_NOT_ALLOWED', 403);
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CareTwinError('INVALID_CARETWIN_REQUEST');
      const input = await parseBody(request); let result;
      if (request.url === '/api/caretwin/generate') { exact(input, []); result = await service.generate(); }
      else if (request.url === '/api/caretwin/decision') {
        exact(input, ['generationId', 'decision']); result = await service.decide(input.generationId, input.decision, request.user?.uid);
      } else throw new CareTwinError('INVALID_CARETWIN_REQUEST');
      json(response, 200, { result });
    } catch (error) {
      const known = error instanceof CareTwinError || error instanceof CareTwinStoreError;
      json(response, known ? error.status : 503, { code: known ? error.code : 'CARETWIN_UNAVAILABLE', message: 'CareTwin is unavailable or could not confirm this request. Refresh to retry.' });
    }
  };
}

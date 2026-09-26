import { ClinicalError, exact } from '../clinical/contracts.js';
import { ResourceError } from '../resources/contracts.js';
export function regionalEndpoint(service, origins) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!service) throw new ClinicalError('REGIONAL_DISABLED', 503);
      if (request.method === 'GET' && request.url === '/api/regional') { response.end(JSON.stringify(await service.view())); return; }
      if (request.method !== 'POST') throw new ClinicalError('INVALID_REGIONAL_REQUEST', 400);
      if (!origins.includes(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ClinicalError('ORIGIN_NOT_ALLOWED', 403);
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ClinicalError('INVALID_REGIONAL_REQUEST', 400);
      let body = ''; for await (const chunk of request) { body += chunk.toString(); if (body.length > 12000) throw new ClinicalError('INVALID_REGIONAL_REQUEST', 400); }
      let input; try { input = JSON.parse(body); } catch { throw new ClinicalError('INVALID_JSON', 400); }
      let result;
      if (request.url === '/api/regional/seed') result = await service.seed(input);
      else if (request.url === '/api/regional/capacity') result = await service.changeCapacity(input);
      else if (request.url === '/api/regional/run') { exact(input, ['requestId']); result = await service.requestRun(input.requestId); }
      else if (/^\/api\/regional\/approvals\/[A-Za-z0-9_-]+$/.test(request.url)) { exact(input, ['decision']); result = await service.decide(request.url.split('/')[4], input.decision); }
      else throw new ClinicalError('INVALID_REGIONAL_REQUEST', 400);
      response.end(JSON.stringify(result)); void service.tick().catch(() => {});
    } catch (error) {
      const known = error instanceof ClinicalError || error instanceof ResourceError;
      response.writeHead(known ? error.status : 503); response.end(JSON.stringify({ code: known ? error.code : 'REGIONAL_UNAVAILABLE', message: 'Regional demo unavailable for this request. Refresh current evidence.' }));
    }
  };
}

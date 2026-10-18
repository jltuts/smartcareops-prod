import { ClinicalError, exact } from '../clinical/contracts.js';
import { ResourceError } from '../resources/contracts.js';
import { browserSignalsAccept } from '../origin.js';
export function operationsEndpoint(service, origins, caseStore) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (request.method === 'GET' && request.url === '/api/operations/emergency-responses') {
        if (!caseStore?.getEmergencyResponseSummary) throw new ClinicalError('OPERATIONS_DISABLED', 503);
        response.end(JSON.stringify(await caseStore.getEmergencyResponseSummary())); return;
      }
      if (!service) throw new ClinicalError('OPERATIONS_DISABLED', 503);
      if (request.method === 'GET' && request.url === '/api/operations') { response.end(JSON.stringify(await service.view())); return; }
      if (request.method !== 'POST') throw new ClinicalError('INVALID_OPERATIONS_REQUEST', 400);
      if (!origins.includes(request.headers.origin) || !browserSignalsAccept(request.headers)) throw new ClinicalError('ORIGIN_NOT_ALLOWED', 403);
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ClinicalError('INVALID_OPERATIONS_REQUEST', 400);
      let body = ''; for await (const chunk of request) { body += chunk.toString(); if (body.length > 12000) throw new ClinicalError('INVALID_OPERATIONS_REQUEST', 400); }
      let input; try { input = JSON.parse(body); } catch { throw new ClinicalError('INVALID_JSON', 400); }
      let result, tick = true;
      if (request.url === '/api/operations/members') result = await service.enroll(input);
      else if (request.url === '/api/operations/capacity') {
        result = await service.changeCapacity(input);
        await service.tick();
        tick = false;
      }
      else if (request.url === '/api/operations/run') { exact(input, ['requestId']); result = await service.requestRun(input.requestId); }
      else if (request.url === '/api/operations/reset') { result = await service.resetDemo(input); tick = false; }
      else if (request.url === '/api/operations/demo-verify') { exact(input, ['caseId']); result = { demoBoundary: await service.verifyDemoBoundary(input.caseId) }; }
      else if (/^\/api\/operations\/approvals\/[A-Za-z0-9_-]+$/.test(request.url)) { exact(input, ['decision']); result = await service.decide(request.url.split('/')[4], input.decision); }
      else throw new ClinicalError('INVALID_OPERATIONS_REQUEST', 400);
      response.end(JSON.stringify(result)); if (tick) void service.tick().catch(() => {});
    } catch (error) {
      const known = error instanceof ClinicalError || error instanceof ResourceError;
      response.writeHead(known ? error.status : 503); response.end(JSON.stringify({ code: known ? error.code : 'OPERATIONS_UNAVAILABLE', message: 'Hospital operations demo unavailable for this request. Refresh to review current state.' }));
    }
  };
}

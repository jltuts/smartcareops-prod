import { CaseStoreError, validCaseId } from '../cases/store.js';
import { validUnitId } from './fleet.js';

export function ambulanceEndpoint(store, origins) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      let result;
      const assign = /^\/api\/cases\/([^/?]+)\/ambulance\/([^/?]+)\/assign$/.exec(request.url);
      const advance = /^\/api\/cases\/([^/?]+)\/ambulance\/(dispatch|arrive-pickup|start-transport|arrive-hospital|complete)$/.exec(request.url);
      if (request.method === 'GET' && request.url === '/api/ambulances') result = await store.listAmbulances();
      else if (request.method === 'POST' && (assign || advance)) {
        const caseId = (assign || advance)[1];
        if (!validCaseId(caseId)) throw new CaseStoreError('INVALID_CASE_ID', 400);
        if (assign && !validUnitId(assign[2])) throw new CaseStoreError('INVALID_AMBULANCE_UNIT', 400);
        if (typeof request.headers.origin !== 'string' || !origins.includes(request.headers.origin)) throw new CaseStoreError('ORIGIN_NOT_ALLOWED', 403);
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CaseStoreError('INVALID_AMBULANCE_REQUEST', 400);
        let body = '';
        for await (const chunk of request) { body += chunk.toString(); if (body.length > 1024) throw new CaseStoreError('INVALID_AMBULANCE_REQUEST', 400); }
        let value;
        try { value = JSON.parse(body); } catch { throw new CaseStoreError('INVALID_AMBULANCE_REQUEST', 400); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new CaseStoreError('INVALID_AMBULANCE_REQUEST', 400);
        result = assign ? await store.assignAmbulance(caseId, assign[2]) : await store.advanceAmbulance(caseId, advance[2]);
      } else throw new CaseStoreError('INVALID_AMBULANCE_REQUEST', 400);
      response.writeHead(200); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof CaseStoreError ? error.status : 503);
      response.end(JSON.stringify({ code: error instanceof CaseStoreError ? error.code : 'CASE_STORE_UNAVAILABLE', message: 'Simulated ambulance operation could not be confirmed.' }));
    }
  };
}

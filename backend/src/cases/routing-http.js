import { CaseStoreError, validCaseId } from './store.js';

// The request identifies a stored case only. No client routing decision is accepted.
export function routingEndpoint(store, origins, { resolvePatientIdentity } = {}) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(request.url, 'http://localhost');
      let result;
      if (request.method === 'POST' && /^\/api\/cases\/[^/]+\/route$/.test(request.url)) {
        const id = url.pathname.split('/')[3];
        if (!validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400);
        if (!origins.includes(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new CaseStoreError('ORIGIN_NOT_ALLOWED', 403);
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CaseStoreError('INVALID_ROUTING_REQUEST', 400);
        let body = '';
        for await (const chunk of request) {
          body += chunk.toString();
          if (body.length > 1024) throw new CaseStoreError('INVALID_ROUTING_REQUEST', 400);
        }
        let value;
        try { value = JSON.parse(body); } catch { throw new CaseStoreError('INVALID_ROUTING_REQUEST', 400); }
        if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new CaseStoreError('INVALID_ROUTING_REQUEST', 400);
        result = await store.routeCase(id);
      } else if (request.method === 'GET' && url.pathname === '/api/doctor/cases') {
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => key !== 'after') || keys.length > 1) throw new CaseStoreError('INVALID_QUEUE_QUERY', 400);
        result = await store.listDoctorCases({ after: url.searchParams.get('after') ?? undefined, resolvePatientIdentity });
      } else if (request.method === 'GET' && /^\/api\/doctor\/cases\/[^/?]+$/.test(request.url)) {
        result = await store.getDoctorCase(url.pathname.split('/')[4], { resolvePatientIdentity });
      } else throw new CaseStoreError('INVALID_ROUTING_REQUEST', 400);
      response.writeHead(200); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof CaseStoreError ? error.status : 503);
      response.end(JSON.stringify({ code: error instanceof CaseStoreError ? error.code : 'CASE_STORE_UNAVAILABLE', message: 'Doctor routing is unavailable for this request.' }));
    }
  };
}

import { CaseStoreError, validCaseId } from './store.js';

async function emptyCommand(request, origins) {
  if (typeof request.headers.origin !== 'string' || !origins.includes(request.headers.origin)) throw new CaseStoreError('ORIGIN_NOT_ALLOWED', 403);
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CaseStoreError('INVALID_EMERGENCY_REQUEST', 400);
  let body = '';
  for await (const chunk of request) { body += chunk.toString(); if (body.length > 1024) throw new CaseStoreError('INVALID_EMERGENCY_REQUEST', 400); }
  let value;
  try { value = JSON.parse(body); } catch { throw new CaseStoreError('INVALID_EMERGENCY_REQUEST', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new CaseStoreError('INVALID_EMERGENCY_REQUEST', 400);
}
export function dispatcherEndpoint(store, origins) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      let result;
      const url = new URL(request.url, 'http://localhost');
      const evaluate = /^\/api\/cases\/([^/?]+)\/evaluate-emergency$/.exec(request.url);
      const acknowledge = /^\/api\/dispatcher\/cases\/([^/?]+)\/acknowledge$/.exec(request.url);
      const hospitals = /^\/api\/dispatcher\/cases\/([^/?]+)\/hospitals$/.exec(request.url);
      const selectHospital = /^\/api\/dispatcher\/cases\/([^/?]+)\/hospitals\/([^/?]+)\/select$/.exec(request.url);
      if (request.method === 'POST' && (evaluate || acknowledge)) {
        const id = (evaluate || acknowledge)[1];
        if (!validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400);
        await emptyCommand(request, origins);
        result = evaluate ? await store.evaluateEmergency(id) : await store.acknowledgeEmergency(id);
      } else if (request.method === 'GET' && url.pathname === '/api/dispatcher/cases') {
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => key !== 'after') || keys.length > 1) throw new CaseStoreError('INVALID_QUEUE_QUERY', 400);
        result = await store.listDispatcherCases({ after: url.searchParams.get('after') ?? undefined });
      } else if (request.method === 'GET' && hospitals) {
        if (!validCaseId(hospitals[1])) throw new CaseStoreError('INVALID_CASE_ID', 400);
        result = await store.listEmergencyHospitals(hospitals[1]);
      } else if (request.method === 'POST' && selectHospital) {
        if (!validCaseId(selectHospital[1])) throw new CaseStoreError('INVALID_CASE_ID', 400);
        await emptyCommand(request, origins);
        result = await store.selectEmergencyHospital(selectHospital[1], selectHospital[2]);
      } else if (request.method === 'GET' && /^\/api\/dispatcher\/cases\/[^/?]+$/.test(request.url)) {
        result = await store.getDispatcherCase(url.pathname.split('/')[4]);
      } else throw new CaseStoreError('INVALID_EMERGENCY_REQUEST', 400);
      response.writeHead(200); response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof CaseStoreError ? error.status : 503);
      response.end(JSON.stringify({ code: error instanceof CaseStoreError ? error.code : 'CASE_STORE_UNAVAILABLE', message: 'Emergency workflow could not be confirmed for this request.' }));
    }
  };
}

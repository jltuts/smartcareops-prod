import { browserSignalsAccept } from '../origin.js';
import { validCaseId } from '../cases/store.js';

const safeView = value => ({
  demoBoundary: value?.demoBoundary || null,
  runs: Array.isArray(value?.runs) ? value.runs.map(run => ({ runId: run.runId, planRevisionId: run.planRevisionId, status: run.status, startedAt: run.startedAt })) : [],
  decisionTrace: Array.isArray(value?.decisionTrace) ? value.decisionTrace.map(trace => ({ planRevisionId: trace.planRevisionId,
    triggers: Array.isArray(trace.triggers) ? trace.triggers.map(trigger => ({ eventType: trigger.eventType })) : [], approval: trace.approval?.status ? { status: trace.approval.status } : null })) : [],
});

export function demoConsoleEndpoint(service, origins) {
  return async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); };
    try {
      if (!service) throw new Error('DEMO_CONSOLE_UNAVAILABLE');
      if (request.method === 'GET' && request.url === '/api/demo-console') { send(200, safeView(await service.view())); return true; }
      if (request.method === 'POST' && request.url === '/api/demo-console/verify') {
        if (!origins.includes(request.headers.origin) || !browserSignalsAccept(request.headers) || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') { send(403, { code: 'ORIGIN_NOT_ALLOWED' }); return true; }
        let raw = ''; for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 1024) throw new Error('INVALID_DEMO_CONSOLE_REQUEST'); }
        const body = JSON.parse(raw || '{}');
        if (!body || Object.keys(body).length !== 1 || !validCaseId(body.caseId)) { send(400, { code: 'INVALID_DEMO_CONSOLE_REQUEST' }); return true; }
        send(200, { demoBoundary: await service.verifyDemoBoundary(body.caseId) }); return true;
      }
      send(404, { code: 'DEMO_CONSOLE_ROUTE_NOT_FOUND' }); return true;
    } catch { send(503, { code: 'DEMO_CONSOLE_UNAVAILABLE', message: 'Demo verification is temporarily unavailable. Refresh to try again.' }); return true; }
  };
}

import { ClinicalError, exact, requireThat, token } from './contracts.js';
import { ResourceError } from '../resources/contracts.js';
import { CaseStoreError, validCaseId } from '../cases/store.js';
import { browserSignalsAccept } from '../origin.js';
export function clinicalEndpoint(configured, origins, { authorizeDoctorCase, authEnabled = true } = {}) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(request.url, 'http://localhost'), caseId = url.searchParams.get('caseId');
      requireThat([...url.searchParams.keys()].every(key => key === 'caseId') && url.searchParams.getAll('caseId').length <= 1 && (!caseId || validCaseId(caseId)));
      if (request.user?.roles?.includes('doctor')) requireThat(caseId && await authorizeDoctorCase?.(request.user, caseId), 'CASE_NOT_FOUND', 404);
      const service = typeof configured === 'function' ? await configured(caseId) : configured;
      const path = url.pathname;
      requireThat(service, 'CLINICAL_DISABLED', 503);
      if (request.method === 'GET' && path === '/api/clinical') { response.end(JSON.stringify(await service.view())); void service.tick().catch(() => {}); return; }
      requireThat(request.method === 'POST', 'INVALID_CLINICAL_REQUEST', 400);
      requireThat(origins.includes(request.headers.origin) && browserSignalsAccept(request.headers), 'ORIGIN_NOT_ALLOWED', 403);
      requireThat(request.headers['content-type']?.split(';')[0].trim() === 'application/json');
      let body = ''; for await (const chunk of request) { body += chunk.toString(); requireThat(body.length <= 12000); }
      let input; try { input = JSON.parse(body); } catch { throw new ClinicalError('INVALID_JSON', 400); }
      let result;
      if (path === '/api/clinical/observations') result = await service.append(input);
      else if (path === '/api/clinical/resources/capacity') result = await service.changeCapacity(input);
      else if (path === '/api/clinical/run') { exact(input, ['requestId']); result = await service.requestRun(input.requestId); }
      else if (path === '/api/clinical/lab-run') {
        requireThat(caseId && (!authEnabled || request.user?.roles?.includes('doctor')), 'CASE_NOT_FOUND', 404);
        exact(input, ['requestId', 'reportId', 'expectedRevision']);
        result = await service.requestLabRun(input);
      }
      else if (path === '/api/clinical/case-review') {
        exact(input, ['requestId', 'decision']); requireThat(token(input.requestId));
        result = await service.decideCaseReview(input.requestId, input.decision, request.user ? {
          uid: request.user.uid,
          displayName: request.user.displayName || null,
          specialties: request.user.specialties || [],
        } : 'demo_doctor');
      }
      else if (/^\/api\/clinical\/executions\/[A-Za-z0-9_-]+\/confirm$/.test(path)) {
        exact(input, ['confirmationId', 'approved']); result = await service.confirmHospitalAction(path.split('/')[4], input.confirmationId, input.approved);
      } else if (/^\/api\/clinical\/approvals\/[A-Za-z0-9_-]+$/.test(path)) {
        exact(input, ['decision']); const id = path.split('/')[4]; requireThat(token(id)); result = await service.decide(id, input.decision, request.user?.uid || 'demo_doctor');
      } else throw new ClinicalError('INVALID_CLINICAL_REQUEST', 400);
      response.end(JSON.stringify(result));
      void service.tick().catch(() => {});
    } catch (error) {
      const known = error instanceof ClinicalError || error instanceof ResourceError || error instanceof CaseStoreError;
      response.writeHead(known ? error.status : 503);
      response.end(JSON.stringify({ code: known ? error.code : 'CLINICAL_UNAVAILABLE', message: 'Clinical demo unavailable for this request. Refresh to review current state.' }));
    }
  };
}

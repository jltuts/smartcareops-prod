import { CaseStoreError, validCaseId } from './store.js';

export function caseEndpoint(store) {
  return async (request, response) => {
    const path = request.url;
    if (!path.startsWith('/api/cases')) return false;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const id = path.slice('/api/cases/'.length);
      if (request.method !== 'GET' || !path.startsWith('/api/cases/') || !validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400);
      const patientCase = request.user?.uid ? await store.getPatientCase(id, request.user.uid) : await store.getCase(id);
      if (!patientCase) throw new CaseStoreError('CASE_NOT_FOUND', 404);
      response.writeHead(200); response.end(JSON.stringify(patientCase));
    } catch (error) {
      response.writeHead(error instanceof CaseStoreError ? error.status : 503);
      response.end(JSON.stringify({ code: error instanceof CaseStoreError ? error.code : 'CASE_STORE_UNAVAILABLE', message: 'Patient case could not be retrieved.' }));
    }
    return true;
  };
}

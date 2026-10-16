import { CaseStoreError, validCaseId } from './store.js';

const encodeCursor = value => value ? Buffer.from(JSON.stringify({ v: 1, ...value })).toString('base64url') : null;
const decodeCursor = value => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) || !validCaseId(parsed.caseId)) throw new Error();
    return { createdAt: parsed.createdAt, caseId: parsed.caseId };
  } catch { throw new CaseStoreError('INVALID_CASE_QUERY', 400); }
};

export function caseEndpoint(store) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), path = url.pathname;
    if (!path.startsWith('/api/cases')) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (request.method !== 'GET') throw new CaseStoreError('INVALID_CASE_QUERY', 400);
      const evidenceMatch = path.match(/^\/api\/cases\/([^/]+)\/evidence\/([a-z0-9-]{1,48})$/);
      if (evidenceMatch) {
        if (url.search || !validCaseId(evidenceMatch[1])) throw new CaseStoreError('INVALID_CASE_ID', 400);
        const image = await store.getPatientCaseEvidence(evidenceMatch[1], evidenceMatch[2], request.user?.uid);
        response.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': image.bytes.length, 'Content-Disposition': 'inline; filename="patient-evidence"' }); response.end(image.bytes); return true;
      }
      response.setHeader('Content-Type', 'application/json');
      if (path === '/api/cases') {
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => !['cursor', 'limit'].includes(key)) || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1) throw new CaseStoreError('INVALID_CASE_QUERY', 400);
        const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? 10 : Number(rawLimit);
        const result = await store.listPatientCases({ patientUid: request.user?.uid, after: decodeCursor(url.searchParams.get('cursor')), limit });
        response.writeHead(200); response.end(JSON.stringify({ ...result, nextCursor: encodeCursor(result.nextCursor) }));
      } else {
        const id = path.slice('/api/cases/'.length);
        if (!path.startsWith('/api/cases/') || url.search || !validCaseId(id)) throw new CaseStoreError('INVALID_CASE_ID', 400);
        const patientCase = request.user?.uid ? await store.getPatientCase(id, request.user.uid) : await store.getCase(id);
        if (!patientCase) throw new CaseStoreError('CASE_NOT_FOUND', 404);
        response.writeHead(200); response.end(JSON.stringify(patientCase));
      }
    } catch (error) {
      response.writeHead(error instanceof CaseStoreError ? error.status : 503);
      response.end(JSON.stringify({ code: error instanceof CaseStoreError ? error.code : 'CASE_STORE_UNAVAILABLE', message: 'Patient case could not be retrieved.' }));
    }
    return true;
  };
}

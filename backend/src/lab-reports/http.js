import { validCaseId } from '../cases/store.js';
import { maxLabReportBytes } from './storage.js';

const reportIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const mimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const maxJsonBytes = Math.ceil(maxLabReportBytes * 4 / 3) + 2048;
const maxReviewJsonBytes = 64 * 1024;
class LabHttpError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); };
const detectedMimeType = bytes => bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' :
  bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 ? 'image/jpeg' :
    bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : null;

async function readUpload(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new LabHttpError('INVALID_LAB_REPORT', 400);
  if (Number(request.headers['content-length']) > maxJsonBytes) throw new LabHttpError('LAB_REPORT_TOO_LARGE', 413);
  let raw = '';
  for await (const chunk of request) { raw += chunk.toString(); if (raw.length > maxJsonBytes) throw new LabHttpError('LAB_REPORT_TOO_LARGE', 413); }
  let input;
  try { input = JSON.parse(raw); } catch { throw new LabHttpError('INVALID_LAB_REPORT', 400); }
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'filename,mimeType,reportBase64' ||
    !mimeTypes.has(input.mimeType) || typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 120 ||
    /[\\/\x00-\x1f\x7f]/.test(input.filename) || typeof input.reportBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.reportBase64) || input.reportBase64.length % 4 !== 0) throw new LabHttpError('INVALID_LAB_REPORT', 400);
  const content = Buffer.from(input.reportBase64, 'base64');
  if (!content.length || content.length > maxLabReportBytes) throw new LabHttpError('LAB_REPORT_TOO_LARGE', 413);
  if (detectedMimeType(content) !== input.mimeType) throw new LabHttpError('INVALID_LAB_REPORT', 400);
  const filename = input.filename.trim().replace(/\s+/g, ' ');
  return { filename, mimeType: input.mimeType, content };
}

async function readReview(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json' || Number(request.headers['content-length']) > maxReviewJsonBytes) throw new LabHttpError('INVALID_LAB_REVIEW', 400);
  let raw = '';
  for await (const chunk of request) { raw += chunk.toString(); if (raw.length > maxReviewJsonBytes) throw new LabHttpError('INVALID_LAB_REVIEW', 400); }
  let input;
  try { input = JSON.parse(raw); } catch { throw new LabHttpError('INVALID_LAB_REVIEW', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LabHttpError('INVALID_LAB_REVIEW', 400);
  return input;
}

export function labReportEndpoint({ caseStore, reportStore, analyze, origins = [], authEnabled = false, logger = console } = {}) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const match = /^\/api\/doctor\/cases\/([^/]+)\/lab-reports(?:\/([^/]+)\/(file|extract|verify))?$/.exec(url.pathname);
    if (!match) return false;
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const [, caseId, reportId, action] = match;
      if (!reportStore) throw new LabHttpError('LAB_REPORTS_UNAVAILABLE', 503);
      if (url.search || !validCaseId(caseId) || reportId && !reportIdPattern.test(reportId)) throw new LabHttpError('INVALID_LAB_REPORT_REQUEST', 400);
      if (authEnabled && (!request.user?.roles?.includes('doctor') || !request.user?.specialties?.length)) throw new LabHttpError('LAB_REPORT_NOT_AUTHORIZED', 403);
      const allowed = authEnabled ? await caseStore.isDoctorCaseAllowed(caseId, request.user.specialties) : await caseStore.getDoctorCase(caseId).then(record => record.routing?.status === 'routed', () => false);
      if (!allowed) throw new LabHttpError('LAB_REPORT_NOT_FOUND', 404);
      if (request.method === 'POST' && !reportId) {
        if (!origins.includes(request.headers.origin)) throw new LabHttpError('ORIGIN_NOT_ALLOWED', 403);
        const input = await readUpload(request);
        const report = await reportStore.create({ caseId, uploaderUid: request.user?.uid || 'local-doctor', ...input });
        json(response, 201, { report }); return true;
      }
      if (request.method === 'GET' && !reportId) { json(response, 200, { reports: await reportStore.list(caseId) }); return true; }
      if (request.method === 'POST' && reportId && action === 'extract') {
        if (!origins.includes(request.headers.origin)) throw new LabHttpError('ORIGIN_NOT_ALLOWED', 403);
        if (Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding']) throw new LabHttpError('INVALID_LAB_REPORT_REQUEST', 400);
        const original = await reportStore.read(caseId, reportId);
        if (!original) throw new LabHttpError('LAB_REPORT_NOT_FOUND', 404);
        const claim = await reportStore.beginExtraction(caseId, reportId);
        if (!claim) throw new LabHttpError('LAB_REPORT_NOT_READY', 409);
        try {
          if (typeof analyze !== 'function') throw Object.assign(new Error('LAB_EXTRACTION_UNAVAILABLE'), { category: 'GEMINI_ERROR' });
          const extraction = await analyze({ mimeType: original.report.mimeType, content: original.content });
          const report = await reportStore.completeExtraction(caseId, reportId, claim.attemptId, extraction);
          if (!report) throw new LabHttpError('LAB_REPORT_NOT_READY', 409);
          json(response, 200, { report }); return true;
        } catch (error) {
          if (error instanceof LabHttpError) throw error;
          const category = ['RATE_LIMIT', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'AUTH_ERROR', 'INVALID_RESPONSE', 'GEMINI_ERROR'].includes(error?.category) ? error.category : 'GEMINI_ERROR';
          await reportStore.failExtraction(caseId, reportId, claim.attemptId, category);
          logger.warn('[lab-extraction]', JSON.stringify({ outcome: 'failed', category }));
          throw new LabHttpError('LAB_EXTRACTION_UNAVAILABLE', 503);
        }
      }
      if (request.method === 'POST' && reportId && action === 'verify') {
        if (!origins.includes(request.headers.origin)) throw new LabHttpError('ORIGIN_NOT_ALLOWED', 403);
        const input = await readReview(request);
        if (!await reportStore.read(caseId, reportId)) throw new LabHttpError('LAB_REPORT_NOT_FOUND', 404);
        let report;
        try { report = await reportStore.verify(caseId, reportId, input, request.user?.uid || 'local-doctor'); }
        catch (error) { if (error?.message === 'INVALID_LAB_REVIEW') throw new LabHttpError('INVALID_LAB_REVIEW', 400); throw error; }
        if (!report) throw new LabHttpError('LAB_REVIEW_STALE', 409);
        json(response, 200, { report }); return true;
      }
      if (request.method === 'GET' && reportId && action === 'file') {
        const result = await reportStore.read(caseId, reportId);
        if (!result) throw new LabHttpError('LAB_REPORT_NOT_FOUND', 404);
        response.writeHead(200, { 'Content-Type': result.report.mimeType, 'Content-Length': result.content.length,
          'Content-Disposition': `attachment; filename="lab-report.${result.report.mimeType === 'application/pdf' ? 'pdf' : result.report.mimeType === 'image/png' ? 'png' : 'jpg'}"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(result.content); return true;
      }
      throw new LabHttpError('LAB_REPORT_METHOD_NOT_ALLOWED', 405);
    } catch (error) {
      const known = error instanceof LabHttpError;
      json(response, known ? error.status : 503, { code: known ? error.code : 'LAB_REPORTS_UNAVAILABLE', message: known && error.code === 'LAB_EXTRACTION_UNAVAILABLE'
        ? 'Gemini could not read this report. The original is preserved; retry when available.' : known && error.status === 413
        ? 'The report is too large. Choose a file under 2 MB.' : known && error.status === 400
          ? error.code === 'INVALID_LAB_REVIEW' ? 'Compare the original report and correct the review fields before verifying.' : 'Choose a valid PDF, JPEG, or PNG laboratory report.' : known && error.status === 404
            ? 'The report is unavailable for this case.' : known && error.code === 'LAB_REVIEW_STALE'
              ? 'This report changed or was already verified. Reopen its review before continuing.' : known && error.status === 409
                ? 'This report is already processing or awaiting Doctor review.' : 'The laboratory report could not be saved or opened. Try again.' });
      return true;
    }
  };
}

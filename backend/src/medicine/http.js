import { validateConfirmedMedication, publicMedication } from './contracts.js';
import { randomUUID } from 'node:crypto';

export const MAX_MEDICINE_IMAGE_BYTES = 512 * 1024;
const sessionPattern = /^[a-f0-9]{64}$/;
const idempotencyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const allowedMime = new Set(['image/jpeg', 'image/webp']);

class MedicineHttpError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
};
async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 740_000) throw new MedicineHttpError('MEDICINE_IMAGE_TOO_LARGE', 413);
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new MedicineHttpError('INVALID_MEDICINE_REQUEST', 400); }
}
function imageInput(body) {
  if (!allowedMime.has(body?.mimeType) || typeof body.imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64) || body.imageBase64.length % 4 !== 0) throw new MedicineHttpError('INVALID_MEDICINE_IMAGE', 400);
  const bytes = Buffer.from(body.imageBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_MEDICINE_IMAGE_BYTES) throw new MedicineHttpError('MEDICINE_IMAGE_TOO_LARGE', 413);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (body.mimeType === 'image/jpeg' && !jpeg || body.mimeType === 'image/webp' && !webp) throw new MedicineHttpError('INVALID_MEDICINE_IMAGE', 400);
  return { mimeType: body.mimeType, imageBase64: body.imageBase64, bytes, byteLength: bytes.length };
}

export function medicineEndpoint({ sessionStore, analyze, logger = console }) {
  return async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!path.startsWith('/api/intake/medicine/') && path !== '/api/intake/evidence/share') return false;
    try {
      if (request.method !== 'POST' || !request.user?.roles?.includes('patient')) throw new MedicineHttpError('MEDICINE_NOT_AUTHORIZED', 403);
      const body = await readJson(request), intakeSessionId = body.intakeSessionId;
      if (!sessionPattern.test(intakeSessionId || '') || !await sessionStore.resolveActive({ intakeSessionId, uid: request.user.uid })) throw new MedicineHttpError('ACTIVE_INTAKE_REQUIRED', 409);
      if (path === '/api/intake/evidence/share') {
        const keys = ['intakeSessionId', 'evidenceId', 'kind', 'patientDescription', 'mimeType', 'imageBase64'];
        if (Object.keys(body).some(key => !keys.includes(key)) || typeof body.evidenceId !== 'string' || !idempotencyPattern.test(body.evidenceId) || body.kind !== 'body_area' ||
            typeof body.patientDescription !== 'string' || !body.patientDescription.trim() || body.patientDescription.trim().length > 500) throw new MedicineHttpError('INVALID_PATIENT_EVIDENCE', 400);
        if (!await sessionStore.takeMedicineScan({ intakeSessionId, uid: request.user.uid })) throw new MedicineHttpError('MEDICINE_SCAN_RATE_LIMITED', 429);
        const image = imageInput(body);
        const evidence = await sessionStore.savePatientEvidence?.({ intakeSessionId, uid: request.user.uid, evidence: {
          evidenceId: body.evidenceId, kind: 'body_area', label: 'Pain location', patientDescription: body.patientDescription.trim(),
          mimeType: image.mimeType, imageBase64: image.imageBase64, byteLength: image.byteLength, capturedAt: new Date().toISOString(),
        } });
        if (evidence?.conflict) throw new MedicineHttpError('PATIENT_EVIDENCE_CONFLICT', 409);
        if (!evidence) throw new MedicineHttpError('PATIENT_EVIDENCE_UNAVAILABLE', 503);
        json(response, 201, { evidence }); return true;
      }
      if (path === '/api/intake/medicine/scan') {
        if (!await sessionStore.takeMedicineScan({ intakeSessionId, uid: request.user.uid })) throw new MedicineHttpError('MEDICINE_SCAN_RATE_LIMITED', 429);
        const image = imageInput(body);
        const candidate = await analyze({ mimeType: image.mimeType, imageBase64: image.imageBase64 });
        if (!await sessionStore.saveMedicineScanResult?.({ intakeSessionId, uid: request.user.uid, candidate,
          image: { mimeType: image.mimeType, imageBase64: image.imageBase64, byteLength: image.byteLength } })) throw new MedicineHttpError('ACTIVE_INTAKE_REQUIRED', 409);
        json(response, 200, candidate.status === 'identified' ? { candidate } : { candidate: null, code: 'MEDICINE_LABEL_UNCLEAR' });
        return true;
      }
      if (path === '/api/intake/medicine/confirm') {
        if (!idempotencyPattern.test(body.idempotencyKey || '')) throw new MedicineHttpError('INVALID_IDEMPOTENCY_KEY', 400);
        let medication;
        try { medication = validateConfirmedMedication(body); } catch { throw new MedicineHttpError('INVALID_MEDICATION_ENTRY', 400); }
        const saved = await sessionStore.saveMedication({ intakeSessionId, uid: request.user.uid, idempotencyKey: body.idempotencyKey, medication });
        if (!saved) throw new MedicineHttpError('ACTIVE_INTAKE_REQUIRED', 409);
        if (saved.conflict) throw new MedicineHttpError('MEDICATION_ALREADY_CONFIRMED', 409);
        json(response, 201, { medication: publicMedication(saved), receiptId: `medicine-${body.idempotencyKey}` });
        return true;
      }
      throw new MedicineHttpError('MEDICINE_ROUTE_NOT_FOUND', 404);
    } catch (error) {
      if (error?.message === 'MEDICINE_MODEL_UNAVAILABLE') {
        const category = ['RATE_LIMIT', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'AUTH_ERROR', 'INVALID_RESPONSE', 'GEMINI_ERROR'].includes(error.category) ? error.category : 'GEMINI_ERROR';
        const responseStage = ['provider_request', 'missing_text', 'invalid_json', 'missing_required_fields', 'schema_invalid'].includes(error.responseStage) ? error.responseStage : 'provider_request';
        const providerCode = ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER'].includes(error.providerCode) ? error.providerCode : 'UNKNOWN';
        const trace = String(request.headers['x-cloud-trace-context'] || '').match(/^([a-f0-9]{32})/i)?.[1];
        const requestId = trace || randomUUID();
        const revision = /^[a-z0-9-]{1,63}$/i.test(process.env.K_REVISION || '') ? process.env.K_REVISION : 'local';
        // Do not log request bodies, image bytes, model text, or medication fields.
        logger.warn('[medicine-scan]', JSON.stringify({ outcome: 'temporarily_unavailable', category, code: providerCode === 'UNKNOWN' ? responseStage : providerCode, requestId, revision }));
        json(response, 503, { code: category === 'INVALID_RESPONSE' ? 'MEDICINE_SCAN_RESPONSE_INVALID' : 'MEDICINE_SCAN_TEMPORARILY_UNAVAILABLE', message: 'Medicine label scanning is temporarily unavailable. Your image was not saved; you can retry without recapturing it.' });
        return true;
      }
      const known = error instanceof MedicineHttpError;
      json(response, known ? error.status : 503, { code: known ? error.code : 'MEDICINE_SERVICE_UNAVAILABLE', message: known && error.code === 'MEDICINE_SCAN_RATE_LIMITED'
        ? 'Please wait before trying another image.' : known && error.code === 'MEDICINE_LABEL_UNCLEAR'
          ? 'The medicine name and strength were not both clear. Try a clearer image.' : 'The medicine entry was not saved. Review it and try again.' });
      return true;
    }
  };
}

import { ProfileValidationError } from '../user-profiles.js';

const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const idempotencyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const safeDoctorApplication = record => ({ uid: record.uid, email: record.email || null,
  displayName: record.doctorApplication?.displayName || null, specialty: record.doctorApplication?.specialty || null,
  submittedAt: record.doctorApplication?.submittedAt || null, status: record.doctorApplication?.status || 'pending',
  version: record.doctorApplication?.version || 1 });
const safePatientApplication = record => ({ uid: record.uid, email: record.email || null,
  displayName: record.displayName || null, submittedAt: record.patientApplication?.submittedAt || null,
  status: record.patientApplication?.status || 'pending', version: record.patientApplication?.version || 1 });
const safeApprovedDoctor = record => ({ uid: record.uid, email: record.email || null, displayName: record.displayName,
  specialty: record.specialty, specialties: Array.isArray(record.specialties) ? record.specialties : [record.specialty].filter(Boolean), status: record.status, approvedAt: record.approvedAt });

async function readJson(request, maximum = 2048) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ProfileValidationError('INVALID_ADMIN_REQUEST');
  let raw = '';
  for await (const chunk of request) { raw += chunk.toString(); if (raw.length > maximum) throw new ProfileValidationError('INVALID_ADMIN_REQUEST'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new ProfileValidationError('INVALID_ADMIN_REQUEST'); }
}
const validObject = (body, allowed) => body && typeof body === 'object' && !Array.isArray(body) && !Object.keys(body).some(key => !allowed.includes(key));
const idempotencyKey = request => {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !idempotencyPattern.test(value)) throw new ProfileValidationError('INVALID_IDEMPOTENCY_KEY');
  return value;
};
const pageOptions = url => {
  if ([...url.searchParams.keys()].some(key => !['limit', 'cursor'].includes(key))) throw new ProfileValidationError('INVALID_ADMIN_QUERY');
  const limitText = url.searchParams.get('limit'), cursor = url.searchParams.get('cursor');
  const limit = limitText === null ? 25 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || cursor !== null && !uidPattern.test(cursor)) throw new ProfileValidationError('INVALID_ADMIN_QUERY');
  return { limit, ...(cursor ? { cursor } : {}) };
};
const decisionReceipt = application => {
  const receipt = application?.reviewReceipt;
  if (!receipt?.receiptId || !['approved', 'rejected'].includes(receipt.decision) || !Number.isSafeInteger(receipt.applicationVersion) || !receipt.reviewedAt) throw new Error('INVALID_DECISION_RECEIPT');
  return { receiptId: receipt.receiptId, decision: receipt.decision, applicationVersion: receipt.applicationVersion, reviewedAt: receipt.reviewedAt };
};

export function adminEndpoint(profileStore, origins, dataStore = null, {
  runPurge = (_context, operation) => operation(), now = Date.now, rateLimit = 60, windowMs = 60_000,
} = {}) {
  const activity = new Map();
  const allowLocally = uid => {
    const current = now(), values = (activity.get(uid) || []).filter(value => current - value < windowMs);
    if (values.length >= rateLimit) return false;
    values.push(current); activity.set(uid, values); return true;
  };
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(request.url, 'http://localhost'), pathname = url.pathname;
    const match = pathname.match(/^\/api\/admin\/(doctor|patient)-applications\/([A-Za-z0-9_-]{1,128})\/decision$/);
    const specialtyRemoval = pathname.match(/^\/api\/admin\/approved-doctors\/([A-Za-z0-9_-]{1,128})\/specialties\/([a-z_]{1,64})$/);
    const writeAllowed = () => typeof request.headers.origin === 'string' && origins.includes(request.headers.origin);
    const send = (status, body, headers = {}) => { for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); response.writeHead(status); response.end(JSON.stringify(body)); };
    try {
      if (!request.user?.roles?.includes('admin')) { send(403, { code: 'ADMIN_REQUIRED' }); return true; }
      const rateAllowed = profileStore.consumeAdminRateLimit
        ? await profileStore.consumeAdminRateLimit(request.user.uid, { limit: rateLimit, windowMs })
        : allowLocally(request.user.uid);
      if (!rateAllowed) { send(429, { code: 'ADMIN_RATE_LIMITED', message: 'Too many Admin requests. Retry shortly.' }, { 'Retry-After': String(Math.ceil(windowMs / 1000)) }); return true; }
      if (request.method === 'GET' && pathname === '/api/admin/doctor-applications') {
        const result = await profileStore.listPendingDoctorApplications(pageOptions(url));
        send(200, { applications: result.records.map(safeDoctorApplication), nextCursor: result.nextCursor }); return true;
      }
      if (request.method === 'GET' && pathname === '/api/admin/approved-doctors') {
        const result = await profileStore.listApprovedDoctors(pageOptions(url));
        send(200, { doctors: result.records.map(safeApprovedDoctor), nextCursor: result.nextCursor }); return true;
      }
      if (request.method === 'DELETE' && specialtyRemoval) {
        if (url.search || !writeAllowed()) { send(403, { code: 'ORIGIN_NOT_ALLOWED' }); return true; }
        const [, uid, specialty] = specialtyRemoval, body = await readJson(request), key = idempotencyKey(request);
        if (!validObject(body, ['expectedSpecialties', 'confirmed']) || !Array.isArray(body.expectedSpecialties) || body.confirmed !== true) throw new ProfileValidationError('INVALID_DOCTOR_SPECIALTY_REMOVAL');
        const result = await profileStore.removeDoctorSpecialty(uid, { specialty, expectedSpecialties: body.expectedSpecialties,
          reviewedBy: request.user.uid, idempotencyKey: key });
        const receipt = result?.receipt;
        if (!receipt?.receiptId || receipt.specialty !== specialty || !Array.isArray(receipt.remainingSpecialties) || !receipt.removedAt) throw new Error('INVALID_SPECIALTY_REMOVAL_RECEIPT');
        send(200, { removedSpecialty: specialty, remainingSpecialties: receipt.remainingSpecialties,
          receipt: { receiptId: receipt.receiptId, specialty: receipt.specialty, removedAt: receipt.removedAt, remainingSpecialties: receipt.remainingSpecialties } }); return true;
      }
      if (request.method === 'GET' && pathname === '/api/admin/patient-applications') {
        const result = await profileStore.listPendingPatientApplications(pageOptions(url));
        send(200, { applications: result.records.map(safePatientApplication), nextCursor: result.nextCursor }); return true;
      }
      if (request.method === 'GET' && pathname === '/api/admin/settings') {
        if (url.search) throw new ProfileValidationError('INVALID_ADMIN_QUERY');
        const policy = profileStore.getPatientAccessPolicy ? await profileStore.getPatientAccessPolicy() : { mode: await profileStore.getPatientAccessMode(), version: 1, updatedAt: null };
        send(200, { patientAccessMode: policy.mode, version: policy.version, updatedAt: policy.updatedAt }); return true;
      }
      if (request.method === 'PUT' && pathname === '/api/admin/settings/patient-access') {
        if (url.search || !writeAllowed()) { send(403, { code: 'ORIGIN_NOT_ALLOWED' }); return true; }
        const body = await readJson(request), key = idempotencyKey(request);
        if (!validObject(body, ['mode', 'expectedVersion', 'confirmed']) || !['open', 'approved_only'].includes(body.mode) || !Number.isSafeInteger(body.expectedVersion) || body.confirmed !== true) throw new ProfileValidationError('INVALID_PATIENT_ACCESS_MODE');
        const setting = await profileStore.setPatientAccessMode(body.mode, { reviewedBy: request.user.uid, expectedVersion: body.expectedVersion, idempotencyKey: key, confirmed: true });
        if (!setting.receipt?.receiptId) throw new Error('INVALID_POLICY_RECEIPT');
        send(200, { patientAccessMode: setting.mode, version: setting.version, updatedAt: setting.updatedAt,
          receipt: { receiptId: setting.receipt.receiptId, mode: setting.receipt.mode, previousVersion: setting.receipt.previousVersion, updatedAt: setting.receipt.updatedAt } }); return true;
      }
      if (request.method === 'GET' && pathname === '/api/admin/purge-preview') {
        if (url.search || !dataStore) throw new ProfileValidationError('PURGE_UNAVAILABLE');
        send(200, await dataStore.preview({ adminUid: request.user.uid })); return true;
      }
      if (request.method === 'POST' && pathname === '/api/admin/purge') {
        if (!dataStore) throw new ProfileValidationError('PURGE_UNAVAILABLE');
        if (url.search || !writeAllowed()) { send(403, { code: 'ORIGIN_NOT_ALLOWED' }); return true; }
        const body = await readJson(request, 2048), key = idempotencyKey(request);
        if (!validObject(body, ['confirmation', 'previewId']) || body.confirmation !== 'PURGE ALL TEST DATA' || typeof body.previewId !== 'string') throw new ProfileValidationError('PURGE_CONFIRMATION_REQUIRED');
        const result = await runPurge({ adminUid: request.user.uid }, () => dataStore.purge({ adminUid: request.user.uid, previewId: body.previewId, idempotencyKey: key }));
        send(200, result); return true;
      }
      if (request.method === 'POST' && match) {
        if (url.search || !writeAllowed()) { send(403, { code: 'ORIGIN_NOT_ALLOWED' }); return true; }
        const [, kind, uid] = match, body = await readJson(request), key = idempotencyKey(request);
        if (!validObject(body, ['decision', 'independentlyVerified', 'applicationVersion', 'confirmed']) || !['approved', 'rejected'].includes(body.decision) || !Number.isSafeInteger(body.applicationVersion) || body.confirmed !== true) throw new ProfileValidationError('INVALID_ADMIN_REVIEW');
        if (kind === 'doctor') {
          if (body.decision === 'approved' && body.independentlyVerified !== true || body.decision === 'rejected' && body.independentlyVerified !== undefined) throw new ProfileValidationError('INVALID_ADMIN_REVIEW');
          const profile = await profileStore.reviewDoctorApplication(uid, { decision: body.decision, independentlyVerified: body.independentlyVerified,
            reviewedBy: request.user.uid, expectedVersion: body.applicationVersion, idempotencyKey: key });
          const application = profile.doctorApplication, receipt = decisionReceipt(application);
          send(200, { application: { uid: profile.uid, status: application.status, displayName: application.displayName,
            specialty: application.specialty, reviewedAt: application.reviewedAt }, receipt }); return true;
        }
        if (body.independentlyVerified !== undefined) throw new ProfileValidationError('INVALID_ADMIN_REVIEW');
        const profile = await profileStore.reviewPatientApplication(uid, { decision: body.decision, reviewedBy: request.user.uid,
          expectedVersion: body.applicationVersion, idempotencyKey: key });
        const application = profile.patientApplication, receipt = decisionReceipt(application);
        send(200, { application: { uid: profile.uid, status: application.status, reviewedAt: application.reviewedAt }, receipt }); return true;
      }
      send(404, { code: 'ADMIN_ROUTE_NOT_FOUND' }); return true;
    } catch (error) {
      const code = error instanceof ProfileValidationError ? error.code : error?.code;
      const conflict = /(_NOT_PENDING|_STALE|_CONFLICT)$/.test(code || '') || code === 'PURGE_PREVIEW_STALE';
      const status = conflict ? 409 : code === 'PURGE_UNAVAILABLE' || code === 'PURGE_PARTIAL_FAILURE' || !(error instanceof ProfileValidationError) ? 503 : 400;
      const body = { code: code || 'ADMIN_REQUEST_UNAVAILABLE', message: code === 'PURGE_PARTIAL_FAILURE'
        ? 'The purge completed only partially. Review the receipt and create a fresh preview before retrying.'
        : conflict ? 'The Admin state changed. Refresh before trying again.' : 'The Admin request could not be completed.' };
      if (error?.receipt) body.receipt = error.receipt;
      if (error?.current) body.current = error.current;
      send(status, body); return true;
    }
  };
}

import { CaseStoreError, validCaseId } from './store.js';
import { browserSignalsAccept } from '../origin.js';

export function appointmentEndpoint(store, origins) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const doctor = /^\/api\/doctor\/cases\/([^/]+)\/appointment$/.exec(url.pathname);
    const patient = /^\/api\/cases\/([^/]+)\/appointment\/response$/.exec(url.pathname);
    const notices = url.pathname === '/api/notifications/appointments';
    if (!doctor && !patient && !notices) return false;
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (notices) {
        const recipientType = url.searchParams.get('recipientType');
        if (request.method !== 'GET' || url.searchParams.size !== 1 || !['patient', 'doctor'].includes(recipientType) ||
            !request.user?.roles?.includes(recipientType)) throw new CaseStoreError('APPOINTMENT_ACCESS_DENIED', 403);
        const notifications = await store.listAppointmentNotifications({ recipientType, recipientUid: request.user.uid });
        response.writeHead(200); response.end(JSON.stringify({ notifications, followups: [], unavailableScopes: [] })); return true;
      }
      if (!origins.includes(request.headers.origin) || !browserSignalsAccept(request.headers)) throw new CaseStoreError('ORIGIN_NOT_ALLOWED', 403);
      if (request.method !== 'POST' || url.search || !validCaseId((doctor || patient)[1]) ||
          request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CaseStoreError('INVALID_APPOINTMENT_REQUEST', 400);
      if (!request.user?.roles?.includes(doctor ? 'doctor' : 'patient')) throw new CaseStoreError('APPOINTMENT_ACCESS_DENIED', 403);
      let raw = '';
      for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 4096) throw new CaseStoreError('INVALID_APPOINTMENT_REQUEST', 400); }
      let input;
      try { input = JSON.parse(raw); } catch { throw new CaseStoreError('INVALID_APPOINTMENT_REQUEST', 400); }
      const result = doctor ? await store.proposeAppointment(doctor[1], input, request.user) :
        await store.respondToAppointment(patient[1], input, request.user.uid);
      response.writeHead(200); response.end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof CaseStoreError;
      response.writeHead(known ? error.status : 503);
      response.end(JSON.stringify({ code: known ? error.code : 'APPOINTMENT_UNAVAILABLE',
        message: known && error.status === 409 ? 'This appointment proposal changed or is no longer available. Refresh the case before retrying.' :
          known && error.status === 400 ? 'Review the appointment slots, timezone, and required fields.' :
          'The appointment could not be saved. Refresh the case to check its current state.' }));
    }
    return true;
  };
}

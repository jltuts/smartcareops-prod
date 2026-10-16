export function caseNoticesEndpoint({ store, caseStore }) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/api/notifications/cases') return false;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const recipientType = url.searchParams.get('recipientType');
    if (request.method !== 'GET' || url.searchParams.size !== 1 || !['patient', 'doctor', 'dispatcher'].includes(recipientType) ||
        !request.user?.roles?.includes(recipientType)) {
      response.writeHead(403); response.end(JSON.stringify({ code: 'CASE_NOTICE_ACCESS_DENIED' })); return true;
    }
    try {
      const notifications = await store.list({ recipientType, recipientUid: request.user.uid, canAccessCase: async (caseId, notice) => {
        if (recipientType === 'doctor') return request.user.specialties?.includes(notice.specialty) &&
          await caseStore.isDoctorCaseAllowed(caseId, request.user.specialties);
        if (recipientType === 'dispatcher') {
          try { await caseStore.getDispatcherCase(caseId); return true; } catch { return false; }
        }
        try { return (await caseStore.getPatientCase(caseId, request.user.uid))?.caseId === caseId; } catch { return false; }
      } });
      response.writeHead(200); response.end(JSON.stringify({ notifications, followups: [], unavailableScopes: [] }));
    } catch {
      response.writeHead(503); response.end(JSON.stringify({ code: 'CASE_NOTICES_UNAVAILABLE' }));
    }
    return true;
  };
}

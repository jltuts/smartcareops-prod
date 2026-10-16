import { NotificationError, check } from './contracts.js';
import { ClinicalError, exact } from '../clinical/contracts.js';
const hasRole = (roles, role) => roles.includes(role) || role === 'command-center' && roles.includes('command_center');
const allowedRecipients = user => {
  if (!user) return null;
  const roles = user?.roles || [];
  if (hasRole(roles, 'command-center')) return null;
  return [hasRole(roles, 'doctor') ? 'doctor' : null, hasRole(roles, 'dispatcher') ? 'dispatcher' : null].filter(Boolean);
};
export function notificationEndpoint(service, origins) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      check(service, 'NOTIFICATIONS_DISABLED', 503); const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/notifications') {
        check([...url.searchParams.keys()].every(key => key === 'recipientType'));
        const recipientType = url.searchParams.get('recipientType');
        const allowed = allowedRecipients(request.user);
        check(!allowed || recipientType && allowed.includes(recipientType), 'NOTIFICATION_SCOPE_VIOLATION', 403);
        response.end(JSON.stringify(await service.view(recipientType))); return;
      }
      check(request.method === 'POST'); check(origins.includes(request.headers.origin) && request.headers['sec-fetch-site'] !== 'cross-site', 'ORIGIN_NOT_ALLOWED', 403);
      check(request.headers['content-type']?.split(';')[0].trim() === 'application/json');
      check(/^\/api\/notifications\/NOTIF-[0-9a-f]{32}\/decision$/.test(url.pathname));
      let body = ''; for await (const chunk of request) { body += chunk.toString(); check(body.length <= 2000); }
      let input; try { input = JSON.parse(body); } catch { throw new NotificationError('INVALID_JSON'); } exact(input, ['decision']);
      response.end(JSON.stringify(await service.decide(url.pathname.split('/')[3], input.decision, allowedRecipients(request.user))));
    } catch (error) {
      const known = error instanceof NotificationError || error instanceof ClinicalError;
      response.writeHead(known ? error.status : 503); response.end(JSON.stringify({ code: known ? error.code : 'NOTIFICATIONS_UNAVAILABLE', message: 'Simulated notification unavailable. Refresh the durable result.' }));
    }
  };
}

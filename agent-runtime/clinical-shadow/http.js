import { ManagedShadowError } from './service.js';

const maxBodyBytes = 80 * 1024;
const json = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
};
const safeFailure = error => ({ error: {
  code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'MANAGED_SHADOW_UNAVAILABLE',
  message: 'Managed fictional shadow evaluation unavailable.',
} });

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ManagedShadowError('MANAGED_SHADOW_JSON_REQUIRED', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new ManagedShadowError('MANAGED_SHADOW_BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ManagedShadowError('INVALID_MANAGED_SHADOW_REQUEST', 400); }
}

const exactEnvelope = (body, classMethod) => body && typeof body === 'object' && !Array.isArray(body) &&
  Object.keys(body).length === 2 && body.class_method === classMethod && Object.hasOwn(body, 'input');

export function createManagedShadowHttpHandler({ service, applicationService, logger = console } = {}) {
  if (!service || typeof service.query !== 'function') throw new TypeError('MANAGED_SHADOW_SERVICE_REQUIRED');
  if (applicationService !== undefined && typeof applicationService?.query !== 'function') throw new TypeError('MANAGED_APPLICATION_SERVICE_INVALID');
  return async (request, response) => {
    if (request.method === 'GET' && ['/health', '/healthz'].includes(request.url)) return json(response, 200, { status: 'ok', service: 'smartcareops-clinical-shadow-runtime' });
    const stream = request.url === '/api/stream_reasoning_engine';
    if (request.method !== 'POST' || (!stream && request.url !== '/api/reasoning_engine')) return json(response, 404, safeFailure({ code: 'MANAGED_SHADOW_ROUTE_NOT_FOUND' }));
    try {
      const body = await readJson(request);
      const method = stream ? 'stream_query' : body?.class_method;
      if (stream ? !exactEnvelope(body, method) || method !== 'stream_query' :
        !exactEnvelope(body, method) || !['query', 'query_application_shadow'].includes(method))
        throw new ManagedShadowError('INVALID_MANAGED_SHADOW_REQUEST', 400);
      if (method === 'query_application_shadow' && !applicationService) throw new ManagedShadowError('MANAGED_APPLICATION_UNAVAILABLE', 503);
      const result = method === 'query_application_shadow' ? await applicationService.query(body.input) : await service.query(body.input);
      const output = { output: result };
      if (!stream) return json(response, 200, output);
      const payload = `${JSON.stringify(output)}\n`;
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
      response.end(payload);
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      const safe = safeFailure(error);
      logger.error(JSON.stringify({ component: 'm60-managed-shadow', stage: 'request', status, errorCode: safe.error.code }));
      json(response, status, safe);
    }
  };
}

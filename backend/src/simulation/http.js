import { SimulationError } from './service.js';

const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
};
const parseBody = async request => {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 1024) throw new SimulationError('INVALID_SIMULATION_REQUEST'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new SimulationError('INVALID_JSON'); }
};
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new SimulationError('INVALID_SIMULATION_REQUEST');
  if (keys.some(key => !Object.hasOwn(value, key))) throw new SimulationError('INVALID_SIMULATION_REQUEST');
};

export function simulationEndpoint(service, origins, { enabled = false } = {}) {
  return async (request, response) => {
    if (!enabled) { json(response, 404, { code: 'NOT_FOUND' }); return; }
    try {
      if (request.method === 'GET' && request.url === '/api/simulation') { json(response, 200, await service.view()); return; }
      if (request.method !== 'POST') throw new SimulationError('INVALID_SIMULATION_REQUEST');
      // A Firebase Hosting page and the API Gateway have different origins, so
      // browsers correctly mark the allowed hosted request as cross-site. Exact
      // Origin validation remains the security boundary.
      if (!origins.includes(request.headers.origin)) throw new SimulationError('ORIGIN_NOT_ALLOWED', 403);
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new SimulationError('INVALID_SIMULATION_REQUEST');
      const input = await parseBody(request); let result;
      if (request.url === '/api/simulation/advance') { exact(input, ['steps']); result = await service.advance(input.steps); }
      else if (request.url === '/api/simulation/scenario') { exact(input, ['scenario']); result = await service.selectScenario(input.scenario); }
      else if (request.url === '/api/simulation/reset') { exact(input, []); result = await service.reset(); }
      else throw new SimulationError('INVALID_SIMULATION_REQUEST');
      json(response, 200, result);
    } catch (error) {
      const known = error instanceof SimulationError;
      json(response, known ? error.status : 503, { code: known ? error.code : 'SIMULATION_UNAVAILABLE', message: 'Synthetic network simulation is unavailable. Refresh to retry.' });
    }
  };
}

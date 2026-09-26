import { once } from 'node:events';
import { createServer } from 'vite';
import { createApiServer } from '../backend/src/server.js';
import { createMemoryCaseStore } from '../backend/src/cases/store.js';

export default async function setupServers() {
  // Own the servers directly so teardown can await socket/watcher cleanup on
  // Windows too, without relying on Playwright's shell/taskkill process tree.
  const api = createApiServer({ caseStore: createMemoryCaseStore() });
  let vite;
  const teardown = async () => {
    const results = await Promise.allSettled([vite?.close(), api.shutdown()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  };
  try {
    const apiPort = Number(process.env.E2E_API_PORT || 8080);
    api.server.listen(apiPort, '127.0.0.1');
    await once(api.server, 'listening');
    const target = `http://127.0.0.1:${apiPort}`;
    vite = await createServer({ server: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: {
      '/api/auth': { target },
      '/api/profile': { target },
      '/api/notifications': { target },
      '/api/regional': { target },
      '/api/simulation': { target },
      '/api/caretwin': { target },
      '/api/operations': { target },
      '/api/clinical': { target },
      '/api/ambulances': { target },
      '/api/dispatcher': { target },
      '/api/doctor': { target },
      '/api/cases': { target },
      '/api/intake-finalization': { target }, '/hospital-demo': { target },
      '/api/agent': { target, ws: true }, '/api/live': { target, ws: true },
    } } });
    await vite.listen();
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}

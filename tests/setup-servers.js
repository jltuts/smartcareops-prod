import { once } from 'node:events';
import { createServer } from 'vite';
import { createApiServer } from '../backend/src/server.js';
import { createMemoryCaseStore } from '../backend/src/cases/store.js';
import { createMemoryLiveSessionStore } from '../backend/src/live-session.js';
import { createMemoryChatIntakeStore } from '../backend/src/chat-intake/store.js';

export default async function setupServers() {
  // Own the servers directly so teardown can await socket/watcher cleanup on
  // Windows too, without relying on Playwright's shell/taskkill process tree.
  const api = createApiServer({ caseStore: createMemoryCaseStore(), liveSessionStore: createMemoryLiveSessionStore(), chatIntakeStore: createMemoryChatIntakeStore(),
    chatExtractor: async ({ utterances }) => {
      const [{ id, text, question }] = utterances;
      const base = { label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: id, quote: text };
      if (/name would you like/i.test(question)) return { updates: [{ ...base, kind: 'name', value: text }] };
      if (/feeling today/i.test(question)) return { updates: [{ ...base, kind: 'symptom', label: /shoulder/i.test(text) ? 'shoulder pain' : 'unwell', status: 'confirmed' }] };
      if (/when did/i.test(question)) return { updates: [{ ...base, kind: 'onset', value: text }] };
      return { updates: [] };
    } });
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
    const webPort = Number(process.env.E2E_WEB_PORT || 4173);
    vite = await createServer({ server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: {
      '/api/auth': { target },
      '/api/profile': { target },
      '/api/notifications': { target },
      '/api/regional': { target },
      '/api/simulation': { target },
      '/api/patterns': { target },
      '/api/caretwin': { target },
      '/api/operations': { target },
      '/api/demo-console': { target },
      '/api/clinical': { target },
      '/api/ambulances': { target },
      '/api/dispatcher': { target },
      '/api/doctor': { target },
      '/api/cases': { target },
      '/api/intake': { target },
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

import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from './environment.js';

// One read per process startup, never per health request. No patient documents,
// writes, Gemini requests, credentials or provider error details are logged.
export async function verifyStartupDependencies(env = process.env, makeDb = options => new Firestore(options)) {
  const config = environmentConfig(env);
  if (env.CASE_STORE === 'memory' && !env.K_SERVICE && config.environment === 'development') return;
  if (env.CASE_STORE && env.CASE_STORE !== 'firestore' || !config.projectId || !env.GEMINI_API_KEY?.trim() || env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Startup configuration unavailable');
  }
  const db = makeDb({ projectId: config.projectId, databaseId: config.database });
  let timeout;
  try {
    await Promise.race([
      db.doc('_smartcareops_platform/readiness').get(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Startup check timed out')), 20000); }),
    ]);
  } finally {
    clearTimeout(timeout);
    await db.terminate();
  }
}

export function startupReadiness(check) {
  let ready = false;
  const settled = Promise.resolve().then(check).then(() => { ready = true; }, () => {
    console.error('[startup] Required dependencies unavailable');
  });
  return { isReady: () => ready, settled };
}

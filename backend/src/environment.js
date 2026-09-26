// Server-only, non-secret configuration. Isolation is by project, never by
// renaming the Firestore database. No production project is provisioned here.
export function environmentConfig(env = process.env) {
  const environment = env.APP_ENV || (env.NODE_ENV === 'production' ? 'production' : 'development');
  if (!['development', 'production'].includes(environment)) throw new Error('Invalid APP_ENV configuration.');
  const projectId = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(env.FIREBASE_PROJECT_ID || '') ? env.FIREBASE_PROJECT_ID : null;
  return Object.freeze({ environment, projectId, database: '(default)' });
}
export function environmentMetadata(storage, env = process.env) {
  return { ...environmentConfig(env), storage: ['firestore', 'firestore_emulator', 'memory', 'unavailable'].includes(storage) ? storage : 'unavailable' };
}

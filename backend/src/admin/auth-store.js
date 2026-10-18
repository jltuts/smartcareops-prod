import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createHash } from 'node:crypto';

const normalizedEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isGoogleAccount = user => Array.isArray(user.providerData) && user.providerData.some(provider => provider.providerId === 'google.com');

export function createFirebaseAuthAccountStore(auth, { protectedEmails = [], protectedUids = [], maxAccounts = 10000 } = {}) {
  const emailAllowlist = new Set(protectedEmails.map(normalizedEmail).filter(Boolean));
  const uidAllowlist = new Set(protectedUids.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean));
  const scan = async () => {
    const removable = [], preserved = [], fingerprints = [];
    let pageToken;
    do {
      const page = await auth.listUsers(1000, pageToken);
      for (const user of page.users) {
        if (!isGoogleAccount(user)) continue;
        if (removable.length + preserved.length >= maxAccounts) throw Object.assign(new Error('AUTH_PURGE_LIMIT'), { code: 'AUTH_PURGE_LIMIT' });
        const email = normalizedEmail(user.email);
        const record = { uid: user.uid, email };
        fingerprints.push(`${user.uid}:${email}:google.com`);
        if (uidAllowlist.has(user.uid) || emailAllowlist.has(email)) preserved.push(record);
        else removable.push(record);
      }
      pageToken = page.pageToken;
    } while (pageToken);
    return {
      count: removable.length,
      preservedCount: preserved.length,
      version: createHash('sha256').update(fingerprints.sort().join('\n')).digest('hex'),
      removable,
    };
  };
  return {
    async previewPurge() {
      const result = await scan();
      return { count: result.count, preservedCount: result.preservedCount, version: result.version };
    },
    async purgeAll({ expectedVersion }) {
      const result = await scan();
      if (result.version !== expectedVersion) throw Object.assign(new Error('AUTH_PURGE_STALE'), { code: 'AUTH_PURGE_STALE' });
      let deleted = 0;
      for (let index = 0; index < result.removable.length; index += 1000) {
        const batch = result.removable.slice(index, index + 1000).map(user => user.uid);
        const outcome = await auth.deleteUsers(batch);
        deleted += outcome.successCount;
        if (outcome.failureCount) throw Object.assign(new Error('AUTH_PURGE_PARTIAL'), { code: 'AUTH_PURGE_PARTIAL', deleted });
      }
      return deleted;
    },
  };
}

export function createConfiguredFirebaseAuthAccountStore(env = process.env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('Firebase project is required for account purge');
  const app = getApps().find(candidate => candidate.name === 'smartcareops-purge-auth') || initializeApp({ projectId }, 'smartcareops-purge-auth');
  const protectedEmails = (env.PURGE_PROTECTED_GOOGLE_EMAILS || '').split(',').map(value => value.trim()).filter(Boolean);
  const protectedUids = (env.ADMIN_UIDS || '').split(',').map(value => value.trim()).filter(Boolean);
  return createFirebaseAuthAccountStore(getAuth(app), { protectedEmails, protectedUids });
}

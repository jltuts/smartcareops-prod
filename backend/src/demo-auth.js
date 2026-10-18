import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const usernames = new Set(['patient1', 'patient2', 'patient3', 'doctor1', 'doctor2', 'doctor3', 'dispatcher1', 'dispatcher2', 'commandcenter1', 'commandcenter2', 'admin1']);
const encode = value => Buffer.from(value).toString('base64url');
const decodeJson = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const safeEqual = (left, right) => left.length === right.length && timingSafeEqual(left, right);

export async function passwordHash(password, salt) {
  return Buffer.from(await scrypt(password, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 })).toString('base64url');
}

export function loadDemoAuthConfig(env = process.env) {
  if (env.DEMO_LOCAL_AUTH_ENABLED !== 'true') return null;
  let parsed;
  try { parsed = JSON.parse(env.DEMO_LOCAL_AUTH_CONFIG || ''); } catch { throw new Error('INVALID_DEMO_AUTH_CONFIG'); }
  if (parsed?.version !== 1 || typeof parsed.signingKey !== 'string' || Buffer.from(parsed.signingKey, 'base64url').length < 32 || !Array.isArray(parsed.accounts)) throw new Error('INVALID_DEMO_AUTH_CONFIG');
  const accounts = new Map();
  for (const account of parsed.accounts) {
    if (!usernames.has(account?.username) || !/^demo-local-[a-z0-9]+$/.test(account?.uid || '') || typeof account.displayName !== 'string' || typeof account.passwordSalt !== 'string' || typeof account.passwordHash !== 'string' || !Number.isSafeInteger(account.accountVersion) || account.accountVersion < 1) throw new Error('INVALID_DEMO_AUTH_CONFIG');
    if (accounts.has(account.username)) throw new Error('INVALID_DEMO_AUTH_CONFIG');
    accounts.set(account.username, Object.freeze({ ...account }));
  }
  if (accounts.size !== usernames.size || [...usernames].some(name => !accounts.has(name))) throw new Error('INVALID_DEMO_AUTH_CONFIG');
  return Object.freeze({ version: parsed.version, signingKey: parsed.signingKey, accounts });
}

export function createDemoAuthentication(config, { now = Date.now, ttlSeconds = 8 * 60 * 60 } = {}) {
  if (!config) return null;
  const attempts = new Map();
  const signature = value => createHmac('sha256', Buffer.from(config.signingKey, 'base64url')).update(value).digest();
  const prune = current => { for (const [key, record] of attempts) if (current - record.startedAt > 5 * 60_000) attempts.delete(key); };
  return {
    async login(username, password, source = 'unknown') {
      const current = now(); prune(current);
      const normalized = typeof username === 'string' ? username.trim().toLowerCase() : '';
      const key = createHmac('sha256', Buffer.from(config.signingKey, 'base64url')).update(`${source}\0${normalized}`).digest('hex');
      const record = attempts.get(key) || { startedAt: current, count: 0 };
      if (record.count >= 5) { const error = new Error('DEMO_LOGIN_RATE_LIMITED'); error.code = 'DEMO_LOGIN_RATE_LIMITED'; throw error; }
      const account = config.accounts.get(normalized);
      const supplied = typeof password === 'string' && password.length <= 256 ? password : '';
      const actual = Buffer.from(await passwordHash(supplied, account?.passwordSalt || randomBytes(16).toString('base64url')), 'base64url');
      const expected = Buffer.from(account?.passwordHash || randomBytes(32).toString('base64url'), 'base64url');
      if (!account || !safeEqual(actual, expected) || account.active === false) {
        record.count += 1; attempts.set(key, record);
        const error = new Error('DEMO_LOGIN_INVALID'); error.code = 'DEMO_LOGIN_INVALID'; throw error;
      }
      attempts.delete(key);
      const issuedAt = Math.floor(current / 1000), expiresAt = issuedAt + ttlSeconds;
      const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const payload = encode(JSON.stringify({ iss: 'smartcareops-demo-auth', aud: 'smartcareops-api', sub: account.uid, username: account.username, manifestVersion: config.version, accountVersion: account.accountVersion, iat: issuedAt, exp: expiresAt, jti: randomUUID() }));
      const unsigned = `${header}.${payload}`;
      return { sessionToken: `${unsigned}.${signature(unsigned).toString('base64url')}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
    },
    verify(token) {
      try {
        const [headerText, payloadText, signatureText, extra] = String(token).split('.');
        if (!headerText || !payloadText || !signatureText || extra) throw new Error();
        const header = decodeJson(headerText), payload = decodeJson(payloadText);
        if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error();
        if (!safeEqual(Buffer.from(signatureText, 'base64url'), signature(`${headerText}.${payloadText}`))) throw new Error();
        const account = config.accounts.get(payload.username);
        const current = Math.floor(now() / 1000);
        if (!account || account.active === false || payload.iss !== 'smartcareops-demo-auth' || payload.aud !== 'smartcareops-api' || payload.sub !== account.uid || payload.manifestVersion !== config.version || payload.accountVersion !== account.accountVersion || !Number.isSafeInteger(payload.iat) || payload.iat > current + 60 || !Number.isSafeInteger(payload.exp) || payload.exp <= current || payload.exp > payload.iat + ttlSeconds) throw new Error();
        return account;
      } catch { const error = new Error('AUTH_INVALID'); error.code = 'AUTH_INVALID'; throw error; }
    },
  };
}

import { createHash, randomBytes } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from './environment.js';
import { browserSignalsAccept, createOriginPolicy } from './origin.js';

export const LIVE_SESSION_TTL_MS = 60_000;
export const LIVE_PROTOCOL = 'smartcareops.live.v1';
const tokenPrefix = 'smartcareops.session.';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = token => createHash('sha256').update(token).digest('hex');
const purpose = 'gemini-live';

function validateRecord(record, { origin, path, now }) {
  if (!record || record.consumedAt || record.path !== path || record.origin !== origin || record.purpose !== purpose ||
      record.role !== 'patient' || typeof record.uid !== 'string' || !record.uid ||
      !Number.isFinite(record.expiresAt) || record.expiresAt <= now) return null;
  return Object.freeze({ uid: record.uid, roles: ['patient'] });
}

export function createMemoryLiveSessionStore({ now = () => Date.now(), ttlMs = LIVE_SESSION_TTL_MS } = {}) {
  const records = new Map();
  return {
    async create({ uid, roles, origin, path = '/api/live' }) {
      if (!roles?.includes('patient')) return null;
      const token = randomBytes(32).toString('base64url');
      const createdAt = now(), expiresAt = createdAt + ttlMs;
      records.set(digest(token), { uid, role: 'patient', origin, path, purpose, createdAt, expiresAt, consumedAt: null });
      return { token, expiresAt };
    },
    async consume({ token, origin, path = '/api/live' }) {
      if (!tokenPattern.test(token || '')) return null;
      const key = digest(token), record = records.get(key), consumedAt = now();
      const identity = validateRecord(record, { origin, path, now: consumedAt });
      if (!identity) { if (record?.expiresAt <= consumedAt) records.delete(key); return null; }
      records.set(key, { ...record, consumedAt });
      return identity;
    },
    close() { records.clear(); },
  };
}

export function createFirestoreLiveSessionStore(db, { now = () => Date.now(), ttlMs = LIVE_SESSION_TTL_MS } = {}) {
  const collection = db.collection('liveSessions');
  const cleanupExpired = async cutoff => {
    const expired = await collection.where('expiresAt', '<=', cutoff).limit(20).get();
    if (expired.empty) return;
    const batch = db.batch();
    for (const document of expired.docs) batch.delete(document.ref);
    await batch.commit();
  };
  return {
    async create({ uid, roles, origin, path = '/api/live' }) {
      if (!roles?.includes('patient')) return null;
      const token = randomBytes(32).toString('base64url');
      const createdAt = now(), expiresAt = createdAt + ttlMs;
      await cleanupExpired(createdAt);
      await collection.doc(digest(token)).create({ uid, role: 'patient', origin, path, purpose, createdAt, expiresAt, consumedAt: null });
      return { token, expiresAt };
    },
    async consume({ token, origin, path = '/api/live' }) {
      if (!tokenPattern.test(token || '')) return null;
      const ref = collection.doc(digest(token)), consumedAt = now();
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const record = snapshot.exists ? snapshot.data() : null;
        const identity = validateRecord(record, { origin, path, now: consumedAt });
        if (!identity) { if (record?.expiresAt <= consumedAt) transaction.delete(ref); return null; }
        transaction.update(ref, { consumedAt });
        return identity;
      });
    },
    close: () => db.terminate(),
  };
}

export function createConfiguredLiveSessionStore(env = process.env) {
  if (env.LIVE_SESSION_STORE === 'memory') return createMemoryLiveSessionStore();
  const config = environmentConfig(env);
  if (!config.projectId || env.LIVE_SESSION_STORE && env.LIVE_SESSION_STORE !== 'firestore') return null;
  return createFirestoreLiveSessionStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}

export function liveSessionProtocol(request) {
  const values = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
  if (!values.includes(LIVE_PROTOCOL)) return null;
  const candidate = values.find(value => value.startsWith(tokenPrefix));
  const token = candidate?.slice(tokenPrefix.length);
  return tokenPattern.test(token || '') ? { token, protocol: LIVE_PROTOCOL } : null;
}

export function createLiveSessionLimiter({ now = () => Date.now(), windowMs = 60_000, perUid = 5, perOrigin = 20, outstandingPerUid = 3 } = {}) {
  const uidWindows = new Map(), originWindows = new Map(), outstanding = new Map();
  const take = (map, key, limit, time) => {
    const recent = (map.get(key) || []).filter(value => time - value < windowMs);
    if (recent.length >= limit) { map.set(key, recent); return false; }
    recent.push(time); map.set(key, recent); return true;
  };
  return {
    allow(uid, origin) {
      const time = now();
      const active = (outstanding.get(uid) || []).filter(value => value > time);
      if (active.length >= outstandingPerUid || !take(uidWindows, uid, perUid, time) || !take(originWindows, origin, perOrigin, time)) return false;
      active.push(time + LIVE_SESSION_TTL_MS); outstanding.set(uid, active); return true;
    },
  };
}

export function liveSessionEndpoint(store, { webSocketUrl, allowedOrigins = [], limiter = createLiveSessionLimiter(), log = detail => console.info('[live-bootstrap]', JSON.stringify(detail)) } = {}) {
  const originPolicy = createOriginPolicy(allowedOrigins);
  return async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path !== '/api/live/session' || request.method !== 'POST') return false;
    const origin = originPolicy.validate(request.headers.origin);
    if (!store || !request.user?.roles?.includes('patient') || !origin || !browserSignalsAccept(request.headers) || !/^wss:\/\//.test(webSocketUrl || '')) {
      log({ outcome: 'rejected', reason: !origin ? 'origin' : !browserSignalsAccept(request.headers) ? 'browser_metadata' : 'authorization_or_configuration', origin: origin || null });
      response.writeHead(store ? 403 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: store ? 'LIVE_SESSION_REJECTED' : 'LIVE_UNAVAILABLE' }));
      return true;
    }
    if (!limiter.allow(request.user.uid, origin)) {
      log({ outcome: 'rejected', reason: 'rate_limit', origin });
      response.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '60' });
      response.end(JSON.stringify({ code: 'LIVE_SESSION_REJECTED' })); return true;
    }
    const session = await store.create({ uid: request.user.uid, roles: request.user.roles, origin });
    if (!session) { response.writeHead(403); response.end(); return true; }
    log({ outcome: 'issued', origin, ttlMs: LIVE_SESSION_TTL_MS });
    response.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), webSocketUrl }));
    return true;
  };
}

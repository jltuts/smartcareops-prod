import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createOriginPolicy } from './origin.js';
import { createConfiguredUserProfileStore } from './user-profiles.js';
import { ProfileValidationError } from './user-profiles.js';

const demoRoles = Object.freeze(['patient', 'doctor', 'dispatcher', 'command-center']);
const patientRole = Object.freeze(['patient']);
const requiredRole = path => {
  if (path.startsWith('/api/doctor/') || path.startsWith('/api/clinical/')) return 'doctor';
  if (path.startsWith('/api/dispatcher/') || path === '/api/ambulances' || path.startsWith('/api/ambulances/')) return 'dispatcher';
  if (path.startsWith('/api/operations') || path.startsWith('/api/regional') || path.startsWith('/api/notifications')) return 'command-center';
  if (path === '/api/simulation' || path.startsWith('/api/simulation/')) return 'command-center';
  if (path === '/api/caretwin' || path.startsWith('/api/caretwin/')) return 'command-center';
  if (path === '/api/predictive' || path.startsWith('/api/predictive/')) return 'command-center';
  if (path === '/api/live/session') return 'patient';
  if (path === '/api/intake-finalization') return 'patient';
  if (path.startsWith('/api/cases/')) return 'patient';
  return null;
};
const hasRole = (roles, required) => roles.includes(required) || required === 'command-center' && roles.includes('command_center');
export function configuredTokenVerifier(env = process.env) {
  if (env.FIREBASE_AUTH_EMULATOR_HOST && env.NODE_ENV === 'production') throw new Error('Auth emulator is not permitted in production');
  const app = getApps().find(app => app.name === 'smartcareops-auth') || initializeApp({ projectId: env.FIREBASE_PROJECT_ID }, 'smartcareops-auth');
  return token => getAuth(app).verifyIdToken(token);
}

export function createAuthentication({ env = process.env, verifyToken, allowedOrigins = [], liveAvailable = false, userProfileStore = createConfiguredUserProfileStore(env) } = {}) {
  // Production cannot opt out. Local development retains its existing demo mode.
  const enabled = env.NODE_ENV === 'production' || env.AUTH_MODE === 'firebase';
  const allowedUids = new Set((env.DEV_AUTH_UIDS || '').split(',').map(value => value.trim()).filter(Boolean));
  const patientUids = new Set((env.DEV_PATIENT_UIDS || '').split(',').map(value => value.trim()).filter(Boolean));
  let verifier = verifyToken;
  const originPolicy = createOriginPolicy(allowedOrigins);
  const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(body));
  };
  async function handle(request, response) {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!enabled || !path.startsWith('/api/')) return false;
    const presentedOrigin = request.headers.origin;
    const origin = presentedOrigin ? originPolicy.validate(presentedOrigin) : null;
    if (presentedOrigin && !origin) { json(response, 403, { code: 'ORIGIN_NOT_ALLOWED' }); return true; }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-SmartCareOps-Finalization-Id');
      response.writeHead(204); response.end(); return true;
    }
    // Gateway replaces Authorization with its Cloud Run identity token and forwards
    // the original header. Neither header is trusted until Firebase verification.
    const header = request.headers['x-forwarded-authorization'] || request.headers.authorization;
    const match = typeof header === 'string' && /^Bearer ([^\s,]{1,8192})$/.exec(header);
    if (!match) { json(response, 401, { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' }); return true; }
    let decoded;
    try {
      verifier ||= configuredTokenVerifier(env);
      decoded = await verifier(match[1]);
      if (!decoded?.uid || decoded.firebase?.sign_in_provider !== 'google.com') throw new Error('Unsupported identity');
    } catch {
      json(response, 401, { code: 'AUTH_INVALID', message: 'Please sign in again.' }); return true;
    }
    let profile;
    if (env.APP_ENV === 'development') {
      try { profile = await userProfileStore.provisionPatient(decoded); }
      catch { json(response, 503, { code: 'AUTH_PROFILE_UNAVAILABLE', message: 'Account access is temporarily unavailable.' }); return true; }
      if (!profile || profile.uid !== decoded.uid || profile.status !== 'active') {
        json(response, 403, { code: 'ACCOUNT_INACTIVE', message: 'This account is not active.' }); return true;
      }
    }
    const storedRoles = profile?.roles || [];
    const roles = env.APP_ENV !== 'development' ? [] : [...new Set([
      ...storedRoles,
      ...(allowedUids.has(decoded.uid) ? demoRoles : []),
      ...(patientUids.has(decoded.uid) ? patientRole : []),
    ])];
    const approved = roles.length > 0;
    request.user = Object.freeze({ uid: decoded.uid, email: profile?.email || decoded.email || null, displayName: profile?.displayName || decoded.name || null, roles });
    if (path === '/api/auth/me' && request.method === 'GET') {
      json(response, 200, { user: request.user, demoAccess: approved, liveAvailable: liveAvailable && roles.includes('patient') }); return true;
    }
    if (path === '/api/profile' && request.method === 'GET') {
      const own = await userProfileStore.getOwnProfile(decoded.uid);
      if (!own) { json(response, 404, { code: 'PROFILE_NOT_FOUND' }); return true; }
      json(response, 200, { profile: own }); return true;
    }
    if (path === '/api/profile' && request.method === 'PATCH') {
      try {
        let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 16384) throw new ProfileValidationError(); }
        const own = await userProfileStore.updateOwnProfile(decoded.uid, JSON.parse(raw || '{}'));
        if (!own) { json(response, 404, { code: 'PROFILE_NOT_FOUND' }); return true; }
        json(response, 200, { profile: own }); return true;
      } catch (error) {
        json(response, 400, { code: error instanceof ProfileValidationError ? error.code : 'INVALID_PROFILE', message: 'Review the profile fields and try again.' }); return true;
      }
    }
    // Identity alone does not grant access to existing privileged demo APIs.
    if (!approved) { json(response, 403, { code: 'DEV_ACCESS_REQUIRED', message: 'This account has not been approved for the DEV workspace.' }); return true; }
    const role = requiredRole(path);
    if (role && !hasRole(roles, role)) { json(response, 403, { code: 'ROLE_REQUIRED', message: 'This account does not have access to this portal.' }); return true; }
    if (path.startsWith('/api/auth/')) {
      json(response, 403, { code: 'TRANSPORT_NOT_AVAILABLE' }); return true;
    }
    return false;
  }
  return { enabled, handle, close: () => userProfileStore.close?.() };
}

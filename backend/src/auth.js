import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { browserSignalsAccept, createOriginPolicy } from './origin.js';
import { createConfiguredUserProfileStore } from './user-profiles.js';
import { ProfileValidationError } from './user-profiles.js';
import { liveLanguagesForModel } from '../../shared/live-languages.js';
import { doctorDisplayNameGuidance } from '../../shared/doctor-display-name.js';
import { createDemoAuthentication, loadDemoAuthConfig } from './demo-auth.js';
import { createConfiguredDemoAccessStore } from './demo-access.js';

const demoRoles = Object.freeze(['patient', 'doctor', 'dispatcher', 'command-center']);
const patientRole = Object.freeze(['patient']);
const localPatient = Object.freeze({ uid: 'local-development-patient', email: null, displayName: 'Local Patient', roles: patientRole });
const requiredRole = (path, request) => {
  if (path.startsWith('/api/demo-console')) return 'authenticated-demo';
  if (path.startsWith('/api/admin/')) return 'admin';
  if (path.startsWith('/api/doctor/') || path.startsWith('/api/clinical/')) return 'doctor';
  if (/^\/api\/cases\/[^/]+\/route$/.test(path)) return 'command-center';
  if (/^\/api\/cases\/[^/]+\/ambulance(?:\/|$)/.test(path)) return 'dispatcher';
  if (path.startsWith('/api/dispatcher/') || path === '/api/ambulances' || path.startsWith('/api/ambulances/')) return 'dispatcher';
  if (path.startsWith('/api/operations') || path.startsWith('/api/regional')) return 'command-center';
  if (path === '/api/notifications' && request?.method === 'GET') {
    const recipientType = new URL(request.url, 'http://localhost').searchParams.get('recipientType');
    if (recipientType === 'doctor') return 'doctor';
    if (recipientType === 'dispatcher') return 'dispatcher';
    return 'command-center';
  }
  if (path === '/api/notifications/appointments' && request?.method === 'GET') return ['patient', 'doctor'];
  if (path === '/api/notifications/cases' && request?.method === 'GET') return ['patient', 'doctor', 'dispatcher'];
  if (path.startsWith('/api/notifications/')) return ['doctor', 'dispatcher', 'command-center'];
  if (path === '/api/simulation' || path.startsWith('/api/simulation/')) return 'command-center';
  if (path === '/api/caretwin' || path.startsWith('/api/caretwin/')) return 'command-center';
  if (path === '/api/predictive' || path.startsWith('/api/predictive/')) return 'command-center';
  if (path === '/api/patterns' || path.startsWith('/api/patterns/')) return 'command-center';
  if (path === '/api/live/session') return 'patient';
  if (path === '/api/intake/voice/complete') return 'patient';
  if (path.startsWith('/api/intake/chat/')) return 'patient';
  if (path.startsWith('/api/intake/medicine/')) return 'patient';
  if (path === '/api/intake/evidence/share') return 'patient';
  if (path === '/api/intake-finalization') return 'patient';
  if (path === '/api/cases' || path.startsWith('/api/cases/')) return 'patient';
  return null;
};
const hasRole = (roles, required) => roles.includes(required) || required === 'command-center' && roles.includes('command_center');
const hasRequiredRole = (roles, required) => Array.isArray(required) ? required.some(role => hasRole(roles, role)) : hasRole(roles, required);
export function configuredTokenVerifier(env = process.env) {
  if (env.FIREBASE_AUTH_EMULATOR_HOST && env.NODE_ENV === 'production') throw new Error('Auth emulator is not permitted in production');
  const app = getApps().find(app => app.name === 'smartcareops-auth') || initializeApp({ projectId: env.FIREBASE_PROJECT_ID }, 'smartcareops-auth');
  return token => getAuth(app).verifyIdToken(token);
}

export function createAuthentication({ env = process.env, verifyToken, allowedOrigins = [], liveAvailable = false, userProfileStore = createConfiguredUserProfileStore(env), demoAccessStore = createConfiguredDemoAccessStore(env), demoAuthentication = createDemoAuthentication(loadDemoAuthConfig(env)) } = {}) {
  // Production cannot opt out. Local development retains its existing demo mode.
  const enabled = env.NODE_ENV === 'production' || env.AUTH_MODE === 'firebase';
  const allowedUids = new Set((env.DEV_AUTH_UIDS || '').split(',').map(value => value.trim()).filter(Boolean));
  const patientUids = new Set((env.DEV_PATIENT_UIDS || '').split(',').map(value => value.trim()).filter(Boolean));
  const adminUids = new Set((env.ADMIN_UIDS || '').split(',').map(value => value.trim()).filter(Boolean));
  let verifier = verifyToken;
  const originPolicy = createOriginPolicy(allowedOrigins);
  const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(body));
  };
  async function handle(request, response) {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!path.startsWith('/api/')) return false;
    if (!enabled) {
      const role = requiredRole(path, request);
      if (role === 'patient' || Array.isArray(role) && role.includes('patient')) request.user = localPatient;
      return false;
    }
    const presentedOrigin = request.headers.origin;
    const origin = presentedOrigin ? originPolicy.validate(presentedOrigin) : null;
    if (presentedOrigin && !origin) { json(response, 403, { code: 'ORIGIN_NOT_ALLOWED' }); return true; }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-SmartCareOps-Finalization-Id, X-SmartCareOps-Chat-Session-Id');
      response.writeHead(204); response.end(); return true;
    }
    if (path === '/api/auth/demo-login' && request.method === 'POST') {
      if (!demoAuthentication) { json(response, 404, { code: 'DEMO_LOGIN_UNAVAILABLE' }); return true; }
      try {
        if (!origin || !browserSignalsAccept(request.headers) || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('DEMO_LOGIN_INVALID');
        let raw = ''; for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 1024) throw new Error('DEMO_LOGIN_INVALID'); }
        const body = JSON.parse(raw || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['username', 'password'].includes(key))) throw new Error('DEMO_LOGIN_INVALID');
        const result = await demoAuthentication.login(body.username, body.password, request.socket?.remoteAddress || 'unknown');
        json(response, 200, result); return true;
      } catch (error) {
        const limited = error?.code === 'DEMO_LOGIN_RATE_LIMITED';
        json(response, limited ? 429 : 401, { code: limited ? 'DEMO_LOGIN_RATE_LIMITED' : 'DEMO_LOGIN_INVALID', message: limited ? 'Too many attempts. Wait five minutes and try again.' : 'The username or password is incorrect.' }); return true;
      }
    }
    // Gateway replaces Authorization with its Cloud Run identity token and forwards
    // the original header. Neither header is trusted until Firebase verification.
    const header = request.headers['x-forwarded-authorization'] || request.headers.authorization;
    const match = typeof header === 'string' && /^Bearer ([^\s,]{1,8192})$/.exec(header);
    if (!match) { json(response, 401, { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' }); return true; }
    let decoded, demoAccount;
    try {
      let header; try { header = JSON.parse(Buffer.from(match[1].split('.')[0], 'base64url').toString('utf8')); } catch { header = null; }
      if (header?.alg === 'HS256') {
        if (!demoAuthentication) throw new Error('Unsupported identity');
        demoAccount = demoAuthentication.verify(match[1]);
        decoded = { uid: demoAccount.uid, name: demoAccount.displayName };
      } else {
        verifier ||= configuredTokenVerifier(env);
        decoded = await verifier(match[1]);
        if (!decoded?.uid || decoded.firebase?.sign_in_provider !== 'google.com') throw new Error('Unsupported identity');
      }
    } catch {
      json(response, 401, { code: 'AUTH_INVALID', message: 'Please sign in again.' }); return true;
    }
    let profile;
    let patientAccessMode = 'open';
    if (!demoAccount && env.APP_ENV === 'development') {
      try { profile = await userProfileStore.provisionPatient(decoded); }
      catch { json(response, 503, { code: 'AUTH_PROFILE_UNAVAILABLE', message: 'Account access is temporarily unavailable.' }); return true; }
      if (!profile || profile.uid !== decoded.uid || profile.status !== 'active') {
        json(response, 403, { code: 'ACCOUNT_INACTIVE', message: 'This account is not active.' }); return true;
      }
      try { patientAccessMode = await userProfileStore.getPatientAccessMode?.() || 'open'; }
      catch { json(response, 503, { code: 'AUTH_ACCESS_POLICY_UNAVAILABLE', message: 'Account access is temporarily unavailable.' }); return true; }
    }
    const storedRoles = profile?.roles || [];
    const approvedPatient = profile?.patientApplication?.status === 'approved';
    const patientRoles = env.APP_ENV === 'development'
      ? (patientAccessMode === 'open' || approvedPatient || adminUids.has(decoded.uid) ? ['patient'] : [])
      : [];
    const firebaseRoles = [...new Set([
      ...(adminUids.has(decoded.uid) ? ['admin'] : []),
      ...(env.APP_ENV !== 'development' ? [] : [
        ...storedRoles.filter(role => role !== 'patient' || patientRoles.includes('patient')),
        ...(patientRoles.includes('patient') && !storedRoles.includes('patient') ? ['patient'] : []),
        ...(allowedUids.has(decoded.uid) ? demoRoles.filter(role => role !== 'patient') : []),
        ...(patientUids.has(decoded.uid) && (patientAccessMode === 'open' || approvedPatient || adminUids.has(decoded.uid)) ? patientRole : []),
      ]),
    ])];
    let roles = firebaseRoles, doctorSpecialties = firebaseRoles.includes('doctor') ? (Array.isArray(profile?.specialties) ? profile.specialties : profile?.specialty ? [profile.specialty] : []) : [];
    if (demoAccount) {
      try { const access = await demoAccessStore.resolve(demoAccount); roles = access.roles; doctorSpecialties = access.specialties; }
      catch { json(response, 503, { code: 'AUTH_ACCESS_POLICY_UNAVAILABLE', message: 'Account access is temporarily unavailable.' }); return true; }
    }
    const approved = demoAccount ? true : roles.length > 0;
    const capabilities = !demoAccount && adminUids.has(decoded.uid) ? ['purge_test_data'] : [];
    request.user = Object.freeze({ uid: decoded.uid, email: profile?.email || decoded.email || null,
      displayName: demoAccount?.displayName || (roles.includes('doctor') && profile?.doctorVerification?.status === 'verified' ? profile.doctorVerification.displayName : profile?.displayName || decoded.name || null),
      ...(demoAccount ? { username: demoAccount.username, authProvider: 'demo-local' } : { authProvider: 'firebase-google' }),
      ...(capabilities.length ? { capabilities: Object.freeze(capabilities) } : {}),
      ...(doctorSpecialties.length ? { specialty: doctorSpecialties[0], specialties: Object.freeze(doctorSpecialties), ...(profile?.doctorVerification ? { doctorVerification: profile.doctorVerification } : {}) } : {}), roles });
    request.demoAccess = approved;
    if (path === '/api/auth/me' && request.method === 'GET') {
      const patientLiveAvailable = liveAvailable && roles.includes('patient');
      json(response, 200, { user: request.user, demoAccess: approved, liveAvailable: patientLiveAvailable,
        patientAccessMode,
        ...(patientLiveAvailable ? { liveSupportedLanguages: liveLanguagesForModel(env.GEMINI_LIVE_MODEL || 'gemini-3.8-live') } : {}) }); return true;
    }
    if (path === '/api/patient/application' && request.method === 'POST') {
      try {
        if (!origin || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ProfileValidationError('INVALID_PATIENT_APPLICATION');
        let raw = ''; for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 1024) throw new ProfileValidationError('INVALID_PATIENT_APPLICATION'); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { throw new ProfileValidationError('INVALID_PATIENT_APPLICATION'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true || Object.keys(body).some(key => key !== 'confirm')) throw new ProfileValidationError('INVALID_PATIENT_APPLICATION');
        const application = await userProfileStore.submitPatientApplication(decoded.uid);
        json(response, 200, { application: application.patientApplication || { status: 'approved' } }); return true;
      } catch (error) {
        json(response, error instanceof ProfileValidationError ? 400 : 503, { code: error instanceof ProfileValidationError ? error.code : 'PATIENT_APPLICATION_UNAVAILABLE', message: 'The Patient access application could not be saved.' }); return true;
      }
    }
    if (demoAccount && (path === '/api/profile' || path === '/api/patient/application' || path === '/api/doctor/application')) {
      json(response, 403, { code: 'PROFILE_NOT_AVAILABLE', message: 'Demo accounts are managed by the demo administrator.' }); return true;
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
    if (path === '/api/doctor/application' && request.method === 'POST') {
      try {
        if (!origin || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ProfileValidationError('INVALID_DOCTOR_APPLICATION');
        let raw = ''; for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 8192) throw new ProfileValidationError('INVALID_DOCTOR_APPLICATION'); }
        const application = await userProfileStore.submitDoctorApplication(decoded.uid, JSON.parse(raw || '{}'));
        json(response, 200, { application: application.doctorApplication }); return true;
      } catch (error) {
        const validation = error instanceof ProfileValidationError;
        json(response, validation ? 400 : 503, { code: validation ? error.code : 'DOCTOR_APPLICATION_UNAVAILABLE', message: error?.code === 'INVALID_DOCTOR_DISPLAY_NAME' && validation ? doctorDisplayNameGuidance : validation ? 'Review the Doctor application and try again.' : 'The Doctor profile application is temporarily unavailable. Try again.' }); return true;
      }
    }
    // Identity alone does not grant access to existing privileged demo APIs.
    if (!approved) { json(response, 403, { code: 'DEV_ACCESS_REQUIRED', message: 'This account has not been approved for the DEV workspace.' }); return true; }
    const role = requiredRole(path, request);
    if (role === 'authenticated-demo' ? !request.demoAccess : role && !hasRequiredRole(roles, role)) { json(response, 403, { code: 'ROLE_REQUIRED', message: 'This account does not have access to this portal.' }); return true; }
    if ((path.startsWith('/api/doctor/') || path.startsWith('/api/clinical/')) && hasRole(roles, 'doctor') && !request.user.specialties?.length) {
      json(response, 403, { code: 'DOCTOR_SPECIALTY_UNVERIFIED', message: 'A verified Doctor specialty is required for this clinical workspace.' }); return true;
    }
    if (path.startsWith('/api/auth/')) {
      json(response, 403, { code: 'TRANSPORT_NOT_AVAILABLE' }); return true;
    }
    return false;
  }
  return { enabled, handle, demoAccessStore, close: async () => { await userProfileStore.close?.(); await demoAccessStore.close?.(); } };
}

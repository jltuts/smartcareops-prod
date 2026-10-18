import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { AuthStatus, createAuthController } from './controller.js';

export { AuthStatus } from './controller.js';
export const AuthorizationStatus = Object.freeze({ IDLE: 'IDLE', CHECKING: 'CHECKING', READY: 'READY', ERROR: 'ERROR' });
export const authEnabled = import.meta.env.VITE_AUTH_MODE === 'firebase' || !import.meta.env.DEV;
const sessionKey = 'smartcareops.demo.session';
let controller, demoSessionToken = null, generation = 0;
let state = { status: authEnabled ? AuthStatus.AUTH_LOADING : AuthStatus.SIGNED_OUT, user: null, error: null, identity: null, authorizationStatus: AuthorizationStatus.IDLE };
const listeners = new Set();
function publish() { for (const listener of listeners) listener(); }
export const authState = () => ({ ...state });
export function observeAuth(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); }
const apiBase = () => import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? window.location.origin : 'https://smartcareops-dev-bm0bhvrl.an.gateway.dev');
const apiUrl = path => { if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Invalid API path'); const url = new URL(path, apiBase()); if (url.protocol !== 'https:' && !(import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS required'); return url; };
export async function readIdentityResponse(response) { if (!response.ok) throw new Error('Identity endpoint unavailable'); const identity = await response.json(); if (!identity?.user) throw new Error('Identity endpoint unavailable'); return identity; }
async function authorizeWithToken(token) { return readIdentityResponse(await fetch(apiUrl('/api/auth/me'), { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store' })); }
function setAuthorized(identity, user) { state = { status: AuthStatus.SIGNED_IN, user, error: null, identity, authorizationStatus: AuthorizationStatus.READY }; publish(); }

export async function initializeAuth() {
  if (!authEnabled) return;
  try {
    const stored = sessionStorage.getItem(sessionKey);
    if (stored) { try { const identity = await authorizeWithToken(stored); demoSessionToken = stored; setAuthorized(identity, { uid: identity.user.uid, displayName: identity.user.displayName }); } catch { sessionStorage.removeItem(sessionKey); } }
    const config = import.meta.env.VITE_FIREBASE_API_KEY ? { apiKey: import.meta.env.VITE_FIREBASE_API_KEY, authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID, appId: import.meta.env.VITE_FIREBASE_APP_ID }
      : await fetch('/__/firebase/init.json', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error('Firebase configuration unavailable'); return response.json(); });
    if (config.projectId !== 'gen-lang-client-0710663107' || !config.apiKey || !config.authDomain || !config.appId) throw new Error('Invalid Firebase configuration');
    const auth = getAuth(initializeApp(config));
    controller = createAuthController({ observe: (next, error) => onAuthStateChanged(auth, next, error), signIn: () => signInWithPopup(auth, new GoogleAuthProvider()), signOut: () => signOut(auth) });
    controller.subscribe(async next => {
      if (demoSessionToken) return;
      const current = ++generation;
      state = { ...next, identity: null, authorizationStatus: next.status === AuthStatus.SIGNED_IN ? AuthorizationStatus.CHECKING : AuthorizationStatus.IDLE }; publish();
      if (next.status === AuthStatus.SIGNED_IN) {
        try { const result = await readIdentityResponse(await apiFetch('/api/auth/me')); if (current !== generation) return; state = { ...state, identity: result, authorizationStatus: AuthorizationStatus.READY }; publish(); }
        catch { if (current !== generation) return; state = { ...state, authorizationStatus: AuthorizationStatus.ERROR }; publish(); }
      }
    });
  } catch { if (!demoSessionToken) { state = { status: AuthStatus.SIGNED_OUT, user: null, error: 'Sign-in is not configured for this deployment yet.', identity: null, authorizationStatus: AuthorizationStatus.IDLE }; publish(); } }
}
export const signIn = () => controller?.signIn();
export async function signInDemo(username, password) {
  const response = await fetch(apiUrl('/api/auth/demo-login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), credentials: 'omit' });
  const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.message || 'Demo sign-in failed.');
  const identity = await authorizeWithToken(result.sessionToken); demoSessionToken = result.sessionToken; sessionStorage.setItem(sessionKey, demoSessionToken); setAuthorized(identity, { uid: identity.user.uid, displayName: identity.user.displayName });
  return identity;
}
export async function signOutUser() { if (demoSessionToken) { demoSessionToken = null; sessionStorage.removeItem(sessionKey); generation += 1; state = { status: AuthStatus.SIGNED_OUT, user: null, error: null, identity: null, authorizationStatus: AuthorizationStatus.IDLE }; publish(); return; } return controller?.signOut(); }
export async function apiFetch(path, options = {}) {
  if (!authEnabled) return fetch(path, options);
  const headers = new Headers(options.headers);
  if (demoSessionToken) headers.set('Authorization', `Bearer ${demoSessionToken}`);
  else { if (!controller) throw new Error('Sign in to continue.'); headers.set('Authorization', `Bearer ${await controller.getIdToken()}`); }
  const response = await fetch(apiUrl(path), { ...options, headers, credentials: 'omit' });
  if (demoSessionToken && response.status === 401) { demoSessionToken = null; sessionStorage.removeItem(sessionKey); generation += 1; state = { status: AuthStatus.SIGNED_OUT, user: null, error: 'Your demo session ended. Sign in again.', identity: null, authorizationStatus: AuthorizationStatus.IDLE }; publish(); }
  return response;
}

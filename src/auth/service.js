import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { AuthStatus, createAuthController } from './controller.js';

export { AuthStatus } from './controller.js';

export const AuthorizationStatus = Object.freeze({
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  READY: 'READY',
  ERROR: 'ERROR',
});

export const authEnabled = import.meta.env.VITE_AUTH_MODE === 'firebase' || !import.meta.env.DEV;
let controller;
let generation = 0;
let state = {
  status: authEnabled ? AuthStatus.AUTH_LOADING : AuthStatus.SIGNED_OUT,
  user: null,
  error: null,
  identity: null,
  authorizationStatus: AuthorizationStatus.IDLE,
};
const listeners = new Set();
function publish() { for (const listener of listeners) listener(); }
export const authState = () => ({ ...state });
export function observeAuth(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); }
export async function initializeAuth() {
  if (!authEnabled) return;
  try {
    const config = import.meta.env.VITE_FIREBASE_API_KEY ? {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    } : await fetch('/__/firebase/init.json', { cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error('Firebase configuration unavailable');
      return response.json();
    });
    if (config.projectId !== 'gen-lang-client-0710663107' || !config.apiKey || !config.authDomain || !config.appId) throw new Error('Invalid Firebase configuration');
    const auth = getAuth(initializeApp(config));
    controller = createAuthController({
      observe: (next, error) => onAuthStateChanged(auth, next, error),
      signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
      signOut: () => signOut(auth),
    });
    controller.subscribe(async next => {
      const current = ++generation;
      state = {
        ...next,
        identity: null,
        authorizationStatus: next.status === AuthStatus.SIGNED_IN ? AuthorizationStatus.CHECKING : AuthorizationStatus.IDLE,
      };
      publish();
      if (next.status === AuthStatus.SIGNED_IN) {
        try {
          const response = await apiFetch('/api/auth/me');
          if (!response.ok) throw new Error('Identity endpoint unavailable');
          const result = await response.json();
          if (current !== generation) return;
          state = { ...state, identity: result, authorizationStatus: AuthorizationStatus.READY };
          publish();
        } catch {
          if (current !== generation) return;
          state = { ...state, authorizationStatus: AuthorizationStatus.ERROR };
          publish();
        }
      }
    });
  } catch {
    state = {
      status: AuthStatus.SIGNED_OUT,
      user: null,
      error: 'Google sign-in is not configured for this deployment yet.',
      identity: null,
      authorizationStatus: AuthorizationStatus.IDLE,
    };
    publish();
  }
}
export const signIn = () => controller?.signIn();
export const signOutUser = () => controller?.signOut();
export async function apiFetch(path, options = {}) {
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Invalid API path');
  if (!authEnabled) return fetch(path, options);
  const base = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? window.location.origin : 'https://smartcareops-dev-bm0bhvrl.an.gateway.dev');
  const url = new URL(path, base);
  if (url.protocol !== 'https:' && !(import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS required');
  if (!controller) throw new Error('Sign in to continue.');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${await controller.getIdToken()}`);
  return fetch(url, { ...options, headers, credentials: 'omit' });
}

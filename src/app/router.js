import { renderHome } from '../pages/home/index.js';
import { renderPatient } from '../pages/patient/index.js';
import { renderDoctor, mountDoctor } from '../pages/doctor/index.js';
import { renderDispatcher, mountDispatcher } from '../pages/dispatcher/index.js';
import { renderCommandCenter, mountCommandCenter } from '../pages/command-center/index.js';
import { renderProfile, mountProfile } from '../pages/profile/index.js';
import { portals } from '../config/portals.js';
import { mountPatient } from '../pages/patient/conversation.js';
import { mountNotificationCenter } from '../components/notification-center.js';
import { AuthStatus, AuthorizationStatus, authEnabled, authState, observeAuth, signIn } from '../auth/service.js';

const routes = new Map([
  ['/', renderHome], ['/patient', renderPatient], ['/doctor', renderDoctor],
  ['/dispatcher', renderDispatcher], ['/command-center', renderCommandCenter],
  ['/profile', renderProfile],
]);

export const PortalAccess = Object.freeze({
  AUTH_LOADING: 'AUTH_LOADING',
  SIGNED_OUT: 'SIGNED_OUT',
  AUTHORIZATION_LOADING: 'AUTHORIZATION_LOADING',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  PATIENT_LIMITED: 'PATIENT_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  AUTHORIZED: 'AUTHORIZED',
});

export function resolvePortalAccess(path, auth) {
  if (auth.status === AuthStatus.AUTH_LOADING) return PortalAccess.AUTH_LOADING;
  if (auth.status !== AuthStatus.SIGNED_IN || !auth.user) return PortalAccess.SIGNED_OUT;
  if (auth.authorizationStatus === AuthorizationStatus.CHECKING) return PortalAccess.AUTHORIZATION_LOADING;
  if (auth.authorizationStatus !== AuthorizationStatus.READY || !auth.identity) return PortalAccess.AUTHORIZATION_ERROR;
  if (path === '/profile') return PortalAccess.AUTHORIZED;
  const userRoles = auth.identity.user?.roles || [];
  const requiredRole = path === '/command-center' ? ['command-center', 'command_center'] : [path.slice(1)];
  const authorized = requiredRole.some(role => userRoles.includes(role));
  if (!authorized) return PortalAccess.UNAUTHORIZED;
  if (path === '/patient' && !auth.identity.liveAvailable) return PortalAccess.PATIENT_LIMITED;
  return PortalAccess.AUTHORIZED;
}

function portalIntro(path) {
  return portals.find(portal => portal.path === path) || { title: 'SmartCareOps', subtitle: 'Secure care coordination.' };
}

export function renderAccessBoundary(outlet, path, auth) {
  const access = resolvePortalAccess(path, auth);
  if (access === PortalAccess.AUTHORIZED) return false;
  const { title, subtitle } = portalIntro(path);
  if (access === PortalAccess.AUTH_LOADING) {
    outlet.innerHTML = `<section class="role-page auth-page" aria-labelledby="page-heading"><div class="auth-page-skeleton" role="status" aria-label="Restoring your session"><span></span><span></span><span></span></div><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle">Restoring your secure session…</p></section>`;
  } else if (access === PortalAccess.SIGNED_OUT) {
    outlet.innerHTML = `<section class="role-page auth-page" aria-labelledby="page-heading"><p class="eyebrow">Secure portal access</p><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle">${subtitle}</p><p>Continue with your Google account to access this portal.</p><div class="auth-actions"><button class="google-button google-button-large" type="button" data-auth-sign-in><span class="google-icon" aria-hidden="true">G</span>Continue with Google</button><a class="back-link" href="/" data-link>← Back to home</a></div></section>`;
    outlet.querySelector('[data-auth-sign-in]').addEventListener('click', () => void signIn());
  } else if (access === PortalAccess.AUTHORIZATION_LOADING) {
    outlet.innerHTML = `<section class="role-page auth-page" aria-labelledby="page-heading"><div class="auth-page-skeleton" role="status" aria-label="Checking portal access"><span></span><span></span><span></span></div><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle">Checking your portal access…</p></section>`;
  } else if (access === PortalAccess.PATIENT_LIMITED) {
    outlet.innerHTML = `<section class="role-page patient-page patient-hosted" aria-labelledby="page-heading"><a class="back-link" href="/" data-link>← Back to home</a><p class="eyebrow">Patient intake and status</p><h1 id="page-heading" tabindex="-1">Patient Portal</h1><p class="role-subtitle">You are signed in. Your identity has been verified.</p><div class="access-panel"><h2>Secure voice intake is being prepared</h2><p>Hosted voice intake is unavailable until its secure session connection is complete. No internal execution or clinical controls are available here.</p></div></section>`;
  } else {
    const backendUnavailable = access === PortalAccess.AUTHORIZATION_ERROR;
    outlet.innerHTML = `<section class="role-page auth-page" aria-labelledby="page-heading"><p class="eyebrow">Signed in</p><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle" id="access-identity"></p><div class="access-panel"><h2>${backendUnavailable ? 'Portal access could not be checked' : `You don't currently have access to the ${title}.`}</h2><p>${backendUnavailable ? 'Your Google session is active, but the DEV authorization service is unavailable. Try again shortly.' : 'Your account is authenticated. Access to this workspace is controlled separately by the backend.'}</p></div><a class="back-link auth-back-link" href="/" data-link>← Back to home</a></section>`;
    const label = auth.user.displayName || auth.user.email || 'Google account';
    outlet.querySelector('#access-identity').textContent = `Signed in as ${label}${auth.user.displayName && auth.user.email ? ` · ${auth.user.email}` : ''}`;
  }
  document.title = `${title} | SmartCareOps`;
  return true;
}

export function startRouter(outlet) {
  let cleanup;
  function render(moveFocus = false) {
    cleanup?.();
    cleanup = undefined;
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    const page = routes.get(path);
    if (authEnabled && page && path !== '/') {
      if (renderAccessBoundary(outlet, path, authState())) return;
    }
    outlet.innerHTML = page ? page() : `<section class="role-page"><h1 id="page-heading" tabindex="-1">Page not found</h1><p>This page does not exist.</p><a href="/" data-link>Back to home</a></section>`;
    const title = portals.find(portal => portal.path === path)?.title;
    document.title = page ? (title ? `${title} | SmartCareOps` : 'SmartCareOps') : 'Page not found | SmartCareOps';
    if (path === '/patient') cleanup = mountPatient(outlet);
    if (path === '/doctor') cleanup = mountDoctor(outlet);
    if (path === '/dispatcher') cleanup = mountDispatcher(outlet);
    if (path === '/command-center') cleanup = mountCommandCenter(outlet);
    if (path === '/profile') cleanup = mountProfile(outlet);
    if (page && path !== '/' && path !== '/patient' && path !== '/profile') {
      const pageCleanup = cleanup, notificationCleanup = mountNotificationCenter(outlet, path);
      cleanup = () => { notificationCleanup(); pageCleanup?.(); };
    }
    if (moveFocus) {
      outlet.querySelector('h1').focus();
      window.scrollTo(0, 0);
    }
  }

  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-link]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    if (url.href !== window.location.href) window.history.pushState({}, '', url);
    render(true);
  });
  window.addEventListener('popstate', () => render(true));
  observeAuth(() => render());
  render();
}

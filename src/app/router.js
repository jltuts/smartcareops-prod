import { renderHome, mountHome, renderHowItWorks, mountHowItWorks, renderPublicNav, mountPublicNav } from '../pages/home/index.js';
import { renderTechnology, mountTechnology } from '../pages/technology.js';
import { renderAbout } from '../pages/about.js';
import { renderManual, mountManual } from '../pages/manual.js';
import { renderPatient } from '../pages/patient/index.js';
import { renderDoctor, mountDoctor } from '../pages/doctor/index.js';
import { renderDispatcher, mountDispatcher } from '../pages/dispatcher/index.js';
import { renderCommandCenter, mountCommandCenter } from '../pages/command-center/index.js';
import { renderProfile, mountProfile } from '../pages/profile/index.js';
import { renderAdmin, mountAdmin } from '../pages/admin/index.js';
import { renderDemoConsole, mountDemoConsole } from '../pages/demo-console/index.js';
import { portals } from '../config/portals.js';
import { mountPatient } from '../pages/patient/conversation.js';
import { mountChatIntake } from '../pages/patient/chat-intake.js';
import { mountIntakeMode } from '../pages/patient/intake-mode.js';
import { mountNotificationCenter } from '../components/notification-center.js';
import { AuthStatus, AuthorizationStatus, apiFetch, authEnabled, authState, observeAuth, signIn } from '../auth/service.js';
import { GOOGLE_SIGN_IN_ICON_URL } from '../auth/ui.js';
import { specialtyCodes, specialtyLabels } from '../../shared/routing.js';
import { doctorDisplayNameGuidance, normalizeDoctorDisplayName } from '../../shared/doctor-display-name.js';

const routes = new Map([
  ['/', renderHome], ['/howitworks', renderHowItWorks], ['/technology', renderTechnology], ['/patient', renderPatient], ['/doctor', renderDoctor],
  ['/dispatcher', renderDispatcher], ['/command-center', renderCommandCenter],
  ['/profile', renderProfile], ['/about', renderAbout], ['/manual', renderManual],
  ['/admin', renderAdmin], ['/demo-console', renderDemoConsole],
]);

const routeShells = { '/': 'home', '/howitworks': 'home', '/technology': 'home', '/manual': 'manual', '/patient': 'patient', '/doctor': 'doctor', '/dispatcher': 'dispatcher', '/command-center': 'command-center', '/demo-console': 'demo-console', '/profile': 'profile', '/about': 'about', '/admin': 'admin' };
function setRouteShell(path) {
  document.documentElement.dataset.pageShell = routeShells[path] || 'home';
}

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
  const requiredRole = ['/command-center', '/demo-console'].includes(path) ? ['command-center', 'command_center'] : [path.slice(1)];
  const authorized = requiredRole.some(role => userRoles.includes(role)) && !(path === '/doctor' && !(auth.identity.user?.specialties || []).length);
  if (!authorized) return PortalAccess.UNAUTHORIZED;
  if (path === '/patient' && !auth.identity.liveAvailable) return PortalAccess.PATIENT_LIMITED;
  return PortalAccess.AUTHORIZED;
}

function portalIntro(path) {
  if (path === '/admin') return { title: 'Admin Portal', subtitle: 'Review pending Doctor access requests.' };
  if (path === '/demo-console') return { title: 'Demo Console', subtitle: 'Verify fictional event boundaries without command-line tools.' };
  return portals.find(portal => portal.path === path) || { title: 'SmartCareOps', subtitle: 'Secure care coordination.' };
}

function adminAccessLoadingMarkup(message, label) {
  return `<section class="role-page admin-page admin-access-shell" aria-labelledby="page-heading">
    <p class="eyebrow">SmartCareOps / Admin workspace</p>
    <h1 id="page-heading" tabindex="-1">Admin controls</h1>
    <p class="role-subtitle">Manage access requests and reset fictional test data.</p>
    <p class="admin-access-status" role="status" aria-live="polite" aria-label="${label}">${message}</p>
    <div class="admin-access-preview" aria-hidden="true"><div class="admin-access-note"></div><div class="admin-access-card"><i></i><i></i><i></i></div></div>
  </section>`;
}

function doctorAccessLoadingMarkup(message, label) {
  return `<section class="role-page doctor-access-shell doctor-access-loading" aria-labelledby="page-heading">
    <div class="doctor-access-nav-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>
    <header class="doctor-access-intro">
      <h1 class="eyebrow doctor-workspace-heading" id="page-heading" tabindex="-1">SmartCareOps / Doctor workspace · Fictional demo</h1>
    </header>
    <p class="doctor-access-status" role="status" aria-live="polite" aria-label="${label}">${message}</p>
    <div class="doctor-access-workspace" aria-hidden="true">
      <section class="doctor-access-inbox-skeleton">
        <div class="doctor-access-heading-skeleton"><span></span><span></span></div>
        <span class="doctor-access-search-skeleton"></span>
        <div class="doctor-access-case-skeleton"><span></span><span></span><span></span></div>
        <div class="doctor-access-case-skeleton"><span></span><span></span><span></span></div>
        <div class="doctor-access-case-skeleton"><span></span><span></span><span></span></div>
      </section>
      <section class="doctor-access-review-skeleton">
        <div class="doctor-access-toolbar-skeleton"><span></span><span></span><span></span><span></span></div>
        <div class="doctor-access-review-body-skeleton"><span></span><span></span><span></span><span></span></div>
      </section>
    </div>
  </section>`;
}

function patientAccessLoadingMarkup(path, message, label) {
  const profile = path === '/profile';
  const title = profile ? 'Your profile' : 'Patient Portal';
  return `<section class="${profile ? 'role-page profile-page profile-access-shell' : 'role-page patient-page patient-access-shell'}" aria-labelledby="page-heading">
    <div class="patient-shell"><aside class="patient-sidebar" aria-hidden="true"><span></span><span></span><span></span><span></span></aside>
      <div class="patient-main ${profile ? 'profile-main' : ''}"><div class="${profile ? 'profile-heading' : 'patient-page-heading'}"><div><p class="eyebrow">${profile ? 'Patient Portal' : 'Connected care'}</p><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle">${profile ? 'Keep your information up to date.' : 'Your care journey, in one place.'}</p></div></div>
        <p class="patient-access-status" role="status" aria-live="polite" aria-label="${label}">${message}</p>
        <div class="patient-access-content" aria-hidden="true"><i></i><i></i><div><i></i><i></i></div></div>
      </div>
    </div>
  </section>`;
}

function dispatcherAccessLoadingMarkup(message, label) {
  return `<section class="dispatcher-access-shell" aria-labelledby="page-heading">
    <header class="dispatcher-access-intro"><p class="eyebrow">SmartCareOps / Dispatch workspace</p><h1 id="page-heading" tabindex="-1">Dispatcher workspace</h1><p class="role-subtitle">Coordinate eligible cases and available response resources.</p></header>
    <p class="dispatcher-access-status" role="status" aria-live="polite" aria-label="${label}">${message}</p>
    <div class="dispatcher-access-metrics" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="dispatcher-access-workspace" aria-hidden="true"><i></i><i></i></div>
  </section>`;
}

function commandCenterAccessLoadingMarkup(message, label) {
  return `<div class="command-center-access-shell">
    <div class="command-center-masthead">
      <section class="role-page ops-header" aria-labelledby="page-heading">
        <div class="ops-header-copy"><p class="eyebrow">SmartCareOps · Network operations</p>
        <h1 id="page-heading" tabindex="-1">Command Center</h1>
        <p class="role-subtitle">See current pressure, investigate emerging signals, and compare options before a human decision.</p></div>
        <p class="ops-workflow-cue"><span>Operator workflow</span>Observe the network <b aria-hidden="true">→</b> Investigate signals <b aria-hidden="true">→</b> Compare plans <b aria-hidden="true">→</b> Review decisions</p>
      </section>
      <div class="command-center-nav command-center-access-nav" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
    </div>
    <p class="command-center-access-status" role="status" aria-live="polite" aria-label="${label}">${message}</p>
    <div class="command-center-access-skeleton" aria-hidden="true">
      <div class="command-center-access-alert-skeleton"></div>
      <div class="command-center-access-network-skeleton"><span></span><span></span><span></span></div>
      <div class="command-center-access-panels-skeleton"><span></span><span></span></div>
    </div>
  </div>`;
}

export function renderAccessBoundary(outlet, path, auth) {
  setRouteShell(path);
  const access = resolvePortalAccess(path, auth);
  if (path === '/dispatcher') outlet.classList.toggle('dispatcher-main', access === PortalAccess.AUTH_LOADING || access === PortalAccess.AUTHORIZATION_LOADING);
  if (path === '/command-center') {
    if (access === PortalAccess.AUTH_LOADING || access === PortalAccess.AUTHORIZATION_LOADING) outlet.classList.add('command-center-main');
    else outlet.classList.remove('command-center-main');
  }
  if (access === PortalAccess.AUTHORIZED) return false;
  const { title, subtitle } = portalIntro(path);
  if (access === PortalAccess.AUTH_LOADING) {
    outlet.innerHTML = path === '/admin'
      ? adminAccessLoadingMarkup('Restoring your secure session…', 'Restoring your session')
      : path === '/doctor'
      ? doctorAccessLoadingMarkup('Restoring your secure session…', 'Restoring your session')
      : path === '/command-center'
        ? commandCenterAccessLoadingMarkup('Restoring your secure session…', 'Restoring your session')
        : path === '/patient' || path === '/profile'
          ? patientAccessLoadingMarkup(path, 'Restoring your secure session…', 'Restoring your session')
          : path === '/dispatcher'
            ? dispatcherAccessLoadingMarkup('Restoring your secure session…', 'Restoring your session')
        : `<section class="role-page auth-page" aria-labelledby="page-heading"><div class="auth-page-skeleton" role="status" aria-label="Restoring your session"><span></span><span></span><span></span></div><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle">Restoring your secure session…</p></section>`;
  } else if (access === PortalAccess.SIGNED_OUT) {
    outlet.innerHTML = `<section class="role-page auth-page" aria-labelledby="page-heading"><p class="eyebrow">Secure portal access</p><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle">${subtitle}</p><p>Continue with your Google account to access this portal.</p><div class="auth-actions"><button class="google-button google-button-large" type="button" data-auth-sign-in><img class="google-icon" src="${GOOGLE_SIGN_IN_ICON_URL}" alt="" aria-hidden="true" referrerpolicy="no-referrer" decoding="async">Continue with Google</button><a class="back-link" href="/" data-link>← Back to home</a></div></section>`;
    outlet.querySelector('[data-auth-sign-in]').addEventListener('click', () => void signIn());
  } else if (access === PortalAccess.AUTHORIZATION_LOADING) {
    outlet.innerHTML = path === '/admin'
      ? adminAccessLoadingMarkup('Checking your portal access…', 'Checking portal access')
      : path === '/doctor'
      ? doctorAccessLoadingMarkup('Checking your portal access…', 'Checking portal access')
      : path === '/command-center'
        ? commandCenterAccessLoadingMarkup('Checking your portal access…', 'Checking portal access')
        : path === '/patient' || path === '/profile'
          ? patientAccessLoadingMarkup(path, 'Checking your portal access…', 'Checking portal access')
          : path === '/dispatcher'
            ? dispatcherAccessLoadingMarkup('Checking your portal access…', 'Checking portal access')
        : `<section class="role-page auth-page" aria-labelledby="page-heading"><div class="auth-page-skeleton" role="status" aria-label="Checking portal access"><span></span><span></span><span></span></div><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle">Checking your portal access…</p></section>`;
  } else if (access === PortalAccess.PATIENT_LIMITED) {
    outlet.innerHTML = `<section class="role-page patient-page patient-hosted" aria-labelledby="page-heading"><a class="back-link" href="/" data-link>← Back to home</a><p class="eyebrow">Patient intake and status</p><h1 id="page-heading" tabindex="-1">Patient Portal</h1><p class="role-subtitle">You are signed in. Your identity has been verified.</p><div class="access-panel"><h2>Secure voice intake is being prepared</h2><p>Hosted voice intake is unavailable until its secure session connection is complete. No internal execution or clinical controls are available here.</p></div></section>`;
  } else if (path === '/doctor' && access === PortalAccess.UNAUTHORIZED) {
    const label = auth.user.displayName || auth.user.email || 'Google account';
    const options = specialtyCodes.map(code => `<option value="${code}">${specialtyLabels[code]}</option>`).join('');
    outlet.innerHTML = `<section class="role-page auth-page doctor-access-shell doctor-access-result" aria-labelledby="page-heading"><p class="eyebrow">Signed in</p><h1 id="page-heading" tabindex="-1">Doctor profile setup</h1><p class="role-subtitle" id="access-identity"></p><div class="access-panel doctor-application-panel"><h2>Request Doctor workspace access</h2><p>Submit your display name and requested specialty. This application does not grant Doctor access or verify professional credentials. An administrator must review and approve it.</p><form id="doctor-application-form" novalidate><label for="doctor-application-name">Display name</label><input id="doctor-application-name" name="displayName" required maxlength="100" autocomplete="name" aria-describedby="doctor-application-name-help"><p class="doctor-application-name-help" id="doctor-application-name-help">${doctorDisplayNameGuidance}</p><label for="doctor-application-specialty">Requested specialty</label><select id="doctor-application-specialty" name="specialty" required>${options}</select><button type="submit">Submit for administrator review</button></form><p id="doctor-application-status" role="status" aria-live="polite">Checking your application…</p></div><a class="back-link auth-back-link" href="/" data-link>← Back to home</a></section>`;
    outlet.querySelector('#access-identity').textContent = `Signed in as ${label}${auth.user.displayName && auth.user.email ? ` · ${auth.user.email}` : ''}`;
    const form = outlet.querySelector('#doctor-application-form'), status = outlet.querySelector('#doctor-application-status'), nameInput = form.elements.displayName;
    nameInput.addEventListener('input', () => nameInput.removeAttribute('aria-invalid'));
    const loadApplication = async () => {
      try {
        const response = await apiFetch('/api/profile', { cache: 'no-store' }); if (!response.ok) throw new Error();
        const { profile } = await response.json(), application = profile.doctorApplication;
        if (application) {
          form.elements.displayName.value = application.displayName || '';
          form.elements.specialty.value = application.specialty;
          status.textContent = application.status === 'approved' ? 'Your application is approved. Doctor access will be available after your session refreshes.' : application.status === 'rejected' ? 'Your application was not approved. Contact the project administrator for next steps.' : 'Application pending administrator verification. You can update the submitted details while it is pending.';
        } else status.textContent = 'Enter your professional display name and requested specialty.';
      } catch { status.textContent = 'Application status is temporarily unavailable. You can retry by refreshing this page.'; }
    };
    const submit = async event => {
      event.preventDefault();
      const displayName = normalizeDoctorDisplayName(nameInput.value);
      if (!displayName) { nameInput.setAttribute('aria-invalid', 'true'); status.textContent = doctorDisplayNameGuidance; nameInput.focus(); return; }
      nameInput.value = displayName;
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]'); button.disabled = true; status.textContent = 'Submitting your application…';
      try {
        const response = await apiFetch('/api/doctor/application', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName, specialty: form.elements.specialty.value }) });
        const result = await response.json();
        if (!response.ok) {
          if (response.status === 400 && result.code === 'INVALID_DOCTOR_DISPLAY_NAME') { nameInput.setAttribute('aria-invalid', 'true'); nameInput.focus(); status.textContent = doctorDisplayNameGuidance; return; }
          status.textContent = response.status === 400 && result.code === 'DOCTOR_ACCESS_ALREADY_GRANTED' ? 'Doctor access is already granted. Refresh your session to open the Doctor workspace.' : response.status === 400 && result.code === 'INVALID_SPECIALTY' ? 'Choose a listed specialty and try again.' : response.status === 400 ? 'Review the Doctor application and try again.' : 'The Doctor profile application is temporarily unavailable. Try again.';
          return;
        }
        status.textContent = 'Application submitted and pending administrator verification. This does not grant Doctor access.';
      } catch { status.textContent = 'The Doctor profile application is temporarily unavailable. Your details remain available to retry.'; }
      finally { button.disabled = false; }
    };
    form.addEventListener('submit', submit); void loadApplication();
    const navHost = document.createElement('div');
    navHost.innerHTML = renderPublicNav('workspace');
    const disposeNav = mountPublicNav(navHost);
    document.title = `${title} | SmartCareOps`;
    return disposeNav;
  } else if (path === '/patient' && access === PortalAccess.UNAUTHORIZED) {
    const label = auth.user.displayName || auth.user.email || 'Google account';
    outlet.innerHTML = `<section class="role-page auth-page patient-access-result" aria-labelledby="page-heading"><p class="eyebrow">Signed in</p><h1 id="page-heading" tabindex="-1">Patient access</h1><p class="role-subtitle" id="access-identity"></p><div class="access-panel patient-application-panel"><h2>Request Patient Portal access</h2><p>Patient access currently requires administrator approval. Submitting a request does not start an intake or use Gemini credits.</p><form id="patient-application-form"><label class="admin-verification"><input type="checkbox" name="confirm" required> I am requesting access to use the Patient Portal.</label><button type="submit">Request access</button></form><p id="patient-application-status" role="status" aria-live="polite">Checking your request…</p></div><a class="back-link auth-back-link" href="/" data-link>← Back to home</a></section>`;
    outlet.querySelector('#access-identity').textContent = `Signed in as ${label}${auth.user.email && auth.user.displayName ? ` · ${auth.user.email}` : ''}`;
    const form = outlet.querySelector('#patient-application-form'), status = outlet.querySelector('#patient-application-status');
    const loadApplication = async () => {
      try {
        const response = await apiFetch('/api/profile', { cache: 'no-store' }); if (!response.ok) throw new Error();
        const { profile } = await response.json(), application = profile.patientApplication;
        if (application?.status === 'approved') status.textContent = 'Your request is approved. Refresh this page to open the Patient Portal.';
        else if (application?.status === 'rejected') status.textContent = 'Your request was not approved. Contact the project administrator for next steps.';
        else if (application?.status === 'pending') status.textContent = 'Your request is waiting for administrator approval.';
        else status.textContent = 'Submit a request for administrator review.';
      } catch { status.textContent = 'Request status is temporarily unavailable. Refresh to try again.'; }
    };
    const submit = async event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const button = form.querySelector('button'); button.disabled = true; status.textContent = 'Submitting access request…';
      try {
        const response = await apiFetch('/api/patient/application', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.message || 'The request could not be saved.');
        status.textContent = result.application.status === 'approved' ? 'Your request is approved. Refresh this page to open the Patient Portal.' : 'Request submitted. Patient Portal access remains blocked until administrator approval.';
      } catch (error) { status.textContent = error.message || 'The request could not be saved. Try again.'; }
      finally { button.disabled = false; }
    };
    form.addEventListener('submit', submit);
  } else {
    const backendUnavailable = access === PortalAccess.AUTHORIZATION_ERROR;
    outlet.innerHTML = `<section class="role-page auth-page${path === '/doctor' ? ' doctor-access-shell doctor-access-result' : ''}" aria-labelledby="page-heading"><p class="eyebrow">Signed in</p><h1 id="page-heading" tabindex="-1">${title}</h1><p class="role-subtitle" id="access-identity"></p><div class="access-panel"><h2>${backendUnavailable ? 'Portal access could not be checked' : `You don't currently have access to the ${title}.`}</h2><p>${backendUnavailable ? 'Your Google session is active, but the DEV authorization service is unavailable. Try again shortly.' : 'Your account is authenticated. Access to this workspace is controlled separately by the backend.'}</p></div><a class="back-link auth-back-link" href="/" data-link>← Back to home</a></section>`;
    const label = auth.user.displayName || auth.user.email || 'Google account';
    outlet.querySelector('#access-identity').textContent = `Signed in as ${label}${auth.user.displayName && auth.user.email ? ` · ${auth.user.email}` : ''}`;
  }
  document.title = `${title} | SmartCareOps`;
  return true;
}

export function startRouter(outlet) {
  let cleanup;
  const scrollToSectionHash = () => {
    const target = window.location.hash ? document.querySelector(window.location.hash) : null;
    if (!target) {
      window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return;
    }
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };
  function render(moveFocus = false) {
    document.documentElement.dataset.appReady = 'true';
    cleanup?.();
    cleanup = undefined;
    outlet.classList.remove('command-center-main', 'dispatcher-main');
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    setRouteShell(path);
    const page = routes.get(path);
    window.dispatchEvent(new Event('smartcareops:navigation'));
    if (authEnabled && page && !['/', '/howitworks', '/technology', '/manual', '/about'].includes(path)) {
      const boundary = renderAccessBoundary(outlet, path, authState());
      if (boundary) { if (typeof boundary === 'function') cleanup = boundary; return; }
    }
    const patientLanguages = path === '/patient' && authEnabled
      ? authState().identity?.liveSupportedLanguages || [{ code: 'en', label: 'English' }]
      : undefined;
    outlet.innerHTML = page ? (path === '/patient' ? page(patientLanguages) : page()) : `<section class="role-page"><h1 id="page-heading" tabindex="-1">Page not found</h1><p>This page does not exist.</p><a href="/" data-link>Back to home</a></section>`;
    const title = portals.find(portal => portal.path === path)?.title;
    document.title = page ? (title ? `${title} | SmartCareOps` : path === '/admin' ? 'Admin Portal | SmartCareOps' : path === '/demo-console' ? 'Demo Console | SmartCareOps' : path === '/about' ? 'About & Demo Notice | SmartCareOps' : path === '/manual' ? 'User Manual | SmartCareOps' : path === '/howitworks' ? 'How SmartCareOps Works | SmartCareOps' : path === '/technology' ? 'Technology | SmartCareOps' : 'SmartCareOps') : 'Page not found | SmartCareOps';
    if (path === '/') cleanup = mountHome(outlet);
    if (path === '/howitworks') cleanup = mountHowItWorks(outlet);
    if (path === '/technology') cleanup = mountTechnology(outlet);
    if (path === '/about') cleanup = mountPublicNav(outlet);
    if (path === '/patient') {
      const disposePatient = mountPatient(outlet), disposeChat = mountChatIntake(outlet), disposeMode = mountIntakeMode(outlet);
      cleanup = () => { disposeMode?.(); disposeChat?.(); disposePatient?.(); };
    }
    if (path === '/doctor') cleanup = mountDoctor(outlet);
    if (path === '/dispatcher') cleanup = mountDispatcher(outlet);
    if (path === '/command-center') cleanup = mountCommandCenter(outlet);
    if (path === '/demo-console') cleanup = mountDemoConsole(outlet);
    if (path === '/profile') cleanup = mountProfile(outlet);
    if (path === '/admin') cleanup = mountAdmin(outlet);
    if (path === '/manual') cleanup = mountManual(outlet);
    if (page && path !== '/' && path !== '/howitworks' && path !== '/technology' && path !== '/patient' && path !== '/profile' && path !== '/manual' && path !== '/admin' && path !== '/demo-console') {
      const pageCleanup = cleanup, notificationCleanup = mountNotificationCenter(outlet, path);
      cleanup = () => { notificationCleanup(); pageCleanup?.(); };
    }
    if (['/patient', '/doctor', '/dispatcher', '/command-center', '/demo-console'].includes(path)) {
      const navHost = document.createElement('div');
      navHost.innerHTML = renderPublicNav('workspace');
      const pageCleanup = cleanup, navCleanup = mountPublicNav(navHost);
      cleanup = () => { navCleanup(); pageCleanup?.(); };
    }
    if (moveFocus) {
      outlet.querySelector('h1').focus();
      window.scrollTo(0, 0);
    }
  }

  document.addEventListener('click', event => {
    const sectionLink = event.target.closest('a[data-section-link]');
    if (sectionLink && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      const url = new URL(sectionLink.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.hash) {
        event.preventDefault();
        if (url.href !== window.location.href) window.history.pushState({}, '', url);
        scrollToSectionHash();
        return;
      }
    }
    const link = event.target.closest('a[data-link]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    if (url.href !== window.location.href) window.history.pushState({}, '', url);
    render(true);
    if (url.hash) scrollToSectionHash();
  });
  window.addEventListener('popstate', () => {
    if (window.location.pathname === '/' && document.querySelector('.landing-page')) {
      scrollToSectionHash();
      return;
    }
    render(true);
    if (window.location.hash) scrollToSectionHash();
  });
  observeAuth(() => render());
  render();
}

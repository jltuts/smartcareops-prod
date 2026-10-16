import { AuthStatus } from './controller.js';

export const GOOGLE_SIGN_IN_ICON_URL = 'https://developers.google.com/static/identity/images/g-logo.png';

function accountLink(href, label, currentPath) {
  const link = document.createElement('a');
  link.href = href;
  link.dataset.link = '';
  link.textContent = label;
  if (href === currentPath) link.setAttribute('aria-current', 'page');
  return link;
}

function accountIdentity(user) {
  const identity = document.createElement('div');
  identity.className = 'account-identity account-menu-identity';
  const copy = document.createElement('span');
  copy.className = 'account-copy';
  const name = document.createElement('strong');
  name.textContent = user.displayName || 'Google account';
  copy.append(name);
  if (user.email) {
    const email = document.createElement('span');
    email.textContent = user.email;
    copy.append(email);
  }
  identity.append(copy);
  return identity;
}

function workspaceLinks(identity) {
  const user = identity?.user;
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const links = [];
  if (roles.includes('patient')) links.push(['/patient', 'Patient']);
  if (roles.includes('doctor') && (user?.specialties || []).length) links.push(['/doctor', 'Doctor']);
  if (roles.includes('dispatcher')) links.push(['/dispatcher', 'Dispatcher']);
  if (roles.includes('command-center') || roles.includes('command_center')) links.push(['/command-center', 'Command Center']);
  if (roles.includes('admin')) links.push(['/admin', 'Admin portal']);
  return links;
}

function googleIcon() {
  const icon = document.createElement('img');
  icon.className = 'google-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.alt = '';
  icon.src = GOOGLE_SIGN_IN_ICON_URL;
  icon.referrerPolicy = 'no-referrer';
  icon.decoding = 'async';
  return icon;
}

export function mountAuthBar(element, { subscribe, getState, signIn, signOut }) {
  const render = () => {
    const { status, user, error, authorizationStatus, identity } = getState();
    const pathname = window.location.pathname;
    element.replaceChildren();
    if (status === AuthStatus.AUTH_LOADING || status === AuthStatus.SIGNED_IN && authorizationStatus === 'CHECKING') {
      const loading = document.createElement('div');
      loading.className = 'auth-loading';
      loading.setAttribute('role', 'status');
      loading.setAttribute('aria-label', status === AuthStatus.AUTH_LOADING ? 'Restoring your session' : 'Checking portal access');
      loading.innerHTML = '<span></span><span></span>';
      element.append(loading);
      return;
    }
    if (status === AuthStatus.SIGNED_IN && user) {
      const ready = authorizationStatus === 'READY' && !!identity?.user;
      const account = ready ? { displayName: identity.user.displayName || user.displayName, email: identity.user.email || user.email } : { displayName: null, email: null };
      const menu = document.createElement('details');
      menu.className = 'command-center-account-menu portal-account-menu';
      const summary = document.createElement('summary');
      summary.setAttribute('aria-label', 'My account');
      const label = document.createElement('span');
      label.className = 'account-menu-label';
      label.textContent = 'My account';
      summary.append(label);
      const panel = document.createElement('div');
      panel.className = 'account-menu-panel';
      panel.setAttribute('aria-label', 'User menu');
      if (ready) panel.append(accountIdentity(account));
      else {
        const unavailable = document.createElement('p');
        unavailable.className = 'account-access-unavailable';
        unavailable.textContent = 'Account access could not be checked. Workspace links are unavailable.';
        panel.append(unavailable);
      }
      panel.append(accountLink('/profile', 'Profile', pathname));
      if (ready) {
        const links = workspaceLinks(identity);
        if (links.length) {
          const heading = document.createElement('p');
          heading.className = 'workspace-switcher-label';
          heading.textContent = 'Switch workspace';
          panel.append(heading);
          const navigation = document.createElement('nav');
          navigation.className = 'workspace-switcher';
          navigation.setAttribute('aria-label', 'Switch workspace');
          for (const [href, text] of links) navigation.append(accountLink(href, text, pathname));
          panel.append(navigation);
        }
        if (['/command-center', '/demo-console'].includes(pathname) && links.some(([href]) => href === '/command-center')) {
          const demo = document.createElement('details');
          demo.className = 'account-demo-controls';
          const demoSummary = document.createElement('summary');
          demoSummary.textContent = 'Demo controls';
          const copy = document.createElement('p');
          copy.textContent = 'Verify the fictional event boundary without command-line tools.';
          const link = accountLink('/demo-console', 'Open Demo Console', pathname);
          demo.append(demoSummary, copy, link);
          panel.append(demo);
        }
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'auth-signout';
      button.textContent = 'Sign out';
      button.addEventListener('click', () => signOut());
      panel.append(button);
      menu.append(summary, panel);
      element.append(menu);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'google-button';
      button.append(googleIcon(), document.createTextNode('Continue with Google'));
      button.addEventListener('click', () => signIn());
      element.append(button);
    }
    if (error) {
      const message = document.createElement('p');
      message.className = 'auth-message';
      message.setAttribute('role', 'status');
      message.textContent = error;
      element.append(message);
    }
  };
  const onKeydown = event => {
    const menu = element.querySelector('.portal-account-menu');
    if (event.key === 'Escape' && menu?.open) {
      event.preventDefault();
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  };
  const onClick = event => {
    const menu = element.querySelector('.portal-account-menu');
    if (menu?.open && !menu.contains(event.target)) menu.open = false;
  };
  render();
  const unsubscribe = subscribe(render);
  window.addEventListener('smartcareops:navigation', render);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onClick);
  return () => {
    unsubscribe();
    window.removeEventListener('smartcareops:navigation', render);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onClick);
  };
}

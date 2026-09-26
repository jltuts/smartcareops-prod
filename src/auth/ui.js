import { AuthStatus } from './controller.js';

function googleIcon() {
  const icon = document.createElement('span');
  icon.className = 'google-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'G';
  return icon;
}

export function mountAuthBar(element, { subscribe, getState, signIn, signOut }) {
  const render = () => {
    const { status, user, error } = getState();
    element.replaceChildren();
    if (status === AuthStatus.AUTH_LOADING) {
      const loading = document.createElement('div');
      loading.className = 'auth-loading';
      loading.setAttribute('role', 'status');
      loading.setAttribute('aria-label', 'Restoring your session');
      loading.innerHTML = '<span></span><span></span>';
      element.append(loading);
      return;
    }
    if (status === AuthStatus.SIGNED_IN && user) {
      const account = document.createElement('div');
      account.className = 'account-identity';
      if (user.photoURL && /^https:\/\//.test(user.photoURL)) {
        const photo = document.createElement('img');
        photo.className = 'account-photo';
        photo.src = user.photoURL;
        photo.alt = '';
        photo.referrerPolicy = 'no-referrer';
        account.append(photo);
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'account-photo account-photo-fallback';
        fallback.textContent = (user.displayName || user.email || 'G').trim().charAt(0).toUpperCase();
        fallback.setAttribute('aria-hidden', 'true');
        account.append(fallback);
      }
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
      account.append(copy);
      element.append(account);
      const profile = document.createElement('a'); profile.href = '/profile'; profile.dataset.link = ''; profile.className = 'auth-profile'; profile.textContent = 'Profile'; element.append(profile);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'auth-signout';
      button.textContent = 'Sign out';
      button.addEventListener('click', () => signOut());
      element.append(button);
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
  render();
  return subscribe(render);
}

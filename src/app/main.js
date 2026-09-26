import '../styles/main.css';
import { startRouter } from './router.js';
import { authEnabled, initializeAuth, observeAuth, authState, signIn, signOutUser } from '../auth/service.js';
import { mountAuthBar } from '../auth/ui.js';

if (authEnabled) {
  const bar = document.createElement('div');
  bar.className = 'auth-bar';
  bar.setAttribute('aria-label', 'Account');
  document.querySelector('.site-header').append(bar);
  mountAuthBar(bar, { subscribe: observeAuth, getState: authState, signIn, signOut: signOutUser });
}

startRouter(document.querySelector('#main'));
void initializeAuth();

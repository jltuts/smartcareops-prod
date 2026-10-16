import '../styles/main.css';
import { startRouter } from './router.js';
import { initializeAuth, observeAuth, authState, signIn, signOutUser } from '../auth/service.js';
import { mountAuthBar } from '../auth/ui.js';
import { mountGlobalNotifications } from '../components/notification-center.js';

const bar = document.createElement('div');
bar.className = 'auth-bar';
bar.setAttribute('aria-label', 'Account');
const header = document.querySelector('.site-header');
header.append(bar);
mountAuthBar(bar, { subscribe: observeAuth, getState: authState, signIn, signOut: signOutUser });
mountGlobalNotifications(header);

startRouter(document.querySelector('#main'));
void initializeAuth();

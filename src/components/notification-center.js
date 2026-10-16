import { apiFetch } from '../auth/service.js';
import { authState, observeAuth } from '../auth/service.js';
import './notification-center.css';

const portalConfig = Object.freeze({
  '/patient': { recipientType: 'patient', label: 'Patient notifications' },
  '/doctor': { recipientType: 'doctor', label: 'Doctor notifications' },
  '/dispatcher': { recipientType: 'dispatcher', label: 'Dispatcher notifications' },
  '/command-center': { recipientType: null, label: 'Operational notifications' },
});
let instanceId = 0;

function element(tag, text, parent, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  parent?.append(node);
  return node;
}

function notificationUrl(path) {
  if (path === '/patient') return '/api/notifications/appointments?recipientType=patient';
  const recipientType = portalConfig[path]?.recipientType;
  return '/api/notifications' + (recipientType ? `?recipientType=${encodeURIComponent(recipientType)}` : '');
}

function followupsFor(path, followups) {
  if (path === '/command-center') return followups;
  if (path === '/doctor') return followups.filter(item => item.scope === 'clinical');
  return [];
}

function mountSurface(host, path, { header = false } = {}) {
  const config = portalConfig[path] || { label: 'Notifications' };
  const available = !!portalConfig[path];
  const root = element(header ? 'div' : 'section', '', host, header ? 'notification-control' : 'notification-center notification-center-supporting');
  const id = `notification-panel-${++instanceId}`;
  let toggle;
  if (header) {
    toggle = element('button', '', root, 'notification-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', id);
    toggle.setAttribute('aria-haspopup', 'dialog');
    const icon = element('span', '♢', toggle, 'notification-toggle-icon');
    icon.setAttribute('aria-hidden', 'true');
    element('span', 'Notifications', toggle, 'notification-toggle-label');
  }
  const panel = element('section', '', root, header ? 'notification-panel' : 'notification-center-body');
  panel.id = id;
  panel.setAttribute('aria-label', config.label);
  if (header) panel.hidden = true;
  const headingRow = element('div', '', panel, 'notification-panel-heading');
  element(header ? 'h2' : 'h3', header ? 'Notifications' : 'Operational notifications', headingRow);
  let close;
  if (header) {
    close = element('button', 'Close', headingRow, 'notification-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close notifications');
  }
  element('p', path === '/command-center'
    ? 'Fictional in-app operational notices and receipts. No external messages are sent.'
    : 'Fictional in-app notices and receipts for this workspace. No external messages are sent.', panel, 'notification-disclosure');
  const tools = element('div', '', panel, 'notification-tools');
  const refresh = element('button', 'Refresh', tools, 'notification-refresh');
  refresh.type = 'button';
  const message = element('p', '', panel, 'notification-message');
  message.setAttribute('aria-live', 'polite');
  const list = element('div', '', panel, 'notification-list');
  const popupHost = header ? element('div', '', document.body, 'notification-popups') : null;
  if (popupHost) {
    popupHost.setAttribute('aria-label', 'New notifications');
    popupHost.setAttribute('aria-live', 'polite');
  }

  let disposed = false;
  let loading = false;
  let initialized = false;
  let timer;
  const popupTimers = new Set();
  const known = new Set();

  function dismissPopup(popup, timeout) {
    if (timeout) { clearTimeout(timeout); popupTimers.delete(timeout); }
    popup.remove();
  }

  function showPopup(notification) {
    if (!popupHost || notification.canApprove) return;
    const popup = element('aside', '', popupHost, 'notification-popup');
    popup.setAttribute('role', 'status');
    element('strong', notification.subject, popup);
    element('p', notification.messageSummary, popup);
    const dismiss = element('button', 'Dismiss', popup);
    dismiss.type = 'button';
    const timeout = setTimeout(() => dismissPopup(popup, timeout), 6500);
    popupTimers.add(timeout);
    dismiss.addEventListener('click', () => dismissPopup(popup, timeout), { once: true });
  }

  function renderNotification(notification) {
    const card = element('article', '', list, `notification-item${notification.canApprove ? ' notification-item-action' : ''}`);
    card.dataset.notificationId = notification.notificationId;
    const title = element('div', '', card, 'notification-item-heading');
    element('h3', notification.subject, title);
    element('span', notification.canApprove ? 'Action required' : notification.status, title, 'notification-status');
    element('p', notification.messageSummary, card);
    const details = element('dl', '', card, 'notification-meta');
    const detail = (name, value) => {
      const row = element('div', '', details); element('dt', name, row); element('dd', value, row);
    };
    detail('Delivery', notification.deliveryMode);
    detail('Created', notification.createdAt);
    if (path === '/command-center') detail('Recipient', `${notification.recipientType} / ${notification.recipientId}`);
    const patternNotice = notification.scope === 'pattern';
    const appointmentNotice = notification.scope === 'appointment';
    const caseNotice = notification.scope === 'case';
    const link = element('a', appointmentNotice || caseNotice ? 'View case' : patternNotice ? 'View pattern alert' : `Plan ${notification.sourceRevisionId} · Action ${notification.sourceActionId}`, card);
    link.href = appointmentNotice || caseNotice ? (path === '/patient' ? '/patient#cases' : path === '/dispatcher' ? '/dispatcher' : '/doctor') : patternNotice ? '/command-center#alerts' : (notification.scope === 'clinical' ? '/doctor' : '/command-center') + '#plan-' + encodeURIComponent(notification.sourceRevisionId);
    link.dataset.link = '';
    element('p', notification.receiptId ? `Receipt: ${notification.receiptId} · Simulated notification delivered` : 'No delivery receipt', card, 'notification-receipt');
    if (notification.stale) element('p', 'Historical proposal; approval unavailable.', card, 'notification-stale');
    if (notification.canApprove) {
      const actions = element('div', '', card, 'notification-actions');
      for (const decision of ['approved', 'rejected']) {
        const button = element('button', decision === 'approved' ? 'Approve simulated notice' : 'Reject simulated notice', actions);
        button.type = 'button';
        button.addEventListener('click', async () => {
          actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
          try {
            const response = await apiFetch(`/api/notifications/${encodeURIComponent(notification.notificationId)}/decision`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
            });
            if (!response.ok) throw new Error('decision');
            await load();
          } catch {
            if (!disposed) message.textContent = 'Decision unavailable. Refresh to check current evidence and delivery.';
          } finally {
            if (!disposed && card.isConnected) actions.querySelectorAll('button').forEach(item => { item.disabled = false; });
          }
        });
      }
    }
  }

  async function load() {
    if (loading || disposed) return;
    loading = true;
    refresh.disabled = true;
    if (!initialized && !list.children.length) message.textContent = 'Loading notifications…';
    try {
      const response = await apiFetch(notificationUrl(path), { cache: 'no-store' });
      let data = response.ok ? await response.json() : { notifications: [], followups: [], unavailableScopes: ['operational'] };
      let caseNoticeAvailable = false;
      if (path === '/doctor') {
        const appointments = await apiFetch('/api/notifications/appointments?recipientType=doctor', { cache: 'no-store' });
        if (appointments.ok) {
          const result = await appointments.json(); data = { ...data, notifications: [...data.notifications, ...result.notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
        } else data.unavailableScopes = [...(data.unavailableScopes || []), 'appointment'];
      }
      if (['/patient', '/doctor', '/dispatcher'].includes(path)) {
        const caseNotices = await apiFetch(`/api/notifications/cases?recipientType=${encodeURIComponent(portalConfig[path].recipientType)}`, { cache: 'no-store' });
        if (caseNotices.ok) {
          const result = await caseNotices.json();
          caseNoticeAvailable = true;
          data = { ...data, notifications: [...data.notifications, ...result.notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
        } else if (![400, 404, 405].includes(caseNotices.status)) data.unavailableScopes = [...(data.unavailableScopes || []), 'case'];
      }
      if (!response.ok && path !== '/doctor' && !caseNoticeAvailable) throw new Error('unavailable');
      if (!Array.isArray(data.notifications) || !Array.isArray(data.followups)) throw new Error('shape');
      if (disposed) return;
      const newInformational = initialized ? data.notifications.filter(item => !known.has(item.notificationId) && !item.canApprove) : [];
      data.notifications.forEach(item => known.add(item.notificationId));
      initialized = true;
      list.replaceChildren();
      message.textContent = data.unavailableScopes?.length
        ? 'Some fictional notification sources are temporarily unavailable.'
        : data.notifications.length ? '' : path === '/command-center' ? 'No active operational notifications.' : 'No notifications for this workspace.';
      data.notifications.forEach(renderNotification);
      const followups = followupsFor(path, data.followups);
      if (followups.length) {
        element('h3', 'Fictional follow-up monitoring', list, 'notification-history-heading');
        for (const item of followups) element('p', `Fictional follow-up · ${item.status} · ${item.dueAt} · Plan ${item.sourcePlanRevision}`, list, 'notification-followup');
      }
      newInformational.forEach(showPopup);
    } catch {
      if (!disposed) {
        list.replaceChildren();
        message.textContent = 'Notifications are unavailable right now. Refresh to retry.';
      }
    } finally {
      loading = false;
      if (!disposed) refresh.disabled = false;
    }
  }

  function setOpen(open, restoreFocus = false) {
    if (!header) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('is-open', open);
    if (open) { if (available) void load(); close.focus(); }
    else if (restoreFocus) toggle.focus();
  }
  const onDocumentClick = event => { if (header && !panel.hidden && !root.contains(event.target) && !event.target.closest?.('.notification-popup')) setOpen(false); };
  const onDocumentKeydown = event => { if (header && event.key === 'Escape' && !panel.hidden) { event.preventDefault(); setOpen(false, true); } };
  if (header) {
    toggle.addEventListener('click', () => setOpen(panel.hidden));
    close.addEventListener('click', () => setOpen(false, true));
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeydown);
  }
  if (available) {
    refresh.addEventListener('click', load);
    void load();
    timer = setInterval(load, 5000);
  } else {
    refresh.hidden = true;
    message.textContent = 'No notifications for this page.';
  }

  return () => {
    disposed = true;
    clearInterval(timer);
    popupTimers.forEach(clearTimeout);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onDocumentKeydown);
    popupHost?.remove();
    root.remove();
  };
}

export function mountNotificationCenter(outlet, path) {
  const config = portalConfig[path];
  if (!config) return () => {};
  const cleanups = [];

  if (path === '/command-center') {
    const commandCenterHost = outlet.querySelector('[data-notification-host]');
    const drawer = commandCenterHost?.closest('details');
    let drawerCleanup;
    const onDrawerToggle = () => {
      if (drawer.open && !drawerCleanup) drawerCleanup = mountSurface(commandCenterHost, path);
      else if (!drawer.open && drawerCleanup) { drawerCleanup(); drawerCleanup = undefined; }
    };
    drawer?.addEventListener('toggle', onDrawerToggle);
    cleanups.push(() => { drawer?.removeEventListener('toggle', onDrawerToggle); drawerCleanup?.(); });
  }

  return () => cleanups.reverse().forEach(cleanup => cleanup());
}

export function mountGlobalNotifications(header, { getState = authState, subscribe = observeAuth } = {}) {
  const host = document.createElement('div');
  host.className = 'notification-header-host';
  header.insertBefore(host, header.querySelector('.auth-bar'));
  let cleanup;
  const render = () => {
    cleanup?.(); cleanup = undefined;
    const state = getState();
    if (state.status !== 'SIGNED_IN' || state.authorizationStatus === 'CHECKING' || state.authorizationStatus === 'IDLE') return;
    const path = window.location.pathname;
    const roles = state.authorizationStatus === 'READY' && Array.isArray(state.identity?.user?.roles) ? state.identity.user.roles : [];
    const authorized = path === '/patient' ? roles.includes('patient')
      : path === '/doctor' ? roles.includes('doctor') && !!state.identity.user.specialties?.length
      : path === '/dispatcher' ? roles.includes('dispatcher')
        : path === '/command-center' ? roles.includes('command-center') || roles.includes('command_center') : false;
    cleanup = mountSurface(host, authorized ? path : '', { header: true });
  };
  const unsubscribe = subscribe(render);
  window.addEventListener('smartcareops:navigation', render);
  return () => { unsubscribe(); window.removeEventListener('smartcareops:navigation', render); cleanup?.(); host.remove(); };
}

import { apiFetch } from '../auth/service.js';
import './notification-center.css';

const recipient = { '/doctor': 'doctor', '/dispatcher': 'dispatcher', '/patient': 'patient_status' };
function element(tag, text, parent) {
  const node = document.createElement(tag); if (text) node.textContent = text; parent?.append(node); return node;
}
export function mountNotificationCenter(outlet, path) {
  const panel = element('section', '', outlet); panel.className = 'notification-center'; panel.setAttribute('aria-label', 'Simulated notification center');
  element('h2', 'Notification center · SIMULATION', panel);
  element('p', 'Fictional in-app receipts only. No external messages are sent.', panel);
  const refresh = element('button', 'Refresh notifications', panel); refresh.type = 'button';
  const message = element('p', '', panel); message.setAttribute('aria-live', 'polite');
  const list = element('div', '', panel); let disposed = false, loading = false;
  async function load() {
    if (loading || disposed) return; loading = true; refresh.disabled = true;
    try {
      const response = await apiFetch('/api/notifications' + (recipient[path] ? '?recipientType=' + recipient[path] : ''));
      if (!response.ok) throw new Error('unavailable'); const data = await response.json(); if (disposed) return;
      list.replaceChildren(); message.textContent = data.unavailableScopes?.length ? 'Some fictional notification sources are unavailable.' : data.notifications.length ? '' : 'No simulated notifications yet.';
      for (const notification of data.notifications) {
        const card = element('article', '', list); card.dataset.notificationId = notification.notificationId;
        element('h3', notification.subject, card); element('p', `SIMULATION · ${notification.status} · ${notification.deliveryMode}`, card);
        element('p', `Recipient: ${notification.recipientType} / ${notification.recipientId}`, card);
        element('p', `Source: ${notification.agentType} · ${notification.createdAt}`, card);
        element('p', notification.messageSummary, card);
        const link = element('a', `Plan ${notification.sourceRevisionId} · Action ${notification.sourceActionId}`, card);
        link.href = (notification.scope === 'clinical' ? '/doctor' : '/command-center') + '#plan-' + encodeURIComponent(notification.sourceRevisionId);
        element('p', notification.receiptId ? `Receipt: ${notification.receiptId} · Simulated notification delivered` : 'No delivery receipt', card);
        if (notification.stale) element('p', 'Historical proposal; approval unavailable.', card);
        if (notification.canApprove) for (const decision of ['approved', 'rejected']) {
          const button = element('button', decision === 'approved' ? 'Approve simulated notice' : 'Reject simulated notice', card); button.type = 'button';
          button.addEventListener('click', async () => {
            card.querySelectorAll('button').forEach(item => { item.disabled = true; });
            try {
              const result = await apiFetch(`/api/notifications/${encodeURIComponent(notification.notificationId)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
              if (!result.ok) throw new Error('decision'); await load();
            } catch { if (!disposed) message.textContent = 'Decision unavailable. Refresh to check current evidence and delivery.'; }
          });
        }
      }
      const followups = data.followups.filter(item => path === '/command-center' || item.scope === 'clinical');
      if (followups.length) { element('h3', 'Fictional follow-up monitoring', list); for (const item of followups) element('p', `SIMULATION · ${item.status} · ${item.dueAt} · Plan ${item.sourcePlanRevision}`, list); }
    } catch { if (!disposed) message.textContent = 'Simulated notifications are unavailable or disabled.'; }
    finally { loading = false; if (!disposed) refresh.disabled = false; }
  }
  refresh.addEventListener('click', load); void load(); const timer = setInterval(load, 5000);
  return () => { disposed = true; clearInterval(timer); panel.remove(); };
}

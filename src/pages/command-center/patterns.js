import { apiFetch } from '../../auth/service.js';

export function renderPatterns() {
  return `<section class="pattern-panel" aria-labelledby="pattern-heading">
    <p class="eyebrow">Synthetic aggregate signals · 90-minute window</p>
    <h2 id="pattern-heading">Pattern Intelligence</h2>
    <p>Deterministic signals only. A possible cluster is an operational alert, not a public-health declaration.</p>
    <div id="alerts" class="pattern-alert-zone" aria-label="Network alerts">
      <p class="pattern-alert-zone-label">Priority alerts</p>
      <p id="pattern-message" role="status" aria-live="polite">Restoring pattern status…</p>
      <div id="pattern-alert" aria-live="polite"></div>
    </div>
    <div id="pattern-summary"></div>
    <button type="button" id="pattern-refresh">Refresh pattern scan</button>
  </section>`;
}

const node = (parent, tag, text, className) => { const child = document.createElement(tag); child.textContent = String(text); if (className) child.className = className; parent.append(child); return child; };

export function mountPatterns(root) {
  const panel = root.querySelector('.pattern-panel'); if (!panel) return () => {};
  const message = panel.querySelector('#pattern-message'), alertRoot = panel.querySelector('#pattern-alert');
  const summary = panel.querySelector('#pattern-summary'), refreshButton = panel.querySelector('#pattern-refresh');
  const controller = new AbortController(); let state = null, busy = false, lastMapState = '';
  async function request(path, body) {
    const response = await apiFetch(`/api/patterns${path}`, { signal: controller.signal, cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('Pattern scan could not be confirmed. Refresh to retry.');
    return response.json();
  }
  function render() {
    alertRoot.replaceChildren(); summary.replaceChildren(); refreshButton.disabled = busy;
    const alert = state?.alert;
    const mapState = JSON.stringify({ active: Boolean(alert), region: alert?.region || null, severity: alert?.severity || null, acknowledged: Boolean(alert?.acknowledged) });
    if (mapState !== lastMapState) { lastMapState = mapState; window.dispatchEvent(new CustomEvent('smartcareops:pattern-state', { detail: JSON.parse(mapState) })); }
    if (alert) {
      const banner = node(alertRoot, 'article', '', alert.acknowledged ? 'pattern-alert acknowledged' : `pattern-alert severity-${alert.severity}`);
      banner.id = 'pattern-alert-banner';
      banner.dataset.alertId = alert.alertId;
      node(banner, 'p', alert.acknowledged ? 'Pattern alert acknowledged' : 'POSSIBLE EMERGING RESPIRATORY CLUSTER', 'pattern-alert-label');
      node(banner, 'h3', `${alert.observedCount} similar synthetic presentations detected in ${alert.windowMinutes} minutes`);
      node(banner, 'p', `${alert.region} · ${alert.severity.toUpperCase()} · ${alert.trend} trend`);
      node(banner, 'p', `Observed: ${alert.observedCount} · Baseline: ${alert.baselineCount}`);
      node(banner, 'p', `Synthetic ED demand proxy: +${alert.projectedEdDemandIncreasePercent}% over the next 2 hours`);
      if (alert.interpretationStatus === 'succeeded' && alert.interpretation) {
        const advisory = node(banner, 'div', '', 'pattern-advisory');
        node(advisory, 'h4', 'Gemini operational advisory');
        node(advisory, 'p', alert.interpretation.operationalImplications);
        node(advisory, 'p', `Monitor: ${alert.interpretation.monitoring}`);
        node(advisory, 'p', `Uncertainty: ${alert.interpretation.uncertainty}`);
      } else if (alert.interpretationStatus === 'unavailable') node(banner, 'p', 'Gemini advisory was not confirmed; the deterministic alert remains active.');
      if (!alert.acknowledged) {
        const actions = node(banner, 'div', '', 'pattern-actions');
        const view = node(actions, 'button', 'View Pattern'); view.type = 'button';
        view.addEventListener('click', () => { const details = panel.querySelector('#pattern-details'); details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
        const forecast = node(actions, 'button', 'Generate Forecast'); forecast.type = 'button';
        forecast.addEventListener('click', () => { root.querySelector('#predictive-generate')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); root.querySelector('#predictive-generate')?.click(); });
        const careTwin = node(actions, 'button', 'Evaluate with CareTwin'); careTwin.type = 'button';
        careTwin.addEventListener('click', () => { root.querySelector('.caretwin-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); window.dispatchEvent(new CustomEvent('smartcareops:caretwin:generate')); });
        const acknowledge = node(actions, 'button', 'Acknowledge'); acknowledge.type = 'button'; acknowledge.disabled = busy;
        acknowledge.addEventListener('click', async () => {
          busy = true; render();
          try { state = await request('/acknowledge', { alertId: alert.alertId }); message.textContent = 'Pattern alert acknowledged.'; }
          catch (error) { if (!controller.signal.aborted) message.textContent = error.message; }
          finally { busy = false; if (!controller.signal.aborted) render(); }
        });
      } else node(banner, 'p', `Acknowledged ${alert.acknowledgedAt ? new Date(alert.acknowledgedAt).toLocaleString() : ''}`);
    }
    if (state?.scan) {
      const details = node(summary, 'details', '', 'pattern-details'); details.id = 'pattern-details';
      node(details, 'summary', 'View synthetic pattern data');
      node(details, 'p', `${state.scan.observedCount} respiratory presentations · ${state.scan.region || 'No concentrated region'} · last ${state.scan.windowMinutes} minutes`);
      node(details, 'p', `Synthetic baseline: ${state.scan.baselineCount} presentations per ${state.scan.windowMinutes} minutes.`);
      node(details, 'p', 'Signals are generated from the simulated clock. No real case records, transcripts, or patient identities are used.');
      if (!state.scan.detected) node(summary, 'p', `No possible cluster currently meets the threshold (${state.scan.observedCount} observed; ${state.scan.baselineCount} baseline).`);
    } else if (!alert) node(summary, 'p', 'No saved pattern scan yet.');
  }
  async function refresh() {
    if (busy) return; busy = true; render();
    try { state = await request('/refresh', {}); if (!controller.signal.aborted) { render(); message.textContent = 'Synthetic pattern scan updated.'; } }
    catch (error) { if (!controller.signal.aborted) message.textContent = error.message; }
    finally { busy = false; if (!controller.signal.aborted) render(); }
  }
  refreshButton.addEventListener('click', () => void refresh());
  void refresh(); const timer = setInterval(() => void refresh(), 15000);
  return () => { controller.abort(); clearInterval(timer); };
}

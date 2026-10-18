import './demo-console.css';
import { apiFetch } from '../../auth/service.js';

const statusIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 12 3 3 7-7"/></svg>`;
const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export const renderDemoConsole = () => `<section class="demo-console" aria-labelledby="page-heading">
  <header class="demo-console-heading">
    <div><h1 id="page-heading" tabindex="-1">Demo Console</h1><p>Confirm how a fictional intake crosses the event boundary without opening cloud tools.</p></div>
    <a href="/" data-link>Home <span aria-hidden="true">→</span></a>
  </header>
  <section class="demo-boundary" aria-labelledby="demo-boundary-heading">
    <div class="demo-boundary-copy"><h2 id="demo-boundary-heading">Routine intake boundary</h2><p>A routine intake may be recorded for audit and projection without becoming a Hospital Operations case.</p></div>
    <p class="demo-boundary-status" id="demo-boundary-status" role="status" aria-live="polite">Checking the latest routine intake event…</p>
    <form class="demo-case-lookup" id="demo-case-form">
      <label for="demo-case-id"><strong>Verify a specific case</strong><span>Paste a fictional Case ID to view its sanitized event trace.</span></label>
      <div><input id="demo-case-id" name="caseId" type="text" required autocomplete="off" spellcheck="false" placeholder="SC-…" aria-describedby="demo-case-help"><button type="submit">Verify trace</button></div>
      <p id="demo-case-help">The Case ID is cleared from this field after verification and shown only in the access-controlled result.</p>
    </form>
    <div class="demo-boundary-path" id="demo-boundary-path" aria-busy="true">
      <span></span><span></span><span></span>
    </div>
    <div class="demo-boundary-result" id="demo-boundary-result" hidden></div>
    <div class="demo-boundary-actions">
      <button id="demo-boundary-refresh" type="button">Refresh verification</button>
      <a href="/patient" data-link>Open Patient Portal</a>
    </div>
  </section>
  <section class="demo-sessions" aria-labelledby="demo-sessions-heading">
    <div class="demo-boundary-copy"><h2 id="demo-sessions-heading">Recent agentic sessions</h2><p>Hospital-capacity events can start bounded Operations sessions. Routine Patient intakes do not.</p></div>
    <div id="demo-sessions-list" class="demo-sessions-list" aria-live="polite"><p>Checking recent sessions…</p></div>
  </section>
  <aside class="demo-privacy-note"><strong>Privacy boundary</strong><span>This view contains operational status and the submitted case reference only. Patient names, concerns, severity, emergency reasons, and transcripts are not displayed.</span></aside>
</section>`;

const row = (label, value) => `<div><dt>${label}</dt><dd>${statusIcon}<span>${value}</span></dd></div>`;
const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString(); };
const sessionNumber = value => String(value || '').match(/(\d+)$/)?.[1] || '—';

export function mountDemoConsole(root) {
  const status = root.querySelector('#demo-boundary-status');
  const path = root.querySelector('#demo-boundary-path');
  const result = root.querySelector('#demo-boundary-result');
  const refresh = root.querySelector('#demo-boundary-refresh');
  const form = root.querySelector('#demo-case-form');
  const caseInput = root.querySelector('#demo-case-id');
  const sessions = root.querySelector('#demo-sessions-list');
  const controller = new AbortController();

  const renderEmpty = () => {
    path.hidden = true; result.hidden = false;
    result.innerHTML = `<div class="demo-empty"><h3>No recent routine intake decision</h3><p>Complete a new fictional Chat intake, then return here and refresh the verification.</p></div>`;
    status.textContent = 'Waiting for a routine intake event.';
  };
  const renderBoundary = boundary => {
    const legacy = boundary.classificationStatus === 'legacy_unclassified';
    const emergency = boundary.classificationStatus === 'emergency';
    path.hidden = false; path.setAttribute('aria-busy', 'false');
    path.innerHTML = `<div><i>${statusIcon}</i><strong>${emergency ? 'Emergency intake' : 'Intake event'}</strong><span>Recorded</span></div><b aria-hidden="true"></b><div><i>${statusIcon}</i><strong>Operations projection</strong><span>Recorded</span></div><b aria-hidden="true"></b><div><i>${statusIcon}</i><strong>${emergency ? 'Emergency pathway' : 'Routing decision'}</strong><span>${emergency ? safe(boundary.routing) : legacy ? 'Not recorded' : 'Normal care'}</span></div>`;
    result.hidden = false;
    const reference = boundary.reference ? `<p class="demo-case-reference">Reference ${safe(boundary.reference)}</p>` : '';
    const trace = Array.isArray(boundary.trace) ? `<ol class="demo-trace">${boundary.trace.map(item => `<li><span>${safe(item.label)}</span><strong>${safe(item.status)}</strong></li>`).join('')}</ol>` : `<dl>${row('Event record', safe(boundary.event))}${row('Operations projection', safe(boundary.projection))}${row('Hospital Operations activation', boundary.hospitalOperationsTriggered ? 'Requested' : 'Not requested')}${row('Patient details shared', 'None')}</dl>`;
    const outcome = emergency ? 'Emergency intake entered the human-controlled Dispatcher pathway.' : legacy ? 'This case reached the event boundary before routing classification was recorded.' : 'Routine intake stayed in the normal care pathway.';
    const session = emergency ? 'Not created. Emergency response remains human-controlled.' : legacy ? 'No session link was recorded for this pre-rollout trace.' : 'Not created. Routine intake routing stops here by design.';
    result.innerHTML = `<div class="demo-result-summary"><span>${emergency ? 'Emergency trace' : legacy ? 'Pre-rollout trace' : 'Verified boundary'}</span><strong>${outcome}</strong>${reference}<p>Checked ${dateLabel(boundary.classifiedAt)}</p><p class="demo-data-boundary"><strong>Patient details shared:</strong> None</p><p class="demo-no-session"><strong>Agentic session:</strong> ${session}</p></div>${trace}`;
    status.textContent = emergency ? 'The current emergency response trace is shown.' : legacy ? 'The available pre-rollout case trace is shown.' : 'The routine intake boundary is verified.';
  };
  const renderSessions = (runs = [], traces = []) => {
    const capacityTraces = traces.filter(item => (item.triggers || []).some(trigger => trigger.eventType === 'hospital.capacity.changed'));
    const revisions = new Set(capacityTraces.map(item => item.planRevisionId));
    const recent = [...runs].filter(run => revisions.has(run.planRevisionId)).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''))).slice(0, 4);
    if (!recent.length) { sessions.innerHTML = '<div class="demo-empty"><h3>No agentic sessions yet</h3><p>A fictional hospital-capacity event will appear here after the Operations agent processes it.</p></div>'; return; }
    sessions.innerHTML = recent.map(run => {
      const decisions = capacityTraces.filter(item => item.planRevisionId === run.planRevisionId);
      const reviews = decisions.filter(item => item.approval?.status && item.approval.status !== 'not_required');
      const pending = reviews.some(item => item.approval.status === 'pending');
      return `<article><div><span>Agentic session ${safe(sessionNumber(run.runId))}</span><strong>${safe(run.status || 'unknown')}</strong></div><dl><div><dt>Trigger</dt><dd>Hospital capacity changed</dd></div><div><dt>Started</dt><dd>${safe(dateLabel(run.startedAt))}</dd></div><div><dt>Bounded actions</dt><dd>${decisions.length}</dd></div><div><dt>Human review</dt><dd>${pending ? 'Pending' : reviews.length ? 'Recorded' : 'Not required'}</dd></div></dl></article>`;
    }).join('');
  };
  const load = async () => {
    refresh.disabled = true; status.textContent = 'Checking the latest routine intake event…'; path.hidden = false; path.setAttribute('aria-busy', 'true'); result.hidden = true;
    try {
      const response = await apiFetch('/api/demo-console', { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Verification is temporarily unavailable.');
      if (payload.demoBoundary) renderBoundary(payload.demoBoundary); else renderEmpty();
      renderSessions(payload.runs, payload.decisionTrace);
    } catch (error) {
      if (controller.signal.aborted) return;
      path.hidden = true; result.hidden = false;
      result.innerHTML = `<div class="demo-empty demo-error"><h3>Verification unavailable</h3><p>${error.message || 'Refresh to try again.'}</p></div>`;
      status.textContent = 'The routine intake boundary could not be checked.';
    } finally { refresh.disabled = false; }
  };
  const verify = async event => {
    event.preventDefault();
    const caseId = caseInput.value.trim();
    if (!caseId) return;
    caseInput.value = '';
    const button = form.querySelector('button');
    button.disabled = true; status.textContent = 'Checking the requested case trace…';
    try {
      const response = await apiFetch('/api/demo-console/verify', { method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'The case trace could not be verified.');
      if (payload.demoBoundary) renderBoundary(payload.demoBoundary); else renderEmpty();
    } catch (error) {
      if (!controller.signal.aborted) { result.hidden = false; result.innerHTML = `<div class="demo-empty demo-error"><h3>Case trace unavailable</h3><p>${safe(error.message || 'Try again.')}</p></div>`; status.textContent = 'The requested case trace could not be checked.'; }
    } finally { button.disabled = false; }
  };
  refresh.addEventListener('click', load);
  form.addEventListener('submit', verify);
  void load();
  return () => controller.abort();
}

import { apiFetch } from '../../auth/service.js';
import { EmergencyStatus, emergencyStatusLabels } from '../../../shared/emergency.js';
import { ambulanceStatusLabels } from '../../../shared/ambulance.js';
import { mountAmbulanceControls } from './ambulance-controls.js';
import './dispatcher.css';

export const renderDispatcher = () => `<section class="role-page dispatcher-page" aria-labelledby="page-heading">
  <a class="back-link" href="/" data-link>← Back to home</a>
  <p class="eyebrow">For response teams · Fictional demo</p><h1 id="page-heading" tabindex="-1">Dispatcher Portal</h1>
  <p class="role-subtitle">Emergency cases awaiting review</p>
  <p>Fictional ambulance simulator. Acknowledgement records a demo review only. No real ambulance is dispatched and no emergency service is contacted.</p>
  <div class="dispatcher-toolbar"><button id="dispatcher-refresh" type="button">Refresh emergencies</button><span id="dispatcher-message" role="status" aria-live="polite"></span></div>
  <p id="dispatcher-action" role="status" aria-live="polite"></p>
  <div id="dispatcher-cases" class="dispatcher-cases"></div><button id="dispatcher-more" type="button" hidden>Load more emergencies</button>
  <section id="dispatcher-detail" class="dispatcher-detail" aria-labelledby="dispatcher-detail-heading" hidden></section>
</section>`;
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded';
const field = (parent, label, value) => { const p = document.createElement('p'); p.append(text('strong', `${label}: `), document.createTextNode(value || 'Not reported')); parent.append(p); };

export function mountDispatcher(outlet) {
  const find = name => outlet.querySelector(`#dispatcher-${name}`);
  let disposed = false, queueController, detailController, actionController, queueGeneration = 0, detailGeneration = 0, nextCursor, selected, acknowledging = false, ambulanceCleanup;
  const seen = new Set();
  async function json(path, options = {}) {
    const response = await apiFetch(path, { cache: 'no-store', ...options });
    if (!response.ok) throw new Error('Unavailable');
    return response.json();
  }
  function details(record, focus) {
    ambulanceCleanup?.();
    const panel = find('detail'); panel.hidden = false; panel.replaceChildren();
    const heading = text('h2', `Case ${record.caseId}`); heading.id = 'dispatcher-detail-heading'; heading.tabIndex = -1; panel.append(heading);
    field(panel, 'Patient preferred name', record.patient.preferredName || record.patient.name);
    field(panel, 'Status', emergencyStatusLabels[record.emergency.status]);
    field(panel, 'Emergency reason', record.emergency.reasonSummary); field(panel, 'Triggered', date(record.emergency.triggeredAt));
    if (record.emergency.status === EmergencyStatus.ACKNOWLEDGED) field(panel, 'Acknowledged by demo dispatcher', date(record.emergency.acknowledgedAt));
    ambulanceCleanup = mountAmbulanceControls(record, panel, saved => {
      if (disposed || selected !== saved.caseId) return;
      detailController?.abort(); ++detailGeneration; details(saved, false); void read();
    });
    panel.append(text('h3', 'Validated patient-reported facts and vitals'));
    for (const [label, value] of Object.entries(record.intakeSummary || {})) field(panel, label, value);
    for (const flag of record.reportedFacts.redFlags) field(panel, `${flag.type} (${flag.status})`, flag.patientReportedText);
    panel.append(text('h3', 'Previous workflow information'));
    field(panel, 'Handoff status', record.handoffStatus); field(panel, 'Hospital receipt', record.handoffReceipt?.caseId || 'None recorded');
    field(panel, 'Previous doctor route', record.routing?.specialty || 'None recorded');
    panel.append(text('p', 'Emergency workflow remains active. All ambulance actions are fictional simulations; no real response is underway.'));
    if (focus) heading.focus();
  }
  async function detail(id, focus = true) {
    ambulanceCleanup?.();
    selected = id; detailController?.abort(); detailController = new AbortController(); const current = ++detailGeneration;
    find('detail').hidden = false; find('detail').replaceChildren(text('p', 'Loading emergency case…'));
    try {
      const record = await json(`/api/dispatcher/cases/${id}`, { signal: detailController.signal });
      if (disposed || current !== detailGeneration) return;
      if (record.caseId !== id || !record.emergency) throw new Error('Unavailable');
      details(record, focus);
    } catch { if (!disposed && current === detailGeneration) find('detail').replaceChildren(text('p', 'Emergency case unavailable. Refresh to retry.')); }
  }
  async function acknowledge(id, button) {
    if (acknowledging) return;
    acknowledging = true; button.disabled = true; actionController = new AbortController(); find('action').textContent = 'Saving acknowledgement…';
    try {
      const record = await json(`/api/dispatcher/cases/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: actionController.signal });
      if (disposed) return;
      if (record.caseId !== id || record.emergency?.status !== EmergencyStatus.ACKNOWLEDGED) throw new Error('Unconfirmed');
      find('action').textContent = 'Dispatcher acknowledged. No emergency response has been dispatched.';
      if (selected === id) { detailController?.abort(); ++detailGeneration; details(record, false); }
      await read();
    } catch { if (!disposed) { button.disabled = false; find('action').textContent = 'Acknowledgement could not be confirmed. Refresh or retry.'; } }
    finally { acknowledging = false; }
  }
  function card(record) {
    const article = document.createElement('article'); article.className = 'dispatcher-card'; article.dataset.caseId = record.caseId;
    article.append(text('span', emergencyStatusLabels[record.emergency.status], 'badge'), text('h2', record.patient.preferredName || record.patient.name || 'Name not reported'));
    field(article, 'Case', record.caseId); field(article, 'Emergency reason', record.emergency.reasonSummary); field(article, 'Triggered', date(record.emergency.triggeredAt));
    if (record.ambulance) field(article, 'Ambulance — simulation', `${record.ambulance.unitId} · ${ambulanceStatusLabels[record.ambulance.status]}`);
    for (const label of ['Reported Symptoms', 'Blood Pressure', 'Heart Rate', 'SpO2']) field(article, label, record.intakeSummary?.[label]);
    const open = text('button', 'Open emergency case'); open.type = 'button'; open.setAttribute('aria-label', `Open emergency case ${record.caseId}`); open.addEventListener('click', () => void detail(record.caseId)); article.append(open);
    if (record.emergency.status === EmergencyStatus.PENDING) {
      const button = text('button', 'Acknowledge'); button.type = 'button'; button.setAttribute('aria-label', `Acknowledge ${record.caseId}`); button.addEventListener('click', () => void acknowledge(record.caseId, button)); article.append(button);
    } else field(article, 'Acknowledged', date(record.emergency.acknowledgedAt));
    return article;
  }
  async function read(more = false) {
    queueController?.abort(); queueController = new AbortController(); const current = ++queueGeneration;
    if (!more) { seen.clear(); find('cases').replaceChildren(); nextCursor = null; }
    find('message').textContent = 'Loading emergency cases…'; find('more').hidden = true;
    try {
      const result = await json(`/api/dispatcher/cases${more && nextCursor ? `?after=${encodeURIComponent(nextCursor)}` : ''}`, { signal: queueController.signal });
      if (disposed || current !== queueGeneration) return;
      for (const record of result.cases) if (!seen.has(record.caseId)) { seen.add(record.caseId); find('cases').append(card(record)); }
      nextCursor = result.nextCursor; find('more').hidden = !nextCursor;
      find('message').textContent = seen.size ? `${seen.size} emergency case${seen.size === 1 ? '' : 's'}${result.storage === 'memory' ? ' · Memory — dev only' : ''}` : 'No emergency cases.';
      if (!more && selected) void detail(selected, false);
    } catch { if (!disposed && current === queueGeneration) { find('message').textContent = 'Emergency queue unavailable. Refresh to retry.'; find('more').hidden = !nextCursor; } }
  }
  const refresh = () => void read(), more = () => void read(true);
  find('refresh').addEventListener('click', refresh); find('more').addEventListener('click', more); void read();
  return () => { disposed = true; ambulanceCleanup?.(); queueController?.abort(); detailController?.abort(); actionController?.abort(); find('refresh')?.removeEventListener('click', refresh); find('more')?.removeEventListener('click', more); };
}

import { apiFetch } from '../../auth/service.js';
import { specialtyLabels } from '../../../shared/routing.js';
import './doctor.css';
import { clinicalMarkup, mountClinical } from './clinical.js';
import { patientDisplayName, patientSearchText } from './patient-name.js';

export const renderDoctor = () => `<section class="role-page doctor-page" aria-labelledby="page-heading">
  <a class="back-link" href="/" data-link>← Back to home</a>
  <p class="eyebrow">For clinicians · Fictional demo</p>
  <h1 id="page-heading" tabindex="-1">Doctor Portal</h1>
  <p class="role-subtitle">Cases for clinical review</p>
  <p>Specialties reflect patient-reported symptom domains. Routing is not a diagnosis or urgency assessment.</p>
  <div class="doctor-toolbar"><button id="doctor-refresh" type="button">Refresh cases</button><label for="doctor-search">Search cases</label><input id="doctor-search" type="search" autocomplete="off" aria-controls="doctor-search-results"><span id="doctor-message" role="status" aria-live="polite"></span></div>
  <div id="doctor-search-results" class="doctor-search-results" role="listbox" aria-label="Case search results" hidden></div>
  <h2>Recent Cases</h2>
  <div id="doctor-cases" class="doctor-cases"></div>
  <button id="doctor-more" type="button" hidden>Load more cases</button>
  <section id="doctor-detail" class="doctor-detail" aria-labelledby="doctor-detail-heading" hidden></section>
${clinicalMarkup}</section>`;

const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded';
const field = (parent, name, value) => { const p = document.createElement('p'); if (name === 'PROFILE IDENTITY') p.className = 'doctor-profile-identity'; p.append(text('strong', `${name}: `), document.createTextNode(value || 'Not reported')); parent.append(p); };
export function mountDoctor(outlet) {
  const cleanupClinical = mountClinical(outlet);
  const find = name => outlet.querySelector(`#doctor-${name}`);
  let disposed = false, queueController, detailController, generation = 0, detailGeneration = 0, nextCursor, selected, expanded = false;
  const seen = new Set(), loadedCases = new Map();
  async function fetchJson(path, signal) {
    const response = await apiFetch(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Unavailable');
    return response.json();
  }
  async function detail(id, focus = true) {
    selected = id; detailController?.abort(); detailController = new AbortController();
    const current = ++detailGeneration;
    const panel = find('detail'); panel.hidden = false; panel.replaceChildren(text('p', 'Loading case…'));
    try {
      const record = await fetchJson(`/api/doctor/cases/${id}`, detailController.signal);
      if (disposed || current !== detailGeneration) return;
      if (record.caseId !== id || record.routing?.status !== 'routed' && record.workflowStatus !== 'submitted_for_clinical_review') throw new Error('Unavailable');
      panel.replaceChildren();
      cleanupClinical.select?.(id);
      const heading = text('h2', 'Patient'); heading.id = 'doctor-detail-heading'; heading.tabIndex = -1; panel.append(heading);
      field(panel, 'PROFILE IDENTITY', patientDisplayName(record.patientIdentity, record.patient));
      field(panel, 'PATIENT REPORTED NAME', record.patient.preferredName || record.patient.name);
      field(panel, 'Case', record.caseId);
      field(panel, 'Status', record.routing ? 'Routed to doctor' : 'Waiting for clinical review');
      panel.append(text('h3', 'Routing interpretation'));
      field(panel, 'Specialty', specialtyLabels[record.routing?.specialty]); field(panel, 'Reason', record.routing?.reasonSummary);
      field(panel, 'Routed', dateLabel(record.routing?.routedAt));
      panel.append(text('h3', 'Validated intake summary — patient reported'));
      for (const [name, value] of Object.entries(record.intakeSummary || {})) field(panel, name, value);
      panel.append(text('h3', 'Reported facts and evidence'));
      for (const fact of [...record.reportedFacts.symptoms, ...record.reportedFacts.redFlags]) field(panel, `${fact.name || fact.type} (${fact.status})`, fact.patientReportedText);
      const denied = [...record.reportedFacts.symptoms, ...record.reportedFacts.redFlags].filter(fact => fact.status === 'denied').map(fact => fact.name || fact.type).join(', ');
      field(panel, 'Denied symptoms', denied || 'None recorded');
      panel.append(text('h3', 'Handoff'));
      field(panel, 'Handoff status', record.handoffStatus); field(panel, 'Hospital receipt', record.handoffReceipt?.caseId || 'No receipt recorded');
      field(panel, 'Created', dateLabel(record.createdAt));
      if (focus) heading.focus();
    } catch {
      if (!disposed && current === detailGeneration) panel.replaceChildren(text('p', 'Case could not be loaded. Refresh to retry.'));
    }
  }
  function card(record) {
    const article = document.createElement('article'); article.className = 'doctor-card'; article.dataset.caseId = record.caseId;
    article.append(text('span', specialtyLabels[record.routing?.specialty] || 'Clinical review', 'badge'), text('h2', patientDisplayName(record.patientIdentity, record.patient)));
    field(article, 'Case', record.caseId); field(article, 'Main reported symptom', record.mainReportedSymptom);
    field(article, 'Routing reason', record.routing?.reasonSummary); field(article, 'Status', record.routing ? 'Routed' : 'Waiting for clinical review');
    field(article, 'Created', dateLabel(record.createdAt)); field(article, 'Routed', dateLabel(record.routing?.routedAt));
    const button = text('button', 'Open case'); button.type = 'button'; button.setAttribute('aria-label', `Open case ${record.caseId}`); button.addEventListener('click', () => void detail(record.caseId)); article.append(button);
    return article;
  }
  const recent = () => [...loadedCases.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const renderCases = () => find('cases').replaceChildren(...(expanded ? recent() : recent().slice(0, 3)).map(card));
  function search() {
    const results = find('search-results'), query = find('search').value.trim().toLocaleLowerCase(); results.replaceChildren();
    if (!query) { results.hidden = true; return; }
    const matches = recent().filter(record => patientSearchText(record.patientIdentity || record.patient).includes(query) || record.caseId.toLocaleLowerCase().includes(query)).slice(0, 8);
    for (const record of matches) {
      const displayName = patientDisplayName(record.patientIdentity, record.patient), button = text('button', displayName); button.type = 'button'; button.setAttribute('role', 'option');
      button.addEventListener('click', () => { find('search').value = displayName; results.hidden = true; void detail(record.caseId); }); results.append(button);
    }
    results.hidden = matches.length === 0;
  }
  async function read(more = false) {
    queueController?.abort(); queueController = new AbortController(); const current = ++generation;
    if (!more) { seen.clear(); loadedCases.clear(); expanded = false; find('cases').replaceChildren(); nextCursor = null; find('search-results').hidden = true; }
    find('message').textContent = 'Loading routed cases…'; find('more').hidden = true;
    try {
      const result = await fetchJson(`/api/doctor/cases${more && nextCursor ? `?after=${encodeURIComponent(nextCursor)}` : ''}`, queueController.signal);
      if (disposed || current !== generation) return;
      for (const record of result.cases) if (!seen.has(record.caseId)) { seen.add(record.caseId); loadedCases.set(record.caseId, record); }
      renderCases(); nextCursor = result.nextCursor; find('more').hidden = expanded ? !nextCursor : loadedCases.size <= 3 && !nextCursor;
      find('message').textContent = seen.size ? `${seen.size} routed case${seen.size === 1 ? '' : 's'}${result.storage === 'memory' ? ' · Memory — dev only' : ''}` : 'No routed cases yet.';
      if (!more && selected) void detail(selected, false);
    } catch {
      if (!disposed && current === generation) { find('message').textContent = 'Queue unavailable. Refresh to retry.'; find('more').hidden = !nextCursor; }
    }
  }
  const refresh = () => void read(), more = () => { if (!expanded) { expanded = true; if (!nextCursor) { renderCases(); find('more').hidden = true; return; } } void read(true); };
  find('refresh').addEventListener('click', refresh); find('more').addEventListener('click', more); find('search').addEventListener('input', search); void read();
  return () => { cleanupClinical(); disposed = true; queueController?.abort(); detailController?.abort(); find('refresh')?.removeEventListener('click', refresh); find('more')?.removeEventListener('click', more); find('search')?.removeEventListener('input', search); };
}

import { apiFetch, authEnabled, authState } from '../../auth/service.js';
import { specialtyCodes, specialtyLabels } from '../../../shared/routing.js';
import './doctor.css';
import { clinicalMarkup, mountClinical } from './clinical.js';
import { patientDisplayName, patientSearchText } from './patient-name.js';
import { mountDoctorMotion } from './motion.js';
import { mountLabReports } from './lab-reports.js';

export const renderDoctor = () => `<section class="role-page doctor-page" aria-labelledby="page-heading">
  <nav class="doctor-nav" aria-label="Doctor workspace"><a class="doctor-nav-brand" href="#doctor-inbox">Doctor Portal</a><a href="#doctor-inbox">Cases</a><a href="#doctor-review-workspace">Review</a></nav>
  <header class="doctor-hero"><div><h1 class="eyebrow doctor-workspace-heading" id="page-heading" tabindex="-1">SmartCareOps / Doctor workspace · Fictional demo</h1></div></header>
  <div class="doctor-workspace-grid">
  <section class="doctor-inbox" id="doctor-inbox" aria-labelledby="doctor-inbox-heading">
    <div class="doctor-section-heading"><div><h2 id="doctor-inbox-heading">Cases</h2></div><button id="doctor-refresh" type="button">Refresh cases</button></div>
    <div class="doctor-search-wrap"><label for="doctor-search">Search cases</label><div class="doctor-search-control"><span aria-hidden="true">⌕</span><input id="doctor-search" type="search" autocomplete="off" placeholder="Patient name or case ID" aria-controls="doctor-search-results"></div><div id="doctor-search-results" class="doctor-search-results" role="listbox" aria-label="Case search results" hidden></div></div>
    <div class="doctor-inbox-status" data-state="loading"><span id="doctor-message" role="status" aria-live="polite"></span></div>
    <div class="doctor-recent-heading"><div><h2>Recent</h2></div><p>Latest 3</p></div>
    <div id="doctor-cases" class="doctor-cases"></div>
    <button id="doctor-more" class="doctor-more" type="button" hidden>Load more cases</button>
  </section>
  <div class="doctor-case-column" id="doctor-review-workspace">
    <div class="doctor-review-toolbar">
      <button id="doctor-back" class="doctor-back" type="button">← Back to inbox</button>
      <div id="doctor-review-context" class="doctor-review-context" aria-live="polite"><span>No case selected</span><small>Choose a case from the clinical inbox.</small></div>
      <nav id="doctor-case-nav" class="doctor-case-nav" aria-label="Case review sections" hidden>
        <button type="button" data-review-target="doctor-evidence-section">Patient report</button>
        <button type="button" data-review-target="doctor-analysis-section">AI summary</button>
        <button type="button" data-review-target="doctor-recommendation-section">Next step</button>
        <button type="button" data-review-target="doctor-decision-section">Decision</button>
      </nav>
    </div>
    <div id="doctor-review-scroll" class="doctor-review-scroll">
      <aside id="doctor-review-placeholder" class="doctor-review-placeholder"><p class="eyebrow">Case review</p><h2>Select a case to begin</h2><p>Patient identity, reported evidence, and available clinical review will appear here after you open a case from the inbox.</p></aside>
      <section id="doctor-detail" class="doctor-detail" aria-labelledby="doctor-detail-heading" hidden></section>
      ${clinicalMarkup}
    </div>
  </div>
  </div>
</section>`;

const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
const dateLabel = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded';
const field = (parent, name, value) => { const p = document.createElement('p'); if (name === 'PROFILE IDENTITY') p.className = 'doctor-profile-identity'; p.append(text('strong', `${name}: `), document.createTextNode(value || 'Not reported')); parent.append(p); };
export function mountDoctor(outlet) {
  const cleanupClinical = mountClinical(outlet);
  const cleanupMotion = mountDoctorMotion(outlet.querySelector('.doctor-page'));
  const find = name => outlet.querySelector(`#doctor-${name}`);
  const page = outlet.querySelector('.doctor-page');
  const currentSpecialties = authEnabled ? authState().identity?.user?.specialties || [] : [];
  if (currentSpecialties.length) {
    const hero = page.querySelector('.doctor-hero > div');
    const access = document.createElement('div'); access.className = 'doctor-specialty-access';
    const accessLabel = text('span', 'Verified specialties', 'doctor-specialty-access-label');
    const specialties = document.createElement('ul'); specialties.className = 'doctor-specialty-list'; specialties.setAttribute('aria-label', 'Verified specialties');
    for (const value of currentSpecialties) specialties.append(text('li', specialtyLabels[value] || value, 'doctor-specialty-indicator'));
    access.append(accessLabel, specialties); hero?.append(access);
    const available = specialtyCodes.filter(value => !currentSpecialties.includes(value));
    if (available.length) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'doctor-specialty-toggle';
      toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'doctor-specialty-request');
      const toggleIcon = document.createElement('span'); toggleIcon.className = 'doctor-specialty-toggle-icon'; toggleIcon.setAttribute('aria-hidden', 'true');
      const toggleLabel = text('span', 'Add specialty'); toggle.append(toggleIcon, toggleLabel); access.append(toggle);
      const form = document.createElement('form'); form.className = 'doctor-specialty-request'; form.id = 'doctor-specialty-request'; form.hidden = true;
      const heading = text('h2', 'Request specialty access'); heading.id = 'doctor-specialty-request-heading'; form.setAttribute('aria-labelledby', heading.id);
      const label = text('label', 'Specialty');
      const select = document.createElement('select'); select.name = 'specialty';
      for (const value of available) { const option = document.createElement('option'); option.value = value; option.textContent = specialtyLabels[value] || value; select.append(option); }
      const button = text('button', 'Send request'); button.type = 'submit';
      const status = text('p', 'A separate Admin verification is required for each specialty.'); status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite'); label.append(select); form.append(heading, label, button, status); hero?.append(form);
      const setExpanded = expanded => {
        form.hidden = !expanded; toggle.setAttribute('aria-expanded', String(expanded));
        toggleLabel.textContent = expanded ? 'Close' : 'Add specialty';
        if (expanded) select.focus(); else toggle.focus();
      };
      toggle.addEventListener('click', () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true'));
      form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); } });
      form.addEventListener('submit', async event => {
        event.preventDefault(); button.disabled = true; status.textContent = 'Submitting specialty application…';
        try {
          const displayName = authState().identity?.user?.displayName;
          const response = await apiFetch('/api/doctor/application', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName, specialty: select.value }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.code === 'DOCTOR_ACCESS_ALREADY_GRANTED' ? 'This specialty is already verified.' : result.message || 'The specialty application could not be saved.');
          status.textContent = `${specialtyLabels[result.application.specialty] || result.application.specialty} application submitted for Admin verification.`;
        } catch (error) { status.textContent = error.message || 'The specialty application could not be saved.'; button.disabled = false; }
      });
    }
  }
  const reviewScroll = find('review-scroll');
  const reviewNav = find('case-nav');
  let disposed = false, queueController, detailController, generation = 0, detailGeneration = 0, nextCursor, selected, expanded = false;
  const evidenceUrls = new Set();
  const clearEvidenceUrls = () => { evidenceUrls.forEach(url => URL.revokeObjectURL(url)); evidenceUrls.clear(); };
  const seen = new Set(), loadedCases = new Map();
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const updateReviewNav = targetId => {
    reviewNav.querySelectorAll('[data-review-target]').forEach(button => {
      const active = button.dataset.reviewTarget === targetId;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
    });
  };
  const navigateReview = event => {
    const button = event.target.closest('[data-review-target]'); if (!button) return;
    const target = outlet.querySelector(`#${button.dataset.reviewTarget}`); if (!target) return;
    const rootTop = reviewScroll.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    reviewScroll.scrollTo({ top: reviewScroll.scrollTop + targetTop - rootTop - 12, behavior: reducedMotion() ? 'auto' : 'smooth' });
    const heading = target.querySelector('h2, h3, h4') || target;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    updateReviewNav(button.dataset.reviewTarget);
  };
  const updateReviewPosition = () => {
    const targets = [...reviewNav.querySelectorAll('[data-review-target]')].map(button => button.dataset.reviewTarget).map(id => outlet.querySelector(`#${id}`)).filter(Boolean);
    if (!targets.length) return;
    const rootTop = reviewScroll.getBoundingClientRect().top + 28;
    const current = targets.reduce((active, target) => target.getBoundingClientRect().top <= rootTop ? target : active, targets[0]);
    updateReviewNav(current.id);
  };
  const backToInbox = () => {
    page.classList.remove('doctor-case-open');
    find('inbox').scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    outlet.querySelector(`.doctor-card[data-case-id="${CSS.escape(selected || '')}"] .doctor-card-open`)?.focus({ preventScroll: true });
  };
  async function fetchJson(path, signal) {
    const response = await apiFetch(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Unavailable');
    return response.json();
  }
  async function detail(id, focus = true) {
    clearEvidenceUrls();
    selected = id; detailController?.abort(); detailController = new AbortController();
    const current = ++detailGeneration;
    page.classList.add('doctor-case-open');
    find('review-placeholder').hidden = true;
    reviewNav.hidden = false;
    find('cases').querySelectorAll('.doctor-card').forEach(card => card.classList.toggle('doctor-card-selected', card.dataset.caseId === id));
    const panel = find('detail'); panel.hidden = false; panel.replaceChildren(text('p', 'Loading case…'));
    try {
      const record = await fetchJson(`/api/doctor/cases/${id}`, detailController.signal);
      if (disposed || current !== detailGeneration) return;
      if (record.caseId !== id || record.routing?.status !== 'routed' && record.workflowStatus !== 'submitted_for_clinical_review') throw new Error('Unavailable');
      panel.replaceChildren();
      cleanupClinical.select?.(id);
      const caseHeader = document.createElement('header'); caseHeader.className = 'doctor-case-header';
      const identity = document.createElement('div'); identity.className = 'doctor-case-identity';
      const heading = text('h2', 'Patient'); heading.id = 'doctor-detail-heading'; heading.tabIndex = -1; identity.append(heading);
      const profileName = document.createElement('p'); profileName.className = 'doctor-profile-name'; profileName.append(document.createTextNode(patientDisplayName(record.patientIdentity, record.patient)));
      const reportedName = document.createElement('p'); reportedName.className = 'doctor-reported-name'; reportedName.append(text('strong', 'Name used during intake: '), document.createTextNode(record.patient.preferredName || record.patient.name || 'Not reported'));
      identity.append(profileName, reportedName);
      const caseMeta = document.createElement('dl'); caseMeta.className = 'doctor-case-meta';
      for (const [name, value] of [['Status', record.routing?.status === 'unassigned' ? 'Specialist unavailable' : record.routing?.status === 'routed' ? 'Ready for review' : 'Waiting for review'], ['Urgency', record.emergency ? 'Emergency' : 'Routine'], ['Specialty', specialtyLabels[record.routing?.specialty] || 'Not assigned'], ['Received', dateLabel(record.createdAt)]]) {
        const item = document.createElement('div'); item.append(text('dt', `${name}: `), text('dd', value)); caseMeta.append(item);
      }
      caseHeader.append(identity, caseMeta); panel.append(caseHeader);
      const displayName = patientDisplayName(record.patientIdentity, record.patient);
      find('review-context').replaceChildren(text('span', displayName), text('small', `${record.routing?.status === 'routed' ? `Routed to ${specialtyLabels[record.routing.specialty] || 'Doctor'}` : record.routing?.status === 'unassigned' ? 'Specialist unavailable · unassigned' : 'Waiting for clinical review'} · ${record.caseId}`));
      const evidence = document.createElement('section'); evidence.className = 'doctor-zone doctor-evidence-zone'; evidence.setAttribute('aria-labelledby', 'doctor-evidence-heading');
      evidence.id = 'doctor-evidence-section';
      const evidenceIntro = document.createElement('div'); evidenceIntro.className = 'doctor-zone-heading';
      const evidenceHeading = text('h3', 'Patient report'); evidenceHeading.id = 'doctor-evidence-heading'; evidenceIntro.append(evidenceHeading, text('p', 'Confirmed details from the intake.'));
      evidence.append(evidenceIntro);
      const evidenceGrid = document.createElement('div'); evidenceGrid.className = 'doctor-evidence-grid';
      const intakeEntries = Object.entries(record.intakeSummary || {});
      const atAGlance = document.createElement('section'); atAGlance.className = 'doctor-evidence-panel doctor-evidence-summary'; atAGlance.append(text('h4', 'At a glance'));
      const usefulEntries = intakeEntries.filter(([name, value]) => name !== 'Patient Name' && String(value || '').trim() && !/^not reported$/i.test(String(value).trim()));
      const glanceOrder = ['Reported Symptoms', 'Onset / Duration', 'Notes'];
      const glanceEntries = [
        ...glanceOrder.map(name => usefulEntries.find(([entryName]) => entryName === name)).filter(Boolean),
        ...usefulEntries.filter(([name]) => !glanceOrder.includes(name) && !['Shortness of Breath', 'Chest Pain'].includes(name)),
      ].slice(0, 4);
      for (const [name, value] of glanceEntries) field(atAGlance, name, value);
      if (!glanceEntries.length) atAGlance.append(text('p', 'No symptoms or timing details were reported.'));
      const fullIntake = document.createElement('details'); fullIntake.className = 'doctor-evidence-more doctor-intake-details'; fullIntake.append(text('summary', 'Full intake details'));
      const summary = document.createElement('section'); summary.className = 'doctor-evidence-panel doctor-evidence-summary'; summary.append(text('h4', 'Intake summary'));
      for (const [name, value] of intakeEntries) field(summary, name, value);
      fullIntake.append(summary);
      const facts = document.createElement('section'); facts.className = 'doctor-evidence-panel'; facts.append(text('h4', 'Patient’s words'));
      for (const fact of [...record.reportedFacts.symptoms, ...record.reportedFacts.redFlags]) field(facts, `${fact.name || fact.type} (${fact.status})`, fact.patientReportedText);
      const denied = [...record.reportedFacts.symptoms, ...record.reportedFacts.redFlags].filter(fact => fact.status === 'denied').map(fact => fact.name || fact.type).join(', ');
      field(facts, 'Denied symptoms', denied || 'None recorded');
      evidenceGrid.append(atAGlance);
      const labReports = document.createElement('details'); labReports.className = 'doctor-evidence-more doctor-lab-details'; labReports.append(text('summary', 'Laboratory reports'));
      labReports.append(mountLabReports(record.caseId, { signal: detailController.signal }));
      const moreEvidence = document.createElement('details'); moreEvidence.className = 'doctor-evidence-more';
      moreEvidence.append(text('summary', 'More patient evidence'));
      const moreEvidenceBody = document.createElement('div'); moreEvidenceBody.className = 'doctor-evidence-more-body'; moreEvidenceBody.append(facts);
      if (record.medications?.length) {
        const medicines = document.createElement('section'); medicines.className = 'doctor-evidence-panel'; medicines.append(text('h4', 'Medicines shown during intake'));
        for (const medication of record.medications) {
          field(medicines, 'Patient-reported; packaging shown', `${medication.name} · ${medication.strength}`);
          field(medicines, 'How the patient says they take it', medication.howTaken);
          if (medication.imageEvidence?.status !== 'available') medicines.append(text('p', 'Packaging image unavailable. The confirmed patient-reported text remains available.', 'doctor-evidence-note'));
        }
        medicines.append(text('p', 'Patient-reported information from packaging shown. Not clinically verified.', 'doctor-evidence-note'));
        moreEvidenceBody.append(medicines);
      }
      if (record.patientEvidence?.length) {
        const shared = document.createElement('section'); shared.className = 'doctor-evidence-panel doctor-shared-evidence'; shared.append(text('h4', 'Patient-shared images'));
        for (const item of record.patientEvidence) {
          const article = document.createElement('article'); article.className = 'doctor-shared-evidence-item';
          article.append(text('h5', item.label || 'Patient-shared image'), text('p', item.patientDescription || 'No patient description was provided.'));
          if (item.kind === 'body_area') article.append(text('p', 'Patient-reported location evidence only. The image is not a diagnosis or verified anatomical finding.', 'doctor-evidence-note'));
          if (item.status !== 'available') article.append(text('p', 'The image is unavailable. The patient description remains available.', 'doctor-evidence-note'));
          else {
            const state = text('p', 'Loading shared image…', 'doctor-evidence-note'); state.setAttribute('role', 'status'); article.append(state); shared.append(article);
            void apiFetch(`/api/doctor/cases/${record.caseId}/evidence/${encodeURIComponent(item.evidenceId)}`, { cache: 'no-store', signal: detailController.signal }).then(async response => {
              if (!response.ok) throw new Error('IMAGE_UNAVAILABLE');
              const blob = await response.blob(); if (!blob.type.startsWith('image/')) throw new Error('IMAGE_UNAVAILABLE');
              if (disposed || current !== detailGeneration) return;
              const image = document.createElement('img'); image.className = 'doctor-evidence-image'; image.alt = `Patient-shared image: ${item.label || 'reported evidence'}`;
              const objectUrl = URL.createObjectURL(blob); evidenceUrls.add(objectUrl);
              image.addEventListener('error', () => { if (detailController.signal.aborted) return; URL.revokeObjectURL(objectUrl); evidenceUrls.delete(objectUrl); state.textContent = 'The shared image is temporarily unavailable. The patient description remains available.'; image.replaceWith(state); }, { once: true });
              image.src = objectUrl;
              state.replaceWith(image);
            }).catch(() => { if (!disposed && current === detailGeneration) state.textContent = 'The shared image is temporarily unavailable. The patient description remains available.'; });
          }
          if (item.status !== 'available') shared.append(article);
        }
        moreEvidenceBody.append(shared);
      }
      moreEvidence.append(moreEvidenceBody);
      evidence.append(evidenceGrid, fullIntake, labReports, moreEvidence);
      const context = document.createElement('details'); context.className = 'doctor-case-context';
      const contextSummary = text('summary', 'Routing and handoff context'); context.append(contextSummary);
      const contextBody = document.createElement('div'); contextBody.className = 'doctor-case-context-grid';
      field(contextBody, 'Specialty', specialtyLabels[record.routing?.specialty]); field(contextBody, 'Reason', record.routing?.reasonSummary); field(contextBody, 'Routed', dateLabel(record.routing?.routedAt));
      field(contextBody, 'Handoff status', record.handoffStatus); field(contextBody, 'Hospital receipt', record.handoffReceipt?.caseId || 'No receipt recorded');
      if (record.appointmentRequest?.state === 'requested') {
        field(contextBody, 'Patient-selected facility', record.appointmentRequest.selection?.hospitalName || 'Fictional facility');
        field(contextBody, 'Requested time', [record.appointmentRequest.selection?.date, record.appointmentRequest.selection?.time].filter(Boolean).join(' ') || 'Not available');
        field(contextBody, 'Appointment request', 'Simulated request recorded — not a confirmed booking');
        field(contextBody, 'Contact status', 'No hospital or Doctor was contacted');
      }
      context.append(contextBody);
      panel.append(evidence, context);
      reviewScroll.scrollTop = 0;
      updateReviewNav('doctor-evidence-section');
      if (focus) heading.focus();
    } catch {
      if (!disposed && current === detailGeneration) panel.replaceChildren(text('p', 'Case could not be loaded. Refresh to retry.'));
    }
  }
  function card(record) {
    const article = document.createElement('article'); article.className = `doctor-card${selected === record.caseId ? ' doctor-card-selected' : ''}`; article.dataset.caseId = record.caseId;
    const copy = document.createElement('div'); copy.className = 'doctor-card-copy'; copy.append(text('span', specialtyLabels[record.routing?.specialty] || 'Clinical review', 'badge'), text('h2', patientDisplayName(record.patientIdentity, record.patient)), text('p', record.mainReportedSymptom || 'Reported symptom not summarized', 'doctor-card-symptom'), text('small', `${record.routing?.status === 'routed' ? `Routed to ${specialtyLabels[record.routing.specialty] || 'Doctor'}` : record.routing?.status === 'unassigned' ? 'Specialist unavailable · unassigned' : 'Waiting for clinical review'} · ${dateLabel(record.createdAt)}`));
    const button = text('button', 'Open'); button.type = 'button'; button.className = 'doctor-card-open'; button.setAttribute('aria-label', `Open case ${record.caseId}`); button.addEventListener('click', () => void detail(record.caseId)); article.append(copy, button);
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
    find('message').textContent = 'Loading routed cases…'; find('message').parentElement.dataset.state = 'loading'; find('more').hidden = true;
    try {
      const result = await fetchJson(`/api/doctor/cases${more && nextCursor ? `?after=${encodeURIComponent(nextCursor)}` : ''}`, queueController.signal);
      if (disposed || current !== generation) return;
      for (const record of result.cases) if (!seen.has(record.caseId)) { seen.add(record.caseId); loadedCases.set(record.caseId, record); }
      renderCases(); nextCursor = result.nextCursor; find('more').hidden = expanded ? !nextCursor : loadedCases.size <= 3 && !nextCursor;
      find('message').textContent = seen.size ? `${seen.size} routed case${seen.size === 1 ? '' : 's'}${result.storage === 'memory' ? ' · Memory — dev only' : ''}` : 'No routed cases yet.';
      find('message').parentElement.dataset.state = seen.size ? 'ready' : 'empty';
      if (!more && selected) void detail(selected, false);
    } catch {
      if (!disposed && current === generation) { find('message').textContent = 'Queue unavailable. Refresh to retry.'; find('message').parentElement.dataset.state = 'error'; find('more').hidden = !nextCursor; }
    }
  }
  const refresh = () => void read(), more = () => { if (!expanded) { expanded = true; if (!nextCursor) { renderCases(); find('more').hidden = true; return; } } void read(true); };
  find('refresh').addEventListener('click', refresh); find('more').addEventListener('click', more); find('search').addEventListener('input', search);
  find('back').addEventListener('click', backToInbox); reviewNav.addEventListener('click', navigateReview); reviewScroll.addEventListener('scroll', updateReviewPosition, { passive: true }); void read();
  return () => { cleanupMotion(); cleanupClinical(); disposed = true; clearEvidenceUrls(); queueController?.abort(); detailController?.abort(); find('refresh')?.removeEventListener('click', refresh); find('more')?.removeEventListener('click', more); find('search')?.removeEventListener('input', search); find('back')?.removeEventListener('click', backToInbox); reviewNav?.removeEventListener('click', navigateReview); reviewScroll?.removeEventListener('scroll', updateReviewPosition); };
}

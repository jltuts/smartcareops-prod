import './admin.css';
import { apiFetch } from '../../auth/service.js';
import { specialtyLabels } from '../../../shared/routing.js';

export const renderAdmin = () => `<section class="role-page admin-page" aria-labelledby="page-heading">
  <p class="eyebrow">SmartCareOps / Admin workspace</p>
  <div class="admin-heading"><div><h1 id="page-heading" tabindex="-1">Admin controls</h1><p class="role-subtitle">Manage access requests and reset fictional test data.</p></div><button class="admin-refresh" id="admin-refresh" type="button">Refresh applications</button></div>
  <section class="admin-section" aria-labelledby="doctor-applications-heading"><h2 id="doctor-applications-heading">Doctor applications</h2><aside class="admin-review-boundary"><strong>Verify before approving</strong><p>Independently confirm the applicant’s identity and professional credentials for the requested specialty. Approval grants Doctor workspace access; SmartCareOps does not perform that verification.</p></aside><p class="admin-status" id="doctor-status" role="status" aria-live="polite" tabindex="-1">Loading pending applications…</p><div class="admin-application-list" id="doctor-application-list" aria-busy="true"></div><button class="admin-load-more" id="doctor-load-more" type="button" hidden>Load more Doctor applications</button></section>
  <section class="admin-section" aria-labelledby="approved-doctors-heading"><h2 id="approved-doctors-heading">Approved Doctors</h2><button class="admin-refresh" id="approved-doctors-refresh" type="button">Refresh approved Doctors</button><p class="admin-status" id="approved-doctors-status" role="status" aria-live="polite" tabindex="-1">Loading approved Doctors…</p><div class="admin-application-list" id="approved-doctors-list" aria-busy="true"></div><button class="admin-load-more" id="approved-doctors-more" type="button" hidden>Load more approved Doctors</button></section>
  <section class="admin-section" aria-labelledby="patient-applications-heading"><h2 id="patient-applications-heading">Patient applications</h2><p>Approve only people who should be able to start an intake using the project’s Gemini credits.</p><p class="admin-status" id="patient-status" role="status" aria-live="polite" tabindex="-1">Loading pending applications…</p><div class="admin-application-list" id="patient-application-list" aria-busy="true"></div><button class="admin-load-more" id="patient-load-more" type="button" hidden>Load more Patient applications</button></section>
  <section class="admin-section" aria-labelledby="patient-access-heading"><h2 id="patient-access-heading">Patient Portal access</h2><p>Open access lets any signed-in account use the Patient Portal. Approved-only access requires an Admin approval before an intake can start. Configured administrators retain Patient access for testing.</p><div class="admin-access-controls"><label for="patient-access-mode">Who can use the Patient Portal?</label><select id="patient-access-mode"><option value="open">Anyone signed in</option><option value="approved_only">Approved patients only</option></select><button id="save-patient-access" type="button">Save access setting</button></div><p class="admin-status" id="patient-access-status" role="status" aria-live="polite">Loading access setting…</p></section>
  <section class="admin-section admin-purge-section" aria-labelledby="purge-heading"><h2 id="purge-heading">Purge test data</h2><p>This removes only the server-listed SmartCareOps case, private evidence object, intake/session, simulated appointment, notification, operational/demo, and non-Admin profile/application data that currently exists. Before deletion, new writers are paused and active intake writers are invalidated. It preserves every configured Admin profile, access-policy definition, audit receipts, Firebase sign-in accounts, infrastructure, secrets, and cloud configuration.</p><button id="preview-purge" type="button">Preview data to purge</button><p class="admin-status" id="purge-status" role="status" aria-live="polite">No data has been deleted.</p><div id="purge-preview" class="purge-preview" hidden></div><label for="purge-confirmation">To enable deletion, type <strong>PURGE ALL TEST DATA</strong></label><input id="purge-confirmation" type="text" autocomplete="off" spellcheck="false" disabled><button id="purge-submit" class="admin-purge-button" type="button" disabled>Purge all test data</button></section>
  <section class="admin-section admin-receipts" aria-labelledby="admin-receipts-heading"><h2 id="admin-receipts-heading">Validated receipts</h2><p>Successful decisions and policy changes remain listed here while this page is open.</p><ul id="admin-receipt-list"><li>No Admin mutations completed in this view.</li></ul></section>
</section>`;

const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Date unavailable' : date.toLocaleString(); };
const make = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };

export function mountAdmin(root) {
  const refresh = root.querySelector('#admin-refresh');
  const queues = {
    doctor: { list: root.querySelector('#doctor-application-list'), status: root.querySelector('#doctor-status'), more: root.querySelector('#doctor-load-more'), title: 'Doctor', cursor: null },
    patient: { list: root.querySelector('#patient-application-list'), status: root.querySelector('#patient-status'), more: root.querySelector('#patient-load-more'), title: 'Patient', cursor: null },
  };
  const directory = { list: root.querySelector('#approved-doctors-list'), status: root.querySelector('#approved-doctors-status'),
    refresh: root.querySelector('#approved-doctors-refresh'), more: root.querySelector('#approved-doctors-more'), cursor: null };
  let busy = false, purgePreview = null, purgeKey = null, policyVersion = null;
  const operationKeys = new Map(), receiptList = root.querySelector('#admin-receipt-list');
  const status = (node, text) => { node.textContent = text; };
  const keyFor = name => { if (!operationKeys.has(name)) operationKeys.set(name, crypto.randomUUID()); return operationKeys.get(name); };
  const addReceipt = (label, receipt) => {
    if (!receipt?.receiptId) throw new Error('The backend returned an invalid receipt. Refresh before continuing.');
    if (receiptList.children.length === 1 && receiptList.firstElementChild.textContent.startsWith('No Admin')) receiptList.replaceChildren();
    receiptList.append(make('li', '', `${label}: ${receipt.receiptId}`));
  };
  const decision = async (kind, application, choice, card, verified = false) => {
    if (busy) return;
    if (!window.confirm(`${choice === 'approved' ? 'Approve' : 'Reject'} this ${kind} application?`)) return;
    busy = true; card.querySelectorAll('button,input').forEach(control => { control.disabled = true; });
    const queue = queues[kind]; status(queue.status, `${choice === 'approved' ? 'Approving' : 'Rejecting'} ${kind} application…`);
    try {
      const operation = `${kind}:${application.uid}:${application.version}:${choice}`;
      const response = await apiFetch(`/api/admin/${kind}-applications/${encodeURIComponent(application.uid)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyFor(operation) }, body: JSON.stringify({ decision: choice, applicationVersion: application.version, confirmed: true, ...(kind === 'doctor' && choice === 'approved' ? { independentlyVerified: verified } : {}) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || 'The application could not be reviewed.');
      addReceipt(`${queue.title} application ${choice}`, result.receipt); operationKeys.delete(operation);
      await loadQueue(kind, true); if (kind === 'doctor' && choice === 'approved') await loadApprovedDoctors();
      status(queue.status, `${kind === 'doctor' ? 'Doctor access' : 'Patient access'} ${choice}. Receipt ${result.receipt.receiptId}.`); queue.status.focus();
    } catch (error) { card.querySelectorAll('button,input').forEach(control => { control.disabled = false; }); status(queue.status, error.message || 'The application could not be reviewed. Refresh and try again.'); }
    finally { busy = false; }
  };
  const renderApplication = (kind, app) => {
    const title = kind === 'doctor' ? app.displayName || 'Name not provided' : app.displayName || app.email || 'Patient account';
    const card = make('article', 'admin-application'); card.append(make('h3', '', title));
    const details = document.createElement('dl'); details.className = 'admin-application-details';
    const fields = [['Email', app.email || 'Not provided'], ['Submitted', dateLabel(app.submittedAt)]];
    if (kind === 'doctor') fields.splice(1, 0, ['Requested specialty', specialtyLabels[app.specialty] || 'Specialty unavailable']);
    for (const [label, value] of fields) details.append(make('dt', '', label), make('dd', '', value));
    const actions = make('div', 'admin-application-actions');
    if (kind === 'doctor') {
      const label = make('label', 'admin-verification'), check = document.createElement('input'); check.type = 'checkbox';
      label.append(check, document.createTextNode(' I independently verified this applicant’s identity and professional credentials for this specialty.'));
      const approve = make('button', 'admin-approve', 'Approve Doctor access'); approve.type = 'button'; approve.disabled = true;
      check.addEventListener('change', () => { approve.disabled = !check.checked || busy; });
      approve.addEventListener('click', () => { if (check.checked) void decision(kind, app, 'approved', card, true); });
      actions.append(approve, label);
    } else {
      const approve = make('button', 'admin-approve', 'Approve Patient access'); approve.type = 'button';
      approve.addEventListener('click', () => void decision(kind, app, 'approved', card)); actions.append(approve);
    }
    const reject = make('button', 'admin-reject', 'Reject application'); reject.type = 'button';
    reject.addEventListener('click', () => void decision(kind, app, 'rejected', card));
    actions.append(reject); card.append(details, actions); return card;
  };
  async function loadQueue(kind, duringDecision = false, append = false) {
    if (busy && !duringDecision) return;
    const queue = queues[kind], list = queue.list; list.setAttribute('aria-busy', 'true'); if (!append) { list.replaceChildren(); queue.cursor = null; } status(queue.status, `Loading pending ${kind} applications…`);
    try {
      const query = new URLSearchParams({ limit: '25', ...(append && queue.cursor ? { cursor: queue.cursor } : {}) });
      const response = await apiFetch(`/api/admin/${kind}-applications?${query}`, { cache: 'no-store' }), result = await response.json();
      if (!response.ok || !Array.isArray(result.applications)) throw new Error(result.message || `Pending ${kind} applications are unavailable.`);
      if (!result.applications.length && !append) { list.append(make('p', 'admin-empty', `No pending ${kind} applications.`)); status(queue.status, 'Applications are up to date.'); }
      else { result.applications.forEach(app => list.append(renderApplication(kind, app))); status(queue.status, `${list.querySelectorAll('.admin-application').length} pending ${kind} applications shown.`); }
      queue.cursor = result.nextCursor || null; queue.more.hidden = !queue.cursor;
    } catch (error) { status(queue.status, error.message || `Pending ${kind} applications are unavailable.`); }
    finally { list.setAttribute('aria-busy', 'false'); }
  }
  const removeDoctorSpecialty = async (doctor, specialty, card) => {
    if (busy) return;
    const specialties = doctor.specialties || [doctor.specialty].filter(Boolean), label = specialtyLabels[specialty] || specialty;
    const finalSpecialty = specialties.length === 1;
    const warning = finalSpecialty
      ? `Remove ${label} from ${doctor.displayName}? This is the Doctor’s final verified specialty and will remove Doctor Portal access.`
      : `Remove ${label} from ${doctor.displayName}? The Doctor will keep access through the remaining verified specialties.`;
    if (!window.confirm(warning)) return;
    busy = true; card.querySelectorAll('button').forEach(control => { control.disabled = true; });
    const operation = `doctor-specialty:${doctor.uid}:${specialty}:${specialties.join(',')}`;
    status(directory.status, `Removing ${label} from ${doctor.displayName}…`);
    try {
      const response = await apiFetch(`/api/admin/approved-doctors/${encodeURIComponent(doctor.uid)}/specialties/${encodeURIComponent(specialty)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyFor(operation) },
        body: JSON.stringify({ expectedSpecialties: specialties, confirmed: true }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) { operationKeys.delete(operation); await loadApprovedDoctors(); throw new Error('The Doctor’s specialties changed. The directory has been refreshed.'); }
        throw new Error(result.message || 'The specialty could not be removed.');
      }
      addReceipt(`${label} removed from ${doctor.displayName}`, result.receipt); operationKeys.delete(operation);
      await loadApprovedDoctors();
      status(directory.status, finalSpecialty
        ? `${label} removed. ${doctor.displayName} no longer has Doctor Portal access. Receipt ${result.receipt.receiptId}.`
        : `${label} removed from ${doctor.displayName}. Receipt ${result.receipt.receiptId}.`);
      directory.status.focus();
    } catch (error) {
      card.querySelectorAll('button').forEach(control => { control.disabled = false; });
      status(directory.status, error.message || 'The specialty could not be removed. Refresh and try again.');
    } finally { busy = false; }
  };
  const renderApprovedDoctor = doctor => {
    const card = make('article', 'admin-application');
    card.append(make('h3', '', doctor.displayName || 'Name unavailable'));
    const details = make('dl', 'admin-application-details');
    for (const [label, value] of [
      ['Account email', doctor.email || 'Not provided'], ['Approval status', 'Approved'],
      ['Approval date', dateLabel(doctor.approvedAt)],
    ]) details.append(make('dt', '', label), make('dd', '', value));
    const specialtyGroup = make('div', 'admin-doctor-specialties'); specialtyGroup.append(make('strong', '', 'Verified specialties'));
    const specialtyList = make('ul', 'admin-doctor-specialty-list');
    for (const specialty of doctor.specialties || [doctor.specialty].filter(Boolean)) {
      const item = document.createElement('li'), label = specialtyLabels[specialty] || specialty;
      item.append(make('span', '', label));
      const remove = make('button', 'admin-remove-specialty', 'Remove'); remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${label} from ${doctor.displayName || 'Doctor'}`);
      remove.addEventListener('click', () => void removeDoctorSpecialty(doctor, specialty, card)); item.append(remove); specialtyList.append(item);
    }
    specialtyGroup.append(specialtyList);
    card.append(specialtyGroup, details, make('small', 'admin-doctor-uid', `Doctor UID: ${doctor.uid}`)); return card;
  };
  async function loadApprovedDoctors(append = false) {
    const { list, more } = directory;
    list.setAttribute('aria-busy', 'true');
    if (!append) { list.replaceChildren(); directory.cursor = null; }
    status(directory.status, 'Loading approved Doctors…');
    try {
      const query = new URLSearchParams({ limit: '25', ...(append && directory.cursor ? { cursor: directory.cursor } : {}) });
      const response = await apiFetch(`/api/admin/approved-doctors?${query}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.doctors)) throw new Error(result.message || 'Approved Doctors are unavailable.');
      if (!result.doctors.length && !append) list.append(make('p', 'admin-empty', 'No approved Doctors yet.'));
      else result.doctors.forEach(doctor => list.append(renderApprovedDoctor(doctor)));
      directory.cursor = result.nextCursor || null; more.hidden = !directory.cursor;
      status(directory.status, `${list.querySelectorAll('.admin-application').length} approved Doctors shown.`);
    } catch { status(directory.status, 'Approved Doctors are unavailable. Refresh and try again.'); }
    finally { list.setAttribute('aria-busy', 'false'); }
  }
  const refreshAll = () => { void loadQueue('doctor'); void loadQueue('patient'); };
  const refreshDirectory = () => { void loadApprovedDoctors(); };
  const moreDirectory = () => { void loadApprovedDoctors(true); };
  refresh.addEventListener('click', refreshAll);
  directory.refresh.addEventListener('click', refreshDirectory);
  directory.more.addEventListener('click', moreDirectory);
  for (const kind of Object.keys(queues)) queues[kind].more.addEventListener('click', () => void loadQueue(kind, false, true));

  const mode = root.querySelector('#patient-access-mode'), accessStatus = root.querySelector('#patient-access-status'), saveAccess = root.querySelector('#save-patient-access');
  const loadAccess = async () => { try { const response = await apiFetch('/api/admin/settings', { cache: 'no-store' }), result = await response.json(); if (!response.ok || !Number.isSafeInteger(result.version)) throw new Error(); mode.value = result.patientAccessMode; policyVersion = result.version; status(accessStatus, `Current setting: ${mode.options[mode.selectedIndex].text}.`); } catch { policyVersion = null; status(accessStatus, 'Access setting is unavailable. Refresh and try again.'); } };
  const persistAccess = async () => {
    if (!Number.isSafeInteger(policyVersion) || !window.confirm(`Change Patient Portal admission to “${mode.options[mode.selectedIndex].text}”?`)) return;
    saveAccess.disabled = true; const operation = `policy:${policyVersion}:${mode.value}`;
    try { const response = await apiFetch('/api/admin/settings/patient-access', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyFor(operation) }, body: JSON.stringify({ mode: mode.value, expectedVersion: policyVersion, confirmed: true }) }), result = await response.json(); if (!response.ok) { if (response.status === 409) { operationKeys.delete(operation); await loadAccess(); throw new Error('The admission policy changed. The current setting has been refreshed.'); } throw new Error(result.message || 'Setting could not be saved.'); } addReceipt('Patient admission policy', result.receipt); operationKeys.delete(operation); policyVersion = result.version; status(accessStatus, `Saved: ${result.patientAccessMode === 'open' ? 'Anyone signed in' : 'Approved patients only'}. Receipt ${result.receipt.receiptId}.`); }
    catch (error) { status(accessStatus, error.message || 'Setting could not be saved. Refresh the policy before retrying.'); } finally { saveAccess.disabled = false; }
  };
  saveAccess.addEventListener('click', persistAccess); void loadAccess();

  const previewButton = root.querySelector('#preview-purge'), purgeStatus = root.querySelector('#purge-status'), preview = root.querySelector('#purge-preview');
  const confirmation = root.querySelector('#purge-confirmation'), purgeButton = root.querySelector('#purge-submit');
  const refreshPurgeEnabled = () => { purgeButton.disabled = !purgePreview || confirmation.value !== 'PURGE ALL TEST DATA'; };
  const loadPurgePreview = async () => {
    previewButton.disabled = true; purgeButton.disabled = true; status(purgeStatus, 'Counting SmartCareOps test records…'); preview.hidden = true;
    try {
      const response = await apiFetch('/api/admin/purge-preview', { cache: 'no-store' }), result = await response.json();
      if (!response.ok || !result.counts || typeof result.total !== 'number') throw new Error(result.message || 'Purge preview is unavailable.');
      if (!result.previewId || !result.expiresAt) throw new Error('The backend returned an invalid purge preview.');
      purgePreview = result; purgeKey = null; preview.replaceChildren();
      const list = document.createElement('ul');
      for (const [name, count] of Object.entries(result.counts)) list.append(make('li', '', `${name}: ${count}`));
      preview.append(make('strong', '', `${result.total} records would be removed`), list,
        make('p', '', 'Every configured Admin profile, Patient access setting, Firebase sign-in accounts, and cloud configuration will be retained.')); preview.hidden = false;
      confirmation.disabled = false; status(purgeStatus, 'Review the counts, then type the confirmation phrase to enable deletion.');
    } catch (error) { purgePreview = null; confirmation.disabled = true; status(purgeStatus, error.message || 'Purge preview is unavailable.'); }
    finally { previewButton.disabled = false; refreshPurgeEnabled(); }
  };
  const executePurge = async () => {
    if (!purgePreview || confirmation.value !== 'PURGE ALL TEST DATA' || !window.confirm('Permanently delete the previewed SmartCareOps test data? This cannot be undone.')) return;
    purgeButton.disabled = true; previewButton.disabled = true; status(purgeStatus, 'Deleting the previewed test records…');
    try {
      purgeKey ||= crypto.randomUUID();
      const response = await apiFetch('/api/admin/purge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': purgeKey }, body: JSON.stringify({ confirmation: confirmation.value, previewId: purgePreview.previewId }) }), result = await response.json();
      if (!response.ok) { if (response.status === 409) { purgePreview = null; purgeKey = null; status(purgeStatus, 'Data changed or the preview expired. Create and review a fresh preview before retrying.'); return; } if (result.receipt?.status === 'partial_failure') { addReceipt('Partial purge', result.receipt); purgePreview = null; purgeKey = null; status(purgeStatus, `The purge completed only partially. Receipt ${result.receipt.receiptId}. Create a fresh preview to retry the remaining data.`); return; } throw new Error(result.message || 'Purge did not complete.'); }
      addReceipt('Completed purge', result); purgePreview = null; purgeKey = null; confirmation.value = ''; confirmation.disabled = true; preview.hidden = true;
      status(purgeStatus, `${result.total} test records deleted. Receipt ${result.receiptId}. Configured Admin profiles, policy, and audit receipt remain.`); refreshAll(); refreshDirectory();
    } catch (error) { status(purgeStatus, error.message || 'Purge did not complete. Refresh the preview before retrying.'); }
    finally { previewButton.disabled = false; refreshPurgeEnabled(); }
  };
  confirmation.addEventListener('input', refreshPurgeEnabled); previewButton.addEventListener('click', loadPurgePreview); purgeButton.addEventListener('click', executePurge);
  refreshAll(); void loadApprovedDoctors();
  return () => { refresh.removeEventListener('click', refreshAll); directory.refresh.removeEventListener('click', refreshDirectory); directory.more.removeEventListener('click', moreDirectory); saveAccess.removeEventListener('click', persistAccess); previewButton.removeEventListener('click', loadPurgePreview); purgeButton.removeEventListener('click', executePurge); confirmation.removeEventListener('input', refreshPurgeEnabled); };
}

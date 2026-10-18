import { apiFetch } from '../../auth/service.js';
import { ambulanceStatusLabels } from '../../../shared/ambulance.js';
import { isEmergencyWorkflow, emergencyStatusLabels } from '../../../shared/emergency.js';
import { specialtyLabels } from '../../../shared/routing.js';
import { defaultMapAmbulances, defaultMapHospitals, defaultPatientPickup, operationalMapMarkup, renderOperationalMap } from '../../components/operational-map.js';
const idPattern = /^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labels = { submitted_for_clinical_review: 'Waiting for clinical review', intake_completed: 'Intake completed', handoff_pending: 'Handoff pending', handoff_in_progress: 'Handoff in progress', handoff_completed: 'Handoff completed', handoff_failed: 'Handoff failed', emergency_pending_dispatcher: 'Emergency — pending dispatcher', routed_to_doctor: 'Routed to doctor', emergency_acknowledged: 'Emergency — dispatcher acknowledged', ambulance_assigned: 'Ambulance assigned — simulation', ambulance_en_route: 'Ambulance en route — simulation', ambulance_at_pickup: 'Ambulance at pickup — simulation', patient_transporting: 'Transporting to hospital — simulation', arrived_at_hospital: 'Arrived at hospital — simulation', emergency_response_completed: 'Emergency response complete — simulation' };
const clinicalReviewLabels = { pending: 'Waiting for clinical review', approved: 'Clinical review approved', rejected: 'Clinical review rejected', deferred: 'Clinical review deferred' };
export const caseMarkup = () => `<section id="patient-case" class="handoff-panel" hidden aria-labelledby="patient-case-heading"><h2 id="patient-case-heading">Patient Case</h2><p>Case ID: <span id="patient-case-id"></span></p><p>Status: <span id="patient-case-status"></span></p><p id="patient-case-receipt" hidden></p><div id="patient-case-emergency" hidden><h3>Emergency escalation</h3><p id="patient-case-emergency-status" role="status"></p><p>No ambulance or emergency service has been contacted by this demo.</p></div><div id="patient-case-ambulance" hidden><h3>Ambulance — fictional simulation</h3><p id="patient-case-ambulance-status" role="status"></p><div class="patient-transport-layout">${operationalMapMarkup({ id: 'patient-transport-map', title: 'Your transport', description: 'A simple view of the current fictional assignment.', mode: 'patient', legend: ['patient', 'ambulance', 'hospital'] })}<dl class="patient-transport-status"><div><dt>Transport status</dt><dd id="patient-transport-status">Not assigned</dd></div><div><dt>Ambulance</dt><dd id="patient-transport-ambulance">Not assigned</dd></div><div><dt>Current position</dt><dd id="patient-transport-position">Not available</dd></div><div><dt>Pickup</dt><dd id="patient-transport-pickup">Fictional demo pickup</dd></div><div><dt>ETA to pickup</dt><dd id="patient-transport-eta">Not available</dd></div><div><dt>Destination hospital</dt><dd id="patient-transport-destination">Not assigned</dd></div><div><dt>Distance to hospital</dt><dd id="patient-transport-distance">Not available</dd></div><div><dt>Latest update</dt><dd id="patient-transport-updated">Not available</dd></div></dl></div><p>No real ambulance has been dispatched.</p></div><p id="patient-case-routing" role="status"></p><button id="patient-case-refresh" type="button">Refresh case</button></section>`;
export function mountCaseCard(outlet, onRecord = () => {}) {
  const find = name => outlet.querySelector(`#patient-case${name ? `-${name}` : ''}`);
  let caseId, lastRecord, generation = 0, timer, controller, disposed = false, routing = false, routeController;
  const idLine = find('id').closest('p'); idLine.classList.add('patient-case-id-line');
  const copyButton = document.createElement('button'); copyButton.type = 'button'; copyButton.className = 'patient-case-copy-id';
  copyButton.setAttribute('aria-label', 'Copy Case ID'); copyButton.title = 'Copy Case ID';
  copyButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></svg>';
  const copyStatus = document.createElement('span'); copyStatus.className = 'patient-case-copy-status'; copyStatus.setAttribute('role', 'status');
  find('id').after(copyButton, copyStatus);
  const copyCaseId = async () => {
    const currentId = caseId;
    if (!idPattern.test(currentId || '')) return;
    try {
      await navigator.clipboard.writeText(currentId);
      if (caseId === currentId) copyStatus.textContent = 'Copied';
    } catch {
      if (caseId === currentId) copyStatus.textContent = 'Clipboard unavailable. Select the Case ID to copy it.';
    }
  };
  copyButton.addEventListener('click', copyCaseId);
  const identityLine = document.createElement('p');
  const dateLabel = document.createTextNode('Intake date: '), dateValue = document.createElement('span');
  dateValue.id = 'patient-case-date'; identityLine.append(dateLabel, dateValue);
  const doctorLine = document.createElement('p'), doctorValue = document.createElement('span');
  doctorLine.id = 'patient-case-doctor-row'; doctorLine.hidden = true; doctorLine.append(document.createTextNode('Reviewed by: '), doctorValue);
  find('id').closest('p')?.after(identityLine, doctorLine);
  const evidencePanel = document.createElement('section'), evidenceHeading = document.createElement('h3'), evidenceList = document.createElement('div');
  evidencePanel.id = 'patient-case-evidence'; evidencePanel.className = 'patient-case-evidence'; evidencePanel.hidden = true;
  evidenceHeading.textContent = 'Evidence you shared'; evidenceList.id = 'patient-case-evidence-list'; evidencePanel.append(evidenceHeading, evidenceList);
  find('refresh').before(evidencePanel);
  const appointmentPanel = document.createElement('section'); appointmentPanel.className = 'patient-appointment-panel'; appointmentPanel.hidden = true;
  find('refresh').before(appointmentPanel);
  let selectedSlotId = null, responseRequestId = null, responseAction = null, responseBusy = false, appointmentFeedback = '';
  const renderAppointment = record => {
    const proposal = record.appointmentProposal;
    appointmentPanel.hidden = !proposal;
    appointmentPanel.replaceChildren();
    if (!proposal) return;
    const heading = document.createElement('h3'); heading.textContent = 'Fictional appointment proposal'; appointmentPanel.append(heading);
    const detail = document.createElement('p'); detail.textContent = `${proposal.doctor.displayName} · ${specialtyLabels[proposal.doctor.specialty] || proposal.doctor.specialty} · ${proposal.appointmentType} · ${proposal.timeZone}`; appointmentPanel.append(detail);
    const note = document.createElement('p'); note.textContent = 'These are demo times. No real Doctor, clinic, hospital, calendar, or external service has been contacted.'; appointmentPanel.append(note);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = appointmentFeedback || ({ appointment_confirmed: 'Your appointment is confirmed in this fictional demo.', alternate_time_requested: 'Your Doctor will propose another time.', awaiting_patient_confirmation: 'Choose a time, then explicitly confirm it.' }[proposal.state] || 'Appointment proposed.'); appointmentPanel.append(status);
    const format = value => new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: proposal.timeZone }).format(new Date(value));
    const list = document.createElement('div'); list.className = 'patient-appointment-slots';
    for (const slot of proposal.slots) {
      const label = document.createElement('label'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'patient-appointment-slot'; radio.value = slot.slotId; radio.disabled = proposal.state !== 'awaiting_patient_confirmation' || responseBusy;
      radio.checked = selectedSlotId === slot.slotId || proposal.confirmedSlotId === slot.slotId;
      radio.addEventListener('change', () => { selectedSlotId = slot.slotId; responseRequestId = null; });
      label.append(radio, document.createTextNode(`${format(slot.startAt)}–${format(slot.endAt)} (${proposal.timeZone})`)); list.append(label);
    }
    appointmentPanel.append(list);
    if (proposal.state !== 'awaiting_patient_confirmation') return;
    const controls = document.createElement('div'); controls.className = 'patient-appointment-actions';
    const act = (label, action) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = responseBusy;
      button.addEventListener('click', () => {
        if (action === 'confirm' && !selectedSlotId) { appointmentFeedback = 'Select a proposed time before confirming.'; renderAppointment(record); return; }
        if (responseAction !== action) responseRequestId = null;
        responseAction = action; responseRequestId ||= crypto.randomUUID(); responseBusy = true; appointmentFeedback = 'Saving your response…'; renderAppointment(record);
        void apiFetch(`/api/cases/${caseId}/appointment/response`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: responseRequestId, version: proposal.version, action, slotId: action === 'confirm' ? selectedSlotId : null }) }).then(async response => {
          if (!response.ok) { const failure = await response.json().catch(() => ({})); const error = new Error(failure.message || 'Response unavailable. Refresh to check the case.'); error.stale = response.status === 409; throw error; }
          appointmentFeedback = ''; responseRequestId = null; responseAction = null; selectedSlotId = null; await read();
        }).catch(error => { appointmentFeedback = error.message || 'Response unavailable. Your selection is preserved; retry or refresh.';
          if (error.stale) { responseRequestId = null; responseAction = null; void read(); } else renderAppointment(record);
        })
          .finally(() => { responseBusy = false; renderAppointment(lastRecord || record); });
      }); controls.append(button);
    };
    act('Confirm this time', 'confirm'); act('Request another time', 'request_another_time'); appointmentPanel.append(controls);
  };
  let evidenceFingerprint = '', evidenceController, evidenceUrls = [];
  const clearEvidence = () => { evidenceController?.abort(); evidenceController = undefined; evidenceUrls.forEach(url => URL.revokeObjectURL(url)); evidenceUrls = []; evidenceFingerprint = ''; };
  const renderEvidence = record => {
    const items = Array.isArray(record.patientEvidence) ? record.patientEvidence : [];
    const fingerprint = JSON.stringify({ caseId, items });
    evidencePanel.hidden = !items.length;
    if (fingerprint === evidenceFingerprint) return;
    evidenceController?.abort(); evidenceController = new AbortController();
    evidenceUrls.forEach(url => URL.revokeObjectURL(url)); evidenceUrls = []; evidenceFingerprint = fingerprint; evidenceList.replaceChildren();
    for (const item of items) {
      const card = document.createElement('article'), title = document.createElement('h4'), context = document.createElement('p'), status = document.createElement('p');
      card.className = 'patient-case-evidence-item'; title.textContent = item.label || 'Patient-shared image';
      context.textContent = item.patientDescription || 'No patient description was provided.'; card.append(title, context);
      if (item.kind === 'medicine_package') {
        const medication = record.medications?.find(entry => entry.verification === 'patient_reported' && entry.source === 'packaging_shown');
        if (medication) {
          const details = document.createElement('p'); details.className = 'patient-case-evidence-note';
          details.textContent = `Patient-reported; packaging shown: ${medication.name} · ${medication.strength}. Not clinically verified.`; card.append(details);
        }
      }
      if (item.kind === 'body_area') {
        const note = document.createElement('p'); note.className = 'patient-case-evidence-note'; note.textContent = 'This is patient-reported location evidence, not a diagnosis or verified anatomical finding.'; card.append(note);
      }
      if (item.status !== 'available') { status.textContent = 'The image is unavailable. Your description remains saved.'; card.append(status); evidenceList.append(card); continue; }
      status.setAttribute('role', 'status'); status.textContent = 'Loading your shared image…'; card.append(status); evidenceList.append(card);
      const signal = evidenceController.signal;
      void apiFetch(`/api/cases/${caseId}/evidence/${encodeURIComponent(item.evidenceId)}`, { cache: 'no-store', signal }).then(async response => {
        if (!response.ok) throw new Error('EVIDENCE_UNAVAILABLE');
        const blob = await response.blob(); if (!blob.type.startsWith('image/')) throw new Error('EVIDENCE_UNAVAILABLE');
        if (signal.aborted) return;
        const image = document.createElement('img'); image.className = 'patient-case-evidence-image'; image.alt = `Image you shared: ${item.label || 'patient-reported evidence'}`;
        const objectUrl = URL.createObjectURL(blob); evidenceUrls.push(objectUrl);
        image.addEventListener('error', () => { if (signal.aborted) return; URL.revokeObjectURL(objectUrl); evidenceUrls = evidenceUrls.filter(url => url !== objectUrl); status.textContent = 'The shared image is temporarily unavailable. Your description remains saved.'; evidenceFingerprint = ''; image.replaceWith(status); }, { once: true });
        image.src = objectUrl; status.replaceWith(image);
      }).catch(() => { if (!signal.aborted) { status.textContent = 'The shared image is temporarily unavailable. Your description remains saved.'; evidenceFingerprint = ''; } });
    }
  };
  const render = record => {
    lastRecord = record;
    find('').hidden = false; find('id').textContent = caseId;
    find('status').textContent = clinicalReviewLabels[record.clinicalReview?.status] || labels[record.workflowStatus] || 'Awaiting saved case';
    const intakeTime = Date.parse(record.createdAt || '');
    dateValue.textContent = Number.isFinite(intakeTime) ? new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium', timeStyle: 'short' }).format(intakeTime) : 'Unavailable';
    doctorLine.hidden = !record.doctorAttribution;
    doctorValue.textContent = record.doctorAttribution?.status === 'available'
      ? `${record.doctorAttribution.displayName} · ${specialtyLabels[record.doctorAttribution.specialty] || record.doctorAttribution.specialty}`
      : record.doctorAttribution ? 'Doctor profile details unavailable' : '';
    renderEvidence(record);
    renderAppointment(record);
    const receipt = record.handoffReceipt?.caseId;
    find('receipt').hidden = !/^DEMO-[A-F0-9]{8}$/.test(receipt || '');
    find('receipt').textContent = find('receipt').hidden ? '' : `Hospital receipt: ${receipt}`;
    find('emergency').hidden = !isEmergencyWorkflow(record.workflowStatus);
    find('emergency-status').textContent = isEmergencyWorkflow(record.workflowStatus) ? `Status: ${emergencyStatusLabels[record.emergency?.status] || (record.workflowStatus === 'emergency_acknowledged' ? 'Dispatcher acknowledged' : 'Pending dispatcher')}` : '';
    find('routing').textContent = isEmergencyWorkflow(record.workflowStatus) ? 'Normal doctor routing skipped.' : record.routing?.status === 'routed' ? `Routed to ${specialtyLabels[record.routing.specialty] || 'Doctor'} for review.` : record.routing?.status === 'unassigned' ? `Unassigned: ${record.routing.reasonSummary}` : routing ? 'Routing: Pending…' : 'Routing: Not routed';
    find('ambulance').hidden = !record.ambulance;
    find('ambulance-status').textContent = record.ambulance ? `${record.ambulance.unitId} — ${ambulanceStatusLabels[record.ambulance.status] || 'Unavailable'}` : '';
    if (record.ambulance) {
      const ambulance = defaultMapAmbulances().find(unit => unit.id === record.ambulance.unitId);
      if (ambulance) ambulance.status = record.ambulance.status;
      const destinationId = record.emergencyDestination?.hospitalId;
      const destination = defaultMapHospitals().filter(hospital => hospital.id === destinationId);
      if (ambulance && destinationId) ambulance.assignment = { destination: destinationId };
      const pickup = record.emergencyDestination?.pickup ? { id: 'patient', label: record.emergencyDestination.pickup.label, position: { lat: record.emergencyDestination.pickup.latitude, lng: record.emergencyDestination.pickup.longitude } } : defaultPatientPickup;
      renderOperationalMap(outlet.querySelector('#patient-transport-map'), { hospitals: destination, ambulances: ambulance ? [ambulance] : [], pickup, status: 'Fictional seeded positions and bounded travel estimate · no live tracking' });
      outlet.querySelector('#patient-transport-status').textContent = ambulanceStatusLabels[record.ambulance.status] || 'Unavailable';
      outlet.querySelector('#patient-transport-ambulance').textContent = record.ambulance.unitId;
      outlet.querySelector('#patient-transport-position').textContent = ambulance ? `Seeded ${ambulance.location}` : 'Not available';
      outlet.querySelector('#patient-transport-destination').textContent = destination[0]?.name || 'Not assigned';
      outlet.querySelector('#patient-transport-pickup').textContent = record.emergencyDestination?.pickup?.label || 'Fictional demo pickup';
      outlet.querySelector('#patient-transport-eta').textContent = record.emergencyDestination ? `About ${Math.ceil(record.emergencyDestination.durationSeconds / 60)} minutes` : 'Not available';
      outlet.querySelector('#patient-transport-distance').textContent = record.emergencyDestination ? `${(record.emergencyDestination.distanceMeters / 1000).toFixed(1)} km` : 'Not available';
      const updatedAt = Date.parse(record.updatedAt || '');
      outlet.querySelector('#patient-transport-updated').textContent = Number.isFinite(updatedAt) ? new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium', timeStyle: 'short' }).format(updatedAt) : 'Not available';
    }
    onRecord({ ...record, caseId });
  };
  async function read() {
    clearTimeout(timer); controller?.abort();
    if (!caseId || disposed) return;
    const current = ++generation; controller = new AbortController();
    try {
      const response = await apiFetch(`/api/cases/${caseId}`, { cache: 'no-store', signal: controller.signal });
      if (disposed || current !== generation) return;
      if (response.status === 404) { reset(); return; }
      if (!response.ok) throw new Error('Unavailable');
      const record = await response.json();
      if (disposed || current !== generation || record.caseId !== caseId) return;
      render(record);
      if (!['handoff_completed', 'handoff_failed', 'emergency_response_completed', 'routed_to_doctor'].includes(record.workflowStatus) || ['pending', 'in_progress'].includes(record.handoffStatus)) timer = setTimeout(read, 3000);
    } catch {
      if (disposed || current !== generation) return;
      if (!lastRecord || !['firestore', 'firestore_emulator', 'memory'].includes(lastRecord.storage)) render({ storage: 'unavailable' });
      timer = setTimeout(read, 5000);
    }
  }
  const update = record => {
    if (!idPattern.test(record?.caseId || '')) return;
    if (caseId !== record.caseId) copyStatus.textContent = '';
    caseId = record.caseId;
    try { sessionStorage.setItem('smartcareops-case-id', caseId); } catch {}
    render(record); void read();
  };
  const reset = () => {
    ++generation; controller?.abort(); routeController?.abort(); routing = false; clearTimeout(timer); clearEvidence(); caseId = null; lastRecord = null; copyStatus.textContent = ''; find('').hidden = true;
    try { sessionStorage.removeItem('smartcareops-case-id'); } catch {}
    onRecord(null);
  };
  find('refresh').addEventListener('click', read);
  try { const saved = sessionStorage.getItem('smartcareops-case-id'); if (idPattern.test(saved || '')) update({ caseId: saved, storage: 'pending' }); } catch {}
  return { update, reset, refresh: read, dispose() { disposed = true; ++generation; controller?.abort(); clearTimeout(timer); clearEvidence(); find('refresh').removeEventListener('click', read); copyButton.removeEventListener('click', copyCaseId); } };
}

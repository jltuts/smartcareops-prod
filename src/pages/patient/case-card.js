import { apiFetch } from '../../auth/service.js';
import { ambulanceStatusLabels } from '../../../shared/ambulance.js';
import { isEmergencyWorkflow, emergencyStatusLabels } from '../../../shared/emergency.js';
import { specialtyLabels } from '../../../shared/routing.js';
const idPattern = /^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labels = { submitted_for_clinical_review: 'Waiting for clinical review', intake_completed: 'Intake completed', handoff_pending: 'Handoff pending', handoff_in_progress: 'Handoff in progress', handoff_completed: 'Handoff completed', handoff_failed: 'Handoff failed', emergency_pending_dispatcher: 'Emergency — pending dispatcher', routed_to_doctor: 'Routed to doctor', emergency_acknowledged: 'Emergency — dispatcher acknowledged', ambulance_assigned: 'Ambulance assigned — simulation', ambulance_en_route: 'Ambulance en route — simulation' };
const storageLabels = { firestore: 'Firestore', firestore_emulator: 'Firestore emulator — local test only', memory: 'Memory — dev only; lost on backend restart', pending: 'Saving…', unavailable: 'Unavailable — persistence not confirmed' };
export const caseMarkup = () => `<section id="patient-case" class="handoff-panel" hidden aria-labelledby="patient-case-heading"><h2 id="patient-case-heading">Patient Case</h2><p>Case ID: <span id="patient-case-id"></span></p><p>Status: <span id="patient-case-status"></span></p><p>Storage: <span id="patient-case-storage"></span></p><p id="patient-case-receipt" hidden></p><div id="patient-case-emergency" hidden><h3>Emergency escalation</h3><p id="patient-case-emergency-status" role="status"></p><p>No ambulance or emergency service has been contacted by this demo.</p></div><div id="patient-case-ambulance" hidden><h3>Ambulance — fictional simulation</h3><p id="patient-case-ambulance-status" role="status"></p><p>No real ambulance has been dispatched.</p></div><p id="patient-case-routing" role="status"></p><button id="patient-case-refresh" type="button">Refresh case</button></section>`;
export function mountCaseCard(outlet, onRecord = () => {}) {
  const find = name => outlet.querySelector(`#patient-case${name ? `-${name}` : ''}`);
  let caseId, lastRecord, generation = 0, timer, controller, disposed = false, routing = false, routeController;
  const render = record => {
    lastRecord = record;
    onRecord({ ...record, caseId });
    find('').hidden = false; find('id').textContent = caseId;
    find('status').textContent = labels[record.workflowStatus] || 'Awaiting saved case';
    find('storage').textContent = storageLabels[record.storage] || storageLabels.unavailable;
    const receipt = record.handoffReceipt?.caseId;
    find('receipt').hidden = !/^DEMO-[A-F0-9]{8}$/.test(receipt || '');
    find('receipt').textContent = find('receipt').hidden ? '' : `Hospital receipt: ${receipt}`;
    find('emergency').hidden = !isEmergencyWorkflow(record.workflowStatus);
    find('emergency-status').textContent = isEmergencyWorkflow(record.workflowStatus) ? `Status: ${emergencyStatusLabels[record.emergency?.status] || (record.workflowStatus === 'emergency_acknowledged' ? 'Dispatcher acknowledged' : 'Pending dispatcher')}` : '';
    find('routing').textContent = isEmergencyWorkflow(record.workflowStatus) ? 'Normal doctor routing skipped.' : record.routing?.status === 'routed' ? `Routing: ${specialtyLabels[record.routing.specialty] || 'Unavailable'}` : routing ? 'Routing: Pending…' : 'Routing: Not routed';
    find('ambulance').hidden = !record.ambulance;
    find('ambulance-status').textContent = record.ambulance ? `${record.ambulance.unitId} — ${ambulanceStatusLabels[record.ambulance.status] || 'Unavailable'}` : '';
  };
  async function read() {
    clearTimeout(timer); controller?.abort();
    if (!caseId || disposed) return;
    const current = ++generation; controller = new AbortController();
    try {
      const response = await apiFetch(`/api/cases/${caseId}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Unavailable');
      const record = await response.json();
      if (disposed || current !== generation || record.caseId !== caseId) return;
      render(record);
      if (!['handoff_completed', 'handoff_failed', 'ambulance_en_route', 'routed_to_doctor'].includes(record.workflowStatus) || ['pending', 'in_progress'].includes(record.handoffStatus)) timer = setTimeout(read, 3000);
    } catch {
      if (disposed || current !== generation) return;
      if (!lastRecord || !['firestore', 'firestore_emulator', 'memory'].includes(lastRecord.storage)) render({ storage: 'unavailable' });
      timer = setTimeout(read, 5000);
    }
  }
  const update = record => {
    if (!idPattern.test(record?.caseId || '')) return;
    caseId = record.caseId;
    try { sessionStorage.setItem('smartcareops-case-id', caseId); } catch {}
    render(record); void read();
  };
  const reset = () => {
    ++generation; controller?.abort(); routeController?.abort(); routing = false; clearTimeout(timer); caseId = null; lastRecord = null; find('').hidden = true;
    try { sessionStorage.removeItem('smartcareops-case-id'); } catch {}
  };
  find('refresh').addEventListener('click', read);
  try { const saved = sessionStorage.getItem('smartcareops-case-id'); if (idPattern.test(saved || '')) update({ caseId: saved, storage: 'pending' }); } catch {}
  return { update, reset, refresh: read, dispose() { disposed = true; ++generation; controller?.abort(); clearTimeout(timer); find('refresh').removeEventListener('click', read); } };
}

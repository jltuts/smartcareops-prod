import { caseMarkup, mountCaseCard } from './case-card.js';
import { isEmergencyWorkflow } from '../../../shared/emergency.js';
export const handoffMarkup = () => `${caseMarkup()}<section class="handoff-panel" aria-labelledby="handoff-heading" hidden>
<h2 id="handoff-heading">Intake status</h2>
<ol id="intake-saved-stages" hidden><li>✓ Information saved</li><li>✓ Case created</li><li>✓ Submitted for clinical review</li></ol>
<p id="handoff-status" role="status" aria-live="polite">Waiting to begin…</p>
<p id="handoff-receipt" hidden></p></section>`;
export function mountHandoff(outlet, onRecord = () => {}) {
  const status = outlet.querySelector('#handoff-status'), stages = outlet.querySelector('#intake-saved-stages'), receipt = outlet.querySelector('#handoff-receipt');
  const emergency = () => { stages.hidden = true; status.textContent = 'Emergency escalation — Pending dispatcher workflow. No dispatcher or emergency service has been contacted by this demo.'; };
  function observe(record) {
    onRecord(record);
    if (!record) return;
    if (isEmergencyWorkflow(record.workflowStatus)) { emergency(); return; }
    const saved = record.workflowStatus && !['pending', 'unavailable'].includes(record.storage);
    if (!saved) return;
    stages.hidden = false;
    const reviewStatus = record.clinicalReview?.status;
    const handoffCompleted = record.handoffStatus === 'completed' || Boolean(record.handoffReceipt?.caseId);
    const reviewMessage = reviewStatus === 'approved' ? `Clinical review approved.${handoffCompleted ? ' Hospital handoff completed.' : ' No hospital handoff has occurred.'}` : reviewStatus === 'rejected' ? 'Clinical review rejected. No hospital handoff has occurred.' : reviewStatus === 'deferred' ? 'Clinical review deferred. No hospital handoff has occurred.' : 'Your intake has been submitted for clinical review.';
    status.textContent = reviewMessage;
    if (record.handoffStatus === 'failed') status.textContent = 'Your information is saved. A hospital action needs clinical review.';
    if (record.handoffStatus === 'in_progress') status.textContent = 'Your information is saved. Your care team is reviewing hospital confirmation.';
    const id = record.handoffReceipt?.caseId;
    receipt.hidden = !/^DEMO-[A-F0-9]{8}$/.test(id || ''); receipt.textContent = receipt.hidden ? '' : `Hospital confirmed receipt. Reference: ${id}`;
  }
  const patientCase = mountCaseCard(outlet, observe);
  return {
    patientCase: record => patientCase.update(record),
    openCase: caseId => patientCase.update({ caseId, storage: 'pending' }),
    finalizing() { stages.hidden = true; status.textContent = 'Voice intake complete. Finalizing and saving your clinical summary…'; },
    failed() { stages.hidden = true; receipt.hidden = true; status.textContent = 'Your intake was captured, but the clinical summary could not be saved. Please try again.'; },
    completed(_intake, _token, record) { patientCase.update(record); },
    emergency(record) { patientCase.update(record); emergency(); },
    reset() { patientCase.reset(); stages.hidden = true; receipt.hidden = true; status.textContent = 'Waiting to begin…'; },
    dispose() { patientCase.dispose(); },
  };
}

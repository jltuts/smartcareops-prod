import { randomUUID } from 'node:crypto';
import { CaseStoreError, Workflow } from './store.js';
import { factsFingerprint, validRouting } from './routing.js';
import { snapshotOf } from './store.js';
import { emergencyEscalation } from '../emergency.js';

// Fictional appointments may be proposed from one hour to 90 days ahead.
export const appointmentWindow = Object.freeze({ minimumMs: 60 * 60 * 1000, maximumMs: 90 * 24 * 60 * 60 * 1000 });
export const appointmentStates = Object.freeze({ proposed: 'appointment_proposed', awaiting: 'awaiting_patient_confirmation', confirmed: 'appointment_confirmed', alternate: 'alternate_time_requested' });
const fail = (code, status = 400) => { throw new CaseStoreError(code, status); };
export const appointmentRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
export function validateProposal(input, now = Date.now()) {
  if (!exact(input, ['requestId', 'expectedVersion', 'timeZone', 'appointmentType', 'slots']) || !appointmentRequestId(input.requestId) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 100 ||
      typeof input.timeZone !== 'string' || input.timeZone.length > 64 || !(input.timeZone === 'UTC' || Intl.supportedValuesOf('timeZone').includes(input.timeZone)) ||
      typeof input.appointmentType !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ,.'()-]{1,79}$/u.test(input.appointmentType) ||
      !Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 3) fail('INVALID_APPOINTMENT_PROPOSAL');
  const slots = input.slots.map(slot => {
    if (!exact(slot, ['startAt', 'endAt']) || !iso(slot.startAt) || !iso(slot.endAt)) fail('INVALID_APPOINTMENT_SLOT');
    const start = Date.parse(slot.startAt), end = Date.parse(slot.endAt);
    if (start < now + appointmentWindow.minimumMs || start > now + appointmentWindow.maximumMs || end <= start || end - start > 8 * 60 * 60 * 1000 || end > now + appointmentWindow.maximumMs) fail('INVALID_APPOINTMENT_SLOT');
    return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
  });
  if (new Set(slots.map(slot => slot.startAt)).size !== slots.length) fail('INVALID_APPOINTMENT_SLOT');
  if (slots.some((slot, index) => index > 0 && slot.startAt <= slots[index - 1].startAt)) fail('INVALID_APPOINTMENT_SLOT');
  return { ...input, appointmentType: input.appointmentType.trim(), slots };
}
export function validateResponse(input) {
  if (!exact(input, ['requestId', 'version', 'action', 'slotId']) || !appointmentRequestId(input.requestId) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 101 ||
      !['confirm', 'request_another_time'].includes(input.action) ||
      (input.action === 'confirm' ? !appointmentRequestId(input.slotId) : input.slotId !== null)) fail('INVALID_APPOINTMENT_RESPONSE');
  return input;
}
export function appointmentEligible(doc) {
  return !!(doc && typeof doc.patientUid === 'string' && doc.patientUid && doc.source === 'smartcareops_demo' && doc.workflowStatus === Workflow.ROUTED &&
    validRouting(doc.routing) && doc.routingFactsHash === factsFingerprint(snapshotOf(doc.reportedFacts)) &&
    doc.clinicalReview?.status === 'approved' && doc.clinicalReviewDecision?.status === 'approved' &&
    !doc.emergency && !emergencyEscalation(doc.reportedFacts) && !doc.ambulance &&
    !['pending', 'in_progress', 'completed'].includes(doc.handoffStatus) &&
    !Object.values(doc.hospitalHandoffs || {}).some(handoff => ['pending', 'in_progress', 'completed', 'succeeded'].includes(handoff.status)));
}
export const newAppointmentSlot = slot => ({ slotId: randomUUID(), ...slot });
export const publicAppointment = proposal => proposal ? {
  version: proposal.version, state: proposal.state, slots: proposal.slots,
  timeZone: proposal.timeZone, appointmentType: proposal.appointmentType,
  doctor: { displayName: proposal.doctor.displayName, specialty: proposal.doctor.specialty },
  createdAt: proposal.createdAt, updatedAt: proposal.updatedAt,
  confirmedSlotId: proposal.confirmedSlotId || null,
} : null;

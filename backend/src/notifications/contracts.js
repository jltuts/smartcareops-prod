import { createHash } from 'node:crypto';
export class NotificationError extends Error { constructor(code = 'INVALID_NOTIFICATION', status = 400) { super('Simulated notification request unavailable.'); this.code = code; this.status = status; } }
export const check = (value, code = 'INVALID_NOTIFICATION', status = 400) => { if (!value) throw new NotificationError(code, status); };
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const channels = ['in_app', 'simulated_sms', 'simulated_email', 'simulated_alert'];
const descriptor = (scopes, risk, recipientType, recipientId) => ({ scopes, risk, recipientType, recipientId, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, simulation: true });
export const actionTools = Object.freeze({
  notify_doctor: descriptor(['clinical'], 'LOW_RISK_OPERATION', 'doctor', 'DEMO-DOCTOR-REVIEW'),
  notify_hospital_operations: descriptor(['clinical', 'hospital'], 'LOW_RISK_OPERATION', 'hospital_operations', 'OPS-HOSP-001'),
  notify_dispatcher: descriptor(['clinical'], 'HIGH_IMPACT', 'dispatcher', 'DEMO-DISPATCHER-001'),
  notify_command_center: descriptor(['hospital', 'regional'], 'HIGH_IMPACT', 'command_center', 'DEMO-COMMAND-CENTER'),
  notify_participating_hospital: descriptor(['regional'], 'HIGH_IMPACT', 'participating_hospital', 'HOSP-002'),
  notify_patient_status: descriptor(['clinical'], 'LOW_RISK_OPERATION', 'patient_status', 'DEMO-PATIENT-STATUS'),
  inspect_notification_history: descriptor(['clinical', 'hospital', 'regional'], 'READ_ONLY', null, null),
  schedule_followup_review: descriptor(['clinical', 'hospital', 'regional'], 'LOW_RISK_OPERATION', null, null),
});
export const isActionTool = name => Object.hasOwn(actionTools, name);
export const notificationToolNames = Object.keys(actionTools);
export const notificationRisks = Object.fromEntries(Object.entries(actionTools).map(([name, value]) => [name, value.risk]));
export const isNotification = name => isActionTool(name) && name.startsWith('notify_');
export function validateBoundArguments(name, args) {
  check(isActionTool(name) && args && typeof args === 'object' && !Array.isArray(args));
  const keys = isNotification(name) ? ['recipientId', 'deliveryMode'] : name === 'schedule_followup_review' ? ['delayMinutes', 'reasonCode'] : [];
  check(Object.keys(args).length === keys.length && keys.every(key => Object.hasOwn(args, key)));
  if (isNotification(name)) check(args.recipientId === actionTools[name].recipientId && channels.includes(args.deliveryMode), 'NOTIFICATION_RECIPIENT_NOT_ALLOWED');
  if (name === 'schedule_followup_review') check([1, 5, 15].includes(args.delayMinutes) && args.reasonCode === 'plan_review', 'INVALID_FOLLOWUP');
  return actionTools[name].risk;
}
export function bindArguments(name, source, options = {}) {
  check(isActionTool(name) && actionTools[name].scopes.includes(source.scope), 'NOTIFICATION_SCOPE_VIOLATION');
  const args = isNotification(name) ? { recipientId: actionTools[name].recipientId, deliveryMode: options.channel || 'in_app' } : name === 'schedule_followup_review' ? { delayMinutes: options.followupMinutes || 5, reasonCode: 'plan_review' } : {};
  validateBoundArguments(name, args); return args;
}
export function availableTools(source, state) {
  return notificationToolNames.filter(name => actionTools[name].scopes.includes(source.scope) && (name !== 'notify_dispatcher' || state.notificationCaseState?.acknowledgedEmergency));
}
const templates = Object.freeze({
  notify_doctor: ['Fictional case review requested', 'DEMO: New fictional observations and a clinical plan are available for doctor review. This is not a medical order.'],
  notify_hospital_operations: ['Fictional operations review requested', 'DEMO: A source plan identifies an operational resource concern requiring review. No resource is reserved.'],
  notify_dispatcher: ['Fictional dispatcher review requested', 'DEMO: An acknowledged fictional emergency state is available for dispatcher review. No ambulance was dispatched.'],
  notify_command_center: ['Simulated command-center bulletin', 'DEMO: An operational signal requires command-center review. Evidence is limited. No external alert was issued.'],
  notify_participating_hospital: ['Simulated participating-hospital notice', 'DEMO: A possible emerging cluster and regional capacity concern require review. Enhanced surveillance is recommended for this fictional scenario. This is not an epidemiological diagnosis; no transfer was initiated.'],
  notify_patient_status: ['Fictional case status update', 'DEMO: An updated fictional case plan is available for review. This simulated status update contains no care instructions.'],
});
export function messageFor(name) { check(Object.hasOwn(templates, name)); const [subject, messageSummary] = templates[name]; return { subject, messageSummary }; }
export function validateMessage(name, value) {
  const expected = messageFor(name); check(value.subject === expected.subject && value.messageSummary === expected.messageSummary, 'UNSAFE_NOTIFICATION_MESSAGE'); return expected;
}

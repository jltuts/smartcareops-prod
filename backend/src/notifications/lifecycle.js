import { durableEvent } from '../agent-core/lifecycle.js';
import { actionTools, isActionTool, isNotification, validateBoundArguments, validateMessage, messageFor, check, hash } from './contracts.js';
const values = Object.values;
const iso = time => new Date(time).toISOString();
export const notificationBuckets = ['notifications', 'followups'];
export function notificationState(state) { state.notifications ||= {}; state.followups ||= {}; }
function event(state, source, type, id, now, extra = {}) {
  if (state.events[id]) return;
  check(values(state.events).length < 180, 'NOTIFICATION_EVENT_LIMIT', 409);
  state.meta.eventVersion = (state.meta.eventVersion || 0) + 1;
  state.events[id] = durableEvent({ eventId: id, type, subjectId: source.subjectId, subjectType: source.scope, version: state.meta.snapshotVersion || state.meta.observationVersion,
    now, scope: { scope: source.scope, agentType: source.agentType, simulation: true }, extra: { eventVersion: state.meta.eventVersion, ...extra } });
}
const notificationId = (source, plan, action) => 'NOTIF-' + hash({ scope: source.scope, subjectId: source.subjectId, revision: plan.revisionId, actionId: action.actionId, recipient: action.arguments.recipientId, type: action.toolName }).slice(0, 32);
export function stageNotifications(state, source, plan, actions, now) {
  notificationState(state);
  for (const action of actions.filter(item => isNotification(item.toolName))) {
    if (action.toolName === 'notify_participating_hospital') check(plan.assessment?.signal === 'Possible emerging respiratory cluster', 'NOTIFICATION_EVIDENCE_REQUIRED', 409);
    validateBoundArguments(action.toolName, action.arguments); check(actionTools[action.toolName].scopes.includes(source.scope), 'NOTIFICATION_SCOPE_VIOLATION');
    const id = notificationId(source, plan, action); if (state.notifications[id]) continue;
    check(values(state.notifications).length < 100, 'NOTIFICATION_LIMIT', 409);
    state.notifications[id] = { notificationId: id, ...source, recipientType: actionTools[action.toolName].recipientType, recipientId: action.arguments.recipientId,
      ...messageFor(action.toolName), toolName: action.toolName, sourcePlanId: plan.planId, sourceRevisionId: plan.revisionId, sourceActionId: action.actionId,
      argumentsDigest: hash(action.arguments), status: 'pending', deliveryMode: action.arguments.deliveryMode, simulation: true, createdAt: iso(now), deliveredAt: null, receiptId: null };
    event(state, source, 'notification.requested', `requested_${id}`, now, { notificationId: id, planRevisionId: plan.revisionId });
  }
}
export function supersedeNotifications(state, now) {
  notificationState(state);
  for (const notification of values(state.notifications)) if (['pending', 'approved'].includes(notification.status)) {
    notification.status = 'superseded'; event(state, notification, 'notification.superseded', `superseded_${notification.notificationId}`, now, { notificationId: notification.notificationId });
  }
  for (const followup of values(state.followups)) if (followup.status === 'scheduled') followup.status = 'superseded';
}
export function notificationDecision(state, revisionId, actionId, decision) {
  notificationState(state);
  for (const notification of values(state.notifications)) if (notification.sourceRevisionId === revisionId && notification.sourceActionId === actionId && ['pending', 'approved'].includes(notification.status)) notification.status = decision === 'approved' ? 'approved' : 'cancelled';
}
export function reconcileNotifications(state, now) {
  notificationState(state);
  for (const notification of values(state.notifications)) {
    if (!['pending', 'approved'].includes(notification.status)) continue;
    const execution = values(state.toolExecutions).find(item => item.planRevisionId === notification.sourceRevisionId && item.actionId === notification.sourceActionId);
    if (!execution || !['failed', 'unknown_outcome'].includes(execution.status) || state.receipts[`receipt_${execution.executionId}`]) continue;
    notification.status = 'failed';
    event(state, notification, 'notification.failed', `failed_${notification.notificationId}`, now, { notificationId: notification.notificationId, reason: 'No verified delivery receipt; automatic replay blocked.' });
  }
}
export function performAction(state, source, plan, action, execution, now) {
  notificationState(state); check(isActionTool(action.toolName)); const risk = validateBoundArguments(action.toolName, action.arguments);
  check(actionTools[action.toolName].scopes.includes(source.scope), 'NOTIFICATION_SCOPE_VIOLATION');
  const receiptId = `receipt_${execution.executionId}`;
  if (state.receipts[receiptId]) return state.receipts[receiptId];
  const base = { receiptId, executionId: execution.executionId, ...source, planRevisionId: plan.revisionId, snapshotVersion: plan.snapshotVersion || plan.inputVersion, actionId: action.actionId, toolName: action.toolName, simulation: true, createdAt: iso(now) };
  if (isNotification(action.toolName)) {
    const id = notificationId(source, plan, action), notification = state.notifications[id];
    check(notification && ['pending', 'approved'].includes(notification.status), 'NOTIFICATION_SUPERSEDED', 409);
    check(notification.argumentsDigest === hash(action.arguments), 'NOTIFICATION_ARGUMENT_CONFLICT', 409); validateMessage(action.toolName, notification);
    check(risk !== 'HIGH_IMPACT' || notification.status === 'approved' && execution.approvalId, 'NOTIFICATION_APPROVAL_REQUIRED', 409);
    if (action.toolName === 'notify_dispatcher') check(state.notificationCaseState?.acknowledgedEmergency, 'ACKNOWLEDGED_EMERGENCY_REQUIRED', 409);
    const receipt = { ...base, notificationId: id, channel: notification.deliveryMode, recipient: { type: notification.recipientType, id: notification.recipientId }, status: 'delivered', deliveredAt: iso(now), outcome: 'Simulated notification delivered' };
    state.receipts[receiptId] = receipt; Object.assign(notification, { status: 'sent', deliveredAt: receipt.deliveredAt, receiptId });
    event(state, source, 'notification.sent', `sent_${id}`, now, { notificationId: id, receiptId }); return receipt;
  }
  if (action.toolName === 'schedule_followup_review') {
    const followupId = 'FOLLOWUP-' + hash({ ...source, revision: plan.revisionId, action: action.actionId }).slice(0, 32);
    state.followups[followupId] ||= { followupId, ...source, sourcePlanRevision: plan.revisionId, sourceActionId: action.actionId, dueAt: iso(now + action.arguments.delayMinutes * 60000),
      reason: 'Review the current fictional plan and delivery evidence.', status: 'scheduled', simulation: true, createdAt: iso(now), triggeredAt: null };
    event(state, source, 'followup.scheduled', `scheduled_${followupId}`, now, { followupId, dueAt: state.followups[followupId].dueAt });
    return state.receipts[receiptId] = { ...base, followupId, status: 'scheduled', outcome: 'Fictional follow-up review scheduled' };
  }
  return state.receipts[receiptId] = { ...base, status: 'inspected', outcome: 'Simulated notification history inspected', notificationIds: values(state.notifications).map(item => item.notificationId) };
}
export function consumeFollowups(state, now, trigger) {
  notificationState(state);
  for (const followup of values(state.followups)) if (followup.status === 'scheduled' && Date.parse(followup.dueAt) <= now) {
    if (followup.sourcePlanRevision !== state.meta.currentRevisionId) { followup.status = 'superseded'; continue; }
    followup.status = 'triggered'; followup.triggeredAt = iso(now); trigger(followup);
  }
}

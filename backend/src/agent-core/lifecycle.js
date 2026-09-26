// Shared M8–M10 durable lifecycle primitives. Domain services still authorize effects.
export const values = object => Object.values(object);
export const iso = now => new Date(now).toISOString();
export function durableEvent({ eventId, type, subjectId, subjectType, version, now, scope, causationId = null, pending = false, extra = {} }) {
  return { eventId, type, subjectType, subjectId, subjectVersion: version, schemaVersion: 1, occurredAt: iso(now), receivedAt: iso(now),
    correlationId: subjectId, causationId, status: pending ? 'pending' : 'recorded', ...scope, ...extra };
}
export function executionJournal({ executionId, subject, revisionId, action, argumentsDigest, approvalId = null, scope }) {
  return { executionId, ...subject, planRevisionId: revisionId, actionId: action.actionId, toolName: action.toolName, argumentsDigest, approvalId,
    idempotencyKey: executionId, status: 'pending', attempt: 0, startedAt: null, completedAt: null, outcome: null, receiptRef: null, ...scope };
}
export function reconcileReceipts(state) {
  for (const execution of values(state.toolExecutions)) if (['unknown_outcome', 'running'].includes(execution.status) && execution.approvalId) {
    const receipt = state.receipts[`receipt_${execution.executionId}`];
    if (receipt) Object.assign(execution, { status: 'succeeded', completedAt: receipt.createdAt, outcome: receipt.outcome, receiptRef: receipt.receiptId });
    else execution.status = 'unknown_outcome';
  }
}
export function supersedeApprovals(state) {
  for (const approval of values(state.approvals)) if (['pending', 'approved'].includes(approval.status)) approval.status = 'superseded';
}
export function immutablePlan(state, plan) {
  if (state.plans[plan.revisionId]) throw new Error('Immutable revision already exists');
  state.plans[plan.revisionId] = structuredClone(plan); state.meta.currentRevisionId = plan.revisionId;
  return plan.revisionId;
}
export function currentPlan(state, revision, evidenceCurrent) {
  return Boolean(revision && state.meta.ready && state.meta.currentRevisionId === revision.revisionId && evidenceCurrent);
}
export function monitoringRecord({ scope, subject, revisionId, conditions, now, extra = {} }) {
  return { monitorId: 'main', ...subject, planRevisionId: revisionId, conditions, nextEvaluationAt: iso(now + 300000), status: 'active', ...scope, ...extra };
}

const values = Object.values;

export function projectDecisionTrace(state) {
  return values(state.plans).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).flatMap(plan => {
    const triggers = (plan.triggerRefs || []).map(eventId => state.events[eventId]).filter(Boolean).map(event => ({
      eventType: event.type,
      outboxId: event.sourceOutboxId,
      occurredAt: event.sourceOccurredAt,
    }));
    return plan.actions.map(action => {
      const approval = values(state.approvals).find(item => item.planRevisionId === plan.revisionId && item.actionId === action.actionId);
      const execution = values(state.toolExecutions).find(item => item.planRevisionId === plan.revisionId && item.actionId === action.actionId);
      const receipt = execution?.receiptRef ? state.receipts[execution.receiptRef] : null;
      return {
        traceId: `${plan.revisionId}:${action.actionId}`,
        planRevisionId: plan.revisionId,
        planCreatedAt: plan.createdAt,
        triggers,
        evidenceRefs: [...plan.evidenceRefs],
        action: { actionId: action.actionId, toolName: action.toolName, risk: action.risk, expectedOutcome: action.expectedOutcome },
        approval: approval ? { approvalId: approval.approvalId, status: approval.status, reviewerId: approval.reviewerId, decidedAt: approval.decidedAt || null, expiresAt: approval.expiresAt } : { status: 'not_required' },
        execution: execution ? { executionId: execution.executionId, status: execution.status, completedAt: execution.completedAt, outcome: execution.outcome } : { status: 'not_started' },
        receipt: receipt ? { receiptId: receipt.receiptId, createdAt: receipt.createdAt, outcome: receipt.outcome } : null,
      };
    });
  });
}

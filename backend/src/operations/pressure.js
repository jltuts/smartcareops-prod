import { requireThat } from '../clinical/contracts.js';
import { durableEvent } from '../agent-core/lifecycle.js';
import { scope } from './contracts.js';
export function recordPressureSignal(state, now) {
  const plan = state.plans[state.meta?.currentRevisionId];
  if (!plan || !['WATCH', 'CONSTRAINED'].includes(plan.assessment.status)) return null;
  const eventId = `hospital_pressure_${plan.revisionId}`;
  if (state.events[eventId]) return state.events[eventId];
  requireThat((state.meta.eventVersion || 0) - (state.meta.eventBudgetStart || 0) < 180, 'OPERATIONS_EVENT_LIMIT', 409);
  const signal = durableEvent({ eventId, type: 'hospital.pressure_signal', subjectId: scope.workspaceId, subjectType: 'hospital', version: plan.snapshotVersion,
    now, scope, extra: { eventVersion: (state.meta.eventVersion || 0) + 1, planRevisionId: plan.revisionId, snapshotRef: `OPS-SNAPSHOT-${plan.snapshotVersion}`,
      evidenceRefs: [plan.revisionId, `OPS-SNAPSHOT-${plan.snapshotVersion}`], reason: 'Hospital operational pressure warrants aggregate regional review.', resourceVersion: plan.resourceVersion } });
  state.meta.eventVersion = signal.eventVersion; state.events[eventId] = signal; return signal;
}
export const publishHospitalPressure = (store, now = Date.now()) => store.transaction(scope.workspaceId, state => recordPressureSignal(state, now));

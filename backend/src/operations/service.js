import { isActionTool, bindArguments, availableTools } from '../notifications/contracts.js';
import { stageNotifications, supersedeNotifications, notificationDecision, performAction, consumeFollowups, reconcileNotifications } from '../notifications/lifecycle.js';
import { randomUUID } from 'node:crypto';
import { digest, exact, requireThat, token } from '../clinical/contracts.js';
import { validCaseId } from '../cases/store.js';
import { initializeResources, updateCapacity, createResourceService } from '../resources/service.js';
import { durableEvent, executionJournal, immutablePlan, reconcileReceipts, supersedeApprovals, currentPlan, monitoringRecord } from '../agent-core/lifecycle.js';
import { scope, tools, validateOperationalAssessment } from './contracts.js';
import { evidenceFingerprint, projectCase, snapshot } from './snapshot.js';
import { createOperationsModel } from './model.js';
import { recordPressureSignal } from './pressure.js';
const id = scope.workspaceId, iso = now => new Date(now).toISOString();
const values = Object.values;
export function createOperationsService({ store, caseStore, model = createOperationsModel(), resources = createResourceService(), now = Date.now, notificationsEnabled = false, notificationOptions = {} } = {}) {
  let running = false, closed = false, activeTick;
  const controllers = new Set();
  const notificationSource = { scope: scope.scope, subjectId: id, agentType: scope.agentType };
  const transaction = change => store.transaction(id, change);
  const approvalFor = (state, revisionId, actionId) => values(state.approvals).find(item => item.planRevisionId === revisionId && item.actionId === actionId);
  const event = (state, type, eventId, extra = {}) => {
    requireThat(values(state.events).length < 180, 'OPERATIONS_EVENT_LIMIT', 409);
    state.meta.eventVersion = (state.meta.eventVersion || 0) + 1;
    state.events[eventId] = durableEvent({ eventId, type, subjectId: id, subjectType: 'hospital', version: state.meta.snapshotVersion, now: now(), scope,
      pending: ['resource.updated', 'hospital.snapshot.updated', 'hospital.plan.requested', 'hospital.monitor.due'].includes(type), extra: { eventVersion: state.meta.eventVersion, ...extra } });
  };
  const invalidate = state => { state.meta.ready = false; state.meta.dirty = true; supersedeApprovals(state); if (notificationsEnabled) supersedeNotifications(state, now()); };
  const initialize = state => {
    initializeResources(state, now());
    state.meta ||= { ...scope, snapshotVersion: 0, revision: 0, currentRevisionId: null, ready: false, dirty: true, runCount: 0, modelCalls: 0, lease: null, nextMonitorAt: 0, lastError: null };
  };
  const refresh = state => {
    initialize(state);
    const current = state.snapshots[`OPS-SNAPSHOT-${state.meta.snapshotVersion}`];
    if (current?.evidenceFingerprint === evidenceFingerprint(state)) return;
    requireThat(state.meta.snapshotVersion < 20, 'OPERATIONS_SNAPSHOT_LIMIT', 409);
    const next = snapshot(state, now()); state.snapshots[next.snapshotId] = next; state.meta.snapshotVersion = next.snapshotVersion;
    const metrics = { active_patient_count: next.counts.active, emergency_case_count: next.counts.emergency, respiratory_case_count: next.counts.respiratory,
      incoming_case_count: next.counts.incoming, monitored_beds_available: next.capacity.monitoredBedsAvailable, icu_beds_available: next.capacity.icuBedsAvailable,
      specialist_availability: next.specialists, ...(next.ambulance ? { ambulance_available_count: next.ambulance.available, ambulance_reserved_count: next.ambulance.reserved } : {}) };
    for (const [type, value] of Object.entries(metrics)) {
      const observationId = `OPS-OBS-${next.snapshotVersion}-${type}`;
      state.observations[observationId] = { ...scope, observationId, type, value, unit: type === 'specialist_availability' ? 'availability' : 'count', snapshotRef: next.snapshotId,
        sourceRefs: type.includes('case') || type.includes('patient') ? next.sourceRefs : [type.startsWith('ambulance') ? next.fleetEvidenceVersion : next.resourceVersion],
        observedAt: next.observedAt, receivedAt: iso(now()), source: next.source, resourceVersion: next.resourceVersion };
    }
    state.meta.caseSetVersion = next.caseSetVersion; state.meta.resourceVersion = next.resourceVersion;
    invalidate(state); event(state, 'hospital.snapshot.updated', `snapshot_${next.snapshotVersion}`, { snapshotRef: next.snapshotId });
  };
  const current = (state, approval, plan, action) => Boolean(plan && action && currentPlan(state, plan,
    plan.evidenceFingerprint === evidenceFingerprint(state) && plan.snapshotVersion === state.meta.snapshotVersion) &&
    (!approval || approval.status === 'approved' && approval.expiresAt > iso(now()) && approval.argumentsDigest === digest({ ...scope, toolName: action.toolName, arguments: action.arguments }) &&
      approval.planRevisionId === plan.revisionId && approval.resourceVersion === state.resourceEnvironment.resourceVersion && approval.fleetEvidenceVersion === state.fleetEvidenceVersion));
  async function execute(revisionId, actionId) {
    const executionId = `ops_exec_${actionId}`;
    await transaction(state => {
      refresh(state); reconcileReceipts(state); if (notificationsEnabled) reconcileNotifications(state, now());
      if (state.toolExecutions[executionId]) return;
      const plan = state.plans[revisionId], action = plan?.actions.find(item => item.actionId === actionId);
      const approval = approvalFor(state, revisionId, actionId);
      requireThat(current(state, action?.risk === 'HIGH_IMPACT' ? approval : null, plan, action), 'OPERATIONS_STALE_ACTION', 409);
      requireThat(action.risk !== 'HIGH_IMPACT' || approval, 'OPERATIONS_APPROVAL_REQUIRED', 409);
      state.toolExecutions[executionId] = executionJournal({ executionId, subject: { workspaceId: id }, revisionId, action,
        argumentsDigest: digest({ ...scope, toolName: action.toolName, arguments: action.arguments }), approvalId: action.risk === 'HIGH_IMPACT' ? approval.approvalId : null, scope });
    });
    // The second transaction is the effect boundary. All case/resource/fleet docs
    // are read again inside it; a concurrent domain update forces revalidation.
    return transaction(state => {
      refresh(state);
      const execution = state.toolExecutions[executionId];
      if (execution.status !== 'pending') return execution;
      if (execution.planRevisionId !== revisionId) { execution.status = 'superseded'; return execution; }
      const plan = state.plans[revisionId], action = plan.actions.find(item => item.actionId === actionId), approval = state.approvals[execution.approvalId];
      if (action.risk === 'HIGH_IMPACT' && !approval || !current(state, action.risk === 'HIGH_IMPACT' ? approval : null, plan, action)) { execution.status = 'superseded'; return execution; }
      requireThat(Object.hasOwn(tools, action.toolName) && tools[action.toolName] === action.risk, 'OPERATIONS_TOOL_NOT_ALLOWED');
      const receiptId = `receipt_${executionId}`;
      requireThat(!state.receipts[receiptId], 'OPERATIONS_DUPLICATE_RECEIPT', 409);
      const timestamp = iso(now());
      const actionReceipt = isActionTool(action.toolName) ? (requireThat(notificationsEnabled, 'NOTIFICATIONS_DISABLED', 409), performAction(state, notificationSource, plan, action, execution, now())) : null;
      state.receipts[receiptId] = actionReceipt || { ...scope, receiptId, executionId, planRevisionId: revisionId, actionId, toolName: action.toolName,
        snapshotVersion: plan.snapshotVersion, createdAt: timestamp, outcome: action.risk === 'HIGH_IMPACT' ? 'fictional_rehearsal_recorded' : action.risk === 'READ_ONLY' ? 'snapshot_read' : 'local_summary_recorded' };
      Object.assign(execution, { status: 'succeeded', attempt: 1, startedAt: timestamp, completedAt: timestamp, receiptRef: receiptId, outcome: state.receipts[receiptId].outcome });
      if (approval) approval.status = 'consumed';
      event(state, 'hospital.action.completed', `completed_${actionId}`, { receiptRef: receiptId });
      return execution;
    });
  }
  const service = {
    async enroll(input) {
      exact(input, ['caseId', 'status']); requireThat(validCaseId(input.caseId) && ['active', 'incoming', 'closed'].includes(input.status));
      projectCase(await caseStore.getCase(input.caseId), input);
      return transaction(state => { initialize(state); requireThat(state.members[input.caseId] || values(state.members).length < 8, 'OPERATIONS_CASE_LIMIT', 409);
        if (state.members[input.caseId]?.status === input.status) return state.members[input.caseId];
        state.members[input.caseId] = { ...input, ...scope }; invalidate(state); return state.members[input.caseId]; });
    },
    async changeCapacity(input) {
      requireThat(input.hospitalId === scope.hospitalId, 'OPERATIONS_SCOPE_VIOLATION');
      return transaction(state => { initialize(state); const eventId = `capacity_${input.requestId}`;
        if (state.events[eventId]) { requireThat(state.events[eventId].requestDigest === digest(input), 'OPERATIONS_REQUEST_CONFLICT', 409); return state.events[eventId]; }
        const before = state.resourceEnvironment.hospitals.find(item => item.hospitalId === scope.hospitalId).capacity.monitoredBedsAvailable;
        updateCapacity(state, input, now()); invalidate(state);
        event(state, 'resource.updated', eventId, { requestDigest: digest(input), before, after: input.monitoredBedsAvailable, resourceVersion: state.resourceEnvironment.resourceVersion });
        return state.events[eventId]; });
    },
    async requestRun(requestId) {
      requireThat(token(requestId)); return transaction(state => { initialize(state); if (!state.events[`request_${requestId}`]) { invalidate(state); event(state, 'hospital.plan.requested', `request_${requestId}`); } return { accepted: true }; });
    },
    async decide(approvalId, decision) {
      requireThat(token(approvalId) && ['approved', 'rejected'].includes(decision));
      return transaction(state => { refresh(state); const approval = state.approvals[approvalId];
        requireThat(approval && approval.status === 'pending' && approval.expiresAt > iso(now()), 'OPERATIONS_STALE_APPROVAL', 409);
        const plan = state.plans[approval.planRevisionId], action = plan?.actions.find(item => item.actionId === approval.actionId);
        requireThat(current(state, { ...approval, status: 'approved' }, plan, action), 'OPERATIONS_STALE_APPROVAL', 409);
        if (notificationsEnabled) notificationDecision(state, approval.planRevisionId, approval.actionId, decision);
        Object.assign(approval, { status: decision, reviewerId: 'demo_ops', decidedAt: iso(now()) });
        event(state, 'hospital.approval.decided', `decision_${approvalId}`, { approvalId, decision }); return approval; });
    },
    execute,
    async view() {
      await transaction(state => refresh(state)); const state = await store.read(id);
      // Never expose hydrated case docs or the complete cross-hospital catalog.
      return { ...scope, storage: store.storage, meta: state.meta, members: values(state.members), currentSnapshot: state.snapshots[`OPS-SNAPSHOT-${state.meta.snapshotVersion}`],
        snapshots: values(state.snapshots).sort((a, b) => a.snapshotVersion - b.snapshotVersion), observations: values(state.observations),
        plans: values(state.plans).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), approvals: values(state.approvals), events: values(state.events).sort((a, b) => a.eventVersion - b.eventVersion),
        notifications: values(state.notifications || {}), followups: values(state.followups || {}), executions: values(state.toolExecutions), receipts: values(state.receipts), resourceEvidence: values(state.resourceSnapshots).sort((a, b) => a.observedAt.localeCompare(b.observedAt)), runs: values(state.agentRuns) };
    },
    async tick() {
      if (running || closed) return; running = true;
      try {
        const claim = await transaction(state => {
          refresh(state); reconcileReceipts(state); if (notificationsEnabled) reconcileNotifications(state, now());
          if (notificationsEnabled) consumeFollowups(state, now(), followup => { invalidate(state); event(state, 'hospital.plan.requested', `due_${followup.followupId}`, { followupId: followup.followupId }); });
          if (!values(state.members).some(item => item.status !== 'closed')) return null;
          if (state.meta.lease && state.meta.lease.expiresAt > now()) return null;
          if (state.meta.lease) { state.agentRuns[state.meta.lease.runId].status = 'interrupted'; state.meta.lease = null; invalidate(state); }
          if (!state.meta.dirty && state.meta.nextMonitorAt <= now()) { invalidate(state); event(state, 'hospital.monitor.due', `monitor_${state.meta.runCount}`); }
          if (!state.meta.dirty) return null;
          if (state.meta.runCount >= 8 || state.meta.modelCalls >= 12) {
            state.meta.ready = false; state.meta.lastError = { code: 'OPERATIONS_BUDGET_EXHAUSTED', message: 'Demo assessment budget reached. Previous plans remain available.' }; return null;
          }
          const runId = `ops_run_${++state.meta.runCount}`, claimId = randomUUID(); state.meta.modelCalls++;
          state.meta.lease = { runId, claimId, expiresAt: now() + 120000 }; state.meta.dirty = false; state.meta.ready = false;
          state.agentRuns[runId] = { ...scope, runId, claimId, status: 'running', startedAt: iso(now()), snapshotVersion: state.meta.snapshotVersion };
          return { runId, claimId, state: structuredClone(state) };
        });
        if (claim) {
          const controller = new AbortController(); controllers.add(controller); const timer = setTimeout(() => controller.abort(), 90000);
          try {
            const state = claim.state, snap = state.snapshots[`OPS-SNAPSHOT-${state.meta.snapshotVersion}`];
            const requests = [ ['get_hospital_capacity', { hospitalId: 'HOSP-001' }], ['get_hospital_capabilities', { hospitalId: 'HOSP-001' }],
              ['find_available_specialists', { hospitalId: 'HOSP-001', specialty: 'pulmonology' }], ['find_available_specialists', { hospitalId: 'HOSP-001', specialty: 'cardiology' }],
              ['get_ambulance_availability', {}], ['get_hospital_capacity', { hospitalId: 'HOSP-003' }], ['find_available_specialists', { hospitalId: 'HOSP-003', specialty: 'pulmonology' }] ];
            const investigation = [];
            for (const [toolName, args] of requests) {
              const evidenceId = `OPS-RESOURCE-${claim.runId}-${investigation.length + 1}`;
              const result = await resources.execute(toolName, args, { state, caseStore });
              investigation.push({ ...scope, evidenceId, toolName, arguments: args, result, observedAt: iso(now()), risk: 'READ_ONLY' });
            }
            const evidenceRefs = [snap.snapshotId, ...investigation.map(item => item.evidenceId)];
            const previous = state.plans[state.meta.currentRevisionId];
            const context = { ...scope, ...(notificationsEnabled ? { notificationTools: availableTools(notificationSource, state) } : {}), snapshot: snap, previousSnapshot: previous ? state.snapshots[`OPS-SNAPSHOT-${previous.snapshotVersion}`] : null,
              previousAssessment: previous?.assessment || null, resourceInvestigation: investigation, evidenceRefs,
              resourceChanges: values(state.events).filter(item => item.type === 'resource.updated' && item.resourceVersion === snap.resourceVersion).map(({ before, after, resourceVersion }) => ({ hospitalId: scope.hospitalId, before, after, resourceVersion })),
              completedActions: values(state.receipts).map(({ toolName, snapshotVersion }) => ({ toolName, snapshotVersion })) };
            const assessment = validateOperationalAssessment(await model(context, controller.signal), context);
            await transaction(live => {
              refresh(live);
              if (live.meta.lease?.claimId !== claim.claimId) return;
              const run = live.agentRuns[claim.runId]; live.meta.lease = null;
              if (evidenceFingerprint(live) !== snap.evidenceFingerprint || live.meta.snapshotVersion !== snap.snapshotVersion) { run.status = 'superseded'; invalidate(live); return; }
              for (const item of investigation) live.resourceSnapshots[item.evidenceId] = item;
              supersedeApprovals(live);
              const revisionId = `OPS-PLAN-${++live.meta.revision}`;
              for (const proposal of assessment.recommendedActions) if (isActionTool(proposal.toolName)) requireThat(notificationsEnabled && availableTools(notificationSource, live).includes(proposal.toolName), 'NOTIFICATION_TOOL_UNAVAILABLE', 409);
              const actions = assessment.recommendedActions.filter(item => !live.receipts[`receipt_ops_exec_${snap.snapshotVersion}_${item.toolName}`]).map(item => ({ ...item,
                actionId: `${snap.snapshotVersion}_${item.toolName}`, arguments: isActionTool(item.toolName) ? bindArguments(item.toolName, notificationSource, notificationOptions) : { hospitalId: scope.hospitalId, snapshotVersion: snap.snapshotVersion }, risk: tools[item.toolName] }));
              immutablePlan(live, { ...scope, planId: 'OPS-PLAN', revisionId, supersedesRevisionId: live.meta.currentRevisionId, createdAt: iso(now()), snapshotVersion: snap.snapshotVersion, evidenceFingerprint: snap.evidenceFingerprint,
                resourceVersion: snap.resourceVersion, fleetEvidenceVersion: snap.fleetEvidenceVersion, assessment, actions, evidenceRefs });
              for (const action of actions) if (action.risk === 'HIGH_IMPACT') {
                const approvalId = `approval_${revisionId}_${action.actionId}`;
                // Revision-bound approvals; stable execution IDs still prevent a
                // repeated plan from performing the same snapshot's effect twice.
                if (!live.approvals[approvalId]) live.approvals[approvalId] = { ...scope, approvalId, planRevisionId: revisionId, actionId: action.actionId, status: 'pending',
                  argumentsDigest: digest({ ...scope, toolName: action.toolName, arguments: action.arguments }), resourceVersion: snap.resourceVersion,
                  fleetEvidenceVersion: snap.fleetEvidenceVersion, expiresAt: iso(now() + 600000), reviewerId: null };
              }
              if (notificationsEnabled) stageNotifications(live, notificationSource, live.plans[revisionId], actions, now());
              live.meta.ready = true; live.meta.lastError = null; live.meta.nextMonitorAt = now() + 300000;
              for (const trigger of values(live.events)) if (trigger.status === 'pending' && trigger.eventVersion <= state.meta.eventVersion) { trigger.status = 'completed'; trigger.processedBy = claim.runId; }
              live.meta.lastProcessedEventVersion = state.meta.eventVersion;
              live.monitoring.main = monitoringRecord({ scope, subject: { workspaceId: id }, revisionId, conditions: assessment.monitoringConditions, now: now() });
              run.status = 'completed'; run.completedAt = iso(now()); run.planRevisionId = revisionId;
              event(live, 'hospital.plan.created', `plan_${revisionId}`, { revisionId });
              recordPressureSignal(live, now());
            });
          } catch (error) {
            await transaction(state => { if (state.meta.lease?.claimId !== claim.claimId) return;
              state.meta.lease = null; state.meta.ready = false; state.meta.dirty = false; state.meta.nextMonitorAt = now() + 300000;
              state.meta.lastError = { code: ['RATE_LIMIT', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'AUTH_ERROR', 'INVALID_RESPONSE', 'GEMINI_ERROR'].includes(error.safeModelError?.code) ? error.safeModelError.code : 'OPERATIONS_RUN_UNAVAILABLE',
                message: 'Hospital assessment unavailable. Review previous evidence; request a new run when ready.' };
              state.agentRuns[claim.runId].status = 'failed'; state.agentRuns[claim.runId].completedAt = iso(now()); supersedeApprovals(state); if (notificationsEnabled) supersedeNotifications(state, now());
            });
          } finally { clearTimeout(timer); controllers.delete(controller); }
        }
        const state = await store.read(id), plan = state.plans[state.meta.currentRevisionId];
        if (state.meta.ready && plan) for (const action of plan.actions) {
          if (action.risk !== 'HIGH_IMPACT' || approvalFor(state, plan.revisionId, action.actionId)?.status === 'approved') await execute(plan.revisionId, action.actionId);
        }
      } finally { running = false; }
    },
    async close() { closed = true; for (const controller of controllers) controller.abort(); await activeTick; await store.close(); },
  };
  const tickWork = service.tick;
  service.tick = () => { if (closed) return Promise.resolve(); if (!activeTick) activeTick = tickWork().finally(() => { activeTick = null; }); return activeTick; };
  return service;
}

import { randomUUID } from 'node:crypto';
import { isActionTool, bindArguments, availableTools } from '../notifications/contracts.js';
import { stageNotifications, supersedeNotifications, notificationDecision, performAction, consumeFollowups, reconcileNotifications } from '../notifications/lifecycle.js';
import { durableEvent, executionJournal, reconcileReceipts, immutablePlan, currentPlan, monitoringRecord } from '../agent-core/lifecycle.js';
import { initializeResources, updateCapacity } from '../resources/service.js';
import { resourceToolNames, validateCatalog } from '../resources/contracts.js';
import { createResourceInvestigator, validateInvestigation } from '../resources/investigator.js';
import { validCaseId } from '../cases/store.js';
import { digest, exact, requireThat, scope, token, policy, validateObservations, validateAssessment } from './contracts.js';
import { queryTool, simulateClinicalReview, fictionalHistory } from './tools.js';
import { createClinicalModel, clinicalModel, configurationVersion } from './model.js';
import { handoffTool } from '../hospital/contracts.js';

const values = object => Object.values(object);
const iso = n => new Date(n).toISOString();
const MAX_RUNS = 8, MAX_CALLS = 12, MAX_OBSERVATIONS = 60, MAX_EVENTS = 180;
export function createClinicalService({ store, caseStore, caseId, model = createClinicalModel(), modelName = clinicalModel(), now = Date.now, simulate = simulateClinicalReview, resources = null, investigator = resources ? createResourceInvestigator() : null, notificationsEnabled = false, notificationOptions = {}, hospitalHandoff = null }) {
  requireThat(validCaseId(caseId), 'INVALID_CASE_ID');
  let stopped = false, activeTick;
  const browserConfirmations = new Map();
  const actionDigest = action => digest({ toolName: action.toolName, arguments: action.arguments, caseId, ...(action.handoffBinding ? { handoffBinding: action.handoffBinding } : {}) });
  const write = change => store.transaction(caseId, change);
  const notificationSource = { scope: 'clinical', subjectId: caseId, agentType: 'clinical' };
  const notificationActionId = (state, name) => `m12_${state.meta.observationVersion}_${state.resourceEnvironment?.version || 0}_${name}`;
  function event(state, type, id, version = state.meta.observationVersion, causationId = null) {
    if (state.events[id]) return state.events[id];
    requireThat(values(state.events).length < MAX_EVENTS, 'EVENT_LIMIT', 409);
    return state.events[id] = durableEvent({ eventId: id, type, subjectType: 'case', subjectId: caseId, version, now: now(), causationId, scope,
      pending: ['observation.recorded', 'agent.run.requested', 'monitor.due', 'resource.updated'].includes(type), extra: { resourceVersion: state.resourceEnvironment?.version || 0, fleetEvidenceVersion: state.fleetEvidenceVersion || null } });
  }
  async function enroll() {
    const patientCase = await caseStore.getCase(caseId);
    requireThat(patientCase?.source === 'smartcareops_demo', 'FICTIONAL_CASE_REQUIRED', 409);
    return write(state => {
      const created = !state.meta;
      if (created) state.meta = { caseId, ...scope, createdAt: iso(now()), observationVersion: patientCase.intakeSource === 'live_intake' ? 1 : 0, currentRevisionId: null, runCount: 0, modelCalls: 0, ready: false, active: null, storageVersion: 0 };
      if (resources && !state.resourceEnvironment) initializeResources(state, now());
      if (created && patientCase.intakeSource === 'live_intake') event(state, 'agent.run.requested', 'case_received', 1);
      return state.meta;
    });
  }
  async function changeCapacity(input) {
    requireThat(resources, 'RESOURCE_TOOLS_DISABLED', 409); await enroll();
    exact(input, ['requestId', 'hospitalId', 'monitoredBedsAvailable', 'expectedVersion']);
    return write(state => {
      const eventId = 'resource_' + input.requestId, requestDigest = digest(input);
      if (state.events[eventId]) { requireThat(state.events[eventId].requestDigest === requestDigest, 'IDEMPOTENCY_CONFLICT', 409); return state.events[eventId]; }
      const previousMonitoredBedsAvailable = state.resourceEnvironment.hospitals.find(h => h.hospitalId === input.hospitalId)?.capacity.monitoredBedsAvailable;
      updateCapacity(state, input, now()); state.meta.ready = false; if (notificationsEnabled) supersedeNotifications(state, now());
      for (const approval of values(state.approvals)) if (['pending', 'approved'].includes(approval.status) && !values(state.toolExecutions).some(e => e.approvalId === approval.approvalId && e.status === 'succeeded')) approval.status = 'superseded';
      return Object.assign(event(state, 'resource.updated', eventId), { requestDigest, changedHospitalId: input.hospitalId, previousMonitoredBedsAvailable, monitoredBedsAvailable: input.monitoredBedsAvailable });
    });
  }
  async function append(input) {
    const observations = validateObservations(input, now()); await enroll();
    return write(state => {
      const eventId = `obs_${input.requestId}`, requestDigest = digest(observations);
      if (state.events[eventId]) { requireThat(state.events[eventId].requestDigest === requestDigest, 'IDEMPOTENCY_CONFLICT', 409); return state.events[eventId]; }
      requireThat(values(state.observations).length + observations.length <= MAX_OBSERVATIONS, 'OBSERVATION_LIMIT', 409);
      const version = ++state.meta.observationVersion;
      observations.forEach((item, index) => {
        if (item.correctionOf) {
          const original = state.observations[item.correctionOf];
          requireThat(original && original.type === item.type && !values(state.observations).some(o => o.correctionOf === item.correctionOf), 'INVALID_CORRECTION', 409);
        }
        const observationId = `${eventId}_${index}`;
        state.observations[observationId] = { ...item, observationId, caseId, version, ...scope, receivedAt: iso(now()), createdAt: iso(now()) };
      });
      state.meta.ready = false;
      if (notificationsEnabled) supersedeNotifications(state, now());
      for (const approval of values(state.approvals)) if (['pending', 'approved'].includes(approval.status)) approval.status = 'superseded';
      return Object.assign(event(state, 'observation.recorded', eventId, version), { requestDigest });
    });
  }
  async function requestRun(requestId) {
    requireThat(token(requestId)); await enroll();
    const patient = await caseStore.getCase(caseId);
    return write(state => { requireThat(state.meta.observationVersion > 0 || patient?.workflowStatus === 'submitted_for_clinical_review', 'OBSERVATIONS_REQUIRED', 409); return event(state, 'agent.run.requested', `request_${requestId}`); });
  }
  function currentApproval(state, approval) {
    const revision = state.plans[approval?.revisionId];
    const action = revision?.recommendedActions.find(a => a.actionId === approval.actionId);
    requireThat(approval && revision && action && currentPlan(state, revision, true) &&
      state.meta.observationVersion === approval.evidenceVersion && revision.inputVersion === approval.evidenceVersion &&
      approval.argumentsDigest === actionDigest(action) &&
      approval.resourceVersion === 'receipt-simulator-v1' && approval.caseId === caseId &&
      (approval.resourceEvidenceVersion || 0) === (state.resourceEnvironment?.version || 0) &&
      (approval.fleetEvidenceVersion || null) === (state.fleetEvidenceVersion || null), 'STALE_APPROVAL', 409);
    requireThat(Date.parse(approval.expiresAt) > now(), 'APPROVAL_EXPIRED', 409);
    requireThat(policy(action.toolName, action.arguments).approvalRequired, 'INVALID_APPROVAL', 409);
    return action;
  }
  async function decide(approvalId, decision, reviewerId = 'demo_doctor') {
    requireThat(token(approvalId) && ['approved', 'rejected', 'deferred', 'revoked'].includes(decision));
    requireThat(typeof reviewerId === 'string' && reviewerId.length > 0 && reviewerId.length <= 128);
    return write(state => {
      const approval = state.approvals[approvalId]; currentApproval(state, approval);
      if (approval.status === decision) return approval;
      requireThat(decision === 'revoked' ? approval.status === 'approved' && !values(state.toolExecutions).some(e => e.approvalId === approvalId && (e.status === 'succeeded' || e.toolName === handoffTool && ['running', 'unknown_outcome'].includes(e.status))) : approval.status === 'pending', 'APPROVAL_NOT_PENDING', 409);
      Object.assign(approval, { status: decision, reviewer: reviewerId, decidedAt: iso(now()) });
      if (notificationsEnabled) notificationDecision(state, approval.revisionId, approval.actionId, decision);
      event(state, 'approval.decided', `decision_${approvalId}_${decision}`);
      return approval;
    });
  }
  function journal(state, revision, action, approvalId = null) {
    const executionId = `exec_${action.actionId}`;
    if (!state.toolExecutions[executionId]) state.toolExecutions[executionId] = executionJournal({ executionId, subject: { caseId }, revisionId: revision.revisionId, action,
      argumentsDigest: actionDigest(action), approvalId, scope });
    return state.toolExecutions[executionId];
  }
  async function executeHospital(approvalId) {
    requireThat(hospitalHandoff, 'HOSPITAL_HANDOFF_DISABLED', 409);
    const patient = await caseStore.getCase(caseId);
    const claim = await write(state => {
      const approval = state.approvals[approvalId];
      const revision = state.plans[approval?.revisionId];
      const action = revision?.recommendedActions.find(a => a.actionId === approval?.actionId);
      requireThat(action?.toolName === handoffTool, 'INVALID_APPROVAL', 409);
      const existing = values(state.toolExecutions).find(e => e.actionId === action.actionId);
      if (existing?.status === 'succeeded') return { execution: existing, action, complete: true };
      if (existing?.status === 'running' && Date.parse(existing.startedAt) + 180000 > now()) return { execution: existing, action, complete: true };
      if (existing && ['running', 'unknown_outcome'].includes(existing.status)) return { execution: existing, action, reconcileOnly: true };
      currentApproval(state, approval); requireThat(approval.status === 'approved', 'APPROVAL_REQUIRED', 409);
      requireThat(digest(hospitalHandoff.binding(patient, action.arguments.hospitalId)) === digest(action.handoffBinding), 'STALE_APPROVAL', 409);
      const execution = journal(state, revision, action, approvalId);
      requireThat(execution.status === 'pending', 'EXECUTION_NOT_PENDING', 409);
      Object.assign(execution, { status: 'running', attempt: 1, startedAt: iso(now()) });
      return { execution, action, reconcileOnly: false };
    });
    if (claim.complete) return claim.execution;
    const executionId = claim.execution.executionId;
    let verified = null;
    try {
      verified = await hospitalHandoff.submitCase({ caseId, hospitalId: claim.action.arguments.hospitalId, payload: patient.reportedFacts,
        idempotencyKey: 'handoff_' + digest({ caseId, hospitalId: claim.action.arguments.hospitalId, payloadDigest: claim.action.handoffBinding.payloadDigest }) },
      { expectedBinding: claim.action.handoffBinding, reconcileOnly: claim.reconcileOnly, confirm: () => new Promise(resolve => {
        const confirmationId = randomUUID();
        const finish = approved => { clearTimeout(timer); browserConfirmations.delete(executionId); resolve(approved); };
        const timer = setTimeout(() => finish(false), 150000);
        browserConfirmations.set(executionId, { confirmationId, finish });
        void write(state => { state.toolExecutions[executionId].confirmation = { confirmationId, status: 'pending' }; }).catch(() => finish(false));
      }) });
    } catch { /* Unknown side effects remain non-replayable, with safe metadata. */ }
    browserConfirmations.get(executionId)?.finish(false);
    return write(state => {
      const execution = state.toolExecutions[executionId];
      if (execution.status === 'succeeded') return execution;
      if (execution.confirmation?.status === 'pending') execution.confirmation.status = 'expired';
      if (verified) {
        const receiptId = `receipt_${executionId}`;
        state.receipts[receiptId] = { receiptId, executionId, caseId, simulation: true, createdAt: iso(now()), hospitalReceipt: verified,
          outcome: `Fictional hospital confirmed receipt ${verified.receiptId}.` };
        Object.assign(execution, { status: 'succeeded', receiptRef: receiptId, completedAt: iso(now()), outcome: state.receipts[receiptId].outcome });
        event(state, 'tool.execution.completed', `completed_${executionId}`);
      } else Object.assign(execution, { status: 'unknown_outcome', outcome: 'UNKNOWN_OUTCOME — receipt reconciliation required. No automatic resubmission.' });
      return execution;
    });
  }
  async function confirmHospitalAction(executionId, confirmationId, approved) {
    requireThat(token(executionId) && typeof confirmationId === 'string' && typeof approved === 'boolean');
    const pending = browserConfirmations.get(executionId);
    requireThat(pending?.confirmationId === confirmationId, 'STALE_APPROVAL', 409);
    const patient = await caseStore.getCase(caseId);
    await write(state => {
      const execution = state.toolExecutions[executionId], approval = state.approvals[execution?.approvalId];
      const action = currentApproval(state, approval);
      requireThat(approval.status === 'approved' && execution.status === 'running' && execution.confirmation?.status === 'pending', 'STALE_APPROVAL', 409);
      requireThat(digest(hospitalHandoff.binding(patient, action.arguments.hospitalId)) === digest(action.handoffBinding), 'STALE_APPROVAL', 409);
      execution.confirmation.status = approved ? 'approved' : 'rejected';
    });
    requireThat(browserConfirmations.get(executionId) === pending, 'STALE_APPROVAL', 409);
    pending.finish(approved);
    return { status: approved ? 'approved' : 'rejected' };
  }
  async function execute(approvalId) {
    const snapshot = await store.read(caseId);
    const proposed = snapshot.plans[snapshot.approvals[approvalId]?.revisionId]?.recommendedActions.find(a => a.actionId === snapshot.approvals[approvalId]?.actionId);
    if (proposed?.toolName === handoffTool) return executeHospital(approvalId);
    const executionId = await write(state => {
      const approval = state.approvals[approvalId];
      const existing = values(state.toolExecutions).find(e => e.approvalId === approvalId);
      if (existing?.status === 'succeeded') return existing.executionId;
      currentApproval(state, approval); requireThat(approval.status === 'approved', 'APPROVAL_REQUIRED', 409);
      return journal(state, state.plans[approval.revisionId], currentApproval(state, approval), approvalId).executionId;
    });
    // Transaction 1 above durably records intent BEFORE any side effect.
    return write(state => {
      const execution = state.toolExecutions[executionId];
      if (execution.status === 'succeeded') return execution;
      if (execution.status === 'unknown_outcome' || execution.status === 'running') {
        const receipt = state.receipts[`receipt_${executionId}`];
        if (receipt) Object.assign(execution, { status: 'succeeded', outcome: receipt.outcome, receiptRef: receipt.receiptId, completedAt: receipt.createdAt });
        else execution.status = 'unknown_outcome';
        return execution; // Reconcile only; never replay uncertain effects.
      }
      requireThat(execution.status === 'pending', 'EXECUTION_NOT_PENDING', 409);
      const approval = state.approvals[approvalId]; currentApproval(state, approval); requireThat(approval.status === 'approved', 'APPROVAL_REQUIRED', 409);
      Object.assign(execution, { status: 'running', attempt: 1, startedAt: iso(now()) });
      try {
        const sourcePlan = state.plans[approval.revisionId], action = sourcePlan.recommendedActions.find(item => item.actionId === approval.actionId);
        const receipt = isActionTool(action.toolName) ? (requireThat(notificationsEnabled, 'NOTIFICATIONS_DISABLED', 409), performAction(state, notificationSource, sourcePlan, action, execution, now())) : simulate(state, execution, iso(now()));
        requireThat(receipt?.executionId === executionId && receipt.simulation === true && state.receipts[receipt.receiptId], 'INVALID_RECEIPT');
        Object.assign(execution, { status: 'succeeded', completedAt: iso(now()), receiptRef: receipt.receiptId, outcome: receipt.outcome });
        event(state, 'tool.execution.completed', `completed_${executionId}`);
      } catch { execution.status = 'unknown_outcome'; execution.outcome = 'Outcome uncertain; reconciliation required. No automatic replay.'; }
      return execution;
    });
  }
  async function autoActions(revisionId) {
    let state = await store.read(caseId); const revision = state.plans[revisionId];
    if (!revision) return;
    for (const action of revision.recommendedActions.filter(a => !a.approvalRequired)) {
      if (isActionTool(action.toolName)) {
        if (!notificationsEnabled) continue;
        const valid = s => s.meta.ready && s.meta.currentRevisionId === revisionId && s.meta.observationVersion === revision.inputVersion && (revision.resourceEvidenceVersion || 0) === (s.resourceEnvironment?.version || 0) && (revision.fleetEvidenceVersion || null) === (s.fleetEvidenceVersion || null);
        const executionId = await write(s => valid(s) ? journal(s, revision, action).executionId : null);
        if (!executionId) continue;
        await write(s => {
          const execution = s.toolExecutions[executionId];
          if (execution.status !== 'pending') return;
          if (!valid(s)) { execution.status = 'superseded'; supersedeNotifications(s, now()); return; }
          const receipt = performAction(s, notificationSource, revision, action, execution, now());
          Object.assign(execution, { status: 'succeeded', attempt: 1, startedAt: iso(now()), completedAt: iso(now()), receiptRef: receipt.receiptId, outcome: receipt.outcome });
          event(s, 'tool.execution.completed', `completed_${executionId}`);
        });
        continue;
      }
      const entry = await write(s => {
        if (!s.meta.ready || s.meta.currentRevisionId !== revisionId || s.meta.observationVersion !== revision.inputVersion || (revision.resourceEvidenceVersion || 0) !== (s.resourceEnvironment?.version || 0) || (revision.fleetEvidenceVersion || null) !== (s.fleetEvidenceVersion || null)) return null;
        const execution = journal(s, revision, action);
        if (execution.status === 'succeeded' || execution.attempt >= 2) return null;
        Object.assign(execution, { status: 'running', attempt: execution.attempt + 1, startedAt: iso(now()) }); return execution;
      });
      if (!entry) continue;
      try {
        state = await store.read(caseId);
        const result = await queryTool(action.toolName, { caseStore, caseId, state, resources, args: action.arguments });
        if (resourceToolNames.includes(action.toolName)) await write(s => { s.toolExecutions[entry.executionId].result = result; });
        await write(s => { Object.assign(s.toolExecutions[entry.executionId], { status: 'succeeded', completedAt: iso(now()), outcome: 'Read-only investigation completed; no state mutation.' }); event(s, 'tool.execution.completed', `completed_${entry.executionId}`); });
      } catch { await write(s => Object.assign(s.toolExecutions[entry.executionId], { status: 'failed', outcome: 'Investigation unavailable.' })); }
    }
  }
  async function processRun() {
    const claimId = randomUUID();
    const claim = await write(state => {
      if (!state.meta) return null;
      for (const approval of values(state.approvals)) if (['pending', 'approved'].includes(approval.status) && Date.parse(approval.expiresAt) <= now()) approval.status = 'expired';
      if (state.meta.active && Date.parse(state.meta.active.leaseUntil) > now()) return null;
      if (state.meta.active) {
        const old = state.agentRuns[state.meta.active.runId]; old.status = 'interrupted';
        const trigger = state.events[old.triggerEventId]; trigger.status = old.attempt < 2 ? 'pending' : 'failed'; state.meta.active = null;
      }
      const monitor = state.monitoring.main;
      if (monitor?.status === 'active' && Date.parse(monitor.nextEvaluationAt) <= now()) {
        event(state, 'monitor.due', `monitor_${monitor.nextEvaluationAt.replace(/[^0-9]/g, '')}`);
        monitor.nextEvaluationAt = iso(now() + 300000);
      }
      const pending = values(state.events).filter(e => e.status === 'pending').sort((a, b) => b.subjectVersion - a.subjectVersion);
      for (const e of pending) if (e.subjectVersion < state.meta.observationVersion || (e.resourceVersion || 0) < (state.resourceEnvironment?.version || 0) || (e.fleetEvidenceVersion || null) !== (state.fleetEvidenceVersion || null)) e.status = 'stale';
      const trigger = pending.find(e => e.status === 'pending'); if (!trigger) return null;
      if (state.meta.runCount >= MAX_RUNS || state.meta.modelCalls + (resources ? 2 : 1) > MAX_CALLS) { trigger.status = 'bounded'; if (monitor) monitor.status = 'bounded'; return null; }
      const runId = `run_${trigger.eventId}_${(trigger.attempt || 0) + 1}`;
      trigger.attempt = (trigger.attempt || 0) + 1; trigger.status = 'processing';
      // Coalesce duplicate triggers for the same observation version.
      for (const e of pending) if (e !== trigger && e.status === 'pending') e.status = 'coalesced';
      state.meta.runCount++; state.meta.modelCalls += resources ? 2 : 1; state.meta.ready = false;
      state.meta.active = { runId, claimId, leaseUntil: iso(now() + (resources ? 120000 : 75000)) };
      const run = state.agentRuns[runId] = { runId, agentType: 'clinical', caseId, triggerEventId: trigger.eventId, inputVersions: { observations: state.meta.observationVersion, history: 1, resources: state.resourceEnvironment?.version || 0, fleet: state.fleetEvidenceVersion || null },
        model: modelName, configurationVersion, status: 'investigating', attempt: trigger.attempt, startedAt: iso(now()), completedAt: null, assessmentSummary: null, planRevisionId: null, toolExecutionIds: [], ...scope };
      return { run: structuredClone(run), state: structuredClone(state) };
    });
    if (!claim) return;
    const { run } = claim;
    try {
      const patientCase = await caseStore.getCase(caseId), livePatientCase = patientCase?.intakeSource === 'live_intake';
      const context = { caseId, simulation: true, reportedFactsPolicy: 'Patient-reported facts are immutable evidence; interpretations and doctor assessment are separate.', ...(hospitalHandoff ? { hospitalHandoffTargets: hospitalHandoff.targets } : {}), ...(notificationsEnabled ? { notificationTools: availableTools(notificationSource, claim.state) } : {}), observationVersion: claim.state.meta.observationVersion, investigation: {}, evidenceRefs: livePatientCase ? ['case'] : ['case', 'history'], previousPlan: claim.state.plans[claim.state.meta.currentRevisionId] || null,
        completedActions: values(claim.state.toolExecutions).filter(e => e.status === 'succeeded').map(e => ({ toolName: e.toolName, outcome: e.outcome, observationVersion: claim.state.plans[e.planRevisionId]?.inputVersion || null })) };
      if (resources) context.resourceChanges = values(claim.state.events)
        .filter(e => e.type === 'resource.updated' && e.changedHospitalId && e.resourceVersion === claim.state.resourceEnvironment.version)
        .map(e => ({ eventId: e.eventId, hospitalId: e.changedHospitalId, previousMonitoredBedsAvailable: e.previousMonitoredBedsAvailable,
          monitoredBedsAvailable: e.monitoredBedsAvailable, resourceVersion: e.resourceVersion, occurredAt: e.occurredAt }));
      for (const name of ['read_case', 'read_observation_history', ...(livePatientCase ? [] : ['read_fictional_patient_history']), 'evaluate_safety']) {
        const executionId = `investigate_${run.runId}_${name}`;
        await write(s => { s.toolExecutions[executionId] = { executionId, caseId, toolName: name, planRevisionId: null, actionId: null, approvalId: null, argumentsDigest: digest({ caseId }), idempotencyKey: executionId, attempt: 1, status: 'running', startedAt: iso(now()), completedAt: null, outcome: null, receiptRef: null, ...scope }; s.agentRuns[run.runId].toolExecutionIds.push(executionId); });
        context.investigation[name] = await queryTool(name, { caseStore, caseId, state: claim.state });
        await write(s => Object.assign(s.toolExecutions[executionId], { status: 'succeeded', completedAt: iso(now()), outcome: 'Evidence retrieved for bounded clinical assessment.' }));
      }
      context.evidenceRefs.push(...values(claim.state.observations).map(o => o.observationId));
      if (resources) {
        validateCatalog(claim.state.resourceEnvironment);
        const selectionSignal = AbortSignal.timeout(15000);
        const selectionContext = { ...context, resourceVersion: claim.state.resourceEnvironment.resourceVersion,
          fleet: await caseStore.listAmbulances(), availableHospitalIds: ['HOSP-001', 'HOSP-002', 'HOSP-003'] };
        const requests = await Promise.race([investigator(selectionContext, selectionSignal), new Promise((_, reject) => selectionSignal.addEventListener('abort', () => reject(selectionSignal.reason), { once: true }))]);
        validateInvestigation({ requests });
        context.resourceInvestigation = [];
        for (const [index, request] of requests.entries()) {
          const executionId = 'TOOL-' + digest({ runId: run.runId, index, request }).slice(0, 32);
          const snapshotId = 'RESOURCE-SNAPSHOT-' + digest({ executionId }).slice(0, 32);
          await write(s => {
            requireThat(s.meta.active?.claimId === claimId, 'STALE_RUN', 409);
            s.toolExecutions[executionId] = { executionId, caseId, toolName: request.toolName, arguments: request.arguments, argumentsDigest: digest(request.arguments), planRevisionId: null, actionId: null, approvalId: null, idempotencyKey: executionId, status: 'running', attempt: 1, startedAt: iso(now()), completedAt: null, outcome: null, receiptRef: null, ...scope };
            s.agentRuns[run.runId].toolExecutionIds.push(executionId);
          });
          try {
            const result = await queryTool(request.toolName, { caseStore, caseId, state: claim.state, resources, args: request.arguments });
            await write(s => {
              s.resourceSnapshots[snapshotId] = { snapshotId, executionId, runId: run.runId, toolName: request.toolName, arguments: request.arguments, result, createdAt: iso(now()), ...scope };
              Object.assign(s.toolExecutions[executionId], { status: 'succeeded', completedAt: iso(now()), result, receiptRef: snapshotId, outcome: 'Normalized simulated operational evidence retrieved.' });
            });
            context.evidenceRefs.push(executionId, snapshotId);
            context.resourceInvestigation.push({ executionId, snapshotId, toolName: request.toolName, result });
          } catch {
            await write(s => Object.assign(s.toolExecutions[executionId], { status: 'failed', completedAt: iso(now()), outcome: 'Resource investigation unavailable. No live data substituted.' }));
            throw new Error('Resource investigation unavailable');
          }
        }
      }
      const signal = AbortSignal.timeout(60000);
      const assessment = await Promise.race([model(context, signal), new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      validateAssessment(assessment, context.evidenceRefs);
      const revisionId = await write(s => {
        if (s.meta.active?.claimId !== claimId) return null;
        const record = s.agentRuns[run.runId]; s.meta.active = null;
        if (s.meta.observationVersion !== run.inputVersions.observations || (s.resourceEnvironment?.version || 0) !== run.inputVersions.resources || (s.fleetEvidenceVersion || null) !== run.inputVersions.fleet) { record.status = 'stale'; s.events[run.triggerEventId].status = 'stale'; return null; }
        const version = values(s.plans).length + 1, revisionId = `revision_${version}`, planId = `plan_${caseId}`;
        for (const proposal of assessment.recommendedActions) if (isActionTool(proposal.toolName)) requireThat(notificationsEnabled && availableTools(notificationSource, s).includes(proposal.toolName), 'NOTIFICATION_TOOL_UNAVAILABLE', 409);
        if (notificationsEnabled) supersedeNotifications(s, now());
        const actions = assessment.recommendedActions.filter(proposal => !isActionTool(proposal.toolName) || !s.receipts[`receipt_exec_${notificationActionId(s, proposal.toolName)}`]).map((proposal, index) => ({ ...proposal, actionId: isActionTool(proposal.toolName) ? notificationActionId(s, proposal.toolName) : proposal.toolName === 'simulate_clinical_review' ? `review_observation_${s.meta.observationVersion}` : `${revisionId}_action_${index}`, arguments: isActionTool(proposal.toolName) ? bindArguments(proposal.toolName, notificationSource, notificationOptions) : proposal.arguments || {}, dependencies: [],
          ...policy(proposal.toolName, proposal.arguments || {}), status: 'proposed', validityConditions: { observationVersion: s.meta.observationVersion, historyVersion: 1, resourceVersion: 'receipt-simulator-v1', resourceEvidenceVersion: run.inputVersions.resources } }));
        for (const action of actions.filter(a => a.toolName === handoffTool)) {
          requireThat(hospitalHandoff, 'HOSPITAL_HANDOFF_DISABLED', 409);
          action.handoffBinding = hospitalHandoff.binding(context.investigation.read_case, action.arguments.hospitalId);
          action.actionId = 'hospital_' + digest({ caseId, hospitalId: action.arguments.hospitalId, payloadDigest: action.handoffBinding.payloadDigest }).slice(0, 32);
        }
        immutablePlan(s, { ...assessment, recommendedActions: actions, planId, revisionId, caseId, version, inputVersion: s.meta.observationVersion, resourceEvidenceVersion: run.inputVersions.resources, fleetEvidenceVersion: run.inputVersions.fleet, resourceSnapshotIds: (context.resourceInvestigation || []).map(r => r.snapshotId), evidenceRefs: context.evidenceRefs,
          createdAt: iso(now()), supersedesRevisionId: s.meta.currentRevisionId, ...scope });
        for (const approval of values(s.approvals)) if (['pending', 'approved'].includes(approval.status)) approval.status = 'superseded';
        for (const action of actions.filter(a => a.approvalRequired)) {
          // Same evidence cannot cause another simulated side effect on a timer/manual replan.
          if (s.toolExecutions[`exec_${action.actionId}`]) continue;
          const approvalId = `approval_${revisionId}_${action.actionId}`;
          s.approvals[approvalId] = { approvalId, caseId, revisionId, actionId: action.actionId, argumentsDigest: actionDigest(action), evidenceVersion: s.meta.observationVersion,
            resourceVersion: 'receipt-simulator-v1', resourceEvidenceVersion: run.inputVersions.resources, fleetEvidenceVersion: run.inputVersions.fleet, reviewer: null, status: 'pending', createdAt: iso(now()), decidedAt: null, expiresAt: iso(now() + 900000), ...scope };
        }
        if (notificationsEnabled) stageNotifications(s, notificationSource, s.plans[revisionId], actions, now());
        Object.assign(record, { status: 'completed', completedAt: iso(now()), assessmentSummary: assessment.changeSummary, planRevisionId: revisionId });
        s.meta.currentRevisionId = revisionId; s.meta.ready = true; s.events[run.triggerEventId].status = 'completed';
        event(s, 'plan.proposed', `proposed_${revisionId}`, s.meta.observationVersion, run.triggerEventId);
        s.monitoring.main = monitoringRecord({ scope, subject: { caseId }, revisionId, conditions: assessment.monitoringConditions, now: now(), extra: {
          lastProcessedObservationVersion: s.meta.observationVersion, lastProcessedResourceVersion: run.inputVersions.resources, lastProcessedFleetVersion: run.inputVersions.fleet } });
        return revisionId;
      });
      if (revisionId) await autoActions(revisionId);
    } catch (error) {
      await write(s => {
        if (s.meta.active?.claimId !== claimId) return;
        s.meta.active = null; s.meta.ready = false;
        if (notificationsEnabled) supersedeNotifications(s, now());
        Object.assign(s.agentRuns[run.runId], { status: 'failed', completedAt: iso(now()), error: { provider: 'gemini', code: ['RATE_LIMIT', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'AUTH_ERROR', 'INVALID_RESPONSE', 'GEMINI_ERROR'].includes(error.safeModelError?.code) ? error.safeModelError.code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'INVALID_RESPONSE', message: 'Assessment unavailable. Previous plan retained; dependent actions are blocked.' } });
        s.events[run.triggerEventId].status = 'failed';
      });
    }
  }
  async function tickWork() {
    if (notificationsEnabled) await write(s => { if (!s.meta) return; consumeFollowups(s, now(), followup => {
      s.meta.ready = false; supersedeNotifications(s, now()); event(s, 'agent.run.requested', `due_${followup.followupId}`, s.meta.observationVersion, followup.followupId);
    }); });
    let state = await store.read(caseId);
    if (resources && !state.resourceEnvironment) { await enroll(); state = await store.read(caseId); }
    if (!state.meta) return;
    if (resources && state.meta.observationVersion > 0 && ((state.monitoring.main?.lastProcessedResourceVersion || 0) !== state.resourceEnvironment.version || (state.monitoring.main?.lastProcessedFleetVersion || null) !== (state.fleetEvidenceVersion || null))) {
      await write(s => {
        const known = values(s.events).some(e => e.type === 'resource.updated' && e.resourceVersion === s.resourceEnvironment.version && (e.fleetEvidenceVersion || null) === (s.fleetEvidenceVersion || null) && ['pending', 'processing', 'completed', 'failed', 'bounded', 'coalesced'].includes(e.status));
        if (!known) {
          s.meta.ready = false;
          if (notificationsEnabled) supersedeNotifications(s, now());
          for (const approval of values(s.approvals)) if (['pending', 'approved'].includes(approval.status) && (approval.fleetEvidenceVersion || null) !== (s.fleetEvidenceVersion || null)) approval.status = 'superseded';
          event(s, 'resource.updated', 'resource_detected_' + s.resourceEnvironment.version + '_' + digest(s.fleetEvidenceVersion || null).slice(0, 12));
        }
      });
    }
    // Receipt-only reconciliation also works after supersession or expiry.
    await write(s => { reconcileReceipts(s); if (notificationsEnabled) reconcileNotifications(s, now()); });
    for (const approval of values(state.approvals).filter(a => a.status === 'approved' || values(state.toolExecutions).some(e => e.approvalId === a.approvalId && e.toolName === handoffTool && ['running', 'unknown_outcome'].includes(e.status)))) { try { await execute(approval.approvalId); } catch { /* Stale/expired approval remains non-executable. */ } }
    if (state.meta.ready && state.meta.currentRevisionId) await autoActions(state.meta.currentRevisionId);
    await processRun();
  }
  function tick() {
    if (stopped) return Promise.resolve();
    if (!activeTick) activeTick = tickWork().finally(() => { activeTick = null; });
    return activeTick;
  }
  async function view() {
    const patientCase = await caseStore.getCase(caseId), livePatientCase = patientCase?.intakeSource === 'live_intake';
    if (livePatientCase) await enroll();
    const state = await store.read(caseId);
    return { enabled: true, storage: store.storage, caseId, ...scope, meta: state.meta, history: livePatientCase ? { source: 'patient_case', version: 1, conditions: [], disclaimer: 'No additional history was inferred.' } : fictionalHistory,
      patientCase: { intakeSource: patientCase?.intakeSource || null, workflowStatus: patientCase?.workflowStatus || null, emergency: patientCase?.emergency || null },
      resourcesEnabled: !!resources, notifications: values(state.notifications || {}), followups: values(state.followups || {}), resourceEnvironment: state.resourceEnvironment, resourceSnapshots: values(state.resourceSnapshots),
      observations: values(state.observations).sort((a,b) => a.observedAt.localeCompare(b.observedAt)), events: values(state.events), runs: values(state.agentRuns),
      plans: values(state.plans).map(plan => ({ ...plan, status: plan.revisionId === state.meta?.currentRevisionId ? 'current' : 'superseded', recommendedActions: plan.recommendedActions.map(action => {
        const execution = state.toolExecutions[`exec_${action.actionId}`], approval = values(state.approvals).find(a => a.revisionId === plan.revisionId && a.actionId === action.actionId);
        return { ...action, status: execution?.status || approval?.status || (plan.revisionId === state.meta?.currentRevisionId ? 'pending' : 'superseded'), approvalId: approval?.approvalId || null };
      }) })), approvals: values(state.approvals), executions: values(state.toolExecutions), receipts: values(state.receipts), monitoring: state.monitoring.main || null };
  }
  return { caseId, enroll, append, changeCapacity, requestRun, decide, execute, confirmHospitalAction, tick, view, async close() { stopped = true; for (const pending of browserConfirmations.values()) pending.finish(false); await activeTick; await store.close(); } };
}

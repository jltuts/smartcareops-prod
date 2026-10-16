import { apiFetch } from '../../auth/service.js';
import './operations.css';
import { renderRegional, mountRegional } from './regional.js';
import { renderSimulation, mountSimulation } from './simulation.js';
import { renderCareTwin, mountCareTwin } from './caretwin.js';
import { renderPredictive, mountPredictive } from './predictive.js';
import { renderPatterns, mountPatterns } from './patterns.js';
import { mountCommandCenterMotion } from './motion.js';
export const renderCommandCenter = () => `<div class="command-center-masthead"><section class="role-page ops-header" aria-labelledby="page-heading">
  <div class="ops-header-copy"><p class="eyebrow">SmartCareOps · Network operations</p>
  <h1 id="page-heading" tabindex="-1">Command Center</h1><p class="role-subtitle">See current pressure, investigate emerging signals, and compare options before a human decision.</p></div>
  <p class="ops-workflow-cue"><span>Operator workflow</span>Observe the network <b aria-hidden="true">→</b> Investigate signals <b aria-hidden="true">→</b> Compare plans <b aria-hidden="true">→</b> Review decisions</p>
</section></div><nav class="command-center-nav" aria-label="Command Center sections">
  <a class="active" aria-current="location" href="#command-center-overview">Overview</a><a href="#simulation-heading">Network</a><a href="#alerts">Alerts</a><a href="#operations-heading">Hospital Operations</a><a href="#predictive-heading">Predictive Intelligence</a><a href="#caretwin-heading">CareTwin</a><a href="#pattern-heading">Pattern Intelligence</a>
</nav><section id="command-center-overview" class="command-center-overview" aria-labelledby="overview-heading">
  <div class="overview-intro"><div><p class="section-kicker">Operational overview</p><h2 id="overview-heading">What needs attention</h2><p>Fictional network overview. Hospital Operations below shows aggregate HOSP-001 records, not Patient case activity.</p></div><a class="overview-primary-link" href="#operations-heading">Open Hospital Operations →</a></div>
  <div class="overview-grid"><article class="overview-status-card" aria-labelledby="overview-status-heading"><p class="section-kicker">HOSP-001 · Hospital Operations</p><h3 id="overview-status-heading">Current assessment</h3><p id="overview-assessment-status" class="overview-assessment-status" role="status">Loading current assessment…</p><p id="overview-assessment-detail">Checking the latest operational record.</p><p id="overview-observed-at" class="overview-observed-at"></p></article>
  <div class="overview-next-steps" aria-label="Command Center destinations"><a href="#simulation-heading"><strong>Network state</strong><span>Review synthetic hospital and fleet capacity →</span></a><a href="#alerts"><strong>Alerts</strong><span>Investigate emerging network signals →</span></a><a href="#operations-heading"><strong>Operational review</strong><span>Inspect assessment, approval, and receipt →</span></a></div></div>
  <p class="overview-boundary">To verify a specific Case ID or confirm that a routine intake did not trigger Hospital Operations, use the access-controlled Demo Console.</p>
</section>${renderSimulation()}${renderPatterns()}<section class="hospital-operations-section" aria-labelledby="operations-heading">
  <div class="hospital-operations-heading"><div><p class="section-kicker">Fictional hospital demo · HOSP-001</p><h2 id="operations-heading">Hospital Operations</h2><p>Review the current assessment and any human-controlled decision. No real hospital, bed, staff member, or ambulance is contacted or reserved.</p></div></div>
  <div class="ops-review-summary" aria-label="Current operational review"><p class="section-kicker">Current review</p><div class="ops-review-steps"><div><strong>1 · Capacity</strong><span id="ops-summary-capacity">Loading…</span></div><div><strong>2 · Assessment</strong><span id="ops-summary-assessment">Loading…</span></div><div><strong>3 · Decision</strong><span id="ops-summary-decision">Loading…</span></div><div><strong>4 · Outcome</strong><span id="ops-summary-outcome">Loading…</span></div></div></div>
  <section class="ops-workspace" aria-label="Hospital Operations review"><p id="ops-message" role="status">Loading hospital operations…</p><div id="ops-content"></div><details class="ops-technical-trace"><summary>Technical trace and history</summary><div id="ops-technical-content"></div></details>
    <div class="ops-review-controls"><button type="button" id="ops-refresh">Refresh operations</button> <button type="button" id="ops-run" disabled>Request assessment</button><button type="button" id="ops-capacity" disabled>Demo: set monitored beds to 0</button> <button type="button" id="ops-reset" disabled>Reset Hospital Operations demo</button></div>
    <p class="ops-demo-reset-note">Reset restores the fictional monitored-bed baseline and a fresh bounded assessment budget. Historical plans and receipts remain visible.</p>
  </section>
</section>${renderPredictive()}${renderCareTwin()}<section class="ops-supporting" aria-labelledby="supporting-operations-heading">
  <div class="supporting-heading">
    <div><p class="section-kicker">Additional records</p><h2 id="supporting-operations-heading">Operational workspaces</h2></div>
    <p>Open detailed regional or notification records when needed.</p>
  </div>
  <section class="ops-panel ops-wide" aria-labelledby="emergency-response-heading"><p class="section-kicker">Read-only operational feed</p><h3 id="emergency-response-heading">Emergency response coordination</h3><p id="emergency-response-message" role="status">Loading fictional response activity…</p><div id="emergency-response-counts"></div><button id="emergency-response-refresh" type="button">Refresh response activity</button></section>
  <div class="supporting-drawers">
    <details class="supporting-drawer regional-support">
      <summary><span>Regional Intelligence</span><small>Cross-hospital evidence and assessments</small></summary>
      ${renderRegional()}
    </details>
    <details class="supporting-drawer notification-support">
      <summary><span>Notifications</span><small>Operational notices and delivery receipts</small></summary>
      <div data-notification-host></div>
    </details>
  </div>
</section>`;

export function mountCommandCenter(root) {
  root.classList.add('command-center-main');
  const cleanupPatterns = mountPatterns(root);
  const cleanupRegional = mountRegional(root);
  const cleanupSimulation = mountSimulation(root);
  const cleanupCareTwin = mountCareTwin(root);
  const cleanupPredictive = mountPredictive(root);
  const cleanupMotion = mountCommandCenterMotion(root);
  const emergencyMessage = root.querySelector('#emergency-response-message'), emergencyCounts = root.querySelector('#emergency-response-counts');
  const emergencyRefresh = root.querySelector('#emergency-response-refresh');
  async function refreshEmergencyResponses() {
    try {
      const response = await apiFetch('/api/operations/emergency-responses', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const result = await response.json(); if (controller.signal.aborted) return;
      const counts = result.counts; emergencyCounts.replaceChildren();
      const rows = [
        ['Active responses', counts.activeResponses], ['Awaiting dispatcher', counts.pending_dispatcher], ['Dispatcher acknowledged', counts.acknowledged],
        ['Destinations accepted', counts.destinationsAccepted], ['Ambulances assigned', counts.assigned], ['En route', counts.en_route],
        ['At pickup', counts.at_pickup], ['Transporting', counts.transporting], ['Arrived at hospital', counts.arrived_hospital],
        ['Fleet available', counts.availableAmbulances], ['Fleet reserved', counts.reservedAmbulances],
      ];
      const list = document.createElement('ul'); for (const [label, value] of rows) { const item = document.createElement('li'); item.textContent = `${label}: ${value}`; list.append(item); } emergencyCounts.append(list);
      for (const hospital of result.hospitalCapacity || []) {
        const detail = document.createElement('p'); detail.textContent = `${hospital.hospitalName}: ${hospital.emergencyBedsAvailable} simulated emergency beds available · ${hospital.arrivedPatients} confirmed simulated arrival${hospital.arrivedPatients === 1 ? '' : 's'}`; emergencyCounts.append(detail);
      }
      emergencyMessage.textContent = 'Current fictional response state. Patient details are not included.';
    } catch { if (!controller.signal.aborted) emergencyMessage.textContent = 'Emergency response activity is unavailable. Refresh to retry.'; }
  }
  const content = root.querySelector('#ops-content'), technicalContent = root.querySelector('#ops-technical-content'), message = root.querySelector('#ops-message');
  const overviewStatus = root.querySelector('#overview-assessment-status'), overviewDetail = root.querySelector('#overview-assessment-detail'), overviewObservedAt = root.querySelector('#overview-observed-at');
  const summaryCapacity = root.querySelector('#ops-summary-capacity'), summaryAssessment = root.querySelector('#ops-summary-assessment'), summaryDecision = root.querySelector('#ops-summary-decision'), summaryOutcome = root.querySelector('#ops-summary-outcome');
  const refreshButton = root.querySelector('#ops-refresh'), runButton = root.querySelector('#ops-run'), capacityButton = root.querySelector('#ops-capacity'), resetButton = root.querySelector('#ops-reset');
  const controller = new AbortController(); let state, busy = false, currentPanel, sectionHost = content;
  const element = (tag, text, parent = currentPanel || content) => {
    if (tag === 'h3') { currentPanel = document.createElement('article'); currentPanel.className = 'ops-panel'; sectionHost.append(currentPanel); parent = currentPanel;
      if (text.startsWith('Operational status:') || text.startsWith('Current plan') || text === 'Operational actions') currentPanel.classList.add('ops-wide'); }
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  };
  const request = async (path = '', body) => {
    const response = await apiFetch('/api/operations' + path, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('Hospital view could not be refreshed, or the action is out of date.');
    return response.json();
  };
  function render() {
    content.replaceChildren(); technicalContent.replaceChildren(); currentPanel = null; sectionHost = content;
    const snap = state.currentSnapshot, plan = state.plans.find(item => item.revisionId === state.meta.currentRevisionId);
    const currentActions = plan?.actions || [];
    const pendingApprovals = state.approvals.filter(item => item.planRevisionId === plan?.revisionId && item.status === 'pending');
    const currentReceipts = state.receipts.filter(item => item.planRevisionId === plan?.revisionId);
    const status = state.meta.lastError ? 'Assessment unavailable' : state.meta.ready ? plan?.assessment.status || 'Awaiting assessment' : 'Awaiting current assessment';
    overviewStatus.textContent = status;
    overviewDetail.textContent = state.meta.lastError ? 'Current assessment unavailable. Previous plans are retained; decisions are blocked.'
      : pendingApprovals.length ? `${pendingApprovals.length} fictional action${pendingApprovals.length === 1 ? '' : 's'} awaiting human review.`
        : plan ? 'No human approval is currently pending for this plan.' : 'No current operational plan is available.';
    overviewObservedAt.textContent = snap ? `Snapshot ${snap.snapshotVersion} · Observed ${snap.observedAt}` : 'No capacity snapshot is available.';
    summaryCapacity.textContent = snap ? `${snap.capacity.monitoredBedsAvailable} monitored beds · ${snap.capacity.icuBedsAvailable} ICU beds` : 'Capacity unavailable';
    summaryAssessment.textContent = plan && state.meta.ready ? `${plan.assessment.status} · ${plan.revisionId}` : status;
    summaryDecision.textContent = pendingApprovals.length ? `${pendingApprovals.length} awaiting human review` : currentActions.length ? 'No approval pending' : 'No current actions';
    summaryOutcome.textContent = currentReceipts.length ? `${currentReceipts.length} durable receipt${currentReceipts.length === 1 ? '' : 's'} for this plan` : 'No receipt for the current plan';
    element('h3', `Operational status: ${state.meta.ready ? plan?.assessment.status || 'Awaiting assessment' : 'Awaiting current assessment'}`);
    element('p', 'Status is the agent’s operational assessment for this fictional hospital.');
    if (snap) {
      element('p', `Active cases: ${snap.counts.active} · Emergency cases: ${snap.counts.emergency} · Respiratory cases: ${snap.counts.respiratory} · Incoming: ${snap.counts.incoming}`);
      element('p', `Monitored beds: ${snap.capacity.monitoredBedsAvailable} · ICU beds: ${snap.capacity.icuBedsAvailable} · ${snap.resourceVersion}`);
      element('p', `Snapshot ${snap.snapshotVersion} · Observed ${snap.observedAt}`);
      sectionHost = technicalContent; currentPanel = null;
      element('h3', 'Specialty demand'); const list = element('ul', '');
      for (const [specialty, count] of Object.entries(snap.specialtyLoad)) element('li', `${specialty}: ${count}`, list);
      element('h3', 'Specialist availability'); const specialists = element('ul', '');
      for (const item of snap.specialists) element('li', `${item.specialty}: ${item.available ? 'available' : 'unavailable'}`, specialists);
      sectionHost = content; currentPanel = null;
    }
    if (state.meta.lastError) element('p', 'Assessment unavailable. Previous plans are retained; actions are blocked until a current assessment succeeds.');
    if (plan) {
      element('h3', `Current plan ${plan.revisionId}`); element('p', plan.assessment.changeSummary);
      for (const [key, title] of [['observations', 'Observations'], ['operationalRisks', 'Operational risks'], ['bottlenecks', 'Bottlenecks']]) {
        element('h4', title); const list = element('ul', ''); for (const item of plan.assessment[key]) element('li', `${item.summary} (${item.evidenceRefs.join(', ')})`, list);
      }
      for (const key of ['uncertainties', 'monitoringConditions']) { element('h4', key === 'uncertainties' ? 'Uncertainties' : 'Monitoring'); const list = element('ul', ''); for (const item of plan.assessment[key]) element('li', item, list); }
      element('h3', 'Operational actions');
      for (const action of plan.actions) {
        const approval = state.approvals.find(item => item.actionId === action.actionId && item.planRevisionId === plan.revisionId), execution = state.executions.find(item => item.actionId === action.actionId);
        const row = element('div', ''); row.className = 'ops-action'; element('p', `${action.toolName} · ${action.risk} · ${execution?.status || approval?.status || 'pending'} — ${action.expectedOutcome}`, row);
        element('p', action.risk === 'HIGH_IMPACT' ? 'Human approval required · Demo reviewer: demo_ops' : 'Automatic local action', row);
        if (action.risk === 'HIGH_IMPACT') element('p', 'Approval records a fictional rehearsal only. No bed, staff or ambulance is reserved.', row);
        if (approval?.status === 'pending') for (const decision of ['approved', 'rejected']) {
          const button = element('button', decision === 'approved' ? 'Approve simulation' : 'Reject simulation', row); button.type = 'button'; button.disabled = !state.meta.ready || busy;
          button.addEventListener('click', () => void mutate(`/approvals/${approval.approvalId}`, { decision }, decision === 'approved' ? 'Recording human approval for this fictional action…' : 'Recording rejection of this fictional action…'));
        }
      }
      sectionHost = technicalContent; currentPanel = null;
      element('h3', 'Decision trace');
      const traces = (state.decisionTrace || []).filter(item => item.planRevisionId === plan.revisionId);
      if (!traces.length) element('p', 'No event-linked decision trace is available for this plan.');
      for (const trace of traces) {
        const row = element('article', ''); row.className = 'ops-decision-trace';
        const triggers = trace.triggers.length ? trace.triggers.map(item => `${item.eventType} · ${item.occurredAt}`).join('; ') : 'Manual or local trigger';
        element('h4', trace.action.toolName, row);
        element('p', `Trigger: ${triggers}`, row);
        element('p', `Evidence: ${trace.evidenceRefs.join(', ')}`, row);
        element('p', `Action: ${trace.action.risk} · ${trace.action.expectedOutcome}`, row);
        element('p', `Approval: ${trace.approval.status}${trace.approval.decidedAt ? ` · ${trace.approval.decidedAt}` : ''}`, row);
        element('p', `Outcome: ${trace.receipt?.outcome || trace.execution.status}${trace.receipt?.createdAt ? ` · ${trace.receipt.createdAt}` : ''}`, row);
      }
    }
    sectionHost = technicalContent; currentPanel = null;
    element('h3', 'Resource investigation');
    for (const item of state.resourceEvidence.slice(-14)) {
      const details = element('details', ''); element('summary', `${item.toolName} · ${item.result.hospitalId || 'fleet'} · ${item.result.resourceVersion}`, details);
      element('pre', JSON.stringify(item.result, null, 2), details);
    }
    const fleet = [...state.resourceEvidence].reverse().find(item => item.toolName === 'get_ambulance_availability');
    if (fleet) element('p', `Ambulances available: ${fleet.result.units.filter(item => item.status === 'available').length} · Reserved: ${fleet.result.units.filter(item => item.status !== 'available').length}`);
    element('h3', 'Plan history'); for (const item of state.plans) element('p', `${item.revisionId} · Snapshot ${item.snapshotVersion} · ${item.assessment.status} · ${item.createdAt}`).id = 'plan-' + item.revisionId;
    element('h3', 'Completed receipts'); for (const receipt of state.receipts) element('p', `${receipt.receiptId} · ${receipt.outcome}`);
    element('h3', 'Event timeline'); const events = element('ul', ''); for (const event of state.events) element('li', `${event.occurredAt} · ${event.type}`, events);
    element('h3', 'Agent runs'); for (const run of state.runs) element('p', `${run.runId} · ${run.status} · Snapshot ${run.snapshotVersion}`, currentPanel);
    runButton.disabled = busy; capacityButton.disabled = busy || !snap || snap.capacity.monitoredBedsAvailable === 0; resetButton.disabled = busy || !snap;
  }
  async function refresh() { try { state = await request(); if (controller.signal.aborted) return; render(); message.textContent = state.meta.ready ? 'Current operational assessment available.' : 'Waiting for a current operational assessment.'; } catch { if (!controller.signal.aborted) { message.textContent = 'Hospital Operations is unavailable in the current demo configuration. Refresh to retry.'; overviewStatus.textContent = 'Unavailable'; overviewDetail.textContent = 'Current operational records could not be loaded.'; overviewObservedAt.textContent = ''; summaryCapacity.textContent = 'Unavailable'; summaryAssessment.textContent = 'Unavailable'; summaryDecision.textContent = 'Unavailable'; summaryOutcome.textContent = 'Unavailable'; runButton.disabled = true; capacityButton.disabled = true; resetButton.disabled = true; content.querySelectorAll('button').forEach(button => { button.disabled = true; }); } } }
  async function mutate(path, body, pendingMessage = 'Recording fictional operation…') { if (busy) return; busy = true; render(); message.textContent = pendingMessage; try { await request(path, body); await refresh(); } catch (error) { if (!controller.signal.aborted) message.textContent = error.message; } finally { busy = false; if (!controller.signal.aborted && state) render(); } }
  refreshButton.addEventListener('click', refresh);
  runButton.addEventListener('click', () => void mutate('/run', { requestId: crypto.randomUUID() }, 'Requesting a current fictional assessment…'));
  capacityButton.addEventListener('click', () => void mutate('/capacity', { requestId: crypto.randomUUID(), hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: Number(state.currentSnapshot.resourceVersion.split(':')[1]) }, 'Recording the fictional capacity change…'));
  resetButton.addEventListener('click', () => void mutate('/reset', { requestId: crypto.randomUUID() }, 'Resetting the fictional Hospital Operations scenario…'));
  const operationsTimer = setInterval(refresh, 5000); void refresh();
  emergencyRefresh.addEventListener('click', refreshEmergencyResponses); void refreshEmergencyResponses();
  return () => { controller.abort(); clearInterval(operationsTimer); emergencyRefresh.removeEventListener('click', refreshEmergencyResponses); cleanupMotion(); cleanupPatterns(); cleanupRegional(); cleanupSimulation(); cleanupCareTwin(); cleanupPredictive(); root.classList.remove('command-center-main'); };
}

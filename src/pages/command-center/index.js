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
  <div class="overview-next-steps" aria-label="Command Center destinations"><a href="#simulation-heading"><strong>Network state</strong><span>Review fictional hospital and fleet capacity →</span></a><a href="#alerts"><strong>Alerts</strong><span>Review signals that need attention →</span></a><a href="#operations-heading"><strong>Hospital demo</strong><span>Review capacity and the suggested response →</span></a></div></div>
  <p class="overview-boundary">To verify a specific Case ID or confirm that a routine intake did not trigger Hospital Operations, use the access-controlled Demo Console.</p>
</section>${renderSimulation()}${renderPatterns()}<section class="hospital-operations-section" aria-labelledby="operations-heading">
  <div class="hospital-operations-heading"><div><p class="section-kicker">Fictional hospital demo · HOSP-001</p><h2 id="operations-heading">Hospital Operations</h2><p>See how SmartCareOps responds to a fictional hospital capacity change. Every proposed action stays under human control.</p></div></div>
  <div class="ops-demo-guide">
    <div class="ops-demo-copy"><h3 id="ops-demo-heading">Run the hospital pressure demo</h3><p id="ops-demo-status" role="status">Loading the current hospital status…</p>
      <div id="ops-demo-result" class="ops-demo-result" hidden><h4>What the demo did</h4><ul><li id="ops-demo-capacity-result"></li><li id="ops-demo-assessment-result"></li><li id="ops-demo-decision-result"></li></ul><p>No real hospital, bed, staff member, or ambulance was contacted or reserved.</p></div>
    </div>
    <button type="button" id="ops-demo-run" disabled>Run demo</button>
  </div>
  <details class="ops-details"><summary>View hospital details and controls</summary>
    <div class="ops-review-summary" aria-label="Current operational review"><p class="section-kicker">Current review</p><div class="ops-review-steps"><div><strong>1 · Capacity</strong><span id="ops-summary-capacity">Loading…</span></div><div><strong>2 · Assessment</strong><span id="ops-summary-assessment">Loading…</span></div><div><strong>3 · Decision</strong><span id="ops-summary-decision">Loading…</span></div><div><strong>4 · Outcome</strong><span id="ops-summary-outcome">Loading…</span></div></div></div>
    <section class="ops-workspace" aria-label="Hospital Operations review"><p id="ops-message" role="status">Loading hospital operations…</p><div id="ops-content"></div><details class="ops-technical-trace"><summary>Technical trace and history</summary><div id="ops-technical-content"></div></details>
      <details class="ops-advanced-controls"><summary>Demo controls</summary><div class="ops-review-controls"><button type="button" id="ops-refresh">Refresh operations</button> <button type="button" id="ops-run" disabled>Request assessment</button><button type="button" id="ops-capacity" disabled>Set fictional monitored beds to 0</button> <button type="button" id="ops-reset" disabled>Reset hospital demo</button></div>
      <p class="ops-demo-reset-note">Reset restores the fictional bed baseline and starts the scenario again. Previous demo records remain available.</p></details>
    </section>
  </details>
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
  const demoHeading = root.querySelector('#ops-demo-heading'), demoStatus = root.querySelector('#ops-demo-status'), demoRunButton = root.querySelector('#ops-demo-run');
  const demoResult = root.querySelector('#ops-demo-result'), demoCapacityResult = root.querySelector('#ops-demo-capacity-result');
  const demoAssessmentResult = root.querySelector('#ops-demo-assessment-result'), demoDecisionResult = root.querySelector('#ops-demo-decision-result');
  const refreshButton = root.querySelector('#ops-refresh'), runButton = root.querySelector('#ops-run'), capacityButton = root.querySelector('#ops-capacity'), resetButton = root.querySelector('#ops-reset');
  const operationsDetails = root.querySelector('.ops-details');
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
    const approvalIsCurrent = item => item.status === 'pending' && new Date(item.expiresAt).getTime() > Date.now();
    const pendingApprovals = state.approvals.filter(item => item.planRevisionId === plan?.revisionId && approvalIsCurrent(item));
    const expiredApprovals = state.approvals.filter(item => item.planRevisionId === plan?.revisionId && item.status === 'pending' && !approvalIsCurrent(item));
    const currentReceipts = state.receipts.filter(item => item.planRevisionId === plan?.revisionId);
    const status = state.meta.lastError ? 'Assessment could not be prepared' : state.meta.ready ? plan?.assessment.status || 'Awaiting assessment' : 'Awaiting current assessment';
    if (!busy) {
      if (state.meta.lastError || !plan) {
        demoHeading.textContent = 'Run the hospital pressure demo';
        demoStatus.textContent = 'One click prepares the scenario, simulates capacity pressure, and creates an operational review.';
        demoResult.hidden = true;
      } else {
        demoHeading.textContent = plan.assessment.status === 'CONSTRAINED' ? 'Hospital capacity needs attention' : 'Hospital review is ready';
        demoStatus.textContent = plan.assessment.changeSummary;
        demoCapacityResult.textContent = `Created fictional hospital pressure with ${snap?.capacity.monitoredBedsAvailable ?? 0} monitored beds available.`;
        demoAssessmentResult.textContent = `Prepared a ${plan.assessment.status.toLowerCase()} operational assessment with ${currentActions.length} suggested action${currentActions.length === 1 ? '' : 's'}.`;
        demoDecisionResult.textContent = pendingApprovals.length
          ? `Left ${pendingApprovals.length} high-impact action${pendingApprovals.length === 1 ? '' : 's'} for human review.`
          : expiredApprovals.length ? 'The human-review window expired. Run the demo again to create a current review.'
          : 'Completed the automatic simulation steps; no human approval is currently pending.';
        demoResult.hidden = false;
      }
    }
    overviewStatus.textContent = status;
    overviewDetail.replaceChildren();
    if (state.meta.lastError) {
      overviewDetail.textContent = 'The capacity change was recorded, but the assessment did not complete. Run the demo again.';
    } else if (pendingApprovals.length) {
      const reviewLink = document.createElement('a'); reviewLink.href = '#ops-actions'; reviewLink.className = 'overview-review-link';
      reviewLink.textContent = `${pendingApprovals.length} fictional action${pendingApprovals.length === 1 ? '' : 's'} awaiting human review →`;
      reviewLink.addEventListener('click', event => {
        event.preventDefault(); operationsDetails.open = true;
        requestAnimationFrame(() => { const target = root.querySelector('#ops-actions'); target?.scrollIntoView({ behavior: 'smooth', block: 'start' }); target?.focus({ preventScroll: true }); });
      });
      overviewDetail.append(reviewLink);
    } else if (expiredApprovals.length) {
      const rerunLink = document.createElement('a'); rerunLink.href = '#ops-demo-run'; rerunLink.className = 'overview-review-link';
      rerunLink.textContent = 'The review window expired. Run the demo again →';
      rerunLink.addEventListener('click', event => { event.preventDefault(); demoRunButton.scrollIntoView({ behavior: 'smooth', block: 'center' }); demoRunButton.focus({ preventScroll: true }); });
      overviewDetail.append(rerunLink);
    } else overviewDetail.textContent = plan ? 'No human approval is currently pending for this plan.' : 'No current operational plan is available.';
    overviewObservedAt.textContent = snap ? `Snapshot ${snap.snapshotVersion} · Observed ${snap.observedAt}` : 'No capacity snapshot is available.';
    summaryCapacity.textContent = snap ? `${snap.capacity.monitoredBedsAvailable} monitored beds · ${snap.capacity.icuBedsAvailable} ICU beds` : 'Capacity unavailable';
    summaryAssessment.textContent = plan && state.meta.ready ? `${plan.assessment.status} · ${plan.revisionId}` : status;
    summaryDecision.textContent = pendingApprovals.length ? `${pendingApprovals.length} awaiting human review` : expiredApprovals.length ? `${expiredApprovals.length} review window${expiredApprovals.length === 1 ? '' : 's'} expired` : currentActions.length ? 'No approval pending' : 'No current actions';
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
    if (state.meta.lastError) element('p', 'The previous demo session ended. Run the scenario above to start fresh.');
    if (plan) {
      element('h3', `Current plan ${plan.revisionId}`); element('p', plan.assessment.changeSummary);
      for (const [key, title] of [['observations', 'Observations'], ['operationalRisks', 'Operational risks'], ['bottlenecks', 'Bottlenecks']]) {
        element('h4', title); const list = element('ul', ''); for (const item of plan.assessment[key]) element('li', `${item.summary} (${item.evidenceRefs.join(', ')})`, list);
      }
      for (const key of ['uncertainties', 'monitoringConditions']) { element('h4', key === 'uncertainties' ? 'Uncertainties' : 'Monitoring'); const list = element('ul', ''); for (const item of plan.assessment[key]) element('li', item, list); }
      const actionsHeading = element('h3', 'Operational actions'); actionsHeading.id = 'ops-actions'; actionsHeading.tabIndex = -1;
      const actionLabels = {
        read_operations_snapshot: 'Hospital status reviewed',
        publish_operations_summary: 'Operational summary updated',
        simulate_capacity_response: 'Capacity response simulation',
        simulate_staffing_response: 'Staffing response simulation',
      };
      for (const action of plan.actions) {
        const approval = state.approvals.find(item => item.actionId === action.actionId && item.planRevisionId === plan.revisionId), execution = state.executions.find(item => item.actionId === action.actionId);
        const approvalExpired = approval?.status === 'pending' && !approvalIsCurrent(approval);
        const status = execution?.status || (approvalExpired ? 'expired' : approval?.status) || 'pending';
        const statusLabels = { succeeded: 'Completed', pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected', superseded: 'Out of date', expired: 'Review expired' };
        const row = element('article', ''); row.className = `ops-action ops-action-${status}`;
        const header = element('div', '', row); header.className = 'ops-action-header';
        element('h4', actionLabels[action.toolName] || action.toolName.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' '), header);
        const badges = element('div', '', header); badges.className = 'ops-action-badges';
        const riskBadge = element('span', action.risk === 'HIGH_IMPACT' ? 'Human review' : 'Automatic', badges); riskBadge.className = action.risk === 'HIGH_IMPACT' ? 'ops-action-badge ops-action-badge-review' : 'ops-action-badge';
        const statusBadge = element('span', statusLabels[status] || status, badges); statusBadge.className = `ops-action-badge ops-action-status-${status}`;
        const outcome = element('p', action.expectedOutcome, row); outcome.className = 'ops-action-outcome';
        if (action.risk === 'HIGH_IMPACT') { const boundary = element('p', 'Approval records a fictional rehearsal only. No bed, staff member, or ambulance is reserved.', row); boundary.className = 'ops-action-boundary'; }
        if (approvalExpired) {
          const expiryMessage = element('p', 'This review window expired. Run the demo again to create a current assessment.', row); expiryMessage.className = 'ops-action-expired-message';
          const controls = element('div', '', row); controls.className = 'ops-action-controls';
          const rerunButton = element('button', 'Run demo again', controls); rerunButton.type = 'button'; rerunButton.className = 'ops-action-approve'; rerunButton.disabled = busy;
          rerunButton.addEventListener('click', () => void runDemoScenario());
        } else if (approval?.status === 'pending') for (const decision of ['approved', 'rejected']) {
          let controls = row.querySelector('.ops-action-controls'); if (!controls) { controls = element('div', '', row); controls.className = 'ops-action-controls'; }
          const button = element('button', decision === 'approved' ? 'Approve simulation' : 'Reject simulation', controls); button.type = 'button'; button.className = decision === 'approved' ? 'ops-action-approve' : 'ops-action-reject'; button.disabled = !state.meta.ready || busy;
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
    demoRunButton.disabled = busy; demoRunButton.textContent = busy ? 'Running demo…' : 'Run demo';
    runButton.disabled = busy; capacityButton.disabled = busy || !snap || snap.capacity.monitoredBedsAvailable === 0; resetButton.disabled = busy || !snap;
  }
  async function refresh() { try { state = await request(); if (controller.signal.aborted) return; render(); message.textContent = state.meta.ready ? 'Current operational assessment available.' : 'Waiting for a current operational assessment.'; } catch { if (!controller.signal.aborted) { message.textContent = 'Hospital Operations is unavailable in the current demo configuration. Refresh to retry.'; demoStatus.textContent = 'The hospital demo could not be loaded. Try again in a moment.'; overviewStatus.textContent = 'Unavailable'; overviewDetail.textContent = 'Current operational records could not be loaded.'; overviewObservedAt.textContent = ''; summaryCapacity.textContent = 'Unavailable'; summaryAssessment.textContent = 'Unavailable'; summaryDecision.textContent = 'Unavailable'; summaryOutcome.textContent = 'Unavailable'; demoRunButton.disabled = true; runButton.disabled = true; capacityButton.disabled = true; resetButton.disabled = true; content.querySelectorAll('button').forEach(button => { button.disabled = true; }); } } }
  async function mutate(path, body, pendingMessage = 'Recording fictional operation…') { if (busy) return; busy = true; render(); message.textContent = pendingMessage; try { await request(path, body); await refresh(); } catch (error) { if (!controller.signal.aborted) message.textContent = error.message; } finally { busy = false; if (!controller.signal.aborted && state) render(); } }
  const pause = ms => new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { controller.signal.removeEventListener('abort', cancelled); resolve(); }
    function cancelled() { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }
    controller.signal.addEventListener('abort', cancelled, { once: true });
  });
  async function waitForDemoAssessment() {
    for (let attempt = 0; attempt < 20; attempt++) {
      state = await request();
      const completedPlan = state.plans.find(item => item.revisionId === state.meta.currentRevisionId);
      if (state.meta.ready && completedPlan && completedPlan.snapshotVersion === state.currentSnapshot?.snapshotVersion && state.currentSnapshot.capacity.monitoredBedsAvailable === 0) return;
      if (state.meta.lastError && !state.meta.lease && !state.meta.dirty) throw new Error('The operational assessment could not be prepared. Select Run demo to try again.');
      demoStatus.textContent = 'Capacity pressure created. SmartCareOps is preparing the operational assessment…';
      await pause(1500);
    }
    throw new Error('The assessment is still being prepared. Wait a moment; this page will update automatically.');
  }
  async function runDemoScenario() {
    if (busy) return; busy = true; render(); demoStatus.textContent = 'Preparing a fresh fictional hospital scenario…';
    try {
      await request('/reset', { requestId: crypto.randomUUID() });
      demoStatus.textContent = 'Baseline restored. Creating fictional hospital capacity pressure…';
      const baseline = await request();
      demoStatus.textContent = 'Capacity pressure created. SmartCareOps is preparing the operational assessment…';
      await request('/capacity', { requestId: crypto.randomUUID(), hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: Number(baseline.currentSnapshot.resourceVersion.split(':')[1]) });
      await waitForDemoAssessment();
    } catch (error) {
      busy = false;
      if (!controller.signal.aborted && state) { render(); demoHeading.textContent = 'Demo could not finish'; demoStatus.textContent = error.message; demoResult.hidden = true; }
      return;
    }
    busy = false; if (!controller.signal.aborted && state) render();
  }
  demoRunButton.addEventListener('click', () => void runDemoScenario());
  refreshButton.addEventListener('click', refresh);
  runButton.addEventListener('click', () => void mutate('/run', { requestId: crypto.randomUUID() }, 'Requesting a current fictional assessment…'));
  capacityButton.addEventListener('click', () => void mutate('/capacity', { requestId: crypto.randomUUID(), hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: Number(state.currentSnapshot.resourceVersion.split(':')[1]) }, 'Recording the fictional capacity change…'));
  resetButton.addEventListener('click', () => void mutate('/reset', { requestId: crypto.randomUUID() }, 'Resetting the fictional Hospital Operations scenario…'));
  const operationsTimer = setInterval(() => { if (!busy) void refresh(); }, 5000); void refresh();
  emergencyRefresh.addEventListener('click', refreshEmergencyResponses); void refreshEmergencyResponses();
  return () => { controller.abort(); clearInterval(operationsTimer); emergencyRefresh.removeEventListener('click', refreshEmergencyResponses); cleanupMotion(); cleanupPatterns(); cleanupRegional(); cleanupSimulation(); cleanupCareTwin(); cleanupPredictive(); root.classList.remove('command-center-main'); };
}

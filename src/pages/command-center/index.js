import { apiFetch } from '../../auth/service.js';
import './operations.css';
import { renderRegional, mountRegional } from './regional.js';
import { renderSimulation, mountSimulation } from './simulation.js';
import { renderCareTwin, mountCareTwin } from './caretwin.js';
import { renderPredictive, mountPredictive } from './predictive.js';
export const renderCommandCenter = () => `<section class="role-page ops-header" aria-labelledby="page-heading">
  <a class="back-link" href="/" data-link>← Back to home</a><p class="eyebrow">For operations teams</p>
  <h1 id="page-heading" tabindex="-1">Command Center</h1><p class="role-subtitle">Monitor healthcare operations, capacity, incidents, and response.</p>
</section>${renderRegional()}${renderSimulation()}${renderPredictive()}${renderCareTwin()}<section class="ops-workspace" aria-labelledby="operations-heading">
  <span class="badge">Fictional hospital demo</span><h2 id="operations-heading">Hospital Operations — HOSP-001</h2><p>Hospital Operations Agent · Operations assessment, not clinical triage</p>
  <p id="ops-message" role="status">Loading hospital operations…</p><div id="ops-content"></div>
  <button type="button" id="ops-refresh">Refresh operations</button> <button type="button" id="ops-run" disabled>Request assessment</button>
  <button type="button" id="ops-capacity" disabled>Demo: set monitored beds to 0</button>
</section>`;

export function mountCommandCenter(root) {
  const cleanupRegional = mountRegional(root);
  const cleanupSimulation = mountSimulation(root);
  const cleanupCareTwin = mountCareTwin(root);
  const cleanupPredictive = mountPredictive(root);
  const content = root.querySelector('#ops-content'), message = root.querySelector('#ops-message');
  const refreshButton = root.querySelector('#ops-refresh'), runButton = root.querySelector('#ops-run'), capacityButton = root.querySelector('#ops-capacity');
  const controller = new AbortController(); let state, busy = false, currentPanel;
  const element = (tag, text, parent = currentPanel || content) => {
    if (tag === 'h3') { currentPanel = document.createElement('article'); currentPanel.className = 'ops-panel'; content.append(currentPanel); parent = currentPanel;
      if (text.startsWith('Operational status:') || text.startsWith('Current plan') || text === 'Operational actions') currentPanel.classList.add('ops-wide'); }
    const node = document.createElement(tag); node.textContent = text; parent.append(node); return node;
  };
  const request = async (path = '', body) => {
    const response = await apiFetch('/api/operations' + path, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('Hospital operations unavailable or the action is stale. Refresh to review current state.');
    return response.json();
  };
  function render() {
    content.replaceChildren(); currentPanel = null; const snap = state.currentSnapshot, plan = state.plans.find(item => item.revisionId === state.meta.currentRevisionId);
    element('h3', `Operational status: ${state.meta.ready ? plan?.assessment.status || 'Awaiting assessment' : 'Awaiting current assessment'}`);
    element('p', 'Status is the agent’s operational assessment for this fictional hospital.');
    if (snap) {
      element('p', `Active cases: ${snap.counts.active} · Emergency cases: ${snap.counts.emergency} · Respiratory cases: ${snap.counts.respiratory} · Incoming: ${snap.counts.incoming}`);
      element('p', `Monitored beds: ${snap.capacity.monitoredBedsAvailable} · ICU beds: ${snap.capacity.icuBedsAvailable} · ${snap.resourceVersion}`);
      element('p', `Snapshot ${snap.snapshotVersion} · Observed ${snap.observedAt}`);
      element('h3', 'Specialty demand'); const list = element('ul', '');
      for (const [specialty, count] of Object.entries(snap.specialtyLoad)) element('li', `${specialty}: ${count}`, list);
      element('h3', 'Specialist availability'); const specialists = element('ul', '');
      for (const item of snap.specialists) element('li', `${item.specialty}: ${item.available ? 'available' : 'unavailable'}`, specialists);
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
          button.addEventListener('click', () => void mutate(`/approvals/${approval.approvalId}`, { decision }));
        }
      }
    }
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
    runButton.disabled = busy; capacityButton.disabled = busy || !snap || snap.capacity.monitoredBedsAvailable === 0;
  }
  async function refresh() { try { state = await request(); if (controller.signal.aborted) return; render(); message.textContent = state.meta.ready ? 'Current operational assessment available.' : 'Waiting for a current operational assessment.'; } catch (error) { if (!controller.signal.aborted) { message.textContent = error.message; runButton.disabled = true; capacityButton.disabled = true; } } }
  async function mutate(path, body) { if (busy) return; busy = true; render(); try { await request(path, body); await refresh(); } catch (error) { if (!controller.signal.aborted) message.textContent = error.message; } finally { busy = false; if (!controller.signal.aborted && state) render(); } }
  refreshButton.addEventListener('click', refresh);
  runButton.addEventListener('click', () => void mutate('/run', { requestId: crypto.randomUUID() }));
  capacityButton.addEventListener('click', () => void mutate('/capacity', { requestId: crypto.randomUUID(), hospitalId: 'HOSP-001', monitoredBedsAvailable: 0, expectedVersion: Number(state.currentSnapshot.resourceVersion.split(':')[1]) }));
  void refresh(); const timer = setInterval(refresh, 5000);
  return () => { controller.abort(); clearInterval(timer); cleanupRegional(); cleanupSimulation(); cleanupCareTwin(); cleanupPredictive(); };
}

import { apiFetch } from '../../auth/service.js';
import './clinical.css';
export const clinicalMarkup = `<section class="clinical-workspace" aria-labelledby="clinical-heading">
  <h2 id="clinical-heading">AI clinical reasoning</h2>
  <p>Gemini provides concise possibilities and recommendations for doctor review. It does not change patient-reported facts, establish a diagnosis, or execute clinical actions.</p>
  <p id="clinical-message" aria-live="polite"></p>
  <div class="clinical-controls"><button id="clinical-refresh">Refresh clinical plan</button><button id="clinical-run" hidden>Request assessment</button></div>
  <form id="clinical-observe" hidden><h3>Record fictional observation</h3>
    <label for="clinical-type">Type</label><select id="clinical-type" name="type"><option value="temperature">Temperature (°C)</option><option value="heart_rate">Heart rate (bpm)</option><option value="blood_pressure">Blood pressure (mmHg, systolic/diastolic)</option><option value="spo2">SpO2 (%)</option><option value="symptom_update">Symptom update</option></select>
    <label>Value <input name="value" required maxlength="300"></label>
    <label>Observed at <input name="observedAt" type="datetime-local" required></label>
    <label for="clinical-source">Fictional source</label><select id="clinical-source" name="source"><option value="fictional_device">Demo device</option><option value="fictional_patient">Demo patient</option><option value="fictional_clinician">Demo clinician</option></select>
    <button>Append observation</button>
  </form><div id="clinical-content"></div>
</section>`;
const node = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
export function mountClinical(outlet) {
  const find = name => outlet.querySelector(`#clinical-${name}`);
  let disposed = false, generation = 0, busy = false, selectedCaseId;
  const controller = new AbortController();
  const message = value => { if (!disposed) find('message').textContent = value; };
  async function request(path = '', body) {
    const response = await apiFetch(`/api/clinical${path}${selectedCaseId ? `?caseId=${encodeURIComponent(selectedCaseId)}` : ''}`, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('Clinical demo request unavailable. Refresh before retrying.');
    return response.json();
  }
  async function command(path, body) {
    if (busy) return; busy = true;
    try { await request(path, body); message('Saved. Waiting for durable worker results…'); await refresh(); }
    catch { message('Request could not be confirmed. Refresh to check the durable result.'); }
    finally { busy = false; }
  }
  function render(data) {
    const content = find('content'); content.replaceChildren();
    const livePatientCase = data.patientCase?.intakeSource === 'live_intake';
    find('observe').hidden = livePatientCase; find('run').hidden = false;
    content.append(node('p', `Case ${data.caseId} · ${data.storage} · doctor-authorized workspace`));
    const observed = node('section', ''); observed.append(node('h3', 'Observed — fictional data'));
    for (const o of data.observations) observed.append(node('p', `${o.type}: ${typeof o.value === 'object' ? `${o.value.systolic}/${o.value.diastolic}` : o.value} ${o.unit} · ${o.observedAt} · ${o.source} · ${o.observationId}${o.correctionOf ? ` · correction of ${o.correctionOf}` : ''}`));
    if (data.observations.length) content.append(observed);
    if (!livePatientCase) content.append(node('h3', 'Investigated'), node('p', `Explicit fictional history: ${data.history.conditions.join(', ')}. ${data.history.disclaimer}`));
    for (const run of data.runs.slice(-3)) content.append(node('p', `Agent run: ${run.status}${run.error ? ` · ${run.error.message}` : ''}`));
    if (data.resourcesEnabled && data.resourceEnvironment) {
      const catalog = data.resourceEnvironment, resources = node('section', ''); resources.className = 'clinical-resources';
      resources.append(node('h3', 'Operational resources · Simulation'), node('p', 'Fictional hospitals and estimated routes. No live hospital, Maps or traffic data. Route lookup does not dispatch an ambulance.'),
        node('p', `Current resource version: ${catalog.resourceVersion} · Updated ${catalog.updatedAt}`));
      for (const hospital of catalog.hospitals) {
        const card = node('section', ''); card.className = 'clinical-resource-card';
        card.append(node('h4', `${hospital.hospitalId} · ${hospital.name}`), node('p', `Current simulated monitored beds: ${hospital.capacity.monitoredBedsAvailable}`));
        const button = node('button', `Set ${hospital.hospitalId} monitored beds to 0 (simulation)`); button.type = 'button'; button.disabled = hospital.capacity.monitoredBedsAvailable === 0;
        button.addEventListener('click', () => { button.disabled = true; void command('/resources/capacity', { requestId: crypto.randomUUID(), hospitalId: hospital.hospitalId, monitoredBedsAvailable: 0, expectedVersion: catalog.version }); });
        card.append(button); resources.append(card);
      }
      for (const event of data.events.filter(e => e.type === 'resource.updated')) resources.append(node('p', `Resource change: ${event.changedHospitalId || 'catalog'} · version ${event.resourceVersion} · ${event.status} · ${event.occurredAt}`));
      content.append(resources);
    }
    for (const plan of [...data.plans].sort((a, b) => b.version - a.version)) {
      const section = node('section', ''); section.className = 'clinical-plan'; section.dataset.revision = plan.version;
      section.id = 'plan-' + plan.revisionId; section.append(node('h3', `${plan.version > 1 && plan.status === 'current' ? 'PLAN UPDATED · ' : ''}Revision ${plan.version} · ${plan.status}`), node('p', plan.changeSummary));
      const analysis = node('section', ''); analysis.className = 'clinical-analysis';
      analysis.append(node('h4', 'AI analysis'), node('p', plan.caseSummary || plan.changeSummary), node('h5', 'Important findings'));
      for (const item of plan.importantFindings || plan.observations || []) analysis.append(node('p', `${item.summary} · Evidence: ${item.evidenceRefs.join(', ')}`));
      analysis.append(node('h5', 'Risks')); for (const item of plan.risks) analysis.append(node('p', `${item.summary} · Evidence: ${item.evidenceRefs.join(', ')}`));
      analysis.append(node('h5', 'Missing information')); for (const value of plan.missingInformation) analysis.append(node('p', value));
      analysis.append(node('h5', 'Differential considerations — possibilities, not diagnoses'));
      for (const item of plan.differentialConsiderations || plan.hypotheses || []) analysis.append(node('p', `${item.summary} · Evidence: ${item.evidenceRefs.join(', ')}`));
      analysis.append(node('h5', 'Uncertainty')); for (const value of plan.uncertainty || plan.uncertainties || []) analysis.append(node('p', value));
      const explanation = node('section', ''); explanation.className = 'clinical-explanation';
      explanation.append(node('h4', 'Recommended next step'), node('p', plan.recommendedNextStep || plan.recommendedActions?.[0]?.expectedOutcome || 'Doctor review required.'), node('h5', 'Why'));
      for (const item of plan.whyRecommended || plan.risks || []) explanation.append(node('p', `${item.summary} · Evidence: ${item.evidenceRefs.join(', ')}`));
      explanation.append(node('h5', 'Why not'));
      for (const item of plan.alternatives || []) explanation.append(node('p', `${item.step}: ${item.whyNot}${item.evidenceRefs.length ? ` · Evidence: ${item.evidenceRefs.join(', ')}` : ''}`));
      explanation.append(node('h5', 'What would change the recommendation'));
      for (const value of plan.whatWouldChangeRecommendation || plan.missingInformation || []) explanation.append(node('p', value));
      section.append(analysis, explanation);
      if (plan.resourceSnapshotIds?.length) {
        section.append(node('h4', 'Operational investigation · Simulation'), node('p', `Evidence resource version: m9-demo:${plan.resourceEvidenceVersion}. Historical snapshots remain unchanged when current capacity changes.`));
        for (const id of plan.resourceSnapshotIds) {
          const snapshot = data.resourceSnapshots.find(s => s.snapshotId === id); if (!snapshot) continue;
          const r = snapshot.result, card = node('div', ''); card.className = 'clinical-resource-card';
          card.append(node('strong', snapshot.toolName));
          if (r.hospitalId) card.append(node('p', `${r.hospitalId} · ${data.resourceEnvironment?.hospitals.find(h => h.hospitalId === r.hospitalId)?.name || 'Fictional hospital'}`));
          if (r.location) card.append(node('p', `Approximate fictional patient location: ${r.location.latitude}, ${r.location.longitude}`));
          if (r.hospitals) for (const h of r.hospitals) card.append(node('p', `${h.hospitalId} · ${h.name} · Capability match: ${h.requiredCapabilityMatch ? 'yes' : 'no'} · Direct distance ${(h.distanceMeters / 1000).toFixed(2)} km`));
          if (r.capabilities) card.append(node('p', `Capabilities: ${r.capabilities.join(', ')}`));
          if (r.monitoredBedsAvailable !== undefined) card.append(node('p', `Monitored beds: ${r.monitoredBedsAvailable} · Emergency beds: ${r.emergencyBedsAvailable} · ICU beds: ${r.icuBedsAvailable}`));
          if (r.specialty) card.append(node('p', `${r.specialty} specialist: ${r.available ? 'available' : 'unavailable'} · Next availability: ${r.nextAvailableMinutes} min`));
          if (r.units) card.append(node('p', `Fictional fleet snapshot: ${r.units.map(u => `${u.unitId}: ${u.status}`).join(', ')}`));
          if (r.durationSeconds !== undefined) card.append(node('p', `${r.origin} → ${r.destination} · ${r.ambulanceUnitId} · Distance ${(r.distanceMeters / 1000).toFixed(2)} km · ETA ${Math.ceil(r.durationSeconds / 60)} min`), node('p', r.routeSummary));
          card.append(node('small', `Simulation · ${r.resourceVersion} · Updated ${r.updatedAt} · Retrieved ${snapshot.createdAt} · Evidence ${id}`)); section.append(card);
        }
      }
      for (const key of ['observations', 'hypotheses']) {
        section.append(node('h4', key === 'hypotheses' ? 'Hypotheses — uncertain interpretations' : key));
        for (const item of plan[key]) section.append(node('p', `${item.summary} · Evidence: ${item.evidenceRefs.join(', ')}`));
      }
      section.append(node('h4', 'Doctor decision'));
      for (const action of plan.recommendedActions) {
        const row = node('div', ''); row.className = 'clinical-action'; row.dataset.actionId = action.actionId;
        row.append(node('p', `${action.toolName} · ${action.status === 'succeeded' ? 'COMPLETE' : action.approvalRequired ? 'APPROVAL REQUIRED' : 'AUTO'} · ${action.status}`), node('p', action.expectedOutcome));
        if (action.approvalId && action.status === 'pending' && plan.status === 'current' && data.meta.ready) {
          for (const [label, decision] of [[action.toolName === 'submit_hospital_case' ? 'Approve hospital handoff' : 'Approve simulated action', 'approved'], ['Reject', 'rejected'], ['Defer', 'deferred']]) {
            const button = node('button', label); button.type = 'button'; button.addEventListener('click', () => { button.disabled = true; void command(`/approvals/${action.approvalId}`, { decision }); }); row.append(button);
          }
        }
        const result = data.executions.find(e => e.actionId === action.actionId);
        if (action.handoffBinding) row.append(node('p', `Hospital: ${action.handoffBinding.hospitalId} · Connector: ${action.handoffBinding.connector === 'rest' ? 'REST API (primary)' : 'Legacy browser (explicit fallback)'} · Doctor approval required`));
        if (result?.confirmation?.status === 'pending' && result.status === 'running') {
          for (const [label, approved] of [['Approve legacy submission action', true], ['Decline legacy action', false]]) {
            const button = node('button', label); button.type = 'button'; button.addEventListener('click', () => { button.disabled = true; void command(`/executions/${result.executionId}/confirm`, { confirmationId: result.confirmation.confirmationId, approved }); }); row.append(button);
          }
        }
        if (result?.outcome) row.append(node('p', `${result.receiptRef ? 'Verified receipt: ' + result.receiptRef + ' · ' : ''}${result.outcome}`));
        section.append(row);
      }
      content.append(section);
    }
    const activity = node('section', ''); activity.className = 'clinical-activity'; activity.append(node('h3', 'Agent activity'));
    activity.append(node('p', 'Case received'));
    if (data.runs.length) activity.append(node('p', 'Gemini analyzed case'));
    if (data.plans.length) activity.append(node('p', 'Risks and missing information identified'), node('p', 'Recommendation prepared'));
    if (data.approvals.some(item => item.status === 'pending')) activity.append(node('p', 'Waiting for doctor decision'));
    const decision = data.approvals.find(item => ['approved', 'rejected', 'deferred'].includes(item.status));
    if (decision) activity.append(node('p', `Doctor decision: ${decision.status}`));
    content.append(activity);
    if (data.monitoring) {
      content.append(node('h3', 'Monitoring'), node('p', `${data.monitoring.status} · Next review: ${data.monitoring.nextEvaluationAt} · Observation version ${data.monitoring.lastProcessedObservationVersion}`));
      for (const condition of data.monitoring.conditions) content.append(node('p', condition));
    }
    message(data.meta?.ready ? 'Plan available for review.' : 'Waiting for a valid assessment. Previous plans are historical; actions remain gated.');
  }
  async function refresh() {
    const current = ++generation;
    try { const data = await request(); if (!disposed && current === generation) render(data); }
    catch { if (!disposed && current === generation) message('Clinical demo is disabled or unavailable. Existing doctor routing remains available.'); }
  }
  const observe = event => {
    event.preventDefault(); const form = new FormData(find('observe')), type = form.get('type'), raw = form.get('value');
    let value = type === 'symptom_update' ? raw : Number(raw);
    if (type === 'blood_pressure') { const [systolic, diastolic] = raw.split('/').map(Number); value = { systolic, diastolic }; }
    void command('/observations', { requestId: crypto.randomUUID(), observations: [{ type, value, unit: { temperature: '°C', heart_rate: 'bpm', blood_pressure: 'mmHg', spo2: '%', symptom_update: '' }[type],
      observedAt: new Date(form.get('observedAt')).toISOString(), source: form.get('source'), status: 'reported', correctionOf: null }] });
  };
  const run = () => void command('/run', { requestId: crypto.randomUUID() });
  find('observe').addEventListener('submit', observe); find('refresh').addEventListener('click', refresh); find('run').addEventListener('click', run);
  const timer = setInterval(() => { if (!busy) void refresh(); }, 3000); void refresh();
  const dispose = () => { disposed = true; clearInterval(timer); controller.abort(); find('observe')?.removeEventListener('submit', observe); find('refresh')?.removeEventListener('click', refresh); find('run')?.removeEventListener('click', run); };
  dispose.select = id => { if (id !== selectedCaseId) { selectedCaseId = id; generation++; find('content').replaceChildren(); find('observe').hidden = true; find('run').hidden = true; void refresh(); } };
  return dispose;
}

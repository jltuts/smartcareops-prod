import { apiFetch } from '../../auth/service.js';
import './clinical.css';
export const clinicalMarkup = `<section class="clinical-workspace" aria-labelledby="clinical-heading">
  <header class="clinical-workspace-header"><div><h2 id="clinical-heading">AI review</h2><p>Gemini summarizes the case. You make the decision.</p></div><div class="clinical-controls"><button id="clinical-refresh">Refresh AI review</button><button id="clinical-run" hidden>Run AI review</button></div></header>
  <p id="clinical-message" class="clinical-message" aria-live="polite"></p>
  <form id="clinical-observe" hidden><h3>Record fictional observation</h3>
    <label for="clinical-type">Type</label><select id="clinical-type" name="type"><option value="temperature">Temperature (°C)</option><option value="heart_rate">Heart rate (bpm)</option><option value="blood_pressure">Blood pressure (mmHg, systolic/diastolic)</option><option value="spo2">SpO2 (%)</option><option value="symptom_update">Symptom update</option></select>
    <label>Value <input name="value" required maxlength="300"></label>
    <label>Observed at <input name="observedAt" type="datetime-local" required></label>
    <label for="clinical-source">Fictional source</label><select id="clinical-source" name="source"><option value="fictional_device">Demo device</option><option value="fictional_patient">Demo patient</option><option value="fictional_clinician">Demo clinician</option></select>
    <button>Append observation</button>
  </form><div id="clinical-content"></div>
</section>`;
const node = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
const clinicalMessageIcons = Object.freeze({
  waiting: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  success: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3v.1"/></svg>',
});
const insight = (parent, value, className = '') => { const item = node('p', value); item.className = `clinical-insight ${className}`.trim(); parent.append(item); };
const plainExplanation = value => String(value || '')
  .replace(/objective vital sign measurement/gi, 'a check of the patient’s vital signs')
  .replace(/clinical examination/gi, 'an examination')
  .replace(/are required to properly evaluate/gi, 'are needed to evaluate')
  .replace(/exclude underlying secondary causes/gi, 'rule out serious causes')
  .replace(/safety assessment returned emergency status false(?: with no intake red flags matched)?/gi, 'the intake did not identify emergency warning signs')
  .replace(/(?:development of )?severe acute headache \(['’]?thunderclap['’]?\)/gi, 'a sudden, extremely severe headache')
  .replace(/focal neurological deficits/gi, 'weakness or numbness')
  .replace(/altered consciousness/gi, 'confusion or fainting')
  .replace(/primary headache disorder \(e\.g\., tension-type headache or migraine\) versus non-emergent secondary headache/gi, 'migraine, tension headache, or another non-emergency cause. These are possibilities, not diagnoses')
  .replace(/upon direct clinical assessment/gi, 'during examination')
  .replace(/^./, character => character.toUpperCase());
const evidenceLabel = reference => reference === 'case' ? 'case record'
  : reference.startsWith('LAB-') ? 'Doctor-verified laboratory report'
    : reference.startsWith('POLICY-') ? 'approved policy'
      : reference.startsWith('TOOL-') || reference.startsWith('RESOURCE-') ? 'checked system data' : reference;
const evidenceText = references => (references || []).map(evidenceLabel).join(', ');
const actionLabels = Object.freeze({
  read_case: 'Case reviewed',
  read_doctor_routing: 'Doctor routing checked',
  read_observation_history: 'Observation history checked',
  evaluate_safety: 'Safety information checked',
  simulate_clinical_review: 'Save fictional review receipt',
  submit_hospital_case: 'Hospital handoff',
});
const actionLabel = toolName => actionLabels[toolName] || String(toolName || 'Suggested action').replaceAll('_', ' ');
const latestAgentRun = runs => [...(runs || [])].sort((left, right) => {
  const time = value => Number.isFinite(Date.parse(value?.startedAt)) ? Date.parse(value.startedAt) : 0;
  return time(left) - time(right) || String(left.runId || '').localeCompare(String(right.runId || ''));
}).at(-1);
const displayedAgentRun = data => {
  if (data.meta?.ready && data.meta.currentRevisionId) {
    const planRun = (data.runs || []).find(run => run.status === 'completed' && run.planRevisionId === data.meta.currentRevisionId);
    if (planRun) return planRun;
  }
  return latestAgentRun(data.runs);
};
export function mountClinical(outlet) {
  const find = name => outlet.querySelector(`#clinical-${name}`);
  let disposed = false, generation = 0, busy = false, caseDecisionBusy = false, caseDecisionError = '', selectedCaseId, renderedView;
  const caseDecisionRequests = new Map();
  let appointmentDraft = null, appointmentBusy = false, appointmentError = '';
  const controller = new AbortController();
  const message = (value, state = 'waiting') => {
    if (disposed) return;
    const element = find('message'), icon = node('span', ''), copy = node('span', value);
    icon.className = 'clinical-message-icon'; icon.dataset.icon = state;
    icon.innerHTML = clinicalMessageIcons[state] || clinicalMessageIcons.waiting;
    element.replaceChildren(icon, copy);
  };
  async function request(path = '', body) {
    const response = await apiFetch(`/api/clinical${path}${selectedCaseId ? `?caseId=${encodeURIComponent(selectedCaseId)}` : ''}`, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      let failure; try { failure = await response.json(); } catch {}
      throw new Error(typeof failure?.message === 'string' && failure.message.length <= 240 ? failure.message : 'Clinical demo request unavailable. Refresh before retrying.');
    }
    return response.json();
  }
  async function command(path, body) {
    if (busy) return; busy = true;
    try {
      const requestedAt = Date.now();
      const result = await request(path, body);
      if (path === '/run' && result?.status === 'up_to_date') {
        await refresh(); message('AI review is already up to date.', 'success'); return;
      }
      message('Saved. Waiting for durable worker results…', 'waiting');
      if (path === '/run') {
        for (let attempt = 0; attempt < 20 && !disposed; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const data = await refresh(), latest = latestAgentRun(data?.runs);
          const belongsToRequest = Number.isFinite(Date.parse(latest?.startedAt)) && Date.parse(latest.startedAt) >= requestedAt - 5000;
          if (belongsToRequest && ['completed', 'failed', 'bounded', 'stale'].includes(latest.status)) break;
        }
      } else await refresh();
    }
    catch (error) { await refresh(); message(error.message || 'Request could not be confirmed. Refresh to check the durable result.', 'error'); }
    finally { busy = false; }
  }
  async function decideCaseReview(decision) {
    if (caseDecisionBusy || !selectedCaseId) return;
    caseDecisionBusy = true; caseDecisionError = '';
    const section = outlet.querySelector('#doctor-decision-section');
    section?.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const status = section?.querySelector('.clinical-decision-status');
    if (status) status.textContent = 'Saving doctor decision…';
    let requestId = caseDecisionRequests.get(selectedCaseId);
    if (!requestId) { requestId = crypto.randomUUID(); caseDecisionRequests.set(selectedCaseId, requestId); }
    try {
      await request('/case-review', { requestId, decision });
      caseDecisionBusy = false; message('Doctor decision saved.', 'success');
      await refresh();
    } catch (error) {
      caseDecisionError = error.message || 'The Doctor decision could not be saved. Your selection was not recorded; retry after reviewing the current case state.';
      caseDecisionBusy = false; renderedView = undefined;
      await refresh(); message(caseDecisionError, 'error');
    }
  }
  function caseDecision(data) {
    const section = node('section', ''); section.className = 'clinical-decision clinical-case-decision'; section.id = 'doctor-decision-section';
    section.append(node('p', 'Your decision'), node('h4', 'Doctor decision'),
      node('p', 'Record whether you agree with the suggested next step.'));
    const recorded = data.patientCase?.clinicalReview;
    if (['approved', 'rejected', 'deferred'].includes(recorded?.status)) {
      const labels = { approved: 'Recommendation accepted', rejected: 'Recommendation not accepted', deferred: 'Decision deferred' };
      const result = node('p', `${labels[recorded.status]} · Saved`); result.className = 'clinical-decision-status clinical-decision-result';
      section.append(result, node('p', `Recorded ${recorded.updatedAt || 'for this case'}.`));
      return section;
    }
    const eligible = ['submitted_for_clinical_review', 'routed_to_doctor'].includes(data.patientCase?.workflowStatus);
    const status = node('p', caseDecisionBusy ? 'Saving doctor decision…' : caseDecisionError || (eligible ? 'Ready for your decision.' : 'This case is not currently awaiting clinical review.'));
    status.className = `clinical-decision-status${caseDecisionError ? ' clinical-decision-error' : ''}`; status.setAttribute('aria-live', 'polite'); section.append(status);
    const controls = node('div', ''); controls.className = 'clinical-decision-controls';
    for (const [label, accessibleLabel, decision] of [['Accept recommendation', 'Approve case review', 'approved'], ['Do not accept', 'Reject case review', 'rejected'], ['Decide later', 'Defer case review', 'deferred']]) {
      const button = node('button', label); button.type = 'button'; button.setAttribute('aria-label', accessibleLabel); button.disabled = !eligible || caseDecisionBusy;
      if (!eligible) button.title = status.textContent;
      button.addEventListener('click', () => void decideCaseReview(decision)); controls.append(button);
    }
    section.append(controls); return section;
  }
  function appointmentSection(data) {
    const record = data.patientCase, proposal = record?.appointmentProposal;
    const eligible = record?.clinicalReview?.status === 'approved' && record?.routing?.status === 'routed' && !record.emergency && !record.ambulance &&
      !['pending', 'in_progress', 'completed'].includes(record.handoffStatus) &&
      !record.hospitalHandoffs?.some(item => ['pending', 'in_progress', 'completed', 'succeeded'].includes(item.status)) &&
      proposal?.state !== 'appointment_confirmed';
    if (!eligible && !proposal) return null;
    const section = node('section', ''); section.className = 'clinical-decision clinical-appointment';
    section.append(node('h4', eligible ? 'Propose appointment' : 'Fictional appointment'), node('p', 'Clinical approval does not schedule a visit. Propose up to three demo times for the Patient to review.'));
    if (proposal) {
      const status = { awaiting_patient_confirmation: 'Waiting for Patient confirmation', appointment_confirmed: 'Patient confirmed a time', alternate_time_requested: 'Patient requested another time' }[proposal.state] || 'Appointment proposed';
      section.append(node('p', `${status} · Version ${proposal.version}`));
      if (proposal.confirmedSlotId) {
        const slot = proposal.slots.find(item => item.slotId === proposal.confirmedSlotId);
        if (slot) section.append(node('p', `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: proposal.timeZone }).format(new Date(slot.startAt))} · ${proposal.timeZone}`));
      }
    }
    if (!eligible) return section;
    const form = node('form', ''); form.className = 'clinical-appointment-form';
    const typeLabel = node('label', 'Appointment type or fictional location');
    const type = document.createElement('input'); type.name = 'appointmentType'; type.required = true; type.maxLength = 80; type.value = appointmentDraft?.appointmentType || 'Fictional consultation'; typeLabel.append(type); form.append(typeLabel);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    form.append(node('p', `Displayed timezone: ${timezone}. Enter times in your local timezone.`));
    const slots = node('div', ''); slots.className = 'clinical-appointment-slots';
    const addSlot = (start = '', end = '') => {
      if (slots.children.length >= 3) return;
      const row = node('div', ''); row.className = 'clinical-appointment-slot';
      for (const [label, value, name] of [['Start', start, 'start'], ['End', end, 'end']]) {
        const field = node('label', label); const input = document.createElement('input'); input.type = 'datetime-local'; input.required = true; input.value = value; input.dataset.slotField = name; field.append(input); row.append(field);
      }
      const remove = node('button', 'Remove time'); remove.type = 'button'; remove.disabled = slots.children.length === 0; remove.addEventListener('click', () => row.remove()); row.append(remove); slots.append(row);
    };
    const localInputValue = value => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    (appointmentDraft?.slots || [{}]).forEach(slot => addSlot(localInputValue(slot.startAt), localInputValue(slot.endAt)));
    form.append(slots);
    const add = node('button', 'Add time'); add.type = 'button'; add.addEventListener('click', () => addSlot()); form.append(add);
    const preview = node('div', ''); preview.setAttribute('aria-live', 'polite'); form.append(preview);
    const send = node('button', appointmentDraft?.reviewed ? 'Send proposal to Patient' : 'Review proposal'); send.type = 'submit'; send.disabled = appointmentBusy; form.append(send);
    const feedback = node('p', appointmentBusy ? 'Sending proposal…' : appointmentError); feedback.setAttribute('role', 'status'); form.append(feedback);
    form.addEventListener('input', () => { appointmentDraft = null; send.textContent = 'Review proposal'; preview.replaceChildren(); });
    form.addEventListener('submit', event => { event.preventDefault();
      const items = [...slots.children].map(row => ({ startAt: new Date(row.querySelector('[data-slot-field="start"]').value).toISOString(), endAt: new Date(row.querySelector('[data-slot-field="end"]').value).toISOString() }));
      if (!items.length) { feedback.textContent = 'Add at least one time.'; return; }
      const candidate = { appointmentType: type.value.trim(), timeZone: timezone, slots: items };
      if (!appointmentDraft?.reviewed) {
        appointmentDraft = { ...candidate, reviewed: true, requestId: crypto.randomUUID() };
        preview.textContent = `Review before sending: ${candidate.appointmentType} · ${candidate.timeZone} · ${items.map(item => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: candidate.timeZone }).format(new Date(item.startAt))).join('; ')}. Fictional demo only.`;
        send.textContent = 'Send proposal to Patient'; return;
      }
      if (appointmentBusy) return;
      appointmentBusy = true; send.disabled = true; feedback.textContent = 'Sending proposal…';
      void apiFetch(`/api/doctor/cases/${selectedCaseId}/appointment`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: appointmentDraft.requestId, expectedVersion: proposal?.version || 0, ...candidate }) }).then(async response => {
        if (!response.ok) { const failure = await response.json().catch(() => ({})); const error = new Error(failure.message || 'Proposal unavailable. Refresh the case.'); error.stale = response.status === 409; throw error; }
        appointmentDraft = null; appointmentError = ''; await refresh();
      }).catch(error => { appointmentError = error.message || 'Proposal unavailable. Retry or refresh the case.'; feedback.textContent = appointmentError;
        if (error.stale) { appointmentDraft = null; void refresh(); }
      })
        .finally(() => { appointmentBusy = false; send.disabled = false; });
    });
    section.append(form); return section;
  }
  function render(data) {
    const content = find('content'); content.replaceChildren();
    const patientIntakeCase = ['live_intake', 'chat_intake'].includes(data.patientCase?.intakeSource);
    find('observe').hidden = patientIntakeCase; find('run').hidden = false;
    const context = node('p', `Case ${data.caseId}`); context.className = 'clinical-case-context'; content.append(context);
    const observed = node('section', ''); observed.append(node('h3', 'Observed — fictional data'));
    for (const o of data.observations) observed.append(node('p', `${o.type}: ${typeof o.value === 'object' ? `${o.value.systolic}/${o.value.diastolic}` : o.value} ${o.unit} · ${o.observedAt} · ${o.source} · ${o.observationId}${o.correctionOf ? ` · correction of ${o.correctionOf}` : ''}`));
    if (data.observations.length) content.append(observed);
    if (!patientIntakeCase) content.append(node('h3', 'Investigated'), node('p', `Explicit fictional history: ${data.history.conditions.join(', ')}. ${data.history.disclaimer}`));
    const latestRun = displayedAgentRun(data);
    if (latestRun?.error) content.append(node('p', `AI review issue: ${latestRun.error.message}`));
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
      const section = node(plan.status === 'current' ? 'section' : 'details', ''); section.className = `clinical-plan ${plan.status === 'current' ? 'clinical-plan-current' : 'clinical-plan-historical'}`; section.dataset.revision = plan.version;
      section.id = 'plan-' + plan.revisionId;
      if (plan.status !== 'current') section.append(node('summary', `Earlier AI review · Revision ${plan.version}`));
      const planHeader = node('header', ''); planHeader.className = 'clinical-plan-header'; planHeader.append(node('p', plan.status === 'current' ? 'Current AI review' : 'Earlier AI review'), node('h3', plan.status === 'current' ? `Revision ${plan.version}` : `Revision ${plan.version} · ${plan.status}`), node('p', plan.changeSummary));
      const sourceLabels = { 'gemini-enterprise-agent-platform': 'Gemini Enterprise Agent Platform · bounded fictional demo', 'gemini-api-fallback': 'Gemini API · automatic fallback', 'gemini-api': 'Gemini API' };
      const source = node('p', sourceLabels[plan.assessmentSource] || 'Gemini API'); source.className = 'clinical-assessment-source'; planHeader.append(source); section.append(planHeader);
      if (plan.labBinding) planHeader.append(node('p', `Doctor-verified laboratory report · revision ${plan.labBinding.revision} · ${plan.status === 'stale' ? 'Source changed; request a new assessment before using this analysis.' : 'Review-only analysis. No clinical or operational action was started.'}`));
      const analysis = node('section', ''); analysis.className = 'clinical-analysis';
      if (plan.status === 'current') analysis.id = 'doctor-analysis-section';
      analysis.append(node('p', 'AI summary'), node('h4', 'What Gemini found'), node('p', plan.caseSummary || plan.changeSummary));
      const findings = node('section', ''); findings.className = 'clinical-analysis-group clinical-findings'; findings.append(node('h5', 'What stands out'));
      for (const item of plan.importantFindings || plan.observations || []) insight(findings, plainExplanation(item.summary), 'clinical-finding');
      const risks = node('section', ''); risks.className = 'clinical-analysis-group clinical-risks'; risks.append(node('h5', 'What to watch'));
      for (const item of plan.risks) insight(risks, plainExplanation(item.summary), 'clinical-risk');
      const missing = node('section', ''); missing.className = 'clinical-analysis-group clinical-missing'; missing.append(node('h5', 'Still needed'));
      for (const value of plan.missingInformation) insight(missing, value, 'clinical-missing-item');
      const differential = node('section', ''); differential.className = 'clinical-analysis-group clinical-differential'; differential.append(node('h5', 'Possible explanations — not diagnoses'));
      for (const item of plan.differentialConsiderations || plan.hypotheses || []) insight(differential, plainExplanation(item.summary));
      const uncertainty = node('section', ''); uncertainty.className = 'clinical-analysis-group clinical-uncertainty'; uncertainty.append(node('h5', 'What remains unclear'));
      for (const value of plan.uncertainty || plan.uncertainties || []) insight(uncertainty, value);
      analysis.append(findings, risks, missing);
      const observations = node('section', ''); observations.className = 'clinical-analysis-group'; observations.append(node('h5', 'Additional observations'));
      for (const item of plan.observations || []) insight(observations, plainExplanation(item.summary));
      const hypotheses = node('section', ''); hypotheses.className = 'clinical-analysis-group clinical-hypotheses'; hypotheses.append(node('h5', 'Possible explanations — not diagnoses'));
      for (const item of plan.hypotheses || []) insight(hypotheses, plainExplanation(item.summary));
      const analysisTechnical = node('details', ''); analysisTechnical.className = 'clinical-explanation-technical'; analysisTechnical.append(node('summary', 'Technical details'));
      const analysisTechnicalBody = node('div', ''); analysisTechnicalBody.className = 'clinical-explanation-technical-body';
      for (const item of [...(plan.importantFindings || []), ...(plan.risks || []), ...(plan.observations || []), ...(plan.hypotheses || []), ...(plan.differentialConsiderations || [])]) insight(analysisTechnicalBody, `${item.summary}${item.evidenceRefs?.length ? ` · Source: ${evidenceText(item.evidenceRefs)}` : ''}`);
      analysisTechnical.append(analysisTechnicalBody);
      const moreAnalysis = node('details', ''); moreAnalysis.className = 'clinical-more-details'; moreAnalysis.append(node('summary', 'More AI details'), differential, uncertainty, observations, hypotheses, analysisTechnical); analysis.append(moreAnalysis);
      const explanation = node('section', ''); explanation.className = 'clinical-explanation';
      if (plan.status === 'current') explanation.id = 'doctor-recommendation-section';
      explanation.append(node('p', 'Suggested next step'), node('h4', 'What to do next'), node('p', plan.recommendedNextStep || plan.recommendedActions?.[0]?.expectedOutcome || 'Doctor review required.'));
      const rationale = node('div', ''); rationale.className = 'clinical-rationale-grid';
      const recommendationReasons = plan.whyRecommended || plan.risks || [];
      const alternatives = plan.alternatives || [];
      const changes = plan.whatWouldChangeRecommendation || plan.missingInformation || [];
      const why = node('section', ''); why.className = 'clinical-rationale clinical-why'; why.append(node('h5', 'Reason for this step'));
      for (const item of recommendationReasons) insight(why, plainExplanation(item.summary));
      const emergencyAlternative = alternatives.length === 1 && /emergency|ambulance|dispatch/i.test(alternatives[0].step);
      const whyNot = node('section', ''); whyNot.className = 'clinical-rationale clinical-why-not'; whyNot.append(node('h5', emergencyAlternative ? 'Why emergency care was not suggested' : 'Why another action was not suggested'));
      for (const item of alternatives) insight(whyNot, plainExplanation(emergencyAlternative ? item.whyNot : `${item.step}: ${item.whyNot}`));
      const change = node('section', ''); change.className = 'clinical-rationale clinical-change'; change.append(node('h5', 'When this recommendation should change'));
      for (const value of changes) insight(change, plainExplanation(value));
      rationale.append(why, whyNot, change);
      const technical = node('details', ''); technical.className = 'clinical-explanation-technical'; technical.append(node('summary', 'Technical details'));
      const technicalBody = node('div', ''); technicalBody.className = 'clinical-explanation-technical-body';
      for (const item of recommendationReasons) insight(technicalBody, `${item.summary}${item.evidenceRefs?.length ? ` · Source: ${evidenceText(item.evidenceRefs)}` : ''}`);
      for (const item of alternatives) insight(technicalBody, `${item.step}: ${item.whyNot}${item.evidenceRefs?.length ? ` · Source: ${evidenceText(item.evidenceRefs)}` : ''}`);
      technical.append(technicalBody);
      const rationaleDetails = node('details', ''); rationaleDetails.className = 'clinical-more-details'; rationaleDetails.append(node('summary', 'Why this is suggested'), rationale, technical); explanation.append(rationaleDetails);
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
      const decision = node('section', ''); decision.className = 'clinical-decision';
      const actionsToReview = plan.recommendedActions.filter(action => action.approvalRequired || action.status !== 'succeeded');
      if (plan.labBinding) decision.append(node('p', 'Lab review'), node('h4', 'No actions started'), node('p', 'Review only. No action was taken.'));
      else decision.append(node('p', 'Suggested action'), node('h4', 'Review this action'), node('p', 'Any action shown here requires its own approval.'));
      for (const action of actionsToReview) {
        const row = node('div', ''); row.className = 'clinical-action'; row.dataset.actionId = action.actionId;
        const result = data.executions.find(e => e.actionId === action.actionId);
        const approval = action.approvalId ? data.approvals.find(item => item.approvalId === action.approvalId) : null;
        const completedReadOnly = !action.approvalRequired && action.status === 'succeeded';
        row.append(node('p', `${actionLabel(action.toolName)} · ${action.status === 'succeeded' ? 'Complete' : action.approvalRequired ? 'Approval required' : 'In progress'}`),
          node('p', completedReadOnly ? `${actionLabel(action.toolName)}. No changes were made.` : action.toolName === 'simulate_clinical_review' ? 'Save a fictional receipt documenting this review. No clinical action is performed.' : action.expectedOutcome));
        const actionTechnical = node('details', ''); actionTechnical.className = 'clinical-explanation-technical'; actionTechnical.append(node('summary', 'Technical details'), node('p', `${action.toolName} · ${action.status} · ${action.expectedOutcome}`)); row.append(actionTechnical);
        if (action.approvalRequired) {
          const decisionStatus = approval?.status;
          const completed = result?.status === 'succeeded' || action.status === 'succeeded';
          const recorded = ['approved', 'rejected', 'deferred'].includes(decisionStatus);
          if (completed || recorded) {
            const label = decisionStatus === 'approved' ? 'Approved' : decisionStatus === 'rejected' ? 'Rejected' : decisionStatus === 'deferred' ? 'Deferred' : 'Completed';
            const status = node('p', `${label}${completed && recorded ? ' · Completed' : !completed && decisionStatus === 'approved' ? ' · Processing' : ''}`);
            status.className = 'clinical-decision-status clinical-decision-result'; row.append(status);
          } else {
            const current = plan.status === 'current';
            const expired = decisionStatus === 'expired' || action.status === 'expired';
            const superseded = !current || decisionStatus === 'superseded' || action.status === 'superseded';
            const needsCaseReview = data.reviewGateEnabled && data.patientCase?.clinicalReview?.status !== 'approved';
            const actionable = Boolean(current && action.approvalId && decisionStatus === 'pending' && action.status === 'pending' && data.meta.ready && !needsCaseReview);
            const status = node('p', actionable ? 'Decision available.' : needsCaseReview ? 'Record the Doctor case review before approving a clinical action.' : expired ? 'Decision window expired. This recommendation is no longer actionable.' : superseded ? 'This recommendation was superseded and is no longer actionable.' : 'Decision controls are unavailable until the current assessment is ready.');
            status.className = 'clinical-decision-status'; row.append(status);
            if (current) {
              const controls = node('div', ''); controls.className = 'clinical-decision-controls';
              for (const [label, choice] of [[action.toolName === 'submit_hospital_case' ? 'Approve hospital handoff' : 'Approve', 'approved'], ['Reject', 'rejected'], ['Defer', 'deferred']]) {
                const button = node('button', label); button.type = 'button'; button.disabled = !actionable;
                if (!actionable) button.title = status.textContent;
                button.addEventListener('click', () => { button.disabled = true; void command(`/approvals/${action.approvalId}`, { decision: choice }); }); controls.append(button);
              }
              row.append(controls);
            }
          }
        }
        if (action.handoffBinding) row.append(node('p', `Hospital: ${action.handoffBinding.hospitalId} · Connector: ${action.handoffBinding.connector === 'rest' ? 'REST API (primary)' : 'Legacy browser (explicit fallback)'} · Doctor approval required`));
        if (result?.confirmation?.status === 'pending' && result.status === 'running') {
          for (const [label, approved] of [['Approve legacy submission action', true], ['Decline legacy action', false]]) {
            const button = node('button', label); button.type = 'button'; button.addEventListener('click', () => { button.disabled = true; void command(`/executions/${result.executionId}/confirm`, { confirmationId: result.confirmation.confirmationId, approved }); }); row.append(button);
          }
        }
        if (result?.outcome) row.append(node('p', `${result.receiptRef ? 'Verified receipt: ' + result.receiptRef + ' · ' : ''}${result.outcome}`));
        decision.append(row);
      }
      if (plan.labBinding || actionsToReview.length) section.append(decision);
      content.append(section);
    }
    content.append(caseDecision(data));
    const appointment = appointmentSection(data); if (appointment) content.append(appointment);
    const technical = node('details', ''); technical.className = 'clinical-technical-details'; technical.append(node('summary', 'Activity and monitoring'));
    const activity = node('section', ''); activity.className = 'clinical-activity'; activity.append(node('h3', 'Activity'));
    activity.append(node('p', 'Case received'));
    if (data.runs.length) activity.append(node('p', 'Gemini analyzed case'));
    if (data.plans.length) activity.append(node('p', 'Risks and missing information identified'), node('p', 'Recommendation prepared'));
    const currentPlan = data.plans.find(plan => plan.status === 'current');
    for (const action of currentPlan?.recommendedActions || []) if (!action.approvalRequired && action.status === 'succeeded') activity.append(node('p', actionLabel(action.toolName)));
    if (data.approvals.some(item => item.status === 'pending')) activity.append(node('p', 'Waiting for doctor decision'));
    const reviewDecision = data.patientCase?.clinicalReview;
    if (['approved', 'rejected', 'deferred'].includes(reviewDecision?.status)) activity.append(node('p', `Doctor decision: ${reviewDecision.status}`));
    const actionDecision = data.approvals.find(item => ['approved', 'rejected', 'deferred'].includes(item.status));
    if (actionDecision) activity.append(node('p', `Recommended action decision: ${actionDecision.status}`));
    technical.append(activity);
    if (data.monitoring) {
      const monitoring = node('section', ''); monitoring.className = 'clinical-monitoring'; monitoring.append(node('h3', 'Monitoring'), node('p', `${data.monitoring.status} · Next review: ${data.monitoring.nextEvaluationAt}`));
      for (const condition of data.monitoring.conditions) monitoring.append(node('p', condition)); technical.append(monitoring);
    }
    content.append(technical);
    message(data.meta?.ready ? 'Plan available for review.' : 'Waiting for a valid assessment. Previous plans are historical; actions remain gated.', data.meta?.ready ? 'success' : 'waiting');
  }
  async function refresh() {
    const current = ++generation;
    try {
      const data = await request(), fingerprint = JSON.stringify(data);
      if (!disposed && current === generation && fingerprint !== renderedView) {
        // Do not erase an unsent slot draft while periodic clinical polling runs.
        const editingAppointment = find('content').querySelector('.clinical-appointment-form')?.contains(document.activeElement);
        if (!editingAppointment || appointmentBusy) { renderedView = fingerprint; render(data); }
      }
      return data;
    }
    catch { if (!disposed && current === generation) message('Clinical demo is disabled or unavailable. Existing doctor routing remains available.', 'error'); return null; }
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
  dispose.select = id => { if (id !== selectedCaseId) { selectedCaseId = id; caseDecisionError = ''; caseDecisionBusy = false; appointmentDraft = null; appointmentError = ''; renderedView = undefined; generation++; find('content').replaceChildren(); find('observe').hidden = true; find('run').hidden = true; void refresh(); } };
  return dispose;
}

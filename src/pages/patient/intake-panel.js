import { getUserMessage, getDeveloperMessage } from '../../../shared/gemini-resilience.mjs';
import { pendingClarifications } from '../../../shared/intake-clarifications.js';

const titles = { confirmed: 'Confirmed', denied: 'Denied', unclear: 'Needs clarification' };
const fieldNames = { temperature: 'Temperature', bloodPressure: 'Blood pressure', heartRate: 'Heart rate', spo2: 'SpO₂', bloodGlucose: 'Blood glucose' };

export const intakeMarkup = () => `<aside class="intake-panel" aria-labelledby="intake-heading">
  <div class="intake-heading"><p class="eyebrow">Your reported information</p><h2 id="intake-heading">Clinical intake summary</h2></div>
  <p class="intake-explanation">Based on your words. “Confirmed” means clearly reported by you, not medically verified.</p>
  <p id="intake-status" role="status" aria-live="polite">Waiting for a conversation.</p>
  <details id="intake-diagnostics" hidden><summary>Developer diagnostics</summary><p id="intake-error-detail"></p></details>
  <div id="intake-fields"></div>
  <section class="operational-note"><h3>Conversation progress <span class="intake-label">AI-GENERATED · OPERATIONAL</span></h3><p id="intake-interpretation">No patient information yet.</p><p>This describes information collected, not a diagnosis or urgency assessment.</p></section>
</aside>`;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function createIntakePanel(outlet) {
  const fields = outlet.querySelector('#intake-fields');
  const status = outlet.querySelector('#intake-status');
  const diagnostics = outlet.querySelector('#intake-diagnostics');
  const detail = outlet.querySelector('#intake-error-detail');
  const interpretation = outlet.querySelector('#intake-interpretation');
  let finalizationFailed = false;
  const label = text => element('span', text, 'intake-label');
  function section(title, id) {
    const node = element('section'); node.dataset.intake = id;
    node.append(element('h3', title)); fields.append(node); return node;
  }
  function fact(parent, title, value, evidence) {
    const row = element('div', undefined, 'intake-fact');
    row.append(element('strong', title), element('span', value ?? '—', 'intake-value'));
    if (value != null && value !== '—') row.append(label('REPORTED'));
    if (evidence) row.append(element('q', evidence, 'intake-evidence'));
    parent.append(row);
  }
  function list(parent, items, nameKey) {
    if (!items.length) { parent.append(element('p', '—', 'intake-empty')); return; }
    const ul = element('ul');
    for (const item of items) {
      const li = element('li'); li.dataset.status = item.status;
      li.append(element('strong', item[nameKey]), label(titles[item.status].toUpperCase()));
      if (item.patientReportedText) li.append(element('q', item.patientReportedText, 'intake-evidence'));
      ul.append(li);
    }
    parent.append(ul);
  }
  function render(intake) {
    fields.replaceChildren();
    const patient = section('Patient', 'patient');
    fact(patient, 'Name', intake?.patient.name, intake?.evidence?.name?.patientReportedText);
    fact(patient, 'Preferred name', intake?.patient.preferredName, intake?.evidence?.preferredName?.patientReportedText);
    const symptoms = section('Symptoms', 'symptoms');
    for (const [state, title] of Object.entries(titles)) {
      const group = element('div'); group.dataset.group = state;
      group.append(element('h4', title)); list(group, (intake?.symptoms || []).filter(item => item.status === state), 'name');
      symptoms.append(group);
    }
    fact(section('Onset / Duration', 'onset'), 'Reported onset', intake?.onset.value || (intake?.onset.clarificationRequested ? 'Unclear' : null), intake?.onset.patientReportedText);
    const vitals = section('Reported Vitals', 'vitals');
    for (const [key, title] of Object.entries(fieldNames)) {
      const item = intake?.vitals[key];
      let value = null;
      if (key === 'bloodPressure' && item?.systolic != null && item?.diastolic != null) value = `${item.systolic} / ${item.diastolic}`;
      else if (item?.value != null) value = `${item.value}${item.unit ? ` ${item.unit}` : ' (unit not reported)'}`;
      else if (item?.qualitative) value = item.qualitative;
      fact(vitals, title, value, intake?.evidence?.[`vitals.${key}`]?.patientReportedText);
    }
    const flags = section('Emergency Indicators', 'redFlags');
    flags.append(element('p', 'Reported indicators only. No automated urgency assessment.', 'intake-explanation'));
    list(flags, intake?.redFlags || [], 'type');
    const notes = section('Additional Notes', 'notes');
    if (intake?.additionalNotes.length) {
      for (const note of intake.additionalNotes) fact(notes, 'Patient statement', note);
    } else notes.append(element('p', '—', 'intake-empty'));
    const count = pendingClarifications(intake).length;
    interpretation.textContent = !intake || !Object.keys(intake.evidence || {}).length ? 'No patient information yet.' : count ? `${count} reported item(s) need clarification.` : 'Reported information has been organized. Missing fields remain blank.';
  }
  render(null);
  return {
    update: render,
    finalization(error) {
      finalizationFailed = true;
      status.textContent = 'Clinical summary could not be finalized. Previous valid information has been preserved.';
      diagnostics.hidden = false; diagnostics.open = true;
      detail.textContent = `Code: ${error.code}\nStage: ${error.stage}\nProvider: ${error.provider}\nUtterance: ${(error.utteranceIds || []).join(', ') || '—'}${error.httpStatus ? `\nHTTP: ${error.httpStatus}` : ''}\n${error.developerMessage}`;
      detail.style.whiteSpace = 'pre-line';
    },
    reset() { finalizationFailed = false; render(null); diagnostics.hidden = true; diagnostics.open = false; detail.textContent = ''; status.textContent = 'Waiting for reported information.'; },
    status(value, code) {
      finalizationFailed = false;
      const failure = value === 'rate-limited' || value === 'unavailable';
      diagnostics.hidden = !failure;
      detail.textContent = !failure ? '' : code === 'RATE_LIMIT' || value === 'rate-limited'
        ? 'Gemini API quota or rate limit exceeded (HTTP 429).'
        : code === 'EXTRACTION_FAILED' ? 'Clinical summary extraction failed (EXTRACTION_FAILED).' : getDeveloperMessage({ code });
      status.textContent = failure ? getUserMessage().replace('The AI service', 'Clinical summary') : ({ waiting: 'Waiting for reported information.', updating: 'Updating from your conversation…', current: 'Updated from the conversation.' })[value] || 'Waiting for reported information.';
    },
    finish(interrupted) { if (!finalizationFailed) status.textContent = interrupted ? 'Connection interrupted. Last available summary retained.' : 'Session ended. Last available summary retained; it may not include the final turn.'; },
  };
}

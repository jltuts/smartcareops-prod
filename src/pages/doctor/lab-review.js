import { apiFetch } from '../../auth/service.js';
import './lab-review.css';

const node = (tag, value, className) => {
  const item = document.createElement(tag); item.textContent = value;
  if (className) item.className = className;
  return item;
};

function field(labelText, value, required = false) {
  const label = node('label', labelText);
  const input = document.createElement('input'); input.type = 'text'; input.value = value ?? ''; input.required = required;
  label.append(input); return { label, input };
}

export function mountLabReview(report, { path, signal, onVerified, onStale }) {
  const root = node('section', '', 'doctor-lab-review');
  root.setAttribute('aria-label', `Review ${report.filename}`);
  root.append(node('h5', 'Compare and verify results'), node('p', 'Compare each included field with the original report. Correct anything Gemini misread. Nothing becomes verified until you confirm.'));
  const layout = node('div', '', 'doctor-lab-review-layout');
  const original = node('section', '', 'doctor-lab-original');
  original.append(node('h6', 'Original report'), node('p', 'Loading the case-scoped original…'));
  const edit = node('section', '', 'doctor-lab-edit');
  edit.append(node('h6', 'Gemini extraction · unverified'));
  const form = document.createElement('form'); form.className = 'doctor-lab-review-form';
  const controls = [];
  for (const [index, row] of (report.unverifiedExtraction?.rows || []).entries()) {
    const group = document.createElement('fieldset'); group.className = 'doctor-lab-row';
    group.append(node('legend', `Result ${index + 1}`));
    if (row.uncertain || row.unreadable) group.append(node('p', row.unreadable ? 'Gemini could not read this row.' : 'Gemini marked this row uncertain.', 'doctor-lab-uncertain'));
    const includeLabel = node('label', '', 'doctor-lab-include');
    const include = document.createElement('input'); include.type = 'checkbox'; include.checked = !row.uncertain && !row.unreadable;
    includeLabel.append(include, document.createTextNode(' Include in verified results'));
    group.append(includeLabel);
    const fields = {
      testName: field('Test name', row.testName, true), resultText: field('Result as printed', row.resultText, true),
      numericValue: field('Numeric value (if printed)', row.numericValue), unit: field('Unit', row.unit),
      referenceRange: field('Printed reference range', row.referenceRange), sourceLocation: field('Page or source location', row.sourceLocation),
    };
    const grid = node('div', '', 'doctor-lab-fields');
    for (const item of Object.values(fields)) grid.append(item.label);
    group.append(grid); form.append(group);
    const sync = () => { for (const item of Object.values(fields)) item.input.disabled = !include.checked; };
    include.addEventListener('change', sync); sync();
    controls.push({ include, fields });
  }
  const confirm = node('label', '', 'doctor-lab-confirm');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.required = true;
  confirm.append(checkbox, document.createTextNode(' I compared every included field with the original report.'));
  const submit = node('button', 'Verify reviewed results'); submit.type = 'submit';
  if (!controls.length) { form.append(node('p', 'Gemini found no readable rows. This report cannot be verified as a result.')); submit.disabled = true; }
  const status = node('p', '', 'doctor-lab-review-status'); status.setAttribute('role', 'status');
  form.append(confirm, submit, status); edit.append(form);
  layout.append(original, edit); root.append(layout);

  let objectUrl = null, destroyed = false;
  const destroy = () => { destroyed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
  void (async () => {
    try {
      const response = await apiFetch(`${path}/${encodeURIComponent(report.reportId)}/file`, { cache: 'no-store', signal });
      if (!response.ok) throw new Error('ORIGINAL_UNAVAILABLE');
      const blob = await response.blob(); if (destroyed || signal?.aborted) return;
      objectUrl = URL.createObjectURL(blob); original.replaceChildren(node('h6', 'Original report'));
      if (report.mimeType === 'application/pdf') {
        const frame = document.createElement('iframe'); frame.title = `Original laboratory report: ${report.filename}`; frame.src = objectUrl;
        original.append(frame);
      } else {
        const image = document.createElement('img'); image.alt = `Original laboratory report: ${report.filename}`; image.src = objectUrl;
        original.append(image);
      }
      original.append(node('p', 'If the preview is unavailable, use Open original above to download the file.'));
    } catch { if (!destroyed && !signal?.aborted) original.replaceChildren(node('h6', 'Original report'), node('p', 'The preview could not be loaded. Use Open original above.')); }
  })();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const rows = [];
    for (const control of controls) {
      if (!control.include.checked) { rows.push({ include: false }); continue; }
      const value = name => control.fields[name].input.value.trim() || null;
      const numericText = value('numericValue');
      const numericValue = numericText === null ? null : Number(numericText);
      if (numericText !== null && (!Number.isFinite(numericValue) || !value('resultText')?.includes(String(numericValue)))) {
        status.textContent = 'Check that each numeric value appears in its printed result.'; return;
      }
      rows.push({ include: true, testName: value('testName'), resultText: value('resultText'), numericValue,
        unit: value('unit'), referenceRange: value('referenceRange'), sourceLocation: value('sourceLocation') });
    }
    if (!rows.some(row => row.include)) { status.textContent = 'Include at least one result before verifying.'; return; }
    submit.disabled = true; status.textContent = 'Saving Doctor verification…';
    try {
      const response = await apiFetch(`${path}/${encodeURIComponent(report.reportId)}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedReviewToken: report.reviewToken, confirmedOriginal: checkbox.checked, rows }), signal,
      });
      if (response.status === 409) { status.textContent = 'This review changed. Reopen the current report before verifying.'; await onStale?.(); return; }
      if (!response.ok) throw new Error('LAB_REVIEW_FAILED');
      const result = await response.json();
      if (!destroyed && !signal?.aborted) await onVerified?.(result.report);
    } catch { if (!destroyed && !signal?.aborted) status.textContent = 'Verification was not saved. Check the fields and try again.'; }
    finally { submit.disabled = false; }
  });
  signal?.addEventListener('abort', destroy, { once: true });
  return { element: root, destroy };
}

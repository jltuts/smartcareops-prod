import { apiFetch } from '../../auth/service.js';
import { mountLabReview } from './lab-review.js';
import './lab-reports.css';

const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const maxBytes = 2 * 1024 * 1024;
const element = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };

function base64For(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('The selected report could not be read.'));
    reader.readAsDataURL(file);
  });
}

export function mountLabReports(caseId, { signal } = {}) {
  const panel = element('section', ''); panel.className = 'doctor-evidence-panel doctor-lab-reports';
  panel.append(element('h4', 'Laboratory reports'), element('p', 'Upload a fictional PDF, JPEG, or PNG report for this case. Maximum 2 MB. Uploading does not verify findings or change clinical decisions.'));
  const form = document.createElement('form');
  const dropzone = element('div', ''); dropzone.className = 'doctor-lab-dropzone';
  const label = element('label', 'Select laboratory report');
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
  const dropHint = element('span', 'Or drag and drop one report here.'); dropHint.className = 'doctor-lab-drop-hint';
  const upload = element('button', 'Upload report'); upload.type = 'submit';
  label.append(input); dropzone.append(label, dropHint); form.append(dropzone, upload);
  const status = element('p', ''); status.setAttribute('role', 'status'); status.className = 'doctor-lab-status';
  const list = document.createElement('ul'); list.className = 'doctor-lab-list';
  const reviewHolder = document.createElement('div');
  panel.append(form, status, list, reviewHolder);
  let activeReview = null;
  const closeReview = () => { activeReview?.destroy(); activeReview = null; reviewHolder.replaceChildren(); };
  signal?.addEventListener('abort', closeReview, { once: true });
  let droppedFile = null;
  const resetHint = () => { dropHint.textContent = 'Or drag and drop one report here.'; };
  input.addEventListener('change', () => { droppedFile = null; resetHint(); });
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  dropzone.addEventListener('dragenter', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); dropzone.classList.add('doctor-lab-dropzone-active');
  });
  dropzone.addEventListener('dragover', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('doctor-lab-dropzone-active');
  });
  dropzone.addEventListener('dragleave', event => {
    if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('doctor-lab-dropzone-active');
  });
  dropzone.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); dropzone.classList.remove('doctor-lab-dropzone-active');
    const files = event.dataTransfer.files;
    if (files.length !== 1) { droppedFile = null; input.value = ''; resetHint(); status.textContent = 'Drop one PDF, JPEG, or PNG report at a time.'; return; }
    droppedFile = files[0]; input.value = '';
    if (!allowedTypes.has(droppedFile.type) || !droppedFile.size || droppedFile.size > maxBytes) {
      droppedFile = null; resetHint(); status.textContent = 'Choose a PDF, JPEG, or PNG under 2 MB.'; return;
    }
    dropHint.textContent = `${droppedFile.name} ready. Select Upload report to continue.`;
    status.textContent = '';
  });
  const path = `/api/doctor/cases/${encodeURIComponent(caseId)}/lab-reports`;
  const render = reports => {
    closeReview();
    list.replaceChildren();
    if (!reports.length) { list.append(element('li', 'No laboratory reports uploaded for this case.')); return; }
    for (const report of reports) {
      const item = document.createElement('li');
      const statusLabel = { uploaded: 'Uploaded', processing: 'Gemini is reading', pending_review: 'Unverified extraction · Doctor review required', verified: `Doctor verified · revision ${report.verifiedResult?.revision || 1} · ${report.verifiedResult?.rows?.length || 0} results`, failed: report.canExtract ? 'Extraction failed · original preserved' : 'Upload failed' }[report.status] || 'Unavailable';
      const details = element('span', `${report.filename} · ${statusLabel}`);
      const actions = element('div', ''); actions.className = 'doctor-lab-actions';
      item.append(details, actions);
      if (report.canExtract) {
        const extract = element('button', 'Extract with Gemini'); extract.type = 'button';
        extract.addEventListener('click', async () => {
          extract.disabled = true; status.textContent = 'Gemini is reading the report…';
          try {
            const response = await apiFetch(`${path}/${encodeURIComponent(report.reportId)}/extract`, { method: 'POST', signal });
            if (!response.ok) throw new Error('REPORT_EXTRACTION_FAILED');
            if (!signal?.aborted) { status.textContent = 'Unverified extraction is ready for Doctor review. No clinical decision was made.'; await load(); }
          } catch { if (!signal?.aborted) { status.textContent = 'Gemini could not read this report. The original is preserved; try again.'; await load(); } }
          finally { extract.disabled = false; }
        });
        actions.append(extract);
      }
      if (report.status === 'pending_review' && report.reviewToken) {
        const review = element('button', 'Review extracted results'); review.type = 'button';
        review.addEventListener('click', () => {
          closeReview();
          activeReview = mountLabReview(report, { path, signal,
            onVerified: async saved => { status.textContent = `Doctor verified revision ${saved.verifiedResult.revision}. No clinical decision was made.`; await load(); },
            onStale: async () => { status.textContent = 'The report changed. Reopen its current review.'; await load(); },
          });
          reviewHolder.append(activeReview.element);
          activeReview.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        actions.append(review);
      }
      if (report.status === 'verified' && report.verifiedResult?.revision) {
        const assess = element('button', 'Request assessment of verified results'); assess.type = 'button';
        assess.addEventListener('click', async () => {
          assess.disabled = true; status.textContent = 'Requesting a review-only clinical assessment…';
          try {
            const response = await apiFetch(`/api/clinical/lab-run?caseId=${encodeURIComponent(caseId)}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId: crypto.randomUUID(), reportId: report.reportId, expectedRevision: report.verifiedResult.revision }), signal,
            });
            if (!response.ok) throw new Error('LAB_ASSESSMENT_UNAVAILABLE');
            status.textContent = 'Assessment requested. Review the AI clinical analysis as it updates; no action was taken.';
          } catch { if (!signal?.aborted) status.textContent = 'Assessment was not requested. Refresh the case and verify this report is still current.'; }
          finally { assess.disabled = false; }
        });
        actions.append(assess);
      }
      if (report.status !== 'failed' || report.canExtract) {
        const open = element('button', 'Open original'); open.type = 'button';
        open.addEventListener('click', async () => {
          open.disabled = true; status.textContent = 'Opening report…';
          try {
            const response = await apiFetch(`${path}/${encodeURIComponent(report.reportId)}/file`, { cache: 'no-store', signal });
            if (!response.ok) throw new Error('The report could not be opened.');
            const blob = await response.blob();
            if (signal?.aborted) return;
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = report.filename; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            status.textContent = 'The original report was downloaded.';
          } catch { if (!signal?.aborted) status.textContent = 'The report could not be opened. Try again.'; }
          finally { open.disabled = false; }
        });
        actions.append(open);
      }
      list.append(item);
    }
  };
  const load = async () => {
    try {
      const response = await apiFetch(path, { cache: 'no-store', signal });
      if (!response.ok) throw new Error('REPORT_LIST_UNAVAILABLE');
      const result = await response.json(); if (!signal?.aborted) render(result.reports || []);
    } catch { if (!signal?.aborted) status.textContent = 'Reports could not be loaded. Reopen the case to retry.'; }
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = droppedFile || input.files?.[0];
    if (!file) { status.textContent = 'Select or drop a laboratory report first.'; return; }
    if (!allowedTypes.has(file.type) || !file.size || file.size > maxBytes) { status.textContent = 'Choose a PDF, JPEG, or PNG under 2 MB.'; return; }
    upload.disabled = true; status.textContent = 'Uploading report…';
    try {
      const reportBase64 = await base64For(file);
      if (signal?.aborted) return;
      const response = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, mimeType: file.type, reportBase64 }), signal });
      if (!response.ok) throw new Error('REPORT_UPLOAD_FAILED');
      input.value = ''; droppedFile = null; resetHint(); status.textContent = 'Report uploaded. Its contents have not been clinically verified.';
      await load();
    } catch { if (!signal?.aborted) { status.textContent = 'The report could not be saved. Select it again and retry.'; await load(); } }
    finally { upload.disabled = false; }
  });
  void load();
  return panel;
}

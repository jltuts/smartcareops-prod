import { apiFetch } from '../../auth/service.js';
import { specialtyLabels } from '../../../shared/routing.js';

const reviewLabels = { pending: 'Waiting for clinical review', approved: 'Clinical review approved', rejected: 'Clinical review rejected', deferred: 'Clinical review deferred' };
const workflowLabels = { submitted_for_clinical_review: 'Waiting for clinical review', intake_completed: 'Intake completed', emergency_pending_dispatcher: 'Emergency — pending dispatcher', emergency_acknowledged: 'Emergency — dispatcher acknowledged', routed_to_doctor: 'Routed to doctor' };
const caseHistoryPageSize = 20;
const formattedDate = value => {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium', timeStyle: 'short' }).format(time) : 'Date unavailable';
};

export function mountCaseHistory(outlet, { onOpen } = {}) {
  const summaryRoot = outlet.querySelector('#patient-recent-activity');
  const fullRoot = outlet.querySelector('#patient-case-history-full');
  let controller, cursor = null, cases = [], disposed = false, loading = false, generation = 0;
  let initialComplete = false, initialUnavailable = false, olderCasesUnavailable = false, mode = 'summary';
  const paragraph = text => { const node = document.createElement('p'); node.textContent = text; return node; };

  function caseList(items) {
    const list = document.createElement('ol'); list.className = 'patient-case-history';
    for (const item of items) {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'patient-case-history-item'; button.dataset.caseId = item.caseId;
      const heading = document.createElement('strong'); heading.textContent = reviewLabels[item.clinicalReview?.status] || workflowLabels[item.workflowStatus] || 'Case saved';
      const date = document.createElement('span'); date.textContent = `Intake: ${formattedDate(item.intakeDate)}`;
      const next = paragraph(item.nextStep || 'Review the latest case status.');
      button.append(heading, date, next);
      if (item.doctorAttribution?.status === 'available') {
        const doctor = paragraph(`Reviewed by ${item.doctorAttribution.displayName} · ${specialtyLabels[item.doctorAttribution.specialty] || item.doctorAttribution.specialty}`);
        doctor.className = 'patient-case-reviewer'; button.append(doctor);
      } else if (item.doctorAttribution?.status === 'unavailable') {
        const doctor = paragraph('Doctor profile details are unavailable for this completed review.');
        doctor.className = 'patient-case-reviewer'; button.append(doctor);
      }
      button.addEventListener('click', () => onOpen?.(item.caseId)); row.append(button); list.append(row);
    }
    return list;
  }

  function appendUnavailable(root, initial) {
    const title = document.createElement('strong'); title.textContent = initial ? 'Cases are temporarily unavailable' : 'Some older cases could not be loaded';
    const message = paragraph(initial ? 'Your saved cases could not be loaded. Nothing was removed.' : 'The cases already shown are unchanged. Try loading the remaining cases again.');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'patient-case-history-more'; retry.textContent = 'Try again';
    retry.addEventListener('click', () => void (initial ? loadInitial() : loadRemaining()));
    root.append(title, message, retry);
  }

  function renderSummary() {
    summaryRoot.replaceChildren();
    if (mode !== 'summary') return;
    if (!initialComplete && !initialUnavailable) { summaryRoot.append(paragraph('Loading your newest case…')); return; }
    if (initialUnavailable) { appendUnavailable(summaryRoot, true); return; }
    if (!cases.length) {
      const title = document.createElement('strong'); title.textContent = 'No saved cases yet';
      summaryRoot.append(title, paragraph('Complete a conversation to create a case you can reopen here.')); return;
    }
    summaryRoot.append(caseList(cases.slice(0, 1)));
    const all = document.createElement('a'); all.className = 'patient-case-history-all'; all.href = '#cases'; all.textContent = 'View all cases →'; summaryRoot.append(all);
  }

  function renderFull() {
    fullRoot.replaceChildren();
    if (mode !== 'full') return;
    if (!initialComplete && !initialUnavailable) { fullRoot.append(paragraph('Loading your cases…')); return; }
    if (initialUnavailable) { appendUnavailable(fullRoot, true); return; }
    if (!cases.length) {
      const title = document.createElement('strong'); title.textContent = 'No saved cases yet';
      fullRoot.append(title, paragraph('Complete a conversation to create a case you can reopen here.')); return;
    }
    fullRoot.append(caseList(cases));
    if (loading) {
      const status = paragraph('Loading older cases…'); status.className = 'patient-case-history-loading'; status.setAttribute('role', 'status'); fullRoot.append(status);
    } else if (olderCasesUnavailable) appendUnavailable(fullRoot, false);
  }

  function render() { renderSummary(); renderFull(); }

  async function requestPage(requestedCursor, limit) {
    const query = new URLSearchParams({ limit: String(limit), ...(requestedCursor ? { cursor: requestedCursor } : {}) });
    const response = await apiFetch(`/api/cases?${query}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('CASE_HISTORY_UNAVAILABLE');
    const result = await response.json();
    if (!Array.isArray(result.cases)) throw new Error('CASE_HISTORY_UNAVAILABLE');
    return result;
  }

  async function loadInitial() {
    if (disposed) return;
    controller?.abort(); controller = new AbortController();
    const current = ++generation;
    loading = true; initialComplete = false; initialUnavailable = false; olderCasesUnavailable = false; cursor = null; cases = []; render();
    try {
      const result = await requestPage(null, 1);
      if (disposed || current !== generation) return;
      cases = result.cases;
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null;
      initialComplete = true;
    } catch (error) {
      if (disposed || current !== generation || error?.name === 'AbortError') return;
      initialUnavailable = true;
    } finally {
      if (!disposed && current === generation) {
        loading = false; render();
        if (mode === 'full' && initialComplete && cursor) void loadRemaining();
      }
    }
  }

  async function loadRemaining() {
    if (disposed || loading || !initialComplete || !cursor) return;
    controller?.abort(); controller = new AbortController();
    const current = ++generation;
    loading = true; olderCasesUnavailable = false; render();
    try {
      while (!disposed && current === generation && cursor) {
        const requestedCursor = cursor;
        const result = await requestPage(requestedCursor, caseHistoryPageSize);
        if (disposed || current !== generation) return;
        const known = new Set(cases.map(item => item.caseId));
        const additions = result.cases.filter(item => item?.caseId && !known.has(item.caseId) && known.add(item.caseId));
        cases = [...cases, ...additions];
        cursor = typeof result.nextCursor === 'string' && result.nextCursor !== requestedCursor ? result.nextCursor : null;
        render();
      }
    } catch (error) {
      if (disposed || current !== generation || error?.name === 'AbortError') return;
      olderCasesUnavailable = true;
    } finally {
      if (!disposed && current === generation) { loading = false; render(); }
    }
  }

  function setMode(nextMode) {
    mode = nextMode === 'full' ? 'full' : 'summary';
    render();
    if (mode === 'full' && initialComplete && cursor) void loadRemaining();
  }

  const refreshForSavedCase = () => void loadInitial();
  window.addEventListener('smartcareops:case-updated', refreshForSavedCase);

  void loadInitial();
  return { setMode, refresh: () => loadInitial(), dispose() { disposed = true; controller?.abort(); window.removeEventListener('smartcareops:case-updated', refreshForSavedCase); } };
}

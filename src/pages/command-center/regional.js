import { apiFetch } from '../../auth/service.js';
export const renderRegional = () => `<section id="regional-workspace" class="ops-workspace" aria-labelledby="regional-heading">
  <span class="badge">Fictional regional intelligence</span><h2 id="regional-heading">Regional Intelligence — REGION-DEMO-001</h2>
  <p>HOSP-001 · HOSP-002 · HOSP-003. Signals require human review; this demo does not establish an epidemiological diagnosis.</p>
  <p id="regional-message" aria-live="polite">Loading regional evidence…</p><div id="regional-content" class="regional-grid"></div>
  <button id="regional-refresh" type="button">Refresh regional evidence</button><button id="regional-run" type="button" disabled>Request regional assessment</button>
  <button id="regional-capacity" type="button" disabled>Demo: set HOSP-003 monitored beds to 0</button>
</section>`;
export function mountRegional(root) {
  const section = root.querySelector('#regional-workspace'), content = section.querySelector('#regional-content'), message = section.querySelector('#regional-message');
  const run = section.querySelector('#regional-run'), capacity = section.querySelector('#regional-capacity');
  const controller = new AbortController(); let view, busy = false;
  const node = (tag, text, parent) => { const el = document.createElement(tag); el.textContent = text; parent.append(el); return el; };
  const panel = title => { const el = node('article', '', content); el.className = 'ops-panel'; node('h3', title, el); return el; };
  async function request(path = '', body) {
    const response = await apiFetch('/api/regional' + path, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('Regional intelligence unavailable or the action is stale. Refresh to review evidence.'); return response.json();
  }
  function render() {
    content.replaceChildren(); const snap = view.currentSnapshot, plan = view.plans.find(item => item.revisionId === view.meta.currentRevisionId);
    const overview = panel('Current regional signal'); overview.classList.add('ops-wide');
    node('p', view.meta.ready && plan ? plan.assessment.signal : 'Awaiting a current regional assessment', overview);
    node('p', 'Evidence strength: limited fictional aggregate samples. No numerical confidence is assigned.', overview);
    if (!snap?.complete) node('p', 'A complete fictional census pair for all three hospitals is required before assessment.', overview);
    if (snap) {
      node('p', `Time window: ${snap.windowHours} hours · Previous respiratory census: ${snap.aggregate.previousWindowRespiratoryCases ?? 'unknown'} · Current: ${snap.aggregate.respiratoryCases ?? 'unknown'} · Hospitals affected: ${snap.aggregate.hospitalsAffected ?? 'unknown'}`, overview);
      node('p', `Current interval: ${snap.currentWindowStart} to ${snap.windowEnd} (end excluded). ${snap.windowMethod}.`, overview);
      const facilities = panel('Participating hospitals'); facilities.classList.add('ops-wide');
      const table = node('table', '', facilities); table.className = 'regional-table'; const header = node('tr', '', node('thead', '', table));
      for (const title of ['Hospital', 'Respiratory census', 'Emergency', 'Monitored beds', 'ICU beds']) node('th', title, header);
      const body = node('tbody', '', table);
      for (const hospital of snap.hospitals) { const row = node('tr', '', body); for (const value of [hospital.hospitalId, `${hospital.previous?.respiratory ?? '?'} → ${hospital.current?.respiratory ?? '?'}`, hospital.current?.emergency ?? '?', hospital.capacity.monitoredBedsAvailable, hospital.capacity.icuBedsAvailable]) node('td', String(value), row); }
      const map = panel('Simulated geographic area'); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 480 220'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Three fictional hospitals plotted from simulated coordinates'); map.append(svg);
      const latitudes = snap.hospitals.map(h => h.location.latitude), longitudes = snap.hospitals.map(h => h.location.longitude);
      const minLat = Math.min(...latitudes), maxLat = Math.max(...latitudes), minLon = Math.min(...longitudes), maxLon = Math.max(...longitudes);
      for (const hospital of snap.hospitals) {
        const x = 65 + (hospital.location.longitude - minLon) / (maxLon - minLon || 1) * 290, y = 160 - (hospital.location.latitude - minLat) / (maxLat - minLat || 1) * 110;
        const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('cx', String(x)); circle.setAttribute('cy', String(y)); circle.setAttribute('r', '12'); circle.setAttribute('fill', hospital.capacity.monitoredBedsAvailable === 0 ? '#94542f' : '#185c51'); svg.append(circle);
        const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', String(x - 40)); label.setAttribute('y', String(y + 32)); label.setAttribute('font-size', '13'); label.textContent = `${hospital.hospitalId}: ${hospital.current?.respiratory ?? '?'} respiratory`; svg.append(label);
      }
      node('p', `${snap.geography.areaId} · ${snap.geography.concentrated ? 'All hospital pairs are within' : 'Some hospital pairs exceed'} 10 km. Location proximity does not establish transmission. Brown markers indicate zero monitored beds.`, map);
      const investigation = panel('Investigated regional evidence');
      for (const item of snap.signals) node('p', item.replaceAll('_', ' '), investigation);
      node('p', snap.fleet ? `Shared fleet: ${snap.fleet.available} available / ${snap.fleet.reserved} reserved. Demand trend unavailable.` : 'Fleet evidence unavailable.', investigation);
      node('p', `Fever total: ${snap.aggregate.feverCases ?? 'unknown — incomplete coverage'}. Oxygen trends: not represented.`, investigation);
      if (snap.pressureSignal) node('p', `Hospital handoff: ${snap.pressureSignal.eventId} · ${snap.pressureSignal.planRevisionId}`, investigation);
      for (const item of view.resourceEvidence.slice(-10)) node('p', `${item.toolName} · ${item.result.hospitalId || 'fleet'} · ${item.result.resourceVersion}`, investigation);
    }
    if (plan) {
      const assessment = panel(`Regional plan ${plan.revisionId}`); assessment.classList.add('ops-wide'); node('p', plan.assessment.changeSummary, assessment);
      for (const [key, title] of [['observations', 'Observed'], ['suspectedSignals', 'Suspected signals'], ['supportingEvidence', 'Supporting evidence'], ['conflictingEvidence', 'Conflicting evidence'], ['uncertainties', 'Uncertainty'], ['operationalRisks', 'Operational risks']]) {
        node('h4', title, assessment); const list = node('ul', '', assessment); for (const item of plan.assessment[key]) node('li', `${item.summary} (${item.evidenceRefs.join(', ')})`, list);
      }
      node('h4', 'Monitoring', assessment); for (const text of plan.assessment.monitoringConditions) node('p', text, assessment);
      const actions = panel('Regional operational actions'); actions.classList.add('ops-wide');
      for (const action of plan.actions) {
        const row = node('div', '', actions); row.className = 'ops-action'; const approval = view.approvals.find(a => a.planRevisionId === plan.revisionId && a.actionId === action.actionId), execution = view.executions.find(e => e.actionId === action.actionId);
        node('p', `${action.toolName} · ${action.risk} · ${execution?.status || approval?.status || 'pending'}`, row);
        node('p', action.risk === 'HIGH_IMPACT' ? 'Human approval creates a fictional rehearsal receipt only. No transfer, reservation or external alert. Demo reviewer: demo_regional.' : 'Automatic local review receipt.', row);
        if (approval?.status === 'pending') for (const decision of ['approved', 'rejected']) { const button = node('button', decision === 'approved' ? 'Approve regional simulation' : 'Reject regional simulation', row); button.type = 'button'; button.disabled = busy || !view.meta.ready; button.addEventListener('click', () => void mutate(`/approvals/${approval.approvalId}`, { decision })); }
      }
    }
    const history = panel('Regional plan history'); for (const item of view.plans) node('p', `${item.revisionId} · Snapshot ${item.snapshotVersion} · ${item.createdAt}`, history).id = 'plan-' + item.revisionId;
    const receipts = panel('Regional completed receipts'); for (const item of view.receipts) node('p', `${item.receiptId} · ${item.outcome}`, receipts);
    const timeline = panel('Regional timeline'); for (const item of view.events) node('p', `${item.occurredAt} · ${item.type}`, timeline);
    const runs = panel('Regional agent runs'); for (const item of view.runs) node('p', `${item.runId} · ${item.status} · Snapshot ${item.snapshotVersion}`, runs);
    run.disabled = busy || !snap?.complete; capacity.disabled = busy || !snap?.complete || snap.hospitals.find(item => item.hospitalId === 'HOSP-003').capacity.monitoredBedsAvailable === 0;
  }
  async function refresh() { try { view = await request(); if (controller.signal.aborted) return; render(); message.textContent = view.meta.lastError ? 'Regional assessment unavailable. Previous plans are retained; dependent actions are blocked.' : view.meta.ready ? 'Current regional assessment available.' : 'Waiting for current regional evidence and assessment.'; } catch (error) { if (!controller.signal.aborted) { message.textContent = error.message; run.disabled = true; capacity.disabled = true; } } }
  async function mutate(path, body) { if (busy) return; busy = true; render(); try { await request(path, body); await refresh(); } catch (error) { if (!controller.signal.aborted) message.textContent = error.message; } finally { busy = false; if (!controller.signal.aborted && view) render(); } }
  section.querySelector('#regional-refresh').addEventListener('click', refresh);
  run.addEventListener('click', () => void mutate('/run', { requestId: crypto.randomUUID() }));
  capacity.addEventListener('click', () => void mutate('/capacity', { requestId: crypto.randomUUID(), hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: Number(view.currentSnapshot.resourceVersion.split(':')[1]) }));
  void refresh(); const timer = setInterval(refresh, 5000); return () => { controller.abort(); clearInterval(timer); };
}

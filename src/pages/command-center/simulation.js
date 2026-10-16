import { apiFetch } from '../../auth/service.js';
import { operationalMapMarkup, renderOperationalMap } from '../../components/operational-map.js';

export function renderSimulation() {
  return `<section class="network-simulation" aria-labelledby="simulation-heading">
    <div class="section-heading-row"><div><p class="eyebrow">Observe · fictional operational model</p><h2 id="simulation-heading">Current Network State</h2></div><p class="simulation-note">Synthetic network only · no real hospital or patient data</p></div>
    <div class="simulation-controls">
      <div class="simulation-scenario-control"><label for="simulation-scenario">Scenario</label>
      <select id="simulation-scenario" disabled>
        <option value="normal_operations">Normal Operations</option>
        <option value="ed_surge">ED Surge</option>
        <option value="respiratory_outbreak">Respiratory Outbreak Simulation</option>
        <option value="capacity_failure">Hospital Capacity Failure Simulation</option>
      </select></div>
      <aside class="simulation-control-dock" data-state="loading" aria-label="Simulation controls">
        <span class="simulation-dock-status"><span class="simulation-dock-label">Simulation</span>
        <strong id="simulation-time" class="simulation-time" aria-live="polite" aria-label="Connecting to simulation">Connecting…</strong></span>
        <div class="simulation-dock-actions"><button type="button" id="simulation-reset" aria-label="Reset current demo scenario" disabled>Reset</button>
        <button type="button" id="simulation-advance" disabled>Advance 5 min</button></div>
      </aside>
    </div>
    <p id="simulation-message" role="status">Loading synthetic network…</p>
    <div class="network-command-layout">
      ${operationalMapMarkup({ id: 'command-network-map', title: 'Network geography', description: 'Hospitals, synthetic fleet positions, assignments, and the active aggregate region.' })}
      <aside class="network-state-rail" aria-labelledby="network-state-heading"><p class="eyebrow">Live simulation snapshot</p><h3 id="network-state-heading">Network state</h3><div id="simulation-network" class="simulation-summary" aria-label="Network summary"></div></aside>
    </div>
    <div id="simulation-hospitals" class="simulation-hospitals"></div>
    <div id="simulation-ambulances" class="simulation-ambulances"></div>
  </section>`;
}

const addText = (parent, tag, value, className) => {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className; parent.append(node); return node;
};

export function mountSimulation(root) {
  const panel = root.querySelector('.network-simulation');
  if (!panel) return () => {};
  const select = panel.querySelector('#simulation-scenario'), time = panel.querySelector('#simulation-time');
  const controlDock = panel.querySelector('.simulation-control-dock');
  const resetButton = panel.querySelector('#simulation-reset'), advanceButton = panel.querySelector('#simulation-advance');
  const message = panel.querySelector('#simulation-message'), summary = panel.querySelector('#simulation-network'), map = panel.querySelector('#command-network-map');
  const hospitals = panel.querySelector('#simulation-hospitals'), ambulances = panel.querySelector('#simulation-ambulances');
  const controller = new AbortController(); let state = null, busy = false, cluster = null, timeTransition;
  async function request(path = '', body) {
    const response = await apiFetch(`/api/simulation${path}`, {
      signal: controller.signal, cache: 'no-store',
      ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error('Simulation unavailable. Refresh to retry.');
    return response.json();
  }
  function draw() {
    if (!state) return;
    const timeChanged = controlDock.dataset.state === 'ready' && time.textContent !== state.simulationTime;
    controlDock.dataset.state = busy ? 'updating' : 'ready';
    time.textContent = state.simulationTime;
    time.setAttribute('aria-label', `Simulation time ${state.simulationTime}`);
    if (timeChanged) {
      clearTimeout(timeTransition); time.classList.remove('time-updated'); void time.offsetWidth; time.classList.add('time-updated');
      timeTransition = setTimeout(() => time.classList.remove('time-updated'), 420);
    }
    select.value = state.scenario;
    summary.replaceChildren(); hospitals.replaceChildren(); ambulances.replaceChildren();
    const facts = [
      ['Network pressure', state.network.pressureLevel],
      ['ED occupancy', `${state.network.totalEdOccupied} / ${state.network.totalEdCapacity}`],
      ['ICU occupancy', `${state.network.totalIcuOccupied} / ${state.network.totalIcuCapacity}`],
      ['Available ambulances', `${state.network.availableAmbulances} / ${state.network.fleetSize}`],
      ['Incoming demand', state.network.incomingDemand],
      ['Projected demand', state.network.projectedDemand],
      ['Critical hospitals', state.hospitals.filter(hospital => hospital.operationalState === 'critical').length],
    ];
    for (const [label, value] of facts) { const item = document.createElement('article'); item.className = 'simulation-metric'; addText(item, 'span', label); addText(item, 'strong', value); summary.append(item); }
    renderOperationalMap(map, { hospitals: state.hospitals, ambulances: state.ambulances, cluster, status: `${state.scenarioName} · ${state.simulationTime} · seeded coordinates and deterministic simulation positions` });
    addText(hospitals, 'h3', 'Hospital state');
    const hospitalGrid = document.createElement('div'); hospitalGrid.className = 'hospital-state-grid';
    for (const hospital of state.hospitals) {
      const card = document.createElement('article'); card.className = `hospital-state state-${hospital.operationalState}`; card.dataset.hospitalId = hospital.id;
      const head = document.createElement('header'); addText(head, 'span', hospital.id, 'hospital-id'); addText(head, 'strong', hospital.operationalState, 'hospital-state-label'); card.append(head); addText(card, 'h4', hospital.name);
      const metrics = document.createElement('div'); metrics.className = 'hospital-metrics';
      for (const [label, value, ratio] of [['ED', `${hospital.edOccupied} / ${hospital.edEffectiveCapacity}`, hospital.edUtilization], ['ICU', `${hospital.icuOccupied} / ${hospital.icuEffectiveCapacity}`, hospital.icuUtilization], ['Staff', `${Math.round(hospital.staffingPressure * 100)}%`, hospital.staffingPressure]]) {
        const metric = document.createElement('div'); metric.className = 'hospital-metric'; const copy = document.createElement('p'); addText(copy, 'span', label); addText(copy, 'strong', value); metric.append(copy);
        const bar = document.createElement('i'); bar.style.setProperty('--metric-value', `${Math.round(ratio * 100)}%`); metric.append(bar); metrics.append(metric);
      }
      card.append(metrics); addText(card, 'p', `Incoming ${hospital.incomingDemand} · Projected ${hospital.projectedDemand} · Respiratory ${hospital.respiratoryDemand}`, 'hospital-demand'); hospitalGrid.append(card);
    }
    hospitals.append(hospitalGrid);
    addText(ambulances, 'h3', 'Fleet status');
    const fleet = document.createElement('div'); fleet.className = 'ambulance-status-strip';
    for (const unit of state.ambulances) {
      const destination = unit.assignment ? ` → ${unit.assignment.destination}` : '';
      const availability = unit.estimatedAvailability ? ` · available ${unit.estimatedAvailability}` : '';
      const item = addText(fleet, 'article', `${unit.id} · ${unit.status}${destination}${availability}`); item.dataset.ambulanceId = unit.id; item.className = `ambulance-status state-${unit.status}`;
    }
    ambulances.append(fleet);
    resetButton.disabled = busy; advanceButton.disabled = busy; select.disabled = busy;
  }
  async function refresh() {
    try { state = await request(); if (controller.signal.aborted) return; draw(); message.textContent = 'Simulation state loaded.'; }
    catch {
      if (!controller.signal.aborted) {
        controlDock.dataset.state = 'unavailable';
        time.textContent = 'Unavailable';
        time.setAttribute('aria-label', 'Simulation unavailable');
        select.disabled = true; resetButton.disabled = true; advanceButton.disabled = true;
        message.textContent = 'Simulation unavailable. Refresh to retry.';
      }
    }
  }
  async function mutate(path, body) {
    if (busy) return; busy = true; controlDock.dataset.state = 'updating'; draw(); message.textContent = 'Updating simulation…';
    try { state = await request(path, body); draw(); message.textContent = 'Simulation updated.'; }
    catch { if (!controller.signal.aborted) message.textContent = 'Simulation update could not be confirmed. Refresh to retry.'; }
    finally { busy = false; if (!controller.signal.aborted) draw(); }
  }
  select.addEventListener('change', () => void mutate('/scenario', { scenario: select.value }));
  resetButton.addEventListener('click', () => void mutate('/reset', {}));
  advanceButton.addEventListener('click', () => void mutate('/advance', { steps: 1 }));
  const patternState = event => { cluster = event.detail; if (state) draw(); };
  window.addEventListener('smartcareops:pattern-state', patternState);
  void refresh();
  return () => { clearTimeout(timeTransition); window.removeEventListener('smartcareops:pattern-state', patternState); controller.abort(); };
}

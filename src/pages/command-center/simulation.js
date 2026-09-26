import { apiFetch } from '../../auth/service.js';

export function renderSimulation() {
  return `<section class="network-simulation" aria-labelledby="simulation-heading">
    <p class="eyebrow">Synthetic network exercise</p>
    <h2 id="simulation-heading">Healthcare Network Simulation</h2>
    <p class="simulation-note">Deterministic fictional operations data. No real hospital or patient data is used.</p>
    <div class="simulation-controls">
      <label for="simulation-scenario">Scenario</label>
      <select id="simulation-scenario">
        <option value="normal_operations">Normal Operations</option>
        <option value="ed_surge">ED Surge</option>
        <option value="respiratory_outbreak">Respiratory Outbreak Simulation</option>
        <option value="capacity_failure">Hospital Capacity Failure Simulation</option>
      </select>
      <span id="simulation-time" class="simulation-time" aria-live="polite">Loading…</span>
      <button type="button" id="simulation-reset" disabled>Reset</button>
      <button type="button" id="simulation-advance" disabled>Advance 5 min</button>
    </div>
    <p id="simulation-message" role="status">Loading synthetic network…</p>
    <div id="simulation-network" class="simulation-summary" aria-label="Network summary"></div>
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
  const resetButton = panel.querySelector('#simulation-reset'), advanceButton = panel.querySelector('#simulation-advance');
  const message = panel.querySelector('#simulation-message'), summary = panel.querySelector('#simulation-network');
  const hospitals = panel.querySelector('#simulation-hospitals'), ambulances = panel.querySelector('#simulation-ambulances');
  const controller = new AbortController(); let state = null, busy = false;
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
    time.textContent = `Simulation time: ${state.simulationTime}`;
    select.value = state.scenario;
    summary.replaceChildren(); hospitals.replaceChildren(); ambulances.replaceChildren();
    const facts = [
      ['Network pressure', state.network.pressureLevel],
      ['ED occupancy', `${state.network.totalEdOccupied} / ${state.network.totalEdCapacity}`],
      ['ICU occupancy', `${state.network.totalIcuOccupied} / ${state.network.totalIcuCapacity}`],
      ['Incoming / projected', `${state.network.incomingDemand} / ${state.network.projectedDemand}`],
      ['Demand trend', state.network.demandTrend],
      ['Available ambulances', `${state.network.availableAmbulances} / ${state.network.fleetSize}`],
    ];
    for (const [label, value] of facts) { const item = document.createElement('article'); item.className = 'simulation-metric'; addText(item, 'span', label); addText(item, 'strong', value); summary.append(item); }
    addText(hospitals, 'h3', 'Hospitals');
    const table = document.createElement('table'); table.className = 'simulation-table';
    const head = document.createElement('thead'), header = document.createElement('tr');
    for (const label of ['Hospital', 'ED occupancy', 'ICU occupancy', 'Respiratory demand', 'Staffing pressure', 'Incoming / projected', 'Operational state']) addText(header, 'th', label);
    head.append(header); table.append(head); const body = document.createElement('tbody');
    for (const hospital of state.hospitals) {
      const row = document.createElement('tr');
      const cells = [hospital.name, `${hospital.edOccupied} / ${hospital.edEffectiveCapacity} (${Math.round(hospital.edUtilization * 100)}%)`, `${hospital.icuOccupied} / ${hospital.icuEffectiveCapacity} (${Math.round(hospital.icuUtilization * 100)}%)`, `${hospital.respiratoryDemand} · ${Math.round(hospital.respiratoryResourcePressure * 100)}% resource pressure`, `${Math.round(hospital.staffingPressure * 100)}%`, `${hospital.incomingDemand} / ${hospital.projectedDemand}`, hospital.operationalState];
      for (const value of cells) addText(row, 'td', value);
      row.dataset.hospitalId = hospital.id; body.append(row);
    }
    table.append(body); hospitals.append(table);
    addText(ambulances, 'h3', 'Ambulances');
    const fleet = document.createElement('ul');
    for (const unit of state.ambulances) {
      const destination = unit.assignment ? ` → ${unit.assignment.destination}` : '';
      const availability = unit.estimatedAvailability ? ` · available ${unit.estimatedAvailability}` : '';
      addText(fleet, 'li', `${unit.id} · ${unit.status}${destination}${availability}`);
    }
    ambulances.append(fleet);
    resetButton.disabled = busy; advanceButton.disabled = busy; select.disabled = busy;
  }
  async function refresh() {
    try { state = await request(); if (controller.signal.aborted) return; draw(); message.textContent = 'Simulation state loaded.'; }
    catch { if (!controller.signal.aborted) message.textContent = 'Simulation unavailable. Refresh to retry.'; }
  }
  async function mutate(path, body) {
    if (busy) return; busy = true; draw(); message.textContent = 'Updating simulation…';
    try { state = await request(path, body); draw(); message.textContent = 'Simulation updated.'; }
    catch { if (!controller.signal.aborted) message.textContent = 'Simulation update could not be confirmed. Refresh to retry.'; }
    finally { busy = false; if (!controller.signal.aborted) draw(); }
  }
  select.addEventListener('change', () => void mutate('/scenario', { scenario: select.value }));
  resetButton.addEventListener('click', () => void mutate('/reset', {}));
  advanceButton.addEventListener('click', () => void mutate('/advance', { steps: 1 }));
  void refresh();
  return () => controller.abort();
}

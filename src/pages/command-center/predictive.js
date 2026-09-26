import { apiFetch } from '../../auth/service.js';

export function renderPredictive() {
  return `<section class="predictive-panel" aria-labelledby="predictive-heading">
    <p class="eyebrow">Operational outlook · deterministic synthetic network</p>
    <h2 id="predictive-heading">Predictive Intelligence</h2>
    <p>Forecasts are generated from independent M15 projections. Gemini interprets these modeled outcomes for human review; it does not change the simulation.</p>
    <div class="predictive-actions"><button type="button" id="predictive-generate">Generate Forecast</button><span id="predictive-baseline">Loading saved forecast…</span></div>
    <p id="predictive-message" role="status" aria-live="polite">Restoring saved forecast…</p><div id="predictive-result"></div>
  </section>`;
}
const add = (parent, tag, text, className) => { const node = document.createElement(tag); node.textContent = String(text); if (className) node.className = className; parent.append(node); return node; };
const percent = value => `${Math.round(value * 100)}%`;

export function mountPredictive(root) {
  const panel = root.querySelector('.predictive-panel'); if (!panel) return () => {};
  const button = panel.querySelector('#predictive-generate'), baseline = panel.querySelector('#predictive-baseline');
  const message = panel.querySelector('#predictive-message'), resultRoot = panel.querySelector('#predictive-result');
  const controller = new AbortController(); let state = null, busy = false;
  async function request(generate = false) {
    const response = await apiFetch(`/api/predictive${generate ? '/generate' : ''}`, { signal: controller.signal, cache: 'no-store',
      ...(generate ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
    if (!response.ok) throw new Error('Predictive forecast is unavailable. Refresh to retry.');
    return response.json();
  }
  function render() {
    button.disabled = busy; resultRoot.replaceChildren();
    if (!state) { baseline.textContent = 'No saved forecast yet.'; return; }
    baseline.textContent = `Baseline: ${state.baseline.scenarioName} · ${state.baseline.simulationTime} · ${state.baseline.metrics.networkPressureLevel} network pressure · ${new Date(state.generatedAt).toLocaleString()}`;
    const current = add(resultRoot, 'article', '', 'predictive-current'); add(current, 'h3', 'CURRENT');
    add(current, 'p', `Network pressure: ${state.baseline.metrics.networkPressureLevel} (${percent(state.baseline.metrics.networkPressure)}) · ED ${state.baseline.metrics.ed.occupied}/${state.baseline.metrics.ed.effectiveCapacity} · ICU ${state.baseline.metrics.icu.occupied}/${state.baseline.metrics.icu.effectiveCapacity} · ambulances ${state.baseline.metrics.availableAmbulances}/${state.baseline.metrics.fleetSize}`);
    const currentHospitals = add(current, 'ul', ''); for (const hospital of state.baseline.metrics.hospitals) add(currentHospitals, 'li', `${hospital.hospitalId}: ${hospital.operationalState}, ED ${hospital.edOccupied}/${hospital.edEffectiveCapacity}, ICU ${hospital.icuOccupied}/${hospital.icuEffectiveCapacity}`);
    const grid = add(resultRoot, 'div', '', 'predictive-horizons');
    for (const horizon of state.horizons) {
      const card = add(grid, 'article', '', 'predictive-horizon'); add(card, 'h3', `NEXT ${horizon.minutes} MIN`);
      add(card, 'p', `Network pressure: ${horizon.metrics.networkPressureLevel} (${percent(horizon.metrics.networkPressure)})`);
      add(card, 'p', `ED: ${horizon.metrics.ed.occupied}/${horizon.metrics.ed.effectiveCapacity} · ICU: ${horizon.metrics.icu.occupied}/${horizon.metrics.icu.effectiveCapacity}`);
      add(card, 'p', `Projected demand: ${horizon.metrics.projectedDemand} · Available ambulances: ${horizon.metrics.availableAmbulances}/${horizon.metrics.fleetSize}`);
      add(card, 'p', `Staffing pressure: ${Math.max(...horizon.metrics.staffingPressure.map(item => item.pressure)).toFixed(2)} · ${horizon.simulationTime}`);
      const list = add(card, 'ul', ''); for (const hospital of horizon.metrics.hospitals) add(list, 'li', `${hospital.hospitalId}: ED ${hospital.edOccupied}/${hospital.edEffectiveCapacity} (${percent(hospital.edUtilization)}), ICU ${hospital.icuOccupied}/${hospital.icuEffectiveCapacity}, ${hospital.operationalState}`);
    }
    const risk = add(resultRoot, 'article', '', 'predictive-risks'); add(risk, 'h3', 'Predicted bottlenecks');
    if (!state.bottlenecks.length) add(risk, 'p', 'No significant capacity or ambulance bottleneck is derived from these projections.');
    else {
      const list = add(risk, 'ul', ''); for (const item of state.bottlenecks) add(list, 'li', `${item.resource} · ${item.severity} pressure ${item.horizonMinutes === 0 ? 'currently' : `within ${item.horizonMinutes} minutes`} · ${JSON.stringify(item.evidence)}`);
      const evaluate = add(risk, 'button', 'Evaluate with CareTwin'); evaluate.type = 'button';
      evaluate.addEventListener('click', () => { const twin = root.querySelector('.caretwin-panel'); twin?.scrollIntoView({ behavior: 'smooth', block: 'start' }); window.dispatchEvent(new CustomEvent('smartcareops:caretwin:generate')); });
    }
    if (state.interpretationStatus === 'succeeded' && state.interpretation) {
      const advice = add(resultRoot, 'article', '', 'predictive-interpretation');
      add(advice, 'p', `Gemini advisory · Top predicted bottleneck: ${state.interpretation.topBottleneck}`);
      add(advice, 'p', `Recommended intervention: ${state.interpretation.recommendation}`);
      for (const [title, key] of [['Why', 'why'], ['Why Not', 'whyNot'], ['Uncertainty', 'uncertainty'], ['What would change this recommendation', 'whatWouldChange']]) {
        add(advice, 'h3', title); const list = add(advice, 'ul', ''); for (const item of state.interpretation[key]) add(list, 'li', item);
      }
    } else if (state.interpretationStatus === 'pending') add(resultRoot, 'p', 'Forecast metrics are saved; Gemini interpretation is still pending.');
    else if (state.interpretationStatus === 'unavailable') add(resultRoot, 'p', 'Forecast metrics are saved. Gemini interpretation is unavailable; no recommendation was confirmed.');
    for (const assumption of state.assumptions) add(resultRoot, 'p', assumption);
  }
  async function refresh() { try { state = (await request()).result; render(); message.textContent = state ? 'Saved forecast restored.' : 'Ready to generate a deterministic forecast.'; } catch { if (!controller.signal.aborted) message.textContent = 'Saved forecast is unavailable. Refresh to retry.'; } }
  button.addEventListener('click', async () => {
    if (busy) return; busy = true; button.disabled = true; message.textContent = 'Generating forecast and Gemini interpretation…';
    try { state = (await request(true)).result; render(); message.textContent = 'Forecast and interpretation saved.'; }
    catch { if (!controller.signal.aborted) message.textContent = 'Forecast could not be confirmed. Refresh to retry.'; }
    finally { busy = false; render(); }
  });
  void refresh(); return () => controller.abort();
}

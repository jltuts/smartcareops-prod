import { apiFetch } from '../../auth/service.js';

export function renderCareTwin() {
  return `<section class="caretwin-panel" aria-labelledby="caretwin-heading">
    <p class="eyebrow">Advisory planning · synthetic futures</p>
    <h2 id="caretwin-heading">CareTwin</h2>
    <p>Compare three deterministic M15 futures from the same current network snapshot. Gemini explains trade-offs; it does not create outcomes or execute plans.</p>
    <div class="caretwin-actions"><button type="button" id="caretwin-generate">Generate Plans</button><span id="caretwin-baseline">Loading current baseline…</span></div>
    <p id="caretwin-message" role="status" aria-live="polite">Loading saved CareTwin result…</p>
    <div id="caretwin-result"></div>
  </section>`;
}

const add = (parent, tag, text, className) => {
  const node = document.createElement(tag); node.textContent = String(text);
  if (className) node.className = className; parent.append(node); return node;
};

export function mountCareTwin(root) {
  const panel = root.querySelector('.caretwin-panel'); if (!panel) return () => {};
  const generateButton = panel.querySelector('#caretwin-generate'), baseline = panel.querySelector('#caretwin-baseline');
  const message = panel.querySelector('#caretwin-message'), resultRoot = panel.querySelector('#caretwin-result');
  const controller = new AbortController(); let state = null, busy = false;
  async function request(path = '', body) {
    const response = await apiFetch(`/api/caretwin${path}`, { signal: controller.signal, cache: 'no-store',
      ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('CareTwin is unavailable or the request could not be confirmed. Refresh to retry.');
    return response.json();
  }
  function render() {
    generateButton.disabled = busy;
    resultRoot.replaceChildren();
    if (!state) { baseline.textContent = 'No saved baseline yet.'; return; }
    const start = state.baseline;
    baseline.textContent = start ? `Baseline: ${start.scenarioName} · ${start.simulationTime} · ${start.metrics.networkPressureLevel} network pressure · ${state.horizonMinutes}-minute horizon` : 'No saved baseline yet.';
    if (!state.plans?.length) return;
    const grid = add(resultRoot, 'div', '', 'caretwin-plan-grid');
    for (const plan of state.plans) {
      const card = add(grid, 'article', '', 'caretwin-plan');
      if (state.comparison?.recommendedPlan === plan.id) card.classList.add('caretwin-recommended');
      add(card, 'p', `Plan ${plan.id}`, 'caretwin-plan-label'); add(card, 'h3', plan.name); add(card, 'p', plan.description);
      add(card, 'p', `ED occupancy ${plan.outcome.ed.occupied} / ${plan.outcome.ed.effectiveCapacity} · ICU ${plan.outcome.icu.occupied} / ${plan.outcome.icu.effectiveCapacity}`);
      add(card, 'p', `Projected demand ${plan.outcome.projectedDemand} · Available ambulances ${plan.outcome.availableAmbulances} · Pressured/critical hospitals ${plan.outcome.pressuredHospitals}`);
      add(card, 'p', `Network pressure ${plan.outcome.networkPressureLevel} (${Math.round(plan.outcome.networkPressure * 100)}%) · ${plan.outcome.simulationTime}`);
      const hospitals = add(card, 'ul', ''); hospitals.setAttribute('aria-label', `Plan ${plan.id} hospital outcomes`);
      for (const hospital of plan.outcome.hospitals) add(hospitals, 'li', `${hospital.hospitalId}: ED ${hospital.edOccupied}/${hospital.edEffectiveCapacity}, projected ${hospital.projectedDemand}, ${hospital.operationalState}`);
    }
    if (state.comparisonStatus === 'succeeded' && state.comparison) {
      const analysis = add(resultRoot, 'article', '', 'caretwin-analysis');
      add(analysis, 'p', `Gemini comparison · Advisory recommendation: Plan ${state.comparison.recommendedPlan}`, 'caretwin-recommendation');
      add(analysis, 'p', state.comparison.comparisonSummary);
      add(analysis, 'h3', 'Why'); const why = add(analysis, 'ul', ''); for (const item of state.comparison.whyRecommended) add(why, 'li', item);
      add(analysis, 'h3', 'Why Not'); const whyNot = add(analysis, 'ul', '');
      for (const item of state.comparison.whyNotOthers) add(whyNot, 'li', `Plan ${item.planId}: ${item.tradeoff}`);
      add(analysis, 'h3', 'Uncertainty'); const uncertainty = add(analysis, 'ul', '');
      for (const item of [...state.assumptions, ...state.comparison.uncertainty]) add(uncertainty, 'li', item);
      add(analysis, 'h3', 'What would change the recommendation'); const changes = add(analysis, 'ul', '');
      for (const item of state.comparison.whatWouldChangeRecommendation) add(changes, 'li', item);
      if (state.approval?.status === 'pending') {
        const actions = add(analysis, 'div', '', 'caretwin-actions');
        for (const [decision, label] of [['approved', 'Approve'], ['rejected', 'Reject'], ['deferred', 'Defer']]) {
          const button = add(actions, 'button', label); button.type = 'button'; button.disabled = busy;
          button.addEventListener('click', () => void decide(decision));
        }
      } else add(analysis, 'p', `Decision recorded: ${state.approval.status}. No plan was executed.`);
      add(analysis, 'p', 'Approval records an advisory decision only. No routing, ambulance dispatch, hospital handoff, or Computer Use is executed.');
    } else if (state.comparisonStatus === 'pending') add(resultRoot, 'p', 'Gemini is comparing the simulated outcomes…');
    else add(resultRoot, 'p', 'Simulated futures are saved, but Gemini comparison is unavailable. Refresh or generate a new comparison; approval is disabled.');
  }
  async function refresh() {
    try { const response = await request(); state = response.result; render(); message.textContent = state ? 'Saved CareTwin result restored.' : 'Ready to compare simulated plans.'; }
    catch { if (!controller.signal.aborted) message.textContent = 'Saved CareTwin state is unavailable. Refresh to retry.'; }
  }
  async function mutate(path, body, success) {
    if (busy) return; busy = true; render(); message.textContent = 'CareTwin request in progress…';
    try { const response = await request(path, body); state = response.result; render(); message.textContent = success; }
    catch (error) { if (!controller.signal.aborted) message.textContent = error.message; }
    finally { busy = false; render(); }
  }
  async function decide(decision) { await mutate('/decision', { generationId: state.generationId, decision }, 'Advisory decision saved. No plan was executed.'); }
  generateButton.addEventListener('click', () => void mutate('/generate', {}, 'Three simulated futures and Gemini comparison saved.'));
  const evaluateFromForecast = () => { if (!busy) void mutate('/generate', {}, 'CareTwin plans generated from the current M15 baseline.'); };
  window.addEventListener('smartcareops:caretwin:generate', evaluateFromForecast);
  void refresh();
  return () => { window.removeEventListener('smartcareops:caretwin:generate', evaluateFromForecast); controller.abort(); };
}

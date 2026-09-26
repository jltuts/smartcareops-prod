import { createHash } from 'node:crypto';
import { advanceSimulationState } from './engine.js';

export const CARETWIN_HORIZON_TICKS = 6;
const reserveUnit = state => state.ambulances.filter(unit => unit.status === 'available').map(unit => unit.id).sort().at(-1) || null;
const baselineId = state => createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 20);

export function simulationMetrics(state) {
  const hospitals = state.hospitals.map(h => ({ hospitalId: h.id, edOccupied: h.edOccupied, edEffectiveCapacity: h.edEffectiveCapacity,
    edUtilization: h.edUtilization, icuOccupied: h.icuOccupied, icuEffectiveCapacity: h.icuEffectiveCapacity,
    projectedDemand: h.projectedDemand, operationalState: h.operationalState }));
  return {
    simulationTime: state.simulationTime, tick: state.tick,
    ed: { occupied: state.network.totalEdOccupied, effectiveCapacity: state.network.totalEdCapacity },
    icu: { occupied: state.network.totalIcuOccupied, effectiveCapacity: state.network.totalIcuCapacity },
    projectedDemand: state.network.projectedDemand,
    availableAmbulances: state.network.availableAmbulances,
    pressuredHospitals: hospitals.filter(h => ['pressured', 'critical'].includes(h.operationalState)).length,
    networkPressure: state.network.pressure, networkPressureLevel: state.network.pressureLevel,
    hospitals,
  };
}

export function candidatePlanDefinitions(state) {
  const reserveAmbulanceId = reserveUnit(state);
  return [
    { id: 'A', name: 'Continue current allocation', description: 'Continue current M15 synthetic demand allocation and ambulance dispatch rules.', actions: [{ kind: 'baseline' }], policy: {} },
    { id: 'B', name: 'Redistribute one demand unit', description: 'Each five-minute tick, shift one synthetic demand unit from the highest-utilization hospital to the lowest-utilization alternate with headroom.', actions: [{ kind: 'redistribute', unitsPerTick: 1 }], policy: { redistributeArrivalsPerTick: 1 } },
    { id: 'C', name: 'Redistribute and hold reserve', description: 'Each five-minute tick, shift up to two synthetic demand units by the same rule and keep one currently available ambulance out of automatic assignment.', actions: [
      { kind: 'redistribute', unitsPerTick: 2 }, ...(reserveAmbulanceId ? [{ kind: 'reserve_ambulance', ambulanceId: reserveAmbulanceId }] : [{ kind: 'reserve_ambulance', unavailable: true }]),
    ], policy: { redistributeArrivalsPerTick: 2, ...(reserveAmbulanceId ? { reserveAmbulanceId } : {}) } },
  ];
}

export function simulateCandidatePlans(baseline, { horizonTicks = CARETWIN_HORIZON_TICKS } = {}) {
  if (!Number.isInteger(horizonTicks) || horizonTicks < 1 || horizonTicks > 12) throw new RangeError('INVALID_CARETWIN_HORIZON');
  const initial = structuredClone(baseline), id = baselineId(initial);
  const plans = candidatePlanDefinitions(initial).map(plan => {
    const start = structuredClone(initial);
    const outcomeState = advanceSimulationState(start, horizonTicks, plan.policy);
    return { id: plan.id, name: plan.name, description: plan.description, actions: structuredClone(plan.actions),
      baselineId: id, outcome: simulationMetrics(outcomeState) };
  });
  return {
    baselineId: id,
    baseline: { scenario: initial.scenario, scenarioName: initial.scenarioName, simulationTime: initial.simulationTime, tick: initial.tick, metrics: simulationMetrics(initial) },
    horizonMinutes: horizonTicks * initial.tickMinutes,
    plans,
    assumptions: ['Demand redistribution applies only to fictional M15 synthetic arrivals and preserves total arrivals.', 'No patient-specific suitability, route time, or admission capability is modeled.', ...(plans[2].actions.some(action => action.kind === 'reserve_ambulance' && action.unavailable) ? ['No currently available ambulance could be held in reserve at the baseline.'] : [])],
  };
}

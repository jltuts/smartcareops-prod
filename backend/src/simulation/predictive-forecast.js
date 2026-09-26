import { createHash } from 'node:crypto';
import { advanceSimulationState } from './engine.js';
import { simulationMetrics } from './caretwin-plans.js';

export const FORECAST_HORIZONS = Object.freeze([30, 60, 120]);
const baselineId = state => createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 20);

function forecastMetrics(state) {
  const metrics = simulationMetrics(state);
  return {
    ...metrics,
    fleetSize: state.ambulances.length,
    icuUtilization: metrics.icu.effectiveCapacity ? Math.round(metrics.icu.occupied / metrics.icu.effectiveCapacity * 100) / 100 : 1,
    staffingPressure: state.hospitals.map(hospital => ({ hospitalId: hospital.id, pressure: hospital.staffingPressure })),
    hospitals: metrics.hospitals.map((hospital, index) => ({ ...hospital,
      icuUtilization: state.hospitals[index].icuUtilization, staffingPressure: state.hospitals[index].staffingPressure })),
  };
}

function deriveBottlenecks(baseline, horizons) {
  const risks = [];
  for (let index = 0; index < baseline.hospitals.length; index++) {
    const initial = baseline.hospitals[index];
    const projections = horizons.map(horizon => ({ minutes: horizon.minutes, hospital: horizon.metrics.hospitals[index] }));
    const pressureStates = initial.operationalState === 'critical' ? [] : initial.operationalState === 'pressured' ? ['critical'] : ['pressured', 'critical'];
    const firstPressure = projections.find(({ hospital }) => pressureStates.includes(hospital.operationalState));
    if (firstPressure) {
      risks.push({ resource: `${initial.hospitalId} ED`, facilityId: initial.hospitalId, horizonMinutes: firstPressure.minutes,
        severity: firstPressure.hospital.operationalState, evidence: { edOccupied: firstPressure.hospital.edOccupied,
          edCapacity: firstPressure.hospital.edEffectiveCapacity, edUtilization: firstPressure.hospital.edUtilization,
          projectedDemand: firstPressure.hospital.projectedDemand, staffingPressure: firstPressure.hospital.staffingPressure } });
    } else if (initial.operationalState === 'critical') {
      risks.push({ resource: `${initial.hospitalId} ED`, facilityId: initial.hospitalId, horizonMinutes: 0, severity: 'critical',
        evidence: { edOccupied: initial.edOccupied, edCapacity: initial.edEffectiveCapacity, edUtilization: initial.edUtilization,
          projectedDemand: initial.projectedDemand, staffingPressure: initial.staffingPressure } });
    }
    const icuProjection = projections.find(({ hospital }) => hospital.icuEffectiveCapacity > 0 && hospital.icuEffectiveCapacity - hospital.icuOccupied <= Math.max(1, Math.ceil(hospital.icuEffectiveCapacity * 0.15)));
    if (icuProjection && initial.icuEffectiveCapacity - initial.icuOccupied > Math.max(1, Math.ceil(initial.icuEffectiveCapacity * 0.15))) {
      risks.push({ resource: `${initial.hospitalId} ICU reserve`, facilityId: initial.hospitalId, horizonMinutes: icuProjection.minutes,
        severity: 'pressured', evidence: { icuOccupied: icuProjection.hospital.icuOccupied, icuCapacity: icuProjection.hospital.icuEffectiveCapacity,
          remainingBeds: icuProjection.hospital.icuEffectiveCapacity - icuProjection.hospital.icuOccupied } });
    }
  }
  const lowAmbulance = horizons.find(({ metrics }) => metrics.availableAmbulances <= 1);
  if (lowAmbulance && baseline.ambulances.filter(unit => unit.status === 'available').length > 1) {
    risks.push({ resource: 'Ambulance fleet', facilityId: 'network', horizonMinutes: lowAmbulance.minutes, severity: 'pressured',
      evidence: { available: lowAmbulance.metrics.availableAmbulances, fleetSize: baseline.ambulances.length, safeReserve: 1 } });
  }
  return risks.sort((a, b) => a.horizonMinutes - b.horizonMinutes || Number(b.severity === 'critical') - Number(a.severity === 'critical') || a.resource.localeCompare(b.resource));
}

function projectTicks(baseline, ticks) {
  let projected = structuredClone(baseline), remaining = ticks;
  while (remaining > 0) { const steps = Math.min(12, remaining); projected = advanceSimulationState(projected, steps); remaining -= steps; }
  return projected;
}

export function createPredictiveForecast(baseline) {
  const source = structuredClone(baseline), id = baselineId(source);
  const horizons = FORECAST_HORIZONS.map(minutes => {
    const ticks = minutes / source.tickMinutes;
    const projected = projectTicks(source, ticks);
    return { minutes, tick: projected.tick, simulationTime: projected.simulationTime, metrics: forecastMetrics(projected) };
  });
  const bottlenecks = deriveBottlenecks(source, horizons);
  return { baselineId: id, baseline: { scenario: source.scenario, scenarioName: source.scenarioName, tick: source.tick,
      simulationTime: source.simulationTime, metrics: forecastMetrics(source) }, horizons, bottlenecks,
    assumptions: ['All projections use deterministic M15 transitions from the same baseline.', 'The simulation does not model patient-specific suitability, travel time, admission capability, or real facilities.'] };
}

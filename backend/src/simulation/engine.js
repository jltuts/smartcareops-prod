const scenarioIds = Object.freeze(['normal_operations', 'ed_surge', 'respiratory_outbreak', 'capacity_failure']);
const scenarioDefinitions = Object.freeze({
  normal_operations: { title: 'Normal Operations', arrivals: [2, 1, 1], throughput: [2, 1, 1], respiratory: [0, 0, 0], icuAdmissionPulse: 'none' },
  ed_surge: { title: 'ED Surge', arrivals: [6, 4, 3], throughput: [3, 2, 2], respiratory: [0, 0, 0], icuAdmissionPulse: 'rotating' },
  respiratory_outbreak: { title: 'Respiratory Outbreak Simulation', arrivals: [4, 2, 4], throughput: [2, 1, 2], respiratory: [3, 1, 4], icuAdmissionPulse: 'respiratory' },
  capacity_failure: { title: 'Hospital Capacity Failure Simulation', arrivals: [4, 1, 4], throughput: [2, 1, 2], respiratory: [0, 0, 0], icuAdmissionPulse: 'none' },
});
const hospitalDefaults = [
  { id: 'HOSP-001', name: 'Northstar General', location: 'Central District', edCapacity: 100, edOccupied: 62, icuCapacity: 20, icuOccupied: 11, staffingCapacity: 100, specialties: ['emergency medicine', 'cardiology', 'pulmonology'], equipment: ['ventilators', 'monitors'] },
  { id: 'HOSP-002', name: 'Riverside Medical', location: 'East District', edCapacity: 80, edOccupied: 44, icuCapacity: 16, icuOccupied: 9, staffingCapacity: 100, specialties: ['emergency medicine', 'family medicine', 'neurology', 'orthopedics'], equipment: ['monitors', 'imaging'] },
  { id: 'HOSP-003', name: 'Harbor Community Hospital', location: 'South District', edCapacity: 60, edOccupied: 28, icuCapacity: 12, icuOccupied: 6, staffingCapacity: 100, specialties: ['emergency medicine', 'pulmonology'], equipment: ['ventilators', 'monitors'] },
];
const ambulanceDefaults = [
  { id: 'AMB-01', location: 'Central District' }, { id: 'AMB-02', location: 'East District' }, { id: 'AMB-03', location: 'South District' },
];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = n => Math.round(n * 100) / 100;
const utilization = (occupied, capacity) => capacity > 0 ? round(clamp(occupied / capacity, 0, 1)) : 1;
const timeLabel = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const seededOffset = (seed, tick, index) => ((Math.imul((seed >>> 0) ^ Math.imul(tick + 1, 0x45d9f3b), index + 17) >>> 0) % 3) - 1;

function effectiveCapacity(base, factor) { return Math.max(0, Math.floor(base * factor)); }

function scenarioDrivenIcuAdmission(pulse, tick, hospitalIndex) {
  if (tick % 3 !== 0) return 0;
  if (pulse === 'rotating') return hospitalIndex === (Math.floor(tick / 3) - 1) % hospitalDefaults.length ? 1 : 0;
  if (pulse === 'respiratory' && (hospitalIndex === 0 || hospitalIndex === 2)) return tick >= 12 ? 2 : 1;
  return 0;
}

export function createInitialSimulationState({ scenario = 'normal_operations', seed = 2026 } = {}) {
  if (!scenarioIds.includes(scenario)) throw new RangeError('INVALID_SIMULATION_SCENARIO');
  const failure = scenario === 'capacity_failure';
  const hospitals = hospitalDefaults.map(item => {
    const affected = failure && item.id === 'HOSP-002', capacityFactor = affected ? 0.65 : 1;
    const edEffectiveCapacity = effectiveCapacity(item.edCapacity, capacityFactor), icuEffectiveCapacity = effectiveCapacity(item.icuCapacity, capacityFactor);
    return {
      ...structuredClone(item), edEffectiveCapacity, edOccupied: Math.min(item.edOccupied, edEffectiveCapacity), edUtilization: utilization(Math.min(item.edOccupied, edEffectiveCapacity), edEffectiveCapacity),
      icuEffectiveCapacity, icuOccupied: Math.min(item.icuOccupied, icuEffectiveCapacity), icuUtilization: utilization(Math.min(item.icuOccupied, icuEffectiveCapacity), icuEffectiveCapacity),
      staffingEffectiveCapacity: affected ? 65 : 100, staffingPressure: affected ? 0.88 : 0.42,
      respiratoryDemand: 0, respiratoryResourcePressure: 0.25, incomingDemand: 0, projectedDemand: 0,
      operationalState: affected ? 'degraded' : 'normal',
    };
  });
  const state = {
    scenario, scenarioName: scenarioDefinitions[scenario].title, seed: seed >>> 0, tick: 0, tickMinutes: 5, simulationTime: '10:30',
    hospitals,
    ambulances: ambulanceDefaults.map(unit => ({ ...unit, status: 'available', assignment: null, estimatedAvailability: null, availableAtTick: null })),
    network: {},
  };
  return withNetwork(state);
}

function withNetwork(state) {
  const totalEdCapacity = state.hospitals.reduce((sum, h) => sum + h.edEffectiveCapacity, 0);
  const totalEdOccupied = state.hospitals.reduce((sum, h) => sum + h.edOccupied, 0);
  const totalIcuCapacity = state.hospitals.reduce((sum, h) => sum + h.icuEffectiveCapacity, 0);
  const totalIcuOccupied = state.hospitals.reduce((sum, h) => sum + h.icuOccupied, 0);
  const totalIncomingDemand = state.hospitals.reduce((sum, h) => sum + h.incomingDemand, 0);
  const projectedDemand = state.hospitals.reduce((sum, h) => sum + h.projectedDemand, 0);
  const pressure = Math.max(totalEdCapacity ? totalEdOccupied / totalEdCapacity : 1, totalIcuCapacity ? totalIcuOccupied / totalIcuCapacity : 1,
    ...state.hospitals.map(h => h.staffingPressure));
  state.network = {
    totalEdCapacity, totalEdOccupied, totalIcuCapacity, totalIcuOccupied,
    availableAmbulances: state.ambulances.filter(unit => unit.status === 'available').length,
    fleetSize: state.ambulances.length, incomingDemand: totalIncomingDemand, projectedDemand,
    demandTrend: state.scenario === 'normal_operations' ? 'stable' : 'increasing',
    pressure: round(clamp(pressure, 0, 1)),
    pressureLevel: pressure >= 0.9 ? 'critical' : pressure >= 0.72 ? 'pressured' : 'normal',
  };
  return state;
}

function advanceOne(state, policy = {}) {
  const next = structuredClone(state), definition = scenarioDefinitions[next.scenario];
  next.tick += 1; next.simulationTime = timeLabel(630 + next.tick * next.tickMinutes);
  const failure = next.scenario === 'capacity_failure';
  const projectedAdds = next.scenario === 'ed_surge' ? [3, 2, 2] : next.scenario === 'respiratory_outbreak' ? [2, 1, 3] : failure ? [3, 2, 3] : [0, 0, 0];
  const transportedArrivals = new Map();
  for (const unit of next.ambulances) {
    if (unit.status === 'dispatched' && unit.assignment?.assignedAtTick < next.tick) unit.status = 'transporting';
    if (unit.status === 'transporting' && unit.assignment?.arrivesAtTick === next.tick) {
      transportedArrivals.set(unit.assignment.destination, (transportedArrivals.get(unit.assignment.destination) || 0) + 1);
      unit.status = 'at_hospital';
    } else if (unit.status === 'at_hospital' && next.tick >= unit.availableAtTick) {
      unit.status = 'available'; unit.location = unit.assignment.destination; unit.assignment = null; unit.estimatedAvailability = null; unit.availableAtTick = null;
    }
  }
  const demandArrivals = next.hospitals.map((h, i) => {
    const redistributed = failure && h.id !== 'HOSP-002' ? 2 : 0;
    const variation = next.scenario === 'normal_operations' ? seededOffset(next.seed, next.tick, i) : 0;
    return Math.max(0, definition.arrivals[i] + variation + redistributed);
  });
  for (let move = 0; move < (policy.redistributeArrivalsPerTick || 0); move++) {
    const sources = next.hospitals.map((h, i) => ({ h, i })).filter(({ i }) => demandArrivals[i] > 0)
      .sort((a, b) => b.h.edUtilization - a.h.edUtilization || a.h.id.localeCompare(b.h.id));
    const source = sources[0];
    const destinations = next.hospitals.map((h, i) => ({ h, i })).filter(({ h, i }) => i !== source?.i && h.edOccupied < h.edEffectiveCapacity)
      .sort((a, b) => a.h.edUtilization - b.h.edUtilization || a.h.id.localeCompare(b.h.id));
    const destination = destinations[0];
    if (!source || !destination) break;
    demandArrivals[source.i] -= 1; demandArrivals[destination.i] += 1;
  }
  for (let i = 0; i < next.hospitals.length; i++) {
    const h = next.hospitals[i], affected = failure && h.id === 'HOSP-002';
    const arrivals = demandArrivals[i] + (transportedArrivals.get(h.id) || 0);
    const edThroughput = Math.max(0, definition.throughput[i]);
    const respiratoryArrivals = definition.respiratory[i] + (next.scenario === 'respiratory_outbreak' ? Math.max(0, Math.floor(next.tick / 3)) : 0);
    // Routine synthetic ICU turnover is one paired admission/discharge every
    // 30 simulated minutes. Scenario surges add bounded aggregate admissions;
    // no diagnosis or patient-level data participates in this model.
    const routineIcuTurnover = next.tick % 6 === 0 ? 1 : 0;
    const icuDischarges = Math.min(h.icuOccupied, routineIcuTurnover);
    const icuAdmissions = routineIcuTurnover + scenarioDrivenIcuAdmission(definition.icuAdmissionPulse, next.tick, i);
    h.incomingDemand = arrivals;
    h.projectedDemand = arrivals + projectedAdds[i];
    h.respiratoryDemand = respiratoryArrivals;
    h.edOccupied = clamp(h.edOccupied + arrivals - edThroughput, 0, h.edEffectiveCapacity);
    h.icuOccupied = clamp(h.icuOccupied + icuAdmissions - icuDischarges, 0, h.icuEffectiveCapacity);
    h.edUtilization = utilization(h.edOccupied, h.edEffectiveCapacity);
    h.icuUtilization = utilization(h.icuOccupied, h.icuEffectiveCapacity);
    h.staffingPressure = affected ? 0.88 : round(clamp(0.35 + h.edUtilization * 0.35 + h.icuUtilization * 0.3 + (respiratoryArrivals ? 0.08 : 0), 0, 1));
    h.respiratoryResourcePressure = round(clamp(0.2 + respiratoryArrivals * 0.12 + h.icuUtilization * 0.35, 0, 1));
    h.operationalState = affected ? 'degraded' : Math.max(h.edUtilization, h.icuUtilization, h.staffingPressure) >= 0.9 ? 'critical' : Math.max(h.edUtilization, h.icuUtilization, h.staffingPressure) >= 0.72 ? 'pressured' : 'normal';
  }
  const unit = next.ambulances.find(item => item.status === 'available' && item.id !== policy.reserveAmbulanceId);
  if (unit && next.scenario !== 'normal_operations' && next.tick % 4 === 1) {
    const destination = [...next.hospitals].filter(h => !(failure && h.id === 'HOSP-002')).sort((a, b) => b.projectedDemand - a.projectedDemand || a.id.localeCompare(b.id))[0];
    unit.status = 'dispatched'; unit.assignment = { destination: destination.id, assignedAtTick: next.tick, arrivesAtTick: next.tick + 2 };
    unit.availableAtTick = next.tick + 3; unit.estimatedAvailability = timeLabel(630 + unit.availableAtTick * next.tickMinutes);
  }
  return withNetwork(next);
}

export function advanceSimulationState(state, steps = 1, policy = {}) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 12) throw new RangeError('INVALID_SIMULATION_STEPS');
  if (!policy || typeof policy !== 'object' || !Number.isInteger(policy.redistributeArrivalsPerTick || 0) || (policy.redistributeArrivalsPerTick || 0) < 0 || (policy.redistributeArrivalsPerTick || 0) > 2) throw new RangeError('INVALID_SIMULATION_POLICY');
  let next = structuredClone(state);
  for (let i = 0; i < steps; i++) next = advanceOne(next, policy);
  return next;
}

export const isSimulationScenario = value => scenarioIds.includes(value);
export const simulationScenarios = () => scenarioIds.map(id => ({ id, name: scenarioDefinitions[id].title }));
export const resetSimulationState = state => createInitialSimulationState({ scenario: state.scenario, seed: state.seed });
export function publicSimulationState(state) { return structuredClone(state); }

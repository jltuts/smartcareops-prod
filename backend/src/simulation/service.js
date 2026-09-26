import { advanceSimulationState, createInitialSimulationState, isSimulationScenario, publicSimulationState, resetSimulationState } from './engine.js';

export class SimulationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function createSimulationService(store) {
  return {
    async view() { return publicSimulationState(await store.get()); },
    async advance(steps = 1) {
      if (!Number.isInteger(steps) || steps < 1 || steps > 12) throw new SimulationError('INVALID_SIMULATION_STEPS');
      return publicSimulationState(await store.transact(state => advanceSimulationState(state, steps)));
    },
    async reset() { return publicSimulationState(await store.transact(resetSimulationState)); },
    async selectScenario(scenario) {
      if (!isSimulationScenario(scenario)) throw new SimulationError('INVALID_SIMULATION_SCENARIO');
      return publicSimulationState(await store.transact(state => createInitialSimulationState({ scenario, seed: state.seed })));
    },
    close: () => store.close?.(),
  };
}

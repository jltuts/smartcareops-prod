import { randomUUID } from 'node:crypto';
import { createPredictiveForecast } from './predictive-forecast.js';
import { createPredictiveModel } from './predictive-model.js';

export class PredictiveError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
export function createPredictiveService({ simulationStore, store, interpret = createPredictiveModel(), now = Date.now } = {}) {
  if (!simulationStore || !store) throw new TypeError('PREDICTIVE_STORES_REQUIRED');
  return {
    async view() { return store.get(); },
    async generate(signal) {
      let forecast;
      try { forecast = createPredictiveForecast(await simulationStore.get()); }
      catch { throw new PredictiveError('SIMULATION_UNAVAILABLE', 503); }
      const result = { ...forecast, forecastId: randomUUID(), generatedAt: new Date(now()).toISOString(), interpretationStatus: 'pending', interpretation: null };
      await store.save(result);
      try {
        const interpretation = await interpret({ baseline: forecast.baseline, horizons: forecast.horizons, bottlenecks: forecast.bottlenecks, assumptions: forecast.assumptions }, signal);
        if (interpretation.topBottleneck !== 'No significant bottleneck identified' && !forecast.bottlenecks.some(item => item.resource === interpretation.topBottleneck)) throw new Error('UNSUPPORTED_PREDICTED_BOTTLENECK');
        Object.assign(result, { interpretationStatus: 'succeeded', interpretation });
      } catch { Object.assign(result, { interpretationStatus: 'unavailable', interpretation: null }); }
      await store.save(result);
      return structuredClone(result);
    },
    close: async () => { await store.close?.(); },
  };
}

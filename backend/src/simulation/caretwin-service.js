import { randomUUID } from 'node:crypto';
import { simulateCandidatePlans } from './caretwin-plans.js';
import { createCareTwinModel } from './caretwin-model.js';
import { CareTwinStoreError } from './caretwin-store.js';

export class CareTwinError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

const publicResult = value => {
  if (!value) return null;
  const { reviewerUid, ...approval } = value.approval;
  return { ...structuredClone(value), approval };
};

export function createCareTwinService({ simulationStore, store, compare = createCareTwinModel(), now = Date.now } = {}) {
  if (!simulationStore || !store) throw new TypeError('CARETWIN_STORES_REQUIRED');
  async function view() { return publicResult(await store.get()); }
  async function generate(signal) {
    let forecast;
    try { forecast = simulateCandidatePlans(await simulationStore.get()); }
    catch { throw new CareTwinError('SIMULATION_UNAVAILABLE', 503); }
    const generationId = randomUUID();
    const createdAt = new Date(now()).toISOString();
    let result = {
      generationId, baselineId: forecast.baselineId, baseline: forecast.baseline, horizonMinutes: forecast.horizonMinutes,
      plans: forecast.plans, assumptions: forecast.assumptions,
      comparisonStatus: 'pending', comparison: null, approval: { required: true, status: 'pending', reviewerUid: null, decidedAt: null }, createdAt,
    };
    await store.save(result);
    try {
      const comparison = await compare({ baseline: forecast.baseline, horizonMinutes: forecast.horizonMinutes, assumptions: forecast.assumptions, plans: forecast.plans }, signal);
      result = await store.update(generationId, current => ({ ...current, comparisonStatus: 'succeeded', comparison, comparedAt: new Date(now()).toISOString() }));
    } catch {
      try { result = await store.update(generationId, current => ({ ...current, comparisonStatus: 'unavailable', comparison: null, comparisonError: 'MODEL_UNAVAILABLE', comparedAt: new Date(now()).toISOString() })); }
      catch (error) { if (error instanceof CareTwinStoreError) throw error; throw new CareTwinError('CARETWIN_STORE_UNAVAILABLE', 503); }
    }
    return publicResult(result);
  }
  async function decide(generationId, decision, reviewerUid) {
    if (typeof generationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(generationId) || !['approved', 'rejected', 'deferred'].includes(decision) || typeof reviewerUid !== 'string' || !reviewerUid) throw new CareTwinError('INVALID_CARETWIN_DECISION');
    try {
      const result = await store.update(generationId, current => {
        if (current.comparisonStatus !== 'succeeded' || !current.comparison?.recommendedPlan) throw new CareTwinError('CARETWIN_RECOMMENDATION_REQUIRED', 409);
        if (current.approval.status === decision && current.approval.reviewerUid === reviewerUid) return current;
        if (current.approval.status !== 'pending') throw new CareTwinError('CARETWIN_DECISION_ALREADY_RECORDED', 409);
        return { ...current, approval: { required: true, status: decision, reviewerUid, decidedAt: new Date(now()).toISOString() } };
      });
      return publicResult(result);
    } catch (error) {
      if (error instanceof CareTwinError || error instanceof CareTwinStoreError) throw error;
      throw new CareTwinError('CARETWIN_STORE_UNAVAILABLE', 503);
    }
  }
  return { view, generate, decide, close: async () => { await store.close?.(); } };
}

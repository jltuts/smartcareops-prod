import { ClinicalError } from '../clinical/contracts.js';

const bool = value => value === true || value === 'true';
const caseIdPattern = /^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const assessmentSources = new WeakMap();

const sourced = (assessment, source) => {
  if (assessment && typeof assessment === 'object') assessmentSources.set(assessment, source);
  return assessment;
};

export function clinicalAssessmentSource(assessment) {
  return assessment && typeof assessment === 'object' ? assessmentSources.get(assessment) || null : null;
}

export function clinicalAgentMode(env = process.env) {
  const mode = env.M60_CLINICAL_AGENT_MODE || 'off';
  if (!['off', 'shadow', 'review'].includes(mode)) throw new ClinicalError('M60_MODE_INVALID', 500);
  if (mode === 'shadow' && !(bool(env.M60_GATE_C_ACCEPTED) && bool(env.M60_GATE_D_ACCEPTED)))
    throw new ClinicalError('M60_SHADOW_GATES_REQUIRED', 503);
  if (mode === 'review' && !(bool(env.M60_GATE_C_ACCEPTED) && bool(env.M60_GATE_D_ACCEPTED) && bool(env.M60_REVIEW_CUTOVER_APPROVED))) {
    throw new ClinicalError('M60_REVIEW_CUTOVER_NOT_APPROVED', 503);
  }
  return mode;
}

export function clinicalShadowCohort(env = process.env) {
  if (!['shadow', 'review'].includes(clinicalAgentMode(env))) return null;
  const caseIds = String(env.M60_SHADOW_CASE_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  const startAt = Date.parse(env.M60_SHADOW_START_AT || ''), endAt = Date.parse(env.M60_SHADOW_END_AT || '');
  if (caseIds.length < 1 || caseIds.length > 10 || new Set(caseIds).size !== caseIds.length || !caseIds.every(value => caseIdPattern.test(value)))
    throw new ClinicalError('M60_SHADOW_COHORT_INVALID', 503);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt || endAt - startAt > 24 * 60 * 60 * 1000)
    throw new ClinicalError('M60_SHADOW_WINDOW_INVALID', 503);
  return Object.freeze({ caseIds: new Set(caseIds), startAt, endAt });
}

export function createClinicalModelCutover({ currentModel, managedModel, env = process.env, recordTelemetry = async () => {}, now = Date.now } = {}) {
  if (typeof currentModel !== 'function' || typeof recordTelemetry !== 'function') throw new TypeError('M60_CUTOVER_CONFIGURATION_REQUIRED');
  if (typeof now !== 'function') throw new TypeError('M60_CUTOVER_CLOCK_REQUIRED');
  const mode = clinicalAgentMode(env);
  const cohort = mode === 'off' ? null : clinicalShadowCohort(env);
  if (mode !== 'off' && typeof managedModel !== 'function') throw new ClinicalError('M60_MANAGED_MODEL_UNAVAILABLE', 503);
  if (mode === 'off') return currentModel;
  const telemetry = async event => { try { await recordTelemetry(event); } catch { /* Telemetry cannot affect the clinical result. */ } };
  return async (context, signal) => {
    const timestamp = now();
    if (!cohort.caseIds.has(context?.caseId) || timestamp < cohort.startAt || timestamp >= cohort.endAt)
      return sourced(await currentModel(context, signal), 'gemini-api');
    if (mode === 'shadow') {
      const managedContext = structuredClone(context), startedAt = now();
      const current = await currentModel(context, signal);
      try {
        await managedModel(managedContext, signal);
        await telemetry({ mode, status: 'shadow_validated', caseId: context.caseId, durationMs: Math.max(0, now() - startedAt) });
      } catch {
        await telemetry({ mode, status: 'shadow_failed', caseId: context.caseId, durationMs: Math.max(0, now() - startedAt) });
      }
      return sourced(current, 'gemini-api');
    }
    const startedAt = now();
    try {
      const result = await managedModel(context, signal);
      await telemetry({ mode, status: 'managed_selected', caseId: context.caseId, durationMs: Math.max(0, now() - startedAt) });
      return sourced(result, 'gemini-enterprise-agent-platform');
    } catch {
      await telemetry({ mode, status: 'rollback_current', caseId: context.caseId, durationMs: Math.max(0, now() - startedAt) });
      return sourced(await currentModel(context, signal), 'gemini-api-fallback');
    }
  };
}

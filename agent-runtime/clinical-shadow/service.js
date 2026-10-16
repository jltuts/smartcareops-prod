import { createClinicalAdkInvoker } from '../../backend/src/agent-platform/clinical-adk-runtime.js';
import { createClinicalShadowAdapter } from '../../backend/src/agent-platform/clinical-shadow.js';
import { readManagedFixture } from './fixtures.js';

export const managedEvaluationVersion = 'm60-managed-v1';
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export class ManagedShadowError extends Error {
  constructor(code = 'MANAGED_SHADOW_UNAVAILABLE', status = 503) {
    super('Managed fictional shadow evaluation unavailable.');
    this.code = code;
    this.status = status;
  }
}

const validateInput = input => {
  if (!exact(input, ['fixtureId', 'requestId', 'evaluationVersion']) || !token(input.fixtureId) || !token(input.requestId) ||
      input.evaluationVersion !== managedEvaluationVersion) throw new ManagedShadowError('INVALID_MANAGED_SHADOW_REQUEST', 400);
  const fixture = readManagedFixture(input.fixtureId);
  if (!fixture) throw new ManagedShadowError('MANAGED_SHADOW_FIXTURE_NOT_ALLOWED', 400);
  return { fixtureId: input.fixtureId, requestId: input.requestId, fixture };
};

const safeError = error => error instanceof ManagedShadowError ? error : new ManagedShadowError(
  typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'MANAGED_SHADOW_UNAVAILABLE',
  Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503,
);

export function createManagedClinicalShadowService({ invokeAgent, recordTelemetry = async () => {}, timeoutMs = 60_000 } = {}) {
  if (invokeAgent !== undefined && typeof invokeAgent !== 'function') throw new TypeError('MANAGED_SHADOW_INVOKER_INVALID');
  if (typeof recordTelemetry !== 'function') throw new TypeError('MANAGED_SHADOW_TELEMETRY_INVALID');
  const modelMetrics = new Map();
  const agentInvoker = invokeAgent || createClinicalAdkInvoker({ recordMetrics: async metrics => {
    modelMetrics.set(metrics.requestId, { model: metrics.model, durationMs: metrics.durationMs, eventCount: metrics.eventCount,
      attempts: metrics.attempts, inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens,
      thinkingTokens: metrics.thinkingTokens, totalTokens: metrics.totalTokens });
  }, recordFailure: async failure => recordTelemetry({ requestId: failure.requestId, status: 'agent_attempt_failed',
    model: failure.model, attempt: failure.attempt, failureStage: failure.failureStage, final: failure.final }) });
  const requests = new Map();
  const adapters = new Map();

  const adapterFor = (fixtureId, fixture) => {
    if (!adapters.has(fixtureId)) adapters.set(fixtureId, createClinicalShadowAdapter({
      readCaseEvidence: async () => structuredClone(fixture.evidence),
      readVerifiedLab: async () => {
        if (!fixture.lab) throw new ManagedShadowError('MANAGED_SHADOW_LAB_NOT_AVAILABLE', 409);
        return structuredClone(fixture.lab);
      },
      retrievePolicy: async () => structuredClone(fixture.policy),
      invokeAgent: agentInvoker,
      timeoutMs,
      recordTelemetry: async event => recordTelemetry({ requestId: event.requestId, fixtureId, status: event.status,
        durationMs: event.durationMs, toolNames: event.toolNames, ...(event.errorCode ? { errorCode: event.errorCode } : {}) }),
    }));
    return adapters.get(fixtureId);
  };

  return {
    async query(input) {
      const { fixtureId, requestId, fixture } = validateInput(input);
      const priorFixture = requests.get(requestId);
      if (priorFixture && priorFixture !== fixtureId) throw new ManagedShadowError('MANAGED_SHADOW_IDEMPOTENCY_CONFLICT', 409);
      requests.set(requestId, fixtureId);
      try {
        const result = await adapterFor(fixtureId, fixture).run({ ...fixture.binding, requestId });
        const metrics = modelMetrics.get(requestId) || null;
        return { evaluationVersion: managedEvaluationVersion, fixtureId, requestId, status: result.status,
          publishable: false, assessment: result.assessment, evidenceRefs: result.evidenceRefs, toolCalls: result.toolCalls, metrics };
      } catch (error) {
        throw safeError(error);
      }
    },
  };
}

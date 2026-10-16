import { createClinicalAdkInvoker } from '../../backend/src/agent-platform/clinical-adk-runtime.js';
import { createClinicalShadowAdapter } from '../../backend/src/agent-platform/clinical-shadow.js';
import { canonicalDigest } from '../../backend/src/clinical/contracts.js';

export const managedApplicationVersion = 'm60-application-shadow-v1';
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export class ManagedApplicationError extends Error {
  constructor(code = 'MANAGED_APPLICATION_UNAVAILABLE', status = 503) {
    super('Managed application shadow unavailable.'); this.code = code; this.status = status;
  }
}
const requireApplication = (condition, code = 'INVALID_MANAGED_APPLICATION_REQUEST', status = 400) => {
  if (!condition) throw new ManagedApplicationError(code, status);
};

function validateInput(input) {
  requireApplication(exact(input, ['integrationVersion', 'binding', 'evidence']) && input.integrationVersion === managedApplicationVersion);
  const { binding, evidence } = input;
  requireApplication(exact(binding, ['requestId', 'caseId', 'evidenceVersion', 'evidenceDigest', 'labBinding', 'policyVersion', 'policyManifestDigest']));
  requireApplication(token(binding.requestId) && Number.isInteger(binding.evidenceVersion) && binding.evidenceVersion >= 0 &&
    sha256(binding.evidenceDigest) && typeof binding.policyVersion === 'string' && binding.policyVersion.length > 0 &&
    binding.policyVersion.length <= 80 && sha256(binding.policyManifestDigest));
  requireApplication(evidence && typeof evidence === 'object' && !Array.isArray(evidence) && evidence.caseId === binding.caseId &&
    evidence.evidenceVersion === binding.evidenceVersion && Array.isArray(evidence.evidenceRefs) && evidence.evidenceRefs.length > 0 &&
    evidence.evidenceRefs.length <= 80 && evidence.evidenceRefs.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 160) &&
    evidence.context?.caseId === binding.caseId && evidence.context?.observationVersion === binding.evidenceVersion &&
    canonicalDigest(evidence) === binding.evidenceDigest, 'MANAGED_APPLICATION_EVIDENCE_INVALID', 409);
  const expectedRequestId = `m60_${canonicalDigest({ caseId: binding.caseId, evidenceVersion: binding.evidenceVersion,
    evidenceDigest: binding.evidenceDigest, labBinding: binding.labBinding, policyVersion: binding.policyVersion,
    policyManifestDigest: binding.policyManifestDigest }).slice(0, 48)}`;
  requireApplication(binding.requestId === expectedRequestId, 'MANAGED_APPLICATION_BINDING_INVALID', 409);
  if (binding.labBinding !== null) {
    requireApplication(exact(binding.labBinding, ['reportId', 'revision', 'evidenceDigest']) &&
      Number.isInteger(binding.labBinding.revision) && binding.labBinding.revision > 0 && sha256(binding.labBinding.evidenceDigest));
    const lab = evidence.context.verifiedLabReport;
    requireApplication(lab?.reportId === binding.labBinding.reportId && lab?.revision === binding.labBinding.revision &&
      lab?.evidenceDigest === binding.labBinding.evidenceDigest, 'MANAGED_APPLICATION_LAB_INVALID', 409);
  }
  requireApplication(Buffer.byteLength(JSON.stringify(input)) <= 64 * 1024, 'MANAGED_APPLICATION_BODY_TOO_LARGE', 413);
  return { binding: structuredClone(binding), evidence: structuredClone(evidence) };
}

const safeError = error => error instanceof ManagedApplicationError ? error : new ManagedApplicationError(
  typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'MANAGED_APPLICATION_UNAVAILABLE',
  Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503);

export function createManagedApplicationService({ invokeAgent, retrievePolicy, recordTelemetry = async () => {}, timeoutMs = 60_000 } = {}) {
  if (invokeAgent !== undefined && typeof invokeAgent !== 'function') throw new TypeError('MANAGED_APPLICATION_INVOKER_INVALID');
  if (typeof retrievePolicy !== 'function' || typeof recordTelemetry !== 'function') throw new TypeError('MANAGED_APPLICATION_CONFIGURATION_INVALID');
  const agentInvoker = invokeAgent || createClinicalAdkInvoker({ recordFailure: async failure => recordTelemetry({
    requestId: failure.requestId, status: 'agent_attempt_failed', attempt: failure.attempt, failureStage: failure.failureStage, final: failure.final }) });

  return {
    async query(input) {
      const { binding, evidence } = validateInput(input);
      const adapter = createClinicalShadowAdapter({
        readCaseEvidence: async () => structuredClone(evidence),
        readVerifiedLab: async () => {
          if (!binding.labBinding) throw new ManagedApplicationError('MANAGED_APPLICATION_LAB_NOT_BOUND', 409);
          return structuredClone(evidence.context.verifiedLabReport);
        },
        retrievePolicy: async ({ query }) => retrievePolicy({ query, binding: structuredClone(binding) }),
        invokeAgent: agentInvoker, timeoutMs,
        recordTelemetry: async event => recordTelemetry({ requestId: event.requestId, status: event.status,
          durationMs: event.durationMs, toolNames: event.toolNames, ...(event.errorCode ? { errorCode: event.errorCode } : {}) }),
      });
      try {
        const result = await adapter.run({ requestId: binding.requestId, caseId: binding.caseId,
          evidenceVersion: binding.evidenceVersion, labBinding: binding.labBinding, policyVersion: binding.policyVersion });
        return { integrationVersion: managedApplicationVersion, requestId: binding.requestId,
          evidenceDigest: binding.evidenceDigest, status: result.status, publishable: false,
          assessment: result.assessment, evidenceRefs: result.evidenceRefs, toolCalls: result.toolCalls };
      } catch (error) { throw safeError(error); }
    },
  };
}

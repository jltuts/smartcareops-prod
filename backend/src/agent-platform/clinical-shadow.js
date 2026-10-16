import { ClinicalError, digest, exact, textValue, token, validateAssessment } from '../clinical/contracts.js';

export const clinicalShadowToolNames = Object.freeze([
  'get_case_evidence',
  'get_verified_lab_revision',
  'retrieve_approved_policy',
]);
export const clinicalShadowRecommendedActions = Object.freeze(['read_case', 'read_observation_history', 'evaluate_safety']);
const reportIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validCaseId = value => typeof value === 'string' && /^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

const requireShadow = (condition, code = 'INVALID_CLINICAL_SHADOW_REQUEST', status = 400) => {
  if (!condition) throw new ClinicalError(code, status);
};

const exactEmpty = value => exact(value, []);
const boundedQuery = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 300;
const safeFailure = error => {
  if (error instanceof ClinicalError) return error;
  const failure = new ClinicalError(error?.name === 'TimeoutError' ? 'CLINICAL_SHADOW_TIMEOUT' : 'CLINICAL_SHADOW_UNAVAILABLE', 503);
  failure.cause = undefined;
  return failure;
};

function validateBinding(binding) {
  const required = ['requestId', 'caseId', 'evidenceVersion', 'labBinding'];
  requireShadow(binding && typeof binding === 'object' && !Array.isArray(binding) &&
    required.every(key => Object.hasOwn(binding, key)) &&
    Object.keys(binding).every(key => [...required, 'policyVersion'].includes(key)));
  requireShadow(token(binding.requestId) && validCaseId(binding.caseId));
  requireShadow(Number.isInteger(binding.evidenceVersion) && binding.evidenceVersion >= 0);
  requireShadow(binding.policyVersion === undefined || binding.policyVersion === null || textValue(binding.policyVersion, 80));
  if (binding.labBinding !== null) {
    exact(binding.labBinding, ['reportId', 'revision', 'evidenceDigest']);
    requireShadow(typeof binding.labBinding.reportId === 'string' && reportIdPattern.test(binding.labBinding.reportId));
    requireShadow(Number.isInteger(binding.labBinding.revision) && binding.labBinding.revision > 0);
    requireShadow(typeof binding.labBinding.evidenceDigest === 'string' && /^[0-9a-f]{64}$/.test(binding.labBinding.evidenceDigest));
  }
  return { ...structuredClone(binding), policyVersion: binding.policyVersion ?? null };
}

function validateCaseEvidence(value, binding) {
  requireShadow(value && typeof value === 'object' && !Array.isArray(value), 'CLINICAL_SHADOW_EVIDENCE_UNAVAILABLE', 503);
  requireShadow(value.caseId === binding.caseId && value.evidenceVersion === binding.evidenceVersion, 'CLINICAL_SHADOW_EVIDENCE_STALE', 409);
  requireShadow(Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0 && value.evidenceRefs.every(ref => textValue(ref, 160)), 'CLINICAL_SHADOW_EVIDENCE_UNAVAILABLE', 503);
  return structuredClone(value);
}

function validateLabEvidence(value, binding) {
  const expected = binding.labBinding;
  requireShadow(expected && value && typeof value === 'object' && !Array.isArray(value), 'CLINICAL_SHADOW_LAB_UNAVAILABLE', 409);
  requireShadow(value.reportId === expected.reportId && value.revision === expected.revision && value.evidenceDigest === expected.evidenceDigest,
    'CLINICAL_SHADOW_LAB_STALE', 409);
  requireShadow(textValue(value.evidenceRef, 160) && Array.isArray(value.rows), 'CLINICAL_SHADOW_LAB_UNAVAILABLE', 409);
  return structuredClone(value);
}

export function createClinicalShadowAdapter({ readCaseEvidence, readVerifiedLab, invokeAgent, retrievePolicy = async () => [],
  recordTelemetry = async () => {}, timeoutMs = 60_000, now = Date.now } = {}) {
  requireShadow(typeof readCaseEvidence === 'function' && typeof readVerifiedLab === 'function' && typeof invokeAgent === 'function');
  requireShadow(typeof retrievePolicy === 'function' && typeof recordTelemetry === 'function' && typeof now === 'function');
  requireShadow(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000);
  const requests = new Map();

  return {
    async run(input) {
      const binding = validateBinding(input);
      const bindingDigest = digest(binding);
      const existing = requests.get(binding.requestId);
      requireShadow(!existing || existing.bindingDigest === bindingDigest, 'CLINICAL_SHADOW_IDEMPOTENCY_CONFLICT', 409);
      if (existing?.result) return structuredClone(existing.result);
      if (existing?.promise) return structuredClone(await existing.promise);
      const startedAt = now();
      const requestState = { bindingDigest, promise: null, result: null };
      requests.set(binding.requestId, requestState);
      const execute = async () => {
      const evidenceRefs = new Set();
      const toolCalls = [];
      const toolCounts = new Map();
      let caseRead = false;
      let labRead = false;
      let policyRead = false;

      const callTool = async (name, args = {}) => {
        requireShadow(clinicalShadowToolNames.includes(name), 'CLINICAL_SHADOW_TOOL_NOT_ALLOWED', 403);
        const count = (toolCounts.get(name) || 0) + 1;
        requireShadow(toolCalls.length < 5 && count <= (name === 'retrieve_approved_policy' ? 3 : 1), 'CLINICAL_SHADOW_TOOL_LIMIT', 409);
        toolCounts.set(name, count);
        toolCalls.push(name);
        if (name === 'get_case_evidence') {
          exactEmpty(args);
          const evidence = validateCaseEvidence(await readCaseEvidence(binding), binding);
          evidence.evidenceRefs.forEach(ref => evidenceRefs.add(ref));
          caseRead = true;
          return evidence;
        }
        if (name === 'get_verified_lab_revision') {
          exactEmpty(args);
          requireShadow(binding.labBinding, 'CLINICAL_SHADOW_LAB_NOT_BOUND', 409);
          const lab = validateLabEvidence(await readVerifiedLab(binding), binding);
          evidenceRefs.add(lab.evidenceRef);
          labRead = true;
          return lab;
        }
        exact(args, ['query']); requireShadow(boundedQuery(args.query));
        policyRead = true;
        const passages = await retrievePolicy({ query: args.query.trim(), binding: structuredClone(binding) });
        requireShadow(Array.isArray(passages) && passages.length <= 5, 'CLINICAL_SHADOW_POLICY_UNAVAILABLE', 503);
        requireShadow(binding.policyVersion || passages.length === 0, 'CLINICAL_SHADOW_POLICY_NOT_BOUND', 409);
        for (const passage of passages) {
          exact(passage, ['evidenceRef', 'documentId', 'version', 'section', 'contentDigest', 'passage']);
          requireShadow([passage.evidenceRef, passage.documentId, passage.version, passage.section].every(item => textValue(item, 160)) &&
            /^[0-9a-f]{64}$/.test(passage.contentDigest) && textValue(passage.passage, 1500), 'CLINICAL_SHADOW_POLICY_UNAVAILABLE', 503);
          requireShadow(passage.version === binding.policyVersion, 'CLINICAL_SHADOW_POLICY_STALE', 409);
          requireShadow(!evidenceRefs.has(passage.evidenceRef), 'CLINICAL_SHADOW_POLICY_UNAVAILABLE', 503);
          evidenceRefs.add(passage.evidenceRef);
        }
        return structuredClone(passages);
      };

      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const response = await Promise.race([
          invokeAgent({ binding: structuredClone(binding), allowedTools: clinicalShadowToolNames, callTool, signal }),
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
        ]);
        requireShadow(caseRead, 'CLINICAL_SHADOW_CASE_EVIDENCE_REQUIRED', 409);
        requireShadow(!binding.labBinding || labRead, 'CLINICAL_SHADOW_LAB_EVIDENCE_REQUIRED', 409);
        requireShadow(!binding.policyVersion || policyRead, 'CLINICAL_SHADOW_POLICY_EVIDENCE_REQUIRED', 409);
        if (binding.labBinding) validateLabEvidence(await readVerifiedLab(binding), binding);
        const assessment = validateAssessment(response, [...evidenceRefs]);
        requireShadow(assessment.recommendedActions.every(action => clinicalShadowRecommendedActions.includes(action.toolName)), 'CLINICAL_SHADOW_ACTION_NOT_ALLOWED', 403);
        const result = { requestId: binding.requestId, status: 'shadow_validated', assessment, evidenceRefs: [...evidenceRefs], toolCalls: [...toolCalls], publishable: false };
        await recordTelemetry({ requestId: binding.requestId, caseId: binding.caseId, status: result.status,
          durationMs: Math.max(0, now() - startedAt), toolNames: [...toolCalls] });
        return result;
      } catch (error) {
        const failure = safeFailure(error);
        await recordTelemetry({ requestId: binding.requestId, caseId: binding.caseId, status: 'shadow_failed',
          durationMs: Math.max(0, now() - startedAt), toolNames: [...toolCalls], errorCode: failure.code });
        throw failure;
      }
      };
      requestState.promise = execute();
      try {
        requestState.result = await requestState.promise;
        requestState.promise = null;
        return structuredClone(requestState.result);
      } catch (error) {
        requestState.promise = null;
        throw error;
      }
    },
  };
}

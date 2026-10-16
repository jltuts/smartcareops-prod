import { canonicalDigest, ClinicalError, validateAssessment } from '../clinical/contracts.js';

export const managedClinicalIntegrationVersion = 'm60-application-shadow-v1';
export const approvedManagedPolicyEvidenceRefs = Object.freeze([
  'POLICY-SCO-DEMO-EVIDENCE-01-01', 'POLICY-SCO-DEMO-EVIDENCE-01-02', 'POLICY-SCO-DEMO-EVIDENCE-01-03',
  'POLICY-SCO-DEMO-LAB-02-01', 'POLICY-SCO-DEMO-LAB-02-02', 'POLICY-SCO-DEMO-LAB-02-03',
  'POLICY-SCO-DEMO-UNCERTAINTY-03-01', 'POLICY-SCO-DEMO-UNCERTAINTY-03-02', 'POLICY-SCO-DEMO-UNCERTAINTY-03-03',
  'POLICY-SCO-DEMO-BOUNDARY-04-01', 'POLICY-SCO-DEMO-BOUNDARY-04-02', 'POLICY-SCO-DEMO-BOUNDARY-04-03',
]);
const allowedToolNames = new Set(['get_case_evidence', 'get_verified_lab_revision', 'retrieve_approved_policy']);
const assessmentEvidenceRefs = new WeakMap();

export function managedClinicalAssessmentEvidenceRefs(assessment) {
  return assessment && typeof assessment === 'object' ? assessmentEvidenceRefs.get(assessment) || null : null;
}

const fail = (condition, code, status = 503) => {
  if (!condition) throw new ClinicalError(code, status);
};
const boundedToken = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validCaseId = value => typeof value === 'string' && /^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function safeContext(context) {
  fail(context && typeof context === 'object' && !Array.isArray(context), 'M60_CONTEXT_INVALID');
  fail(validCaseId(context.caseId) && Number.isInteger(context.observationVersion) && context.observationVersion >= 0,
    'M60_CONTEXT_INVALID');
  fail(Array.isArray(context.evidenceRefs) && context.evidenceRefs.length > 0 && context.evidenceRefs.length <= 80 &&
    context.evidenceRefs.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 160), 'M60_CONTEXT_INVALID');
  let copy;
  try { copy = structuredClone(context); } catch { fail(false, 'M60_CONTEXT_INVALID'); }
  fail(Buffer.byteLength(JSON.stringify(copy)) <= 64 * 1024, 'M60_CONTEXT_TOO_LARGE', 413);
  return copy;
}

function labBinding(context) {
  const lab = context.verifiedLabReport;
  if (!lab) return null;
  fail(typeof lab.reportId === 'string' && Number.isInteger(lab.revision) && lab.revision > 0 && sha256(lab.evidenceDigest),
    'M60_LAB_BINDING_INVALID', 409);
  return { reportId: lab.reportId, revision: lab.revision, evidenceDigest: lab.evidenceDigest };
}

export function createManagedClinicalModel({ invokeRuntime, policyVersion, policyManifestDigest,
  recordTelemetry = async () => {}, now = Date.now } = {}) {
  if (typeof invokeRuntime !== 'function' || typeof recordTelemetry !== 'function' || typeof now !== 'function')
    throw new TypeError('M60_MANAGED_CLIENT_CONFIGURATION_INVALID');
  if (typeof policyVersion !== 'string' || !policyVersion.trim() || policyVersion.length > 80 || !sha256(policyManifestDigest))
    throw new TypeError('M60_MANAGED_POLICY_CONFIGURATION_INVALID');

  return async (context, signal) => {
    const authorizedContext = safeContext(context);
    const evidence = { caseId: authorizedContext.caseId, evidenceVersion: authorizedContext.observationVersion,
      evidenceRefs: [...authorizedContext.evidenceRefs], context: authorizedContext };
    const evidenceDigest = canonicalDigest(evidence);
    const binding = {
      requestId: `m60_${canonicalDigest({ caseId: evidence.caseId, evidenceVersion: evidence.evidenceVersion,
        evidenceDigest, labBinding: labBinding(authorizedContext), policyVersion, policyManifestDigest }).slice(0, 48)}`,
      caseId: evidence.caseId,
      evidenceVersion: evidence.evidenceVersion,
      evidenceDigest,
      labBinding: labBinding(authorizedContext),
      policyVersion,
      policyManifestDigest,
    };
    const startedAt = now();
    try {
      const output = await invokeRuntime({ integrationVersion: managedClinicalIntegrationVersion, binding, evidence }, signal);
      fail(output && typeof output === 'object' && !Array.isArray(output) &&
        output.integrationVersion === managedClinicalIntegrationVersion && output.requestId === binding.requestId &&
        output.evidenceDigest === evidenceDigest && output.publishable === false && output.status === 'shadow_validated' &&
        Array.isArray(output.evidenceRefs) && output.evidenceRefs.length <= evidence.evidenceRefs.length + 6 &&
        new Set(output.evidenceRefs).size === output.evidenceRefs.length && Array.isArray(output.toolCalls) &&
        output.toolCalls.includes('get_case_evidence') && output.toolCalls.every(name => allowedToolNames.has(name)) &&
        (!binding.labBinding || output.toolCalls.includes('get_verified_lab_revision')), 'M60_MANAGED_RESPONSE_INVALID');
      const labRef = authorizedContext.verifiedLabReport?.evidenceRef;
      const approvedRefs = new Set([...evidence.evidenceRefs, ...(labRef ? [labRef] : []), ...approvedManagedPolicyEvidenceRefs]);
      fail(output.evidenceRefs.every(ref => approvedRefs.has(ref)) && evidence.evidenceRefs.every(ref => output.evidenceRefs.includes(ref)),
        'M60_MANAGED_EVIDENCE_INVALID', 409);
      const allowedRefs = [...approvedRefs].filter(ref => output.evidenceRefs.includes(ref));
      const assessment = validateAssessment(output.assessment, allowedRefs);
      assessmentEvidenceRefs.set(assessment, Object.freeze([...allowedRefs]));
      await recordTelemetry({ mode: 'managed_client', status: 'validated', durationMs: Math.max(0, now() - startedAt) });
      return assessment;
    } catch (error) {
      await recordTelemetry({ mode: 'managed_client', status: 'failed', durationMs: Math.max(0, now() - startedAt),
        errorCode: error instanceof ClinicalError ? error.code : signal?.aborted ? 'M60_MANAGED_TIMEOUT' : 'M60_MANAGED_UNAVAILABLE' });
      if (error instanceof ClinicalError) throw error;
      throw new ClinicalError(signal?.aborted ? 'M60_MANAGED_TIMEOUT' : 'M60_MANAGED_UNAVAILABLE', 503);
    }
  };
}

export function createReasoningEngineInvoker({ projectId, location, engineId, accessToken, request = fetch } = {}) {
  if (!boundedToken(projectId) || !/^[a-z]+-[a-z]+\d$/.test(location || '') || !/^\d{1,30}$/.test(engineId || '') ||
    typeof accessToken !== 'function' || typeof request !== 'function') throw new TypeError('M60_REASONING_ENGINE_CONFIGURATION_INVALID');
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/reasoningEngines/${engineId}:query`;
  return async (input, signal) => {
    const token = await accessToken(signal);
    fail(typeof token === 'string' && token.length > 20, 'M60_MANAGED_AUTH_UNAVAILABLE');
    const response = await request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ class_method: 'query_application_shadow', input }), signal });
    fail(response?.ok, response?.status === 429 ? 'M60_MANAGED_RATE_LIMIT' : 'M60_MANAGED_UNAVAILABLE');
    const body = await response.json();
    fail(body && typeof body === 'object' && Object.hasOwn(body, 'output'), 'M60_MANAGED_RESPONSE_INVALID');
    return body.output;
  };
}

export function createMetadataAccessTokenProvider({ request = fetch, now = Date.now } = {}) {
  let cached = null;
  return async signal => {
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    const response = await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal });
    fail(response?.ok, 'M60_MANAGED_AUTH_UNAVAILABLE');
    const body = await response.json();
    fail(typeof body?.access_token === 'string' && Number.isFinite(body.expires_in), 'M60_MANAGED_AUTH_UNAVAILABLE');
    cached = { token: body.access_token, expiresAt: now() + Math.max(0, body.expires_in - 30) * 1000 };
    return cached.token;
  };
}

export function createConfiguredManagedClinicalModel(env = process.env, options = {}) {
  if ((env.M60_CLINICAL_AGENT_MODE || 'off') === 'off') return undefined;
  const invokeRuntime = options.invokeRuntime || createReasoningEngineInvoker({
    projectId: env.M60_AGENT_PROJECT_ID, location: env.M60_AGENT_REGION, engineId: env.M60_AGENT_ENGINE_ID,
    accessToken: options.accessToken || createMetadataAccessTokenProvider(options), request: options.request || fetch,
  });
  return createManagedClinicalModel({ invokeRuntime, policyVersion: env.M60_POLICY_VERSION,
    policyManifestDigest: env.M60_POLICY_MANIFEST_DIGEST, recordTelemetry: options.recordTelemetry });
}

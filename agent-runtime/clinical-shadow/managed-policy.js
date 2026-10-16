import { mapManagedPolicyContexts } from '../../backend/src/agent-platform/policy-managed-retrieval.js';

const fail = (condition, code = 'MANAGED_POLICY_UNAVAILABLE', status = 503) => {
  if (!condition) throw Object.assign(new Error('Managed policy retrieval unavailable.'), { code, status });
};
const boundedQuery = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 300;

export function createManagedPolicyRetriever({ fixture, receipt, accessToken, request = fetch } = {}) {
  fail(fixture?.schemaVersion === '1.0' && receipt?.status === 'uploaded' &&
    fixture.version === receipt.corpusVersion && fixture.manifestDigest === receipt.manifestDigest,
  'MANAGED_POLICY_CONFIGURATION_INVALID', 500);
  if (typeof accessToken !== 'function' || typeof request !== 'function') throw new TypeError('MANAGED_POLICY_CONFIGURATION_INVALID');
  const endpoint = `https://${receipt.location}-aiplatform.googleapis.com/v1/projects/${receipt.project}/locations/${receipt.location}:retrieveContexts`;
  return async ({ query, binding, signal }) => {
    fail(boundedQuery(query), 'MANAGED_POLICY_QUERY_INVALID', 400);
    fail(binding?.policyVersion === fixture.version && binding?.policyManifestDigest === fixture.manifestDigest,
      'MANAGED_POLICY_BINDING_STALE', 409);
    const token = await accessToken(signal);
    fail(typeof token === 'string' && token.length > 20, 'MANAGED_POLICY_AUTH_UNAVAILABLE');
    const response = await request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ vertexRagStore: { ragResources: [{ ragCorpus: receipt.corpusResource }] },
        query: { text: query.trim(), ragRetrievalConfig: { topK: 5 } } }), signal });
    fail(response?.ok, response?.status === 429 ? 'MANAGED_POLICY_RATE_LIMIT' : 'MANAGED_POLICY_UNAVAILABLE');
    return mapManagedPolicyContexts({ response: await response.json(), fixture, receipt, corpusResource: receipt.corpusResource });
  };
}

export function createRuntimeMetadataTokenProvider({ request = fetch, now = Date.now } = {}) {
  let cached = null;
  return async signal => {
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    const response = await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal });
    fail(response?.ok, 'MANAGED_POLICY_AUTH_UNAVAILABLE');
    const value = await response.json();
    fail(typeof value?.access_token === 'string' && Number.isFinite(value.expires_in), 'MANAGED_POLICY_AUTH_UNAVAILABLE');
    cached = { token: value.access_token, expiresAt: now() + Math.max(0, value.expires_in - 30) * 1000 };
    return cached.token;
  };
}

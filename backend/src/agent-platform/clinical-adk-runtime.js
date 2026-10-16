import { InMemoryRunner } from '@google/adk';
import { clinicalAdkOutputSchema, createClinicalAdkAgent } from './clinical-adk-agent.js';

const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const usageFrom = event => {
  const usage = event?.usageMetadata || event?.usage_metadata || {};
  return {
    inputTokens: boundedCount(usage.promptTokenCount ?? usage.prompt_token_count),
    outputTokens: boundedCount(usage.candidatesTokenCount ?? usage.candidates_token_count),
    thinkingTokens: boundedCount(usage.thoughtsTokenCount ?? usage.thoughts_token_count),
    totalTokens: boundedCount(usage.totalTokenCount ?? usage.total_token_count),
  };
};
const retryableStructuredFailure = error => error instanceof SyntaxError || error?.name === 'ZodError' ||
  Array.isArray(error?.issues) || Array.isArray(error?.cause?.issues) || error?.message === 'CLINICAL_ADK_INVALID_RESPONSE';
const failureStage = error => {
  if (error?.diagnosticStage === 'MISSING_STRUCTURED_SUBMISSION') return error.diagnosticStage;
  if (error instanceof SyntaxError) return 'INVALID_JSON';
  if (error?.name === 'ZodError' || Array.isArray(error?.issues) || Array.isArray(error?.cause?.issues)) return 'SCHEMA_INVALID';
  return 'PROVIDER_OR_RUNNER_FAILURE';
};
const structuredFailure = diagnosticStage => Object.assign(new Error('CLINICAL_ADK_INVALID_RESPONSE'), { diagnosticStage });

export function createClinicalAdkInvoker({ model = process.env.GEMINI_CLINICAL_MODEL || 'gemini-3.6-flash',
  recordMetrics = async () => {}, recordFailure = async () => {}, runnerFactory = agent => new InMemoryRunner({ agent, appName: 'smartcareops_m60_shadow' }), now = Date.now, maxAttempts = 2 } = {}) {
  if (typeof recordMetrics !== 'function' || typeof recordFailure !== 'function' || typeof runnerFactory !== 'function' || typeof now !== 'function') throw new TypeError('CLINICAL_ADK_RUNTIME_CONFIGURATION_INVALID');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new TypeError('CLINICAL_ADK_RUNTIME_ATTEMPTS_INVALID');
  return async ({ binding, callTool, signal }) => {
    const startedAt = now();
    const toolResults = new Map();
    const cachedCallTool = (name, args = {}) => {
      const key = `${name}:${JSON.stringify(args)}`;
      if (!toolResults.has(key)) toolResults.set(key, Promise.resolve().then(() => callTool(name, args)));
      return toolResults.get(key).then(value => {
        if (name === 'retrieve_approved_policy' && Array.isArray(value)) {
          for (const passage of value) if (typeof passage?.evidenceRef === 'string') policyEvidenceRefs.add(passage.evidenceRef);
        }
        return structuredClone(value);
      });
    };
    const policyEvidenceRefs = new Set();
    let usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 }, eventCount = 0, lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw signal.reason;
      let submittedAssessment = null;
      const agent = createClinicalAdkAgent({ callTool: cachedCallTool, model, hasVerifiedLab: Boolean(binding.labBinding), policyAvailable: Boolean(binding.policyVersion),
        submitAssessment: async candidate => {
          const assessment = clinicalAdkOutputSchema.parse(candidate);
          const cited = new Set([
            ...assessment.importantFindings, ...assessment.observations, ...assessment.hypotheses, ...assessment.risks,
            ...assessment.differentialConsiderations, ...assessment.whyRecommended, ...assessment.alternatives,
          ].flatMap(item => item.evidenceRefs || []));
          const missingPolicyRefs = policyEvidenceRefs.size > 1 && [...policyEvidenceRefs].some(ref => !cited.has(ref));
          if (missingPolicyRefs) return { accepted: false, reason: 'Cite every returned approved policy evidence reference before submitting again.' };
          submittedAssessment = assessment;
          return { accepted: true };
        } });
      const runner = runnerFactory(agent, attempt);
      let attemptUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };
      try {
        for await (const event of runner.runEphemeral({ userId: 'm60-shadow',
          newMessage: { role: 'user', parts: [{ text: attempt === 1 ? 'Prepare one grounded, structured, non-publishing clinical review for the evidence bound to this run.' : 'Retry the same review. Correct the prior structured-output failure and return only fields allowed by the schema. Read-only recommended actions accept no arguments.' }] } })) {
          if (signal?.aborted) throw signal.reason;
          eventCount++;
          const currentUsage = usageFrom(event);
          attemptUsage = { inputTokens: Math.max(attemptUsage.inputTokens, currentUsage.inputTokens), outputTokens: Math.max(attemptUsage.outputTokens, currentUsage.outputTokens),
            thinkingTokens: Math.max(attemptUsage.thinkingTokens, currentUsage.thinkingTokens), totalTokens: Math.max(attemptUsage.totalTokens, currentUsage.totalTokens) };
        }
        if (!submittedAssessment) throw structuredFailure('MISSING_STRUCTURED_SUBMISSION');
        const assessment = submittedAssessment;
        usage = { inputTokens: usage.inputTokens + attemptUsage.inputTokens, outputTokens: usage.outputTokens + attemptUsage.outputTokens,
          thinkingTokens: usage.thinkingTokens + attemptUsage.thinkingTokens, totalTokens: usage.totalTokens + attemptUsage.totalTokens };
        await recordMetrics({ requestId: binding.requestId, model, durationMs: Math.max(0, now() - startedAt), eventCount, attempts: attempt, ...usage });
        return assessment;
      } catch (error) {
        usage = { inputTokens: usage.inputTokens + attemptUsage.inputTokens, outputTokens: usage.outputTokens + attemptUsage.outputTokens,
          thinkingTokens: usage.thinkingTokens + attemptUsage.thinkingTokens, totalTokens: usage.totalTokens + attemptUsage.totalTokens };
        lastError = error;
        const retryable = retryableStructuredFailure(error);
        await recordFailure({ requestId: binding.requestId, model, attempt, failureStage: failureStage(error), final: signal?.aborted || attempt === maxAttempts || !retryable });
        if (signal?.aborted || attempt === maxAttempts || !retryable) throw error;
      }
    }
    throw lastError;
  };
}

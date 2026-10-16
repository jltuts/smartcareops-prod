import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { managedFixtureIds } from './fixtures.js';
import { managedEvaluationVersion } from './service.js';

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseUrl = option('base-url') || 'http://127.0.0.1:18080';
const repeat = Number(option('repeat') || 3);
const selectedFixture = option('fixture');
const outputPath = resolve(option('output') || 'docs/m60-phase-c1-local-evaluation.json');
if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl)) throw new Error('M60_C1_LOOPBACK_URL_REQUIRED');
if (selectedFixture && !managedFixtureIds.includes(selectedFixture)) throw new Error('M60_C1_FIXTURE_NOT_ALLOWED');
const fixtureIds = selectedFixture ? [selectedFixture] : managedFixtureIds;
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3 || fixtureIds.length * repeat > 75) throw new Error('M60_C1_EVALUATION_LIMIT_INVALID');

const allowedTools = new Set(['get_case_evidence', 'get_verified_lab_revision', 'retrieve_approved_policy']);
const summarize = (fixtureId, result) => {
  if (result?.status !== 'shadow_validated' || result.publishable !== false || !Array.isArray(result.toolCalls) ||
      result.toolCalls.some(name => !allowedTools.has(name)) || !result.toolCalls.includes('get_case_evidence')) throw new Error('M60_C1_INVALID_SHADOW_RESULT');
  if (fixtureId.includes('lab') && !result.toolCalls.includes('get_verified_lab_revision')) throw new Error('M60_C1_LAB_NOT_READ');
  if (fixtureId.includes('policy') && !result.toolCalls.includes('retrieve_approved_policy')) throw new Error('M60_C1_POLICY_NOT_READ');
  const policyRefs = result.evidenceRefs.filter(ref => ref.startsWith('POLICY-'));
  const citedRefs = [
    ...result.assessment.importantFindings,
    ...result.assessment.observations,
    ...result.assessment.hypotheses,
    ...result.assessment.risks,
    ...result.assessment.differentialConsiderations,
    ...result.assessment.whyRecommended,
    ...result.assessment.alternatives,
  ].flatMap(item => item.evidenceRefs || []);
  const citedPolicyRefs = [...new Set(citedRefs.filter(ref => ref.startsWith('POLICY-')))];
  if (fixtureId === 'empty-policy-retrieval' && policyRefs.length) throw new Error('M60_C1_EMPTY_POLICY_CITATION');
  if (fixtureId === 'conflicting-policy-passages' && citedPolicyRefs.length < 2) throw new Error('M60_C1_POLICY_CONFLICT_CITATIONS_MISSING');
  if (fixtureId === 'conflicting-policy-passages' && result.assessment.conflictingEvidence.length < 1) throw new Error('M60_C1_POLICY_CONFLICT_NOT_DISCLOSED');
  const metrics = result.metrics || {};
  return {
    status: 'passed',
    latencyMs: 0,
    toolCalls: result.toolCalls,
    evidenceReferenceCount: result.evidenceRefs.length,
    policyReferenceCount: policyRefs.length,
    citedPolicyReferenceCount: citedPolicyRefs.length,
    conflictingEvidenceCount: result.assessment.conflictingEvidence.length,
    hasUncertainty: result.assessment.uncertainties.length > 0,
    recommendedActions: result.assessment.recommendedActions.map(item => item.toolName),
    model: typeof metrics.model === 'string' ? metrics.model : null,
    attempts: Number.isSafeInteger(metrics.attempts) ? metrics.attempts : null,
    inputTokens: Number.isSafeInteger(metrics.inputTokens) ? metrics.inputTokens : 0,
    outputTokens: Number.isSafeInteger(metrics.outputTokens) ? metrics.outputTokens : 0,
    thinkingTokens: Number.isSafeInteger(metrics.thinkingTokens) ? metrics.thinkingTokens : 0,
    totalTokens: Number.isSafeInteger(metrics.totalTokens) ? metrics.totalTokens : 0,
  };
};

const scenarios = [];
for (const fixtureId of fixtureIds) {
  const runs = [];
  for (let index = 0; index < repeat; index++) {
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/api/reasoning_engine`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ class_method: 'query', input: { fixtureId, requestId: `c1-${fixtureId}-${index + 1}`, evaluationVersion: managedEvaluationVersion } }),
        signal: AbortSignal.timeout(65_000) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error('M60_C1_RUNTIME_REQUEST_FAILED'), { safeCode: body?.error?.code });
      const summary = summarize(fixtureId, body?.output); summary.latencyMs = Math.round(performance.now() - started); runs.push(summary);
    } catch (error) {
      runs.push({ status: 'failed', latencyMs: Math.round(performance.now() - started), errorCode: error?.safeCode || error?.message || 'M60_C1_EVALUATION_FAILED' });
    }
  }
  const passed = runs.filter(run => run.status === 'passed');
  scenarios.push({ id: fixtureId, status: passed.length === runs.length ? 'passed' : 'failed', runCount: runs.length, passedRuns: passed.length, runs });
}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), evaluationVersion: managedEvaluationVersion,
  environment: 'local container with direct Gemini API; not Agent Platform', dataPolicy: 'fictional-only; no model output, prompt, case text, tool result or hidden reasoning retained',
  invocationCount: fixtureIds.length * repeat, invocationLimit: 75, scenarios };
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outputPath, invocationCount: report.invocationCount, scenarios: scenarios.map(item => ({ id: item.id, status: item.status, passedRuns: item.passedRuns, runCount: item.runCount })) }));
if (scenarios.some(item => item.status !== 'passed')) process.exitCode = 1;

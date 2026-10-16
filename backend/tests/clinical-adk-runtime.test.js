import test from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalAdkInvoker } from '../src/agent-platform/clinical-adk-runtime.js';
import { assessment } from './clinical-fixtures.js';

const toolNamed = async (agent, name) => (await agent.canonicalTools()).find(tool => tool.name === name);

test('ADK runtime parses strict output and records bounded model metrics', async () => {
  const metrics = [], value = assessment({ evidenceRefs: ['case'] });
  value.hypotheses[0].evidenceRefs = ['case'];
  value.observations[0].evidenceRefs = ['case'];
  value.recommendedActions = [{ toolName: 'read_case', expectedOutcome: 'Review the bound case.', proposedRisk: 'READ_ONLY' }];
  const invoker = createClinicalAdkInvoker({ model: 'test-model', now: (() => { let time = 100; return () => time += 5; })(),
    recordMetrics: async event => metrics.push(event), runnerFactory: agent => {
      assert.match(agent.instruction, /verified laboratory revision is not available/);
      return { async *runEphemeral(input) {
        assert.equal(input.userId, 'm60-shadow');
        await (await toolNamed(agent, 'submit_clinical_assessment')).runAsync({ args: value, toolContext: undefined });
        yield { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 220 } };
      } };
    } });
  const output = await invoker({ binding: { requestId: 'm60-eval-1', labBinding: null, policyVersion: null }, callTool: async () => {}, signal: new AbortController().signal });
  assert.deepEqual(output, value);
  assert.deepEqual(metrics, [{ requestId: 'm60-eval-1', model: 'test-model', durationMs: 5, eventCount: 1, attempts: 1, inputTokens: 120, outputTokens: 80, thinkingTokens: 20, totalTokens: 220 }]);
  assert.equal(JSON.stringify(metrics).includes('Patient'), false);
});

test('ADK runtime rejects free-form final output before the shadow boundary', async () => {
  const invoker = createClinicalAdkInvoker({ model: 'test-model', runnerFactory: () => ({ async *runEphemeral() {
    yield { content: { parts: [{ text: '{"caseSummary":"incomplete"}' }] } };
  } }) });
  await assert.rejects(invoker({ binding: { requestId: 'm60-eval-invalid', labBinding: null, policyVersion: null }, callTool: async () => {} }));
});

test('ADK runtime reports content-free structured failure stages without retaining model output', async () => {
  const failures = [];
  const invoker = createClinicalAdkInvoker({ model: 'test-model', maxAttempts: 1, recordFailure: async event => failures.push(event),
    runnerFactory: () => ({ async *runEphemeral() { yield { content: { parts: [{ text: 'untrusted model output' }] } }; } }) });
  await assert.rejects(invoker({ binding: { requestId: 'm60-missing-submission', labBinding: null, policyVersion: null }, callTool: async () => {} }));
  assert.deepEqual(failures.map(({ failureStage, final }) => ({ failureStage, final })), [
    { failureStage: 'MISSING_STRUCTURED_SUBMISSION', final: true },
  ]);
  assert.equal(JSON.stringify(failures).includes('untrusted model output'), false);
});

test('ADK runtime retries one structured failure and reuses cached read-only tool results', async () => {
  const value = assessment({ evidenceRefs: ['case'] });
  value.hypotheses[0].evidenceRefs = ['case']; value.observations[0].evidenceRefs = ['case'];
  value.recommendedActions = [{ toolName: 'read_case', expectedOutcome: 'Review the bound case.', proposedRisk: 'READ_ONLY' }];
  let toolReads = 0; const metrics = [];
  const invoker = createClinicalAdkInvoker({ model: 'test-model', recordMetrics: async event => metrics.push(event),
    runnerFactory: (agent, attempt) => ({ async *runEphemeral() {
      const tool = (await agent.canonicalTools())[0]; await tool.runAsync({ args: {}, toolContext: undefined });
      if (attempt === 2) await (await toolNamed(agent, 'submit_clinical_assessment')).runAsync({ args: value, toolContext: undefined });
      yield { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
    } }) });
  const output = await invoker({ binding: { requestId: 'm60-retry', labBinding: null, policyVersion: null }, callTool: async () => { toolReads++; return { evidenceRefs: ['case'] }; } });
  assert.deepEqual(output, value); assert.equal(toolReads, 1); assert.equal(metrics[0].attempts, 2); assert.equal(metrics[0].totalTokens, 30);
});

test('ADK runtime does not retry a provider failure', async () => {
  let attempts = 0;
  const invoker = createClinicalAdkInvoker({ model: 'test-model', runnerFactory: () => ({ async *runEphemeral() { attempts++; const error = new Error('provider unavailable'); error.status = 429; throw error; } }) });
  await assert.rejects(invoker({ binding: { requestId: 'm60-provider-failure', labBinding: null, policyVersion: null }, callTool: async () => {} }));
  assert.equal(attempts, 1);
});

test('ADK completion tool rejects a partial policy citation and accepts the corrected submission', async () => {
  const value = assessment({ evidenceRefs: ['case', 'POLICY-a', 'POLICY-b'] });
  for (const item of [...value.importantFindings, ...value.observations, ...value.hypotheses, ...value.risks,
    ...value.differentialConsiderations, ...value.whyRecommended, ...value.alternatives]) item.evidenceRefs = ['case'];
  value.observations[0].evidenceRefs = ['POLICY-a'];
  value.recommendedActions = [{ toolName: 'read_case', expectedOutcome: 'Review the bound case.', proposedRisk: 'READ_ONLY' }];
  const corrected = structuredClone(value); corrected.observations[0].evidenceRefs.push('POLICY-b');
  const invoker = createClinicalAdkInvoker({ model: 'test-model', runnerFactory: agent => ({ async *runEphemeral() {
    await (await toolNamed(agent, 'retrieve_approved_policy')).runAsync({ args: { query: 'conflicting guidance' }, toolContext: undefined });
    const submission = await toolNamed(agent, 'submit_clinical_assessment');
    assert.deepEqual(await submission.runAsync({ args: value, toolContext: undefined }), { accepted: false, reason: 'Cite every returned approved policy evidence reference before submitting again.' });
    assert.deepEqual(await submission.runAsync({ args: corrected, toolContext: undefined }), { accepted: true });
    yield { usageMetadata: { totalTokenCount: 10 } };
  } }) });
  const output = await invoker({ binding: { requestId: 'm60-policy-correction', labBinding: null, policyVersion: 'v1' },
    callTool: async name => name === 'retrieve_approved_policy' ? [{ evidenceRef: 'POLICY-a' }, { evidenceRef: 'POLICY-b' }] : {} });
  assert.deepEqual(output, corrected);
});

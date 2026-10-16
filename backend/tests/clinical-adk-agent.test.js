import test from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalAdkAgent, clinicalAdkAgentName, clinicalAdkInstruction, clinicalAdkOutputSchema } from '../src/agent-platform/clinical-adk-agent.js';

test('ADK clinical shadow agent has no conversation memory, transfers, or unbounded tools', async () => {
  const calls = [], submissions = [];
  const agent = createClinicalAdkAgent({ model: 'test-model', callTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    submitAssessment: async value => { submissions.push(value); return { accepted: true }; } });
  assert.equal(agent.name, clinicalAdkAgentName);
  assert.equal(agent.includeContents, 'none');
  assert.equal(agent.disallowTransferToParent, true);
  assert.equal(agent.disallowTransferToPeers, true);
  assert.equal(agent.instruction.startsWith(clinicalAdkInstruction), true);
  assert.match(agent.instruction, /verified laboratory revision is not available/);
  const tools = await agent.canonicalTools();
  assert.deepEqual(tools.map(tool => tool.name), ['get_case_evidence', 'get_verified_lab_revision', 'retrieve_approved_policy', 'submit_clinical_assessment']);
  assert.equal(tools.every(tool => tool.isLongRunning === false), true);
  await tools[0].runAsync({ args: {}, toolContext: undefined });
  await tools[1].runAsync({ args: {}, toolContext: undefined });
  await tools[2].runAsync({ args: { query: 'fictional review policy' }, toolContext: undefined });
  assert.deepEqual(calls, [
    { name: 'get_case_evidence', args: {} },
    { name: 'get_verified_lab_revision', args: {} },
    { name: 'retrieve_approved_policy', args: { query: 'fictional review policy' } },
  ]);
  assert.equal(submissions.length, 0);
});

test('ADK tool schemas reject model-selected identifiers, extra fields, and invalid policy queries before dispatch', async () => {
  let calls = 0;
  const tools = await createClinicalAdkAgent({ model: 'test-model', callTool: async () => { calls++; } }).canonicalTools();
  await assert.rejects(tools[0].runAsync({ args: { caseId: 'SC-other' }, toolContext: undefined }));
  await assert.rejects(tools[1].runAsync({ args: { reportId: 'other' }, toolContext: undefined }));
  await assert.rejects(tools[2].runAsync({ args: { query: '', caseId: 'SC-other' }, toolContext: undefined }));
  assert.equal(calls, 0);
});

test('ADK keeps tool use compatible while the strict schema remains the shadow boundary', () => {
  const agent = createClinicalAdkAgent({ model: 'test-model', callTool: async () => ({}) });
  assert.equal(agent.outputSchema, undefined);
  assert.match(agent.instruction, /submit_clinical_assessment exactly once/);
  assert.throws(() => clinicalAdkOutputSchema.parse({ chainOfThought: 'private' }));
  const actionSchema = clinicalAdkOutputSchema.shape.recommendedActions.element;
  assert.throws(() => actionSchema.parse({ toolName: 'notify_doctor', expectedOutcome: 'Send a message.', proposedRisk: 'READ_ONLY' }));
  assert.throws(() => actionSchema.parse({ toolName: 'read_case', arguments: { caseId: 'SC-other' }, expectedOutcome: 'Read another case.', proposedRisk: 'READ_ONLY' }));
});

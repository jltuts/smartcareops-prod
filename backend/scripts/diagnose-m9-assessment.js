// Explicit fictional DEV diagnostic: one model call, no workspace writes or raw output logs.
import assert from 'node:assert/strict';
import '../src/server.js';
import { GoogleGenAI } from '@google/genai';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { queryTool } from '../src/clinical/tools.js';
import { createClinicalModel } from '../src/clinical/model.js';
import { assessmentSchema, policy, toolNames } from '../src/clinical/contracts.js';
assert(process.argv.includes('--run') && process.env.APP_ENV === 'development' && process.env.NODE_ENV !== 'production');
const store = configuredClinicalStore(), cases = createConfiguredCaseStore();
try {
  const caseId = process.env.M8_CASE_ID, state = await store.read(caseId);
  assert.equal((await cases.getCase(caseId))?.source, 'smartcareops_demo');
  const context = { caseId, simulation: true, observationVersion: state.meta.observationVersion, investigation: {}, evidenceRefs: ['case', 'history'], previousPlan: state.plans[state.meta.currentRevisionId],
    completedActions: Object.values(state.toolExecutions).filter(e => e.status === 'succeeded').map(e => ({ toolName: e.toolName, outcome: e.outcome, observationVersion: state.plans[e.planRevisionId]?.inputVersion || null })) };
  context.resourceChanges = Object.values(state.events).filter(e => e.type === 'resource.updated' && e.changedHospitalId && e.resourceVersion === state.resourceEnvironment.version)
    .map(e => ({ eventId: e.eventId, hospitalId: e.changedHospitalId, previousMonitoredBedsAvailable: e.previousMonitoredBedsAvailable, monitoredBedsAvailable: e.monitoredBedsAvailable, resourceVersion: e.resourceVersion, occurredAt: e.occurredAt }));
  for (const name of ['read_case', 'read_observation_history', 'read_fictional_patient_history', 'evaluate_safety']) context.investigation[name] = await queryTool(name, { caseId, caseStore: cases, state });
  context.evidenceRefs.push(...Object.keys(state.observations));
  const run = Object.values(state.agentRuns).sort((a,b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
  context.resourceInvestigation = Object.values(state.resourceSnapshots).filter(s => s.runId === run.runId).map(({ executionId, snapshotId, toolName, result }) => ({ executionId, snapshotId, toolName, result }));
  for (const s of context.resourceInvestigation) context.evidenceRefs.push(s.executionId, s.snapshotId);
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = createClinicalModel({ request: async (...args) => {
    const response = await client.interactions.create(...args);
    const output = response.output_text || '';
    const diagnostic = { textPresent: typeof response.output_text === 'string', textLength: output.length, jsonValid: false,
      startsObject: output.trim().startsWith('{'), endsObject: output.trim().endsWith('}'), codeFence: output.includes('```'),
      refusalLanguage: /cannot|can't|unable|medical advice/i.test(output),
      status: ['completed', 'incomplete', 'failed', 'cancelled'].includes(response.status) ? response.status : 'other',
      outputTokenCount: response.usage?.total_output_tokens, reasoningTokenCount: response.usage?.total_thought_tokens };
    try {
      const value = JSON.parse(response.output_text); diagnostic.jsonValid = true;
      diagnostic.missingFields = assessmentSchema.required.filter(key => !Object.hasOwn(value, key));
      diagnostic.extraFieldCount = Object.keys(value).filter(key => !assessmentSchema.required.includes(key)).length;
      diagnostic.statements = ['observations', 'hypotheses', 'risks'].map(key => ({ field: key, count: value[key]?.length,
        entries: (value[key] || []).map(item => ({ summaryLength: item.summary?.length, referenceCount: item.evidenceRefs?.length, invalidReferences: item.evidenceRefs?.filter(ref => !context.evidenceRefs.includes(ref)).length })) }));
      diagnostic.lists = ['uncertainties', 'conflictingEvidence', 'missingInformation', 'monitoringConditions'].map(key => ({ field: key, count: value[key]?.length, lengths: value[key]?.map(item => item.length) }));
      diagnostic.changeSummaryLength = value.changeSummary?.length;
      diagnostic.changeMentionsMonitoredBeds = /monitored/i.test(value.changeSummary || '');
      diagnostic.alternativeMentioned = JSON.stringify([value.changeSummary, value.observations]).includes('HOSP-003');
      diagnostic.actions = (value.recommendedActions || []).map(action => { let valid = true; try { policy(action.toolName, action.arguments || {}); } catch { valid = false; } return { tool: toolNames.includes(action.toolName) ? action.toolName : 'NOT_ALLOWED', argumentsValid: valid, outcomeLength: action.expectedOutcome?.length, riskValid: ['READ_ONLY', 'LOW_RISK_OPERATION', 'HIGH_IMPACT'].includes(action.proposedRisk) }; });
    } catch { /* No model text is logged. */ }
    console.log(JSON.stringify(diagnostic)); return response;
  } });
  try { await model(context, AbortSignal.timeout(60000)); console.log('ASSESSMENT_VALID'); }
  catch (error) { console.log(JSON.stringify({ category: error.safeModelError?.code || 'UNAVAILABLE', httpStatus: error.safeModelError?.httpStatus })); process.exitCode = 1; }
} finally { await store.close(); await cases.close(); }

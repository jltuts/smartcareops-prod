// One explicit, read-only Gemini diagnostic. Prints schema checks, never raw output.
import assert from 'node:assert/strict';
import '../src/server.js';
import { GoogleGenAI } from '@google/genai';
import { resourceFixture } from '../tests/resources-fixtures.js';
import { observationSet } from '../tests/clinical-fixtures.js';
import { queryTool } from '../src/clinical/tools.js';
import { createResourceInvestigator } from '../src/resources/investigator.js';
import { resourceToolNames, validateArguments } from '../src/resources/contracts.js';
assert(process.argv.includes('--run') && process.env.APP_ENV === 'development');
const fixture = await resourceFixture();
const { store, caseStore: cases } = fixture;
try {
  await fixture.service.append(observationSet());
  const caseId = fixture.caseId, state = await store.read(caseId), context = { caseId, simulation: true, investigation: {}, availableHospitalIds: ['HOSP-001', 'HOSP-002', 'HOSP-003'], fleet: await cases.listAmbulances() };
  for (const name of ['read_case', 'read_observation_history', 'read_fictional_patient_history', 'evaluate_safety']) context.investigation[name] = await queryTool(name, { caseId, caseStore: cases, state });
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const investigator = createResourceInvestigator({ request: async (...args) => {
    let result;
    try { result = await client.interactions.create(...args); }
    catch (error) {
      const text = String(error.message || '').toLowerCase();
      console.log(JSON.stringify({ requestRejected: true, httpStatus: Number.isInteger(error.status) ? error.status : null,
        schemaTerms: ['anyof', 'schema', 'complex', 'constraint', 'unsupported', 'required', 'properties', 'items', 'enum', 'minimum', 'maximum'].filter(term => text.includes(term)) }));
      throw error;
    }
    const diagnostic = { textPresent: typeof result.output_text === 'string', textLength: result.output_text?.length || 0, jsonValid: false, requests: [] };
    try {
      const value = JSON.parse(result.output_text); diagnostic.jsonValid = true;
      const requests = resourceToolNames.flatMap(toolName => Array.isArray(value[toolName]) ? value[toolName].map(args => ({ toolName, arguments: args })) : []); diagnostic.count = requests.length;
      for (const request of requests) {
        let valid = true; try { validateArguments(request.toolName, request.arguments); } catch { valid = false; }
        diagnostic.requests.push({ tool: resourceToolNames.includes(request.toolName) ? request.toolName : 'NOT_ALLOWED', valid, argumentKeys: ['hospitalId', 'specialty', 'requiredCapabilities', 'maxResults', 'ambulanceUnitId', 'origin', 'destination'].filter(key => Object.hasOwn(request.arguments || {}, key)), unexpectedArgumentCount: Object.keys(request.arguments || {}).filter(key => !['hospitalId', 'specialty', 'requiredCapabilities', 'maxResults', 'ambulanceUnitId', 'origin', 'destination'].includes(key)).length });
      }
    } catch { /* Safe shape summary only. */ }
    console.log(JSON.stringify(diagnostic)); return result;
  } });
  try { await investigator(context, AbortSignal.timeout(30000)); console.log('INVESTIGATION_VALID'); }
  catch (error) { console.log(JSON.stringify({ category: error.safeModelError?.code || 'UNAVAILABLE', httpStatus: error.safeModelError?.httpStatus })); process.exitCode = 1; }
} finally { await store.close(); await cases.close(); }

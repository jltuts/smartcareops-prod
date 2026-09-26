// Fresh-client read-only verification. No model calls, events, or workflow writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import '../src/server.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { configuredOperationsStore } from '../src/operations/storage.js';
import { configuredRegionalStore } from '../src/regional/storage.js';
import { evidenceChoices } from '../src/regional/contracts.js';
import { digest } from '../src/clinical/contracts.js';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
const history = state => ({ plans: state.plans, observations: state.observations, receipts: state.receipts, executions: state.toolExecutions, snapshots: state.snapshots || {}, resourceSnapshots: state.resourceSnapshots });
async function main() {
  assert(process.argv.includes('--run') && process.env.APP_ENV === 'development' && process.env.NODE_ENV !== 'production'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107');
  const checkpoint = JSON.parse(await readFile(new URL('../../.m11-progress.json', import.meta.url), 'utf8')); let previous;
  for (let i = 0; i < 2; i++) {
    const cases = createConfiguredCaseStore(), store = configuredRegionalStore(process.env, cases), hospital = configuredOperationsStore(process.env, cases), clinical = configuredClinicalStore();
    try {
      const state = await store.read('REGION-DEMO-001'); assert.equal(hash(state.plans[checkpoint.plan1]), checkpoint.plan1Hash); assert.equal(hash(state.plans[checkpoint.plan2]), checkpoint.plan2Hash);
      assert.equal(state.meta.currentRevisionId, checkpoint.plan2); assert.equal(state.meta.lease, null); assert.equal(state.approvals[checkpoint.staleApprovalId].status, 'superseded');
      assert.equal(state.events['capacity_m11-hosp003-zero'].status, 'completed');
      for (const [id, expected] of Object.entries(checkpoint.receipts)) assert.equal(hash(state.receipts[id]), expected);
      for (const plan of Object.values(state.plans)) {
        const snapshot = state.snapshots[`REG-SNAPSHOT-${plan.snapshotVersion}`], choices = evidenceChoices({ snapshot });
        for (const key of ['observations', 'suspectedSignals', 'supportingEvidence', 'conflictingEvidence', 'uncertainties', 'operationalRisks']) for (const item of plan.assessment[key]) {
          assert.equal(item.summary, choices[item.kind].summary); assert.deepEqual(item.evidenceRefs, choices[item.kind].evidenceRefs); assert(item.evidenceRefs.every(ref => plan.evidenceRefs.includes(ref)));
        }
        const resources = Object.values(state.resourceSnapshots).filter(item => plan.evidenceRefs.includes(item.evidenceId)); assert.equal(resources.length, 10);
        assert(resources.every(item => item.result.simulation && item.result.resourceVersion === plan.resourceVersion));
      }
      assert(Object.values(state.toolExecutions).every(item => item.attempt === 1));
      assert.equal(hash(history(await hospital.read('OPS-HOSP-001'))), checkpoint.hospitalHash); assert.equal(hash(history(await clinical.read(process.env.M8_CASE_ID))), checkpoint.clinicalHash); assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
      const actual = hash(history(state)); if (previous) assert.equal(actual, previous); previous = actual;
    } finally { await store.close(); await hospital.close(); await clinical.close(); await cases.close(); }
  }
  const path = new URL('../../docs/m11-outbreak-intelligence-verification.json', import.meta.url), evidence = JSON.parse(await readFile(path, 'utf8'));
  evidence.finalReadback = { passed: true, freshClients: 2, noModelCalls: true, noWorkflowWrites: true, controlledStatementsRevalidated: true, verifiedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence.finalReadback));
}
main().catch(error => { console.error(JSON.stringify({ status: 'FAIL', safeCode: error.code || 'READBACK_FAILED' })); process.exitCode = 1; });

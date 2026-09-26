// Read-only follow-up after the live verifier. No model calls or workflow writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import '../src/server.js';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { digest } from '../src/clinical/contracts.js';
import { validateResult } from '../src/resources/contracts.js';
assert(process.argv.includes('--run') && process.env.APP_ENV === 'development' && process.env.NODE_ENV !== 'production');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
const checkpoint = JSON.parse(await readFile(new URL('../../.m9-progress.json', import.meta.url), 'utf8'));
const caseId = process.env.M8_CASE_ID;
assert.equal(checkpoint.caseId, caseId);
let first;
for (let client = 1; client <= 2; client++) {
  const store = configuredClinicalStore(), cases = createConfiguredCaseStore();
  try {
    const state = await store.read(caseId);
    assert.equal(hash(await cases.getCase(caseId)), checkpoint.originalCaseHash);
    assert.equal(hash(await cases.listAmbulances()), checkpoint.fleetHash);
    for (const [id, expected] of Object.entries(checkpoint.baselinePlans)) assert.equal(hash(state.plans[id]), expected);
    assert.equal(hash(state.receipts), checkpoint.receiptsHash);
    assert.equal(hash(state.plans[`revision_${checkpoint.firstVersion}`]), checkpoint.firstPlanHash);
    assert.equal(Object.keys(state.plans).length, checkpoint.finalVersion || checkpoint.firstVersion + 1);
    assert.equal(state.meta.currentRevisionId, `revision_${checkpoint.finalVersion || checkpoint.firstVersion + 1}`);
    assert.equal(state.meta.active, null);
    assert.equal(state.resourceEnvironment.version, 2);
    assert.equal(state.events['resource_m9-dev-capacity'].status, 'completed');
    assert.equal(state.approvals[checkpoint.staleApprovalId].status, 'superseded');
    assert.equal(Object.values(state.toolExecutions).filter(e => e.approvalId && e.status === 'succeeded').length, Object.keys(state.receipts).length);
    const revisions = [];
    for (const [version, beds] of [[checkpoint.firstVersion, 2], [checkpoint.finalVersion || checkpoint.firstVersion + 1, 0]]) {
      const plan = state.plans[`revision_${version}`];
      const snapshots = plan.resourceSnapshotIds.map(id => {
        const snapshot = state.resourceSnapshots[id]; assert(snapshot);
        validateResult(snapshot.toolName, snapshot.result);
        assert(state.agentRuns[snapshot.runId].planRevisionId === plan.revisionId);
        assert(state.toolExecutions[snapshot.executionId].status === 'succeeded');
        assert.equal(snapshot.result.resourceVersion, `m9-demo:${plan.resourceEvidenceVersion}`);
        assert.equal(snapshot.result.fleetEvidenceVersion, plan.fleetEvidenceVersion);
        return snapshot;
      });
      assert.equal(snapshots.find(s => s.toolName === 'get_hospital_capacity' && s.result.hospitalId === 'HOSP-001').result.monitoredBedsAvailable, beds);
      assert(snapshots.some(s => s.toolName === 'get_hospital_capacity' && s.result.hospitalId === 'HOSP-003' && s.result.monitoredBedsAvailable > 0));
      revisions.push({ revision: version, normalizedSnapshots: snapshots.length, catalogVersion: plan.resourceEvidenceVersion, monitoredBeds: beds, evidenceReferencesResolved: true });
    }
    const result = { plans: state.plans, snapshots: state.resourceSnapshots, receipts: state.receipts };
    if (first) assert.equal(hash(result), first); else first = hash(result);
    if (client === 2) {
      const evidence = { verifiedAt: new Date().toISOString(), succeeded: true, freshFirestoreClients: 2, revisions, originalCaseAndFleetUnchanged: true,
        m8PlansAndReceiptsUnchanged: true, m9PlanV1Immutable: true, staleApprovalSuperseded: true, noDuplicateExecution: true,
        receiptCount: Object.keys(state.receipts).length, runCount: state.meta.runCount, modelCalls: state.meta.modelCalls, workerIdle: true };
      await writeFile(new URL('../../.m9-readback.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
    }
  } finally { await store.close(); await cases.close(); }
}

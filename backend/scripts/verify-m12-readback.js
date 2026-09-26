// Read-only fresh-process checks: no model calls, timers, commands or workflow writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import '../src/server.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { configuredClinicalStore } from '../src/clinical/storage.js';
import { configuredOperationsStore } from '../src/operations/storage.js';
import { configuredRegionalStore } from '../src/regional/storage.js';
import { digest } from '../src/clinical/contracts.js';
import { validateMessage } from '../src/notifications/contracts.js';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => digest(canonical(value));
assert(process.argv.includes('--run')); assert.equal(process.env.APP_ENV, 'development'); assert.equal(process.env.FIREBASE_PROJECT_ID, 'gen-lang-client-0710663107');
const checkpoint = JSON.parse(await readFile(new URL('../../.m12-progress.json', import.meta.url), 'utf8'));
const evidenceFile = new URL('../../docs/m12-notifications-agent-actions-verification.json', import.meta.url), evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
const cases = createConfiguredCaseStore(), stores = [configuredClinicalStore(process.env, { captureCase: true }), configuredOperationsStore(process.env, cases), configuredRegionalStore(process.env, cases)];
try {
  const ids = ['SC-10000000-0000-4000-8000-000000000001', 'OPS-HOSP-001', 'REGION-DEMO-001'], states = await Promise.all(stores.map((store, index) => store.read(ids[index])));
  const checkHistory = (state, baseline) => { for (const [bucket, items] of Object.entries(baseline)) for (const [id, expected] of Object.entries(items)) assert.equal(hash(state[bucket][id]), expected); };
  checkHistory(await stores[0].read(process.env.M8_CASE_ID), checkpoint.clinicalHistory); checkHistory(states[1], checkpoint.hospitalHistory); checkHistory(states[2], checkpoint.regionalHistory); checkHistory(states[2], checkpoint.delivered);
  assert.equal(hash(await cases.getCase(ids[0])), checkpoint.originalCase); assert.equal(hash(await cases.listAmbulances()), checkpoint.fleet);
  for (const state of states) {
    assert(Object.values(state.followups).length > 0);
    for (const notice of Object.values(state.notifications)) {
      validateMessage(notice.toolName, notice); assert.equal(notice.simulation, true); assert(state.plans[notice.sourceRevisionId]);
      const receipts = Object.values(state.receipts).filter(r => r.notificationId === notice.notificationId);
      if (notice.status === 'sent') { assert.equal(receipts.length, 1); assert.equal(receipts[0].receiptId, notice.receiptId); assert.equal(receipts[0].status, 'delivered'); assert.equal(state.toolExecutions[receipts[0].executionId].status, 'succeeded'); }
      else assert.equal(receipts.length, 0);
    }
  }
  assert.equal(states[2].notifications[checkpoint.stale.notificationId].status, 'superseded'); assert.equal(states[2].meta.currentRevisionId, checkpoint.replan);
  assert.equal(states[2].events['capacity_m12-hosp002-pressure'].status, 'completed');
  assert.equal(states[2].resourceEnvironment.hospitals.find(h => h.hospitalId === 'HOSP-002').capacity.monitoredBedsAvailable, 3);
  evidence.resourceChange = { hospitalId: 'HOSP-002', monitoredBedsBefore: 4, monitoredBedsAfter: 3, catalogBefore: 'm9-demo:5', catalogAfter: 'm9-demo:6', durableEventProcessed: true };
  evidence.supersededNotification = states[2].notifications[checkpoint.stale.notificationId];
  evidence.operationsNotification = Object.values(states[1].notifications).find(n => n.toolName === 'notify_hospital_operations'); assert.equal(evidence.operationsNotification.status, 'sent');
  for (const [index, key] of ['clinical', 'hospital', 'regional'].entries()) { evidence[key] = states[index].notifications[checkpoint[key].notificationId]; assert.equal(evidence[key].status, 'sent'); }
  evidence.finalReadOnlyProcess = { passed: true, at: new Date().toISOString(), freshClients: 3, workspaces: states.map((s, i) => ({ subjectId: ids[i], revision: s.meta.currentRevisionId, snapshotVersion: s.meta.snapshotVersion || s.meta.observationVersion, plans: Object.keys(s.plans).length, receipts: Object.keys(s.receipts).length, runs: s.meta.runCount, modelCalls: s.meta.modelCalls, catalogVersion: s.resourceEnvironment.resourceVersion })) };
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence.finalReadOnlyProcess));
} finally { await Promise.all(stores.map(store => store.close())); await cases.close(); }

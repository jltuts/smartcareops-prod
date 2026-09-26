import test from 'node:test';
import assert from 'node:assert/strict';
import { regionalFixture, regionalAssessment } from './regional-fixtures.js';
import { validateAssessment } from '../src/regional/contracts.js';
import { summarizeWindows, snapshot } from '../src/regional/snapshot.js';
import { createRegionalService } from '../src/regional/service.js';
import { createRegionalModel } from '../src/regional/model.js';
const change = () => ({ requestId: 'zero', hospitalId: 'HOSP-003', monitoredBedsAvailable: 0, expectedVersion: 2 });
test('regional snapshot combines three hospitals, bounded census windows, geography, capacity and M10 pressure', async () => {
  const f = await regionalFixture(); await f.service.tick(); const view = await f.service.view(), s = view.currentSnapshot;
  assert.equal(view.plans.length, 1); assert.equal(s.hospitals.length, 3); assert.equal(s.windowHours, 18);
  assert.equal(s.aggregate.respiratoryCases, 7); assert.equal(s.aggregate.previousWindowRespiratoryCases, 3); assert.equal(s.aggregate.hospitalsAffected, 3);
  assert.equal(s.aggregate.feverCases, null); assert.equal(s.geography.concentrated, true); assert.equal(s.geography.pairs.length, 3);
  assert.equal(view.observations.length, 8); assert.equal(view.resourceEvidence.length, 10); assert.equal(view.receipts.length, 2);
  assert.equal(s.pressureSignal.type, 'hospital.pressure_signal'); assert.equal(view.events.filter(item => item.type === 'regional.hospital_signal.received').length, 1);
  assert.equal(JSON.stringify(view).includes('Demo Alex'), false); assert.equal(view.meta.scope, 'regional');
});
test('window boundaries are half-open, choose latest census and do not sum repeated reports', () => {
  const end = '2026-09-23T12:00:00.000Z', to = Date.parse(end), width = 18 * 3600000;
  const report = (id, when, count) => ({ reportId: id, hospitalId: 'HOSP-001', observedAt: new Date(when).toISOString(), active: count, respiratory: count, emergency: 0, fever: 0, simulation: true });
  const result = summarizeWindows([report('start', to - width, 2), report('latest', to - 1, 3), report('endExcluded', to, 99), report('previousStart', to - 2 * width, 1), report('tooOld', to - 2 * width - 1, 50)], end);
  assert.equal(result[0].current.respiratory, 3); assert.equal(result[0].previous.respiratory, 1); assert.equal(result[1].current, null);
});
test('regional capacity change replans with immutable history, stale approval gate and preserved receipts', async () => {
  const f = await regionalFixture(); await f.service.tick(); const first = await f.service.view();
  await f.service.decide(first.approvals[0].approvalId, 'approved'); await f.service.execute(first.plans[0].revisionId, first.approvals[0].actionId);
  const receipts = (await f.service.view()).receipts; await f.service.decide(first.approvals[1].approvalId, 'approved'); await f.service.changeCapacity(change());
  await assert.rejects(f.service.decide(first.approvals[1].approvalId, 'approved'), { code: 'REGIONAL_STALE_APPROVAL' });
  await assert.rejects(f.service.execute(first.plans[0].revisionId, first.approvals[1].actionId));
  await f.service.tick(); const next = await f.service.view(); assert.equal(next.plans.length, 2); assert.deepEqual(next.plans[0], first.plans[0]);
  for (const receipt of receipts) assert.deepEqual(next.receipts.find(item => item.receiptId === receipt.receiptId), receipt);
  assert.equal(next.currentSnapshot.hospitals.find(item => item.hospitalId === 'HOSP-003').capacity.monitoredBedsAvailable, 0);
});
test('duplicate seed, capacity and ticks do not duplicate snapshots, events or effects', async () => {
  const f = await regionalFixture(); const state = await f.store.read('REGION-DEMO-001');
  await f.service.seed({ requestId: 'demo', windowEnd: state.meta.windowEnd }); await f.service.tick(); const first = await f.service.view();
  await f.service.tick(); await f.service.view(); const same = await f.service.view(); assert.deepEqual(same.snapshots, first.snapshots); assert.deepEqual(same.receipts, first.receipts);
  await f.service.changeCapacity(change()); await f.service.changeCapacity(change()); const next = await f.service.view(); assert.equal(next.events.filter(item => item.eventId === 'capacity_zero').length, 1);
});
test('regional high impact requires approval and expiry/rejection blocks effects', async () => {
  let clock = Date.now(); const f = await regionalFixture({ now: () => clock }); await f.service.tick(); const view = await f.service.view();
  await assert.rejects(f.service.execute(view.plans[0].revisionId, view.approvals[0].actionId)); await f.service.decide(view.approvals[0].approvalId, 'rejected');
  await assert.rejects(f.service.decide(view.approvals[0].approvalId, 'approved')); clock += 600001; await assert.rejects(f.service.decide(view.approvals[1].approvalId, 'approved'));
  assert.equal((await f.service.view()).receipts.length, 2);
});
test('concurrent workers and fresh service do not replay completed actions', async () => {
  const f = await regionalFixture(), other = createRegionalService(f); await Promise.all([f.service.tick(), other.tick()]); const first = await f.service.view();
  assert.equal(first.runs.length, 1); await other.tick(); assert.deepEqual((await other.view()).receipts, first.receipts);
});
test('resource mutation during model call fences the stale proposal', async () => {
  let mutated = false; const f = await regionalFixture({ model: async context => { if (!mutated) { mutated = true; await f.service.changeCapacity(change()); } return regionalAssessment(context); } });
  await f.service.tick(); assert.equal((await f.service.view()).plans.length, 0); await f.service.tick(); assert.equal((await f.service.view()).plans.length, 1);
});
test('model failure preserves regional plan and blocks downstream actions without raw errors', async () => {
  let fail = false; const f = await regionalFixture({ model: async context => { if (fail) throw new Error('raw provider secret'); return regionalAssessment(context); } });
  await f.service.tick(); const before = await f.service.view(); fail = true; await f.service.changeCapacity(change()); await f.service.tick(); const after = await f.service.view();
  assert.deepEqual(after.plans, before.plans); assert.deepEqual(after.receipts, before.receipts); assert.equal(after.meta.ready, false); assert.equal(JSON.stringify(after).includes('raw provider secret'), false);
});
test('controlled language rejects outbreak, pathogen, causal claims and arbitrary prose', async () => {
  const f = await regionalFixture(); const state = await f.store.read('REGION-DEMO-001'); const context = { snapshot: snapshot(state, Date.now()) };
  for (const unsafe of ['confirmed outbreak', 'epidemic confirmed', 'influenza is spreading', 'polluted water caused disease', 'Transmission proven', '<script>alert(1)</script>']) {
    assert.throws(() => validateAssessment({ ...regionalAssessment(context), suspectedSignals: [unsafe] }, context), { code: 'UNSAFE_REGIONAL_ASSESSMENT' });
  }
  assert.throws(() => validateAssessment({ ...regionalAssessment(context), chainOfThought: 'hidden' }, context));
  const result = validateAssessment(regionalAssessment(context), context); assert.equal(result.signal, 'Possible emerging respiratory cluster');
});
test('unsupported suspected cluster is rejected when the evidence shows no increase', async () => {
  const f = await regionalFixture(), state = await f.store.read('REGION-DEMO-001'), s = snapshot(state, Date.now()); s.signals = [];
  assert.throws(() => validateAssessment({ ...regionalAssessment({ snapshot: s }), suspectedSignals: ['possible_cluster'] }, { snapshot: s }));
});
test('regional run budget is finite and does not reset', async () => {
  const f = await regionalFixture(); await f.service.tick(); await f.store.transaction('REGION-DEMO-001', state => { state.meta.runCount = 8; });
  await f.service.requestRun('budget'); await f.service.tick(); const view = await f.service.view(); assert.equal(view.meta.lastError.code, 'REGIONAL_BUDGET_EXHAUSTED'); assert.equal(view.plans.length, 1);
});
test('regional Gemini boundary disables storage/retries and returns only validated selections', async () => {
  const f = await regionalFixture(), state = await f.store.read('REGION-DEMO-001'), context = { snapshot: snapshot(state, Date.now()) }; let calls = 0;
  const model = createRegionalModel({ request: async (input, options) => { calls++; assert.equal(input.store, false); assert.equal(options.maxRetries, 0); return { status: 'completed', output_text: JSON.stringify(regionalAssessment(context)) }; } });
  assert.deepEqual(await model(context), regionalAssessment(context)); assert.equal(calls, 1);
  await assert.rejects(createRegionalModel({ request: async () => ({ status: 'incomplete', output_text: '{}' }) })(context));
});
test('regional geography distinguishes distributed fixtures without inventing a proximity signal', async () => {
  const f = await regionalFixture(), state = await f.store.read('REGION-DEMO-001'); state.resourceEnvironment.hospitals[2].location.latitude += 1;
  const s = snapshot(state, Date.now()); assert.equal(s.geography.concentrated, false); assert.equal(s.signals.includes('geographic_concentration'), false);
});
test('regional report seed cannot overwrite an existing incident or change its window', async () => {
  const f = await regionalFixture(); await assert.rejects(f.service.seed({ requestId: 'replacement', windowEnd: new Date().toISOString() }), { code: 'REGIONAL_ALREADY_SEEDED' });
  await assert.rejects(f.service.changeCapacity({ ...change(), hospitalId: 'HOSP-999' }), { code: 'REGIONAL_SCOPE_VIOLATION' });
});
test('all rendered regional statements resolve to durable snapshot, geography, trend or handoff evidence', async () => {
  const f = await regionalFixture(); await f.service.tick(); const view = await f.service.view(), plan = view.plans[0], s = view.currentSnapshot;
  const refs = [s.snapshotId, s.trendId, s.geography.evidenceId, s.pressureSignal.eventId];
  for (const key of ['observations', 'suspectedSignals', 'supportingEvidence', 'conflictingEvidence', 'uncertainties', 'operationalRisks']) for (const item of plan.assessment[key]) {
    assert(item.evidenceRefs.every(ref => refs.includes(ref) && plan.evidenceRefs.includes(ref)));
  }
});

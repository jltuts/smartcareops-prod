import { test, expect } from '@playwright/test';
import { fixture, observationSet } from '../../backend/tests/clinical-fixtures.js';
import { assessment } from '../../backend/tests/clinical-fixtures.js';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { memoryClinicalStore } from '../../backend/src/clinical/storage.js';
import { createClinicalService } from '../../backend/src/clinical/service.js';
import { routingIntake } from '../../backend/tests/routing-fixtures.js';

async function setup(page) {
  const f = await fixture(); await f.service.append(observationSet()); await f.service.tick();
  await page.route('**/api/clinical**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    try {
      let result;
      if (request.method() === 'GET') result = await f.service.view();
      else if (path.includes('/approvals/')) { result = await f.service.decide(path.split('/').at(-1), request.postDataJSON().decision); await f.service.tick(); }
      else if (path.endsWith('/observations')) { result = await f.service.append(request.postDataJSON()); await f.service.tick(); }
      else throw new Error('Unexpected command');
      await route.fulfill({ json: result });
    } catch { await route.fulfill({ status: 409, json: { code: 'STALE_APPROVAL' } }); }
  });
  await page.goto('/doctor'); await expect(page.getByRole('heading', { name: 'Revision 1 · current' })).toBeVisible();
  return f;
}
test('clinical plan displays evidence/uncertainty, approval produces verified fictional receipt across refresh', async ({ page }) => {
  const f = await setup(page);
  await expect(page.getByText('Explicit fictional history:', { exact: false })).toBeVisible();
  await expect(page.getByText('Fictional data does not establish a diagnosis.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve simulated action' }).click();
  await expect(page.getByText('Verified receipt:', { exact: false })).toBeVisible();
  await page.reload(); await expect(page.getByText('Verified receipt:', { exact: false })).toBeVisible();
  expect((await f.service.view()).receipts).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Refresh cases', exact: true })).toBeVisible();
});
test('reject keeps the simulated action from executing', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText('simulate_clinical_review · APPROVAL REQUIRED · rejected')).toBeVisible();
  expect((await f.service.view()).receipts).toHaveLength(0);
});
test('new fictional observation produces revision 2 and preserves completed revision 1 receipt', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Approve simulated action' }).click();
  await expect(page.getByText('Verified receipt:', { exact: false })).toBeVisible();
  await page.getByLabel('Type', { exact: true }).selectOption('spo2'); await page.getByLabel('Value', { exact: true }).fill('88');
  await page.getByLabel('Observed at', { exact: true }).fill('2026-09-22T02:00');
  await page.getByRole('button', { name: 'Append observation' }).click();
  await expect(page.getByRole('heading', { name: 'PLAN UPDATED · Revision 2 · current' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Revision 1 · superseded' })).toBeVisible();
  expect((await f.service.view()).receipts).toHaveLength(1);
});
test('stale approval click fails safely and refreshed plan exposes no old approval control', async ({ page }) => {
  const f = await setup(page); await f.service.append(observationSet('newEvidence', 88));
  await page.getByRole('button', { name: 'Approve simulated action' }).click();
  await expect(page.getByText('Request could not be confirmed. Refresh to check the durable result.')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh clinical plan' }).click();
  await expect(page.getByRole('button', { name: 'Approve simulated action' })).toHaveCount(0);
  expect((await f.service.view()).receipts).toHaveLength(0);
});

test('persisted Patient case renders separate Gemini Why/Why Not and durable Defer without side effects', async ({ page }) => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(), intake = routingIntake([['dizzy', 'confirmed'], ['chest pain', 'denied']]);
  await caseStore.createCase({ caseId, intake, patientUid: 'patient-1', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  const before = await caseStore.getCase(caseId), clinical = createClinicalService({ caseId, caseStore, store: memoryClinicalStore(), modelName: 'test-model', model: async context => {
    const result = assessment(context); result.hypotheses = [{ summary: 'Vertigo is one possible explanation, not a diagnosis.', evidenceRefs: ['case'] }]; return result;
  } });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url()), result = url.pathname === '/api/doctor/cases' ? await caseStore.listDoctorCases() : await caseStore.getDoctorCase(caseId);
    await route.fulfill({ json: result });
  });
  await page.route('**/api/clinical**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname; let result;
    if (request.method() === 'GET') { result = await clinical.view(); await clinical.tick(); result = await clinical.view(); }
    else if (path.includes('/approvals/')) result = await clinical.decide(path.split('/').at(-1), request.postDataJSON().decision);
    else throw new Error('Unexpected command');
    await route.fulfill({ json: result });
  });
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${caseId}` }).click();
  await expect(page.locator('#doctor-detail')).toContainText('dizzy (confirmed)');
  await expect(page.getByRole('heading', { name: 'AI analysis' })).toBeVisible();
  await expect(page.getByText('Vertigo is one possible explanation, not a diagnosis.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Why not', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What would change the recommendation' })).toBeVisible();
  await page.getByRole('button', { name: 'Defer', exact: true }).click(); await expect(page.getByText('Doctor decision: deferred')).toBeVisible();
  await page.reload(); await expect(page.getByText('Doctor decision: deferred')).toBeVisible();
  expect((await clinical.view()).receipts).toHaveLength(0); expect((await caseStore.getCase(caseId)).handoffStatus).toBe('not_started');
  expect((await caseStore.getCase(caseId)).reportedFacts).toEqual(before.reportedFacts);
});

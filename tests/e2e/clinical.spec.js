import { test, expect } from '@playwright/test';
import { fixture, observationSet } from '../../backend/tests/clinical-fixtures.js';
import { assessment } from '../../backend/tests/clinical-fixtures.js';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { memoryClinicalStore } from '../../backend/src/clinical/storage.js';
import { createClinicalService } from '../../backend/src/clinical/service.js';
import { routingIntake } from '../../backend/tests/routing-fixtures.js';

async function setup(page) {
  const f = await fixture(); await f.service.append(observationSet()); await f.service.tick();
  f.decisionRequests = [];
  await page.route('**/api/clinical**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    try {
      let result;
      if (request.method() === 'GET') result = await f.service.view();
      else if (path.includes('/approvals/')) {
        const body = request.postDataJSON();
        f.decisionRequests.push({ path, body });
        result = await f.service.decide(path.split('/').at(-1), body.decision); await f.service.tick();
      }
      else if (path.endsWith('/observations')) { result = await f.service.append(request.postDataJSON()); await f.service.tick(); }
      else if (path.endsWith('/run')) { result = await f.service.requestRun(request.postDataJSON().requestId); await f.service.tick(); }
      else throw new Error('Unexpected command');
      await route.fulfill({ json: result });
    } catch {
      await route.fulfill({
        status: 409,
        json: { code: 'STALE_APPROVAL', message: 'Clinical demo unavailable for this request. Refresh to review current state.' },
      });
    }
  });
  await page.goto('/doctor'); await expect(page.getByRole('heading', { name: 'Revision 1', exact: true })).toBeVisible();
  return f;
}
test('clinical plan displays evidence/uncertainty, approval produces verified fictional receipt across refresh', async ({ page }) => {
  const f = await setup(page);
  await expect(page.locator('.clinical-plan-current .clinical-decision')).not.toContainText('Case reviewed');
  await expect(page.getByText('Save fictional review receipt · Approval required', { exact: true })).toBeVisible();
  await expect(page.getByText('Explicit fictional history:', { exact: false })).toBeVisible();
  await expect(page.locator('#doctor-analysis-section')).toContainText('Fictional data does not establish a diagnosis.');
  await page.getByText('More AI details', { exact: true }).click();
  await expect(page.getByText('Fictional data does not establish a diagnosis.', { exact: true })).toBeVisible();
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/clinical/approvals/'));
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  expect((await responsePromise).status()).toBe(200);
  await expect(page.getByText('Verified receipt:', { exact: false })).toBeVisible();
  await expect(page.getByText('Approved · Completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Defer', exact: true })).toHaveCount(0);
  expect(f.decisionRequests).toHaveLength(1);
  expect(f.decisionRequests[0].body).toEqual({ decision: 'approved' });
  expect(f.decisionRequests[0].path).toMatch(/^\/api\/clinical\/approvals\/[^/]+$/);
  await page.reload(); await expect(page.getByText('Verified receipt:', { exact: false })).toBeVisible();
  await expect(page.getByText('Approved · Completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  expect((await f.service.view()).receipts).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Refresh cases', exact: true })).toBeVisible();
});
test('reject keeps the simulated action from executing', async ({ page }) => {
  const f = await setup(page);
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/clinical/approvals/'));
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  expect((await responsePromise).status()).toBe(200);
  await expect(page.getByText('Save fictional review receipt · Approval required', { exact: true })).toBeVisible();
  await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  expect(f.decisionRequests).toHaveLength(1);
  expect(f.decisionRequests[0].body).toEqual({ decision: 'rejected' });
  await page.reload();
  await expect(page.getByText('Save fictional review receipt · Approval required', { exact: true })).toBeVisible();
  await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  expect((await f.service.view()).receipts).toHaveLength(0);
});
test('manual AI review with unchanged evidence keeps the current revision', async ({ page }) => {
  const f = await setup(page);
  await page.getByRole('button', { name: 'Run AI review', exact: true }).click();
  await expect(page.locator('#clinical-message')).toHaveText('AI review is already up to date.');
  await expect(page.getByRole('heading', { name: 'Revision 1', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Revision 2', exact: true })).toHaveCount(0);
  expect((await f.service.view()).plans).toHaveLength(1);
});
test('new fictional observation produces revision 2 and preserves completed revision 1 receipt', async ({ page }) => {
  const f = await setup(page); await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Verified receipt:', { exact: false })).toBeVisible();
  expect(await page.locator('#clinical-observe').evaluate(element => {
    const style = getComputedStyle(element), input = getComputedStyle(element.querySelector('input'));
    return style.borderTopWidth === '4px' && style.borderRadius !== '0px' && input.minHeight === '44px';
  })).toBe(true);
  await page.getByLabel('Type', { exact: true }).selectOption('spo2'); await page.getByLabel('Value', { exact: true }).fill('88');
  await page.getByLabel('Observed at', { exact: true }).fill('2026-09-22T02:00');
  await page.getByRole('button', { name: 'Append observation' }).click();
  await expect(page.getByRole('heading', { name: 'Revision 2', exact: true })).toBeVisible();
  await expect(page.locator('.clinical-plan-historical')).toContainText('Revision 1 · superseded');
  await expect(page.locator('.clinical-plan-historical .clinical-decision-result')).toHaveText('Completed');
  await expect(page.locator('.clinical-plan-historical')).toContainText('Verified receipt:');
  expect((await f.service.view()).receipts).toHaveLength(1);
});
test('historical rejected decision remains visible without stale actions', async ({ page }) => {
  const f = await setup(page);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
  await f.service.append(observationSet('newEvidence', 88)); await f.service.tick();
  await page.getByRole('button', { name: 'Refresh AI review' }).click();
  const historical = page.locator('.clinical-plan-historical');
  await expect(historical.locator('.clinical-decision-result')).toHaveText('Rejected');
  await expect(historical.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(historical.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  await expect(historical.getByRole('button', { name: 'Defer', exact: true })).toHaveCount(0);
});
test('clinical status messages use the original size with teal italic emphasis', async ({ page }) => {
  const f = await setup(page);
  const status = page.locator('#clinical-message');
  await expect(status.locator('[data-icon="success"] svg')).toHaveCount(1);
  await f.store.transaction(f.caseId, state => { state.meta.ready = false; });
  await page.getByRole('button', { name: 'Refresh AI review' }).click();
  await expect(status).toHaveText('Waiting for a valid assessment. Previous plans are historical; actions remain gated.');
  await expect(status.locator('[data-icon="waiting"] svg')).toHaveCount(1);
  expect(await status.evaluate(element => {
    const style = getComputedStyle(element);
    return style.fontStyle === 'italic' && style.fontSize === '13px' && style.color === 'rgb(23, 127, 116)' && style.backgroundColor === 'rgba(0, 0, 0, 0)';
  })).toBe(true);
});
test('stale approval click fails safely and refreshed plan keeps old controls disabled', async ({ page }) => {
  const f = await setup(page); await f.service.append(observationSet('newEvidence', 88));
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Clinical demo unavailable for this request. Refresh to review current state.')).toBeVisible();
  await expect(page.getByText('This recommendation was superseded and is no longer actionable.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  expect(f.decisionRequests).toHaveLength(1);
  await page.getByRole('button', { name: 'Approve', exact: true }).click({ force: true });
  expect(f.decisionRequests).toHaveLength(1);
  expect((await f.service.view()).receipts).toHaveLength(0);
});

test('current expired Doctor decision remains visible but cannot bypass approval expiry', async ({ page }) => {
  const f = await setup(page);
  await f.store.transaction(f.caseId, state => {
    const approval = Object.values(state.approvals).find(item => item.revisionId === state.meta.currentRevisionId);
    approval.status = 'expired';
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Doctor decision', exact: true })).toBeVisible();
  await expect(page.getByText('Decision window expired. This recommendation is no longer actionable.')).toBeVisible();
  for (const name of ['Approve', 'Reject', 'Defer']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Approve', exact: true }).click({ force: true });
  expect(f.decisionRequests).toHaveLength(0);
});

test('expired approval state disables actions even if action projection says pending', async ({ page }) => {
  const f = await setup(page);
  await page.route('**/api/clinical**', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const data = await f.service.view();
    const action = data.plans.find(plan => plan.status === 'current').recommendedActions.find(item => item.approvalRequired);
    data.approvals.find(item => item.approvalId === action.approvalId).status = 'expired';
    action.status = 'pending';
    await route.fulfill({ json: data });
  });
  await page.getByRole('button', { name: 'Refresh AI review' }).click();
  await expect(page.getByText('Decision window expired. This recommendation is no longer actionable.')).toBeVisible();
  for (const name of ['Approve', 'Reject', 'Defer']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  expect(f.decisionRequests).toHaveLength(0);
});

test('persisted Doctor case remains stable for 60 seconds while polling and saves one decision', async ({ page }) => {
  test.setTimeout(90000);
  const f = await setup(page);
  let navigations = 0;
  const onNavigation = frame => { if (frame === page.mainFrame()) navigations++; };
  page.on('framenavigated', onNavigation);
  await page.evaluate(() => {
    const content = document.querySelector('#clinical-content');
    window.__doctorIdleState = { decision: content.querySelector('.clinical-decision'), mutations: 0 };
    window.__doctorIdleObserver = new MutationObserver(records => {
      window.__doctorIdleState.mutations += records.filter(record => record.type === 'childList').length;
    });
    window.__doctorIdleObserver.observe(content, { childList: true, subtree: true });
  });
  await page.waitForTimeout(60500);
  expect(navigations).toBe(0);
  expect(await page.evaluate(() => ({
    sameDecisionNode: document.querySelector('.clinical-decision') === window.__doctorIdleState.decision,
    mutations: window.__doctorIdleState.mutations,
  }))).toEqual({ sameDecisionNode: true, mutations: 0 });
  for (const name of ['Approve', 'Reject', 'Defer']) await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/clinical/approvals/'));
  await page.getByRole('button', { name: 'Defer', exact: true }).click();
  expect((await responsePromise).status()).toBe(200);
  await expect(page.locator('.clinical-technical-details')).toContainText('Recommended action decision: deferred');
  await expect(page.getByText('Deferred', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Defer', exact: true })).toHaveCount(0);
  expect(f.decisionRequests).toHaveLength(1);
  expect(f.decisionRequests[0].body).toEqual({ decision: 'deferred' });
  page.off('framenavigated', onNavigation);
  await page.reload();
  await expect(page.locator('.clinical-technical-details')).toContainText('Recommended action decision: deferred');
  await expect(page.getByText('Deferred', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Defer', exact: true })).toHaveCount(0);
});

test('persisted Patient case explains the recommendation and keeps durable Defer without side effects', async ({ page }) => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(), intake = routingIntake([['dizzy', 'confirmed'], ['chest pain', 'denied']]);
  await caseStore.createCase({ caseId, intake, patientUid: 'patient-1', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  const before = await caseStore.getCase(caseId), clinical = createClinicalService({ caseId, caseStore, store: memoryClinicalStore(), modelName: 'test-model', model: async context => {
    const result = assessment(context);
    result.hypotheses = [
      { summary: 'Vertigo is one possible explanation, not a diagnosis.', evidenceRefs: ['case'] },
      { summary: 'Primary headache disorder (e.g., tension-type headache or migraine) versus non-emergent secondary headache.', evidenceRefs: ['case'] },
    ];
    result.whyRecommended = [{ summary: 'Objective vital sign measurement and clinical examination are required to properly evaluate the headache and exclude underlying secondary causes.', evidenceRefs: ['case'] }];
    result.alternatives = [{ step: 'Emergency ambulance dispatch', whyNot: 'Safety assessment returned emergency status false with no intake red flags matched.', evidenceRefs: ['case'] }];
    result.whatWouldChangeRecommendation = ["Development of severe acute headache ('thunderclap'), focal neurological deficits, altered consciousness, fever, or neck stiffness.", 'Abnormal vital signs upon direct clinical assessment.'];
    return result;
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
  await expect(page.getByRole('heading', { name: 'Patient report', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What Gemini found' })).toBeVisible();
  await page.getByText('More AI details', { exact: true }).click();
  await expect(page.locator('.clinical-hypotheses')).toContainText('Vertigo is one possible explanation, not a diagnosis.');
  await expect(page.getByText('Migraine, tension headache, or another non-emergency cause. These are possibilities, not diagnoses.', { exact: true })).toBeVisible();
  await expect(page.locator('.doctor-evidence-zone')).not.toContainText('Vertigo is one possible explanation');
  await page.getByText('Why this is suggested', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reason for this step', exact: true })).toBeVisible();
  await expect(page.getByText('A check of the patient’s vital signs and an examination are needed to evaluate the headache and rule out serious causes.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why emergency care was not suggested', exact: true })).toBeVisible();
  await expect(page.getByText('The intake did not identify emergency warning signs.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'When this recommendation should change', exact: true })).toBeVisible();
  await expect(page.getByText('A sudden, extremely severe headache, weakness or numbness, confusion or fainting, fever, or neck stiffness.', { exact: true })).toBeVisible();
  await page.locator('#doctor-recommendation-section').getByText('Technical details', { exact: true }).click();
  await expect(page.getByText('Objective vital sign measurement and clinical examination are required to properly evaluate the headache and exclude underlying secondary causes. · Source: case record', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Doctor decision', exact: true })).toBeVisible();
  await expect(page.locator('#doctor-decision-section')).toHaveCSS('position', 'static');
  const caseNav = page.getByRole('navigation', { name: 'Case review sections' });
  await expect(caseNav).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  const pageScrollBefore = await page.evaluate(() => scrollY);
  await caseNav.getByRole('button', { name: 'AI summary' }).click();
  await expect(caseNav.getByRole('button', { name: 'AI summary' })).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('#doctor-analysis-section').getByRole('heading', { name: 'What Gemini found' })).toBeFocused();
  await expect.poll(() => page.locator('#doctor-review-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(pageScrollBefore);
  await caseNav.getByRole('button', { name: 'Next step' }).click();
  await expect(page.locator('#doctor-recommendation-section').getByRole('heading', { name: 'What to do next' })).toBeFocused();
  await caseNav.getByRole('button', { name: 'Decision' }).click();
  await expect(page.locator('#doctor-decision-section').getByRole('heading', { name: 'Doctor decision' })).toBeFocused();
  expect(await page.evaluate(() => {
    const evidence = document.querySelector('.doctor-evidence-zone'), analysis = document.querySelector('.clinical-analysis'), recommendation = document.querySelector('.clinical-explanation'), decision = document.querySelector('.clinical-decision');
    return [evidence, analysis, recommendation].every((item, index) => item.compareDocumentPosition([analysis, recommendation, decision][index]) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBeTruthy();
  await page.getByRole('button', { name: 'Defer', exact: true }).click();
  await expect(page.locator('.clinical-technical-details')).toContainText('Recommended action decision: deferred');
  await page.reload(); await expect(page.locator('.clinical-technical-details')).toContainText('Recommended action decision: deferred');
  expect((await clinical.view()).receipts).toHaveLength(0); expect((await caseStore.getCase(caseId)).handoffStatus).toBe('not_started');
  expect((await caseStore.getCase(caseId)).reportedFacts).toEqual(before.reportedFacts);
});

test('pending Live case without approvable AI actions has an independent durable Doctor decision', async ({ page }) => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(), intake = routingIntake();
  await caseStore.createCase({ caseId, intake, patientUid: 'patient-1', submittedForReview: true,
    intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  const clinical = createClinicalService({ caseId, caseStore, store: memoryClinicalStore(), modelName: 'test-model', model: async context => {
    const result = assessment(context);
    result.hypotheses = [{ summary: 'Several explanations remain possible and require Doctor review.', evidenceRefs: ['case'] }];
    result.recommendedActions = [{ toolName: 'read_case', expectedOutcome: 'Review the persisted patient-reported case.', proposedRisk: 'READ_ONLY' }];
    return result;
  } });
  await clinical.view(); await clinical.tick();
  const requests = [];
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url()), result = url.pathname === '/api/doctor/cases' ? await caseStore.listDoctorCases() : await caseStore.getDoctorCase(caseId);
    await route.fulfill({ json: result });
  });
  await page.route('**/api/clinical**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: await clinical.view() });
    if (path === '/api/clinical/case-review') {
      const body = request.postDataJSON(); requests.push(body);
      await new Promise(resolve => setTimeout(resolve, 150));
      return route.fulfill({ json: await clinical.decideCaseReview(body.requestId, body.decision, 'doctor-1') });
    }
    throw new Error('Unexpected clinical command');
  });
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${caseId}` }).click();
  await expect(page.getByRole('heading', { name: 'Doctor decision', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve case review' })).toBeEnabled();
  await expect(page.locator('.clinical-plan-current')).not.toContainText('APPROVAL REQUIRED');
  await expect(page.locator('.clinical-plan-current .clinical-decision')).toHaveCount(0);
  await page.getByText('Activity and monitoring', { exact: true }).click();
  await expect(page.locator('.clinical-technical-details')).toContainText('Case reviewed');
  const response = page.waitForResponse(item => item.url().includes('/api/clinical/case-review'));
  await page.getByRole('button', { name: 'Approve case review' }).click();
  await expect(page.getByText('Saving doctor decision…', { exact: true })).toBeVisible();
  expect((await response).status()).toBe(200); expect(requests).toHaveLength(1);
  await expect(page.getByText('Recommendation accepted · Saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve case review' })).toHaveCount(0);
  const patient = await caseStore.getPatientCase(caseId, 'patient-1');
  expect(patient.clinicalReview.status).toBe('approved'); expect(patient.handoffStatus).toBe('not_started');
  expect(patient.routing).toBeNull(); expect(patient.ambulance).toBeNull(); expect((await clinical.view()).receipts).toHaveLength(0);
  await page.reload();
  await expect(page.getByText('Recommendation accepted · Saved', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('case review save failure preserves an actionable retry with one request per tap', async ({ page }) => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId();
  await caseStore.createCase({ caseId, intake: routingIntake(), patientUid: 'patient-1', submittedForReview: true,
    intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  const clinical = createClinicalService({ caseId, caseStore, store: memoryClinicalStore(), modelName: 'test-model', model: async () => { throw new Error('unused'); } });
  await clinical.view(); const requests = [];
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url()), result = url.pathname === '/api/doctor/cases' ? await caseStore.listDoctorCases() : await caseStore.getDoctorCase(caseId);
    await route.fulfill({ json: result });
  });
  await page.route('**/api/clinical**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: await clinical.view() });
    if (path === '/api/clinical/case-review') {
      const body = request.postDataJSON(); requests.push(body);
      if (requests.length === 1) return route.fulfill({ status: 503, json: { code: 'CLINICAL_UNAVAILABLE', message: 'Doctor decision could not be saved. Retry after reviewing the current case state.' } });
      return route.fulfill({ json: await clinical.decideCaseReview(body.requestId, body.decision, 'doctor-1') });
    }
    throw new Error('Unexpected clinical command');
  });
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${caseId}` }).click();
  const approve = page.getByRole('button', { name: 'Approve case review' });
  await approve.click();
  await expect(page.locator('#doctor-decision-section').getByText('Doctor decision could not be saved. Retry after reviewing the current case state.')).toBeVisible();
  await expect(approve).toBeEnabled(); expect(requests).toHaveLength(1);
  await approve.click(); await expect(page.getByText('Recommendation accepted · Saved', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1].requestId).toBe(requests[0].requestId);
  await page.reload(); await expect(page.getByText('Recommendation accepted · Saved', { exact: true })).toBeVisible();
});

test('Doctor clinical workflow respects reduced motion and stays responsive', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  await expect(page.locator('.clinical-plan')).toHaveCSS('transform', 'none');
  await expect(page.getByRole('heading', { name: 'What Gemini found' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What to do next' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Doctor decision' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

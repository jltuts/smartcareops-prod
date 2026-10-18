import { test, expect } from '@playwright/test';
import { installGoogleMapsStub } from './helpers/google-maps.js';

test('empty Patient home offers intake without claiming completed care', async ({ page }) => {
  await page.route('**/api/cases?*', route => route.fulfill({ json: { cases: [], nextCursor: null, storage: 'firestore' } }));
  await page.goto('/patient');
  await expect(page.getByRole('heading', { name: 'How would you like to answer?' })).toBeVisible();
  const journey = page.getByRole('list', { name: 'Care journey stages' });
  await expect(journey).toBeVisible();
  await expect(journey.getByRole('listitem')).toHaveCount(6);
  await expect(journey.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(page.locator('.patient-sidebar [data-patient-view-link="home"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.patient-mobile-nav [data-patient-view-link="home"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.patient-journey-steps .complete')).toHaveCount(0);
  await expect(page.locator('.patient-journey-steps .current')).toHaveCount(0);
  await expect(page.locator('.patient-journey-steps > div').nth(4)).toContainText('Next Step');
  await expect(page.locator('.patient-journey-steps > div').nth(5)).toContainText('Follow-up');
  await expect(page.locator('.patient-journey-steps')).not.toContainText('Hospital');
  await expect(page.locator('#patient-recent-activity')).toContainText('No saved cases yet');
  await expect(page.locator('.patient-start-link')).toBeVisible();
  await expect(page.locator('.patient-view-case')).toBeHidden();
  await expect(page.locator('#patient-transport-action')).toBeHidden();
});

test('Patient care journey exposes completed and current stages without changing its labels', async ({ page }) => {
  const caseId = 'SC-20000000-0000-4000-8000-000000000013';
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.route(`**/api/cases/${caseId}`, route => route.fulfill({ json: {
    caseId,
    storage: 'firestore',
    workflowStatus: 'submitted_for_clinical_review',
    clinicalReview: { status: 'approved' },
  } }));
  await page.goto('/patient');

  const journey = page.getByRole('list', { name: 'Care journey stages' });
  await expect(journey.getByRole('listitem')).toHaveCount(6);
  await expect(journey.locator('.complete').first()).toHaveAccessibleName('1. First Contact, complete');
  await expect(journey.locator('[aria-current="step"]')).toHaveAccessibleName('6. Review Complete, current step');
  await expect(journey.locator('[aria-current="step"]')).toContainText('Review Complete');
});

test('missing stored Patient case clears active dashboard state and stops polling', async ({ page }) => {
  const caseId = 'SC-20000000-0000-4000-8000-000000000011';
  let reads = 0;
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.route('**/api/cases?*', route => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route(`**/api/cases/${caseId}`, route => { reads++; return route.fulfill({ status: 404, json: { code: 'CASE_NOT_FOUND', message: 'Patient case could not be retrieved.' } }); });
  await page.goto('/patient');
  await expect(page.getByRole('heading', { name: 'How would you like to answer?' })).toBeVisible();
  await expect(page.locator('.patient-start-link')).toBeVisible();
  await expect(page.locator('.patient-view-case')).toBeHidden();
  await expect(page.locator('.patient-active-details')).toBeHidden();
  await expect(page.locator('#patient-case')).toBeHidden();
  await expect(page.locator('.patient-journey-steps .complete, .patient-journey-steps .current')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('smartcareops-case-id'))).toBeNull();
  const readsAfterReset = reads;
  await page.waitForTimeout(5500);
  expect(reads).toBe(readsAfterReset);
});

test('temporary Patient case failure retains the active case for retry', async ({ page }) => {
  const caseId = 'SC-20000000-0000-4000-8000-000000000012';
  let reads = 0;
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.route('**/api/cases?*', route => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route(`**/api/cases/${caseId}`, route => {
    reads++;
    return route.fulfill({ status: 503, json: { code: 'CASE_STORE_UNAVAILABLE' } });
  });
  await page.goto('/patient');
  await expect(page.locator('#patient-case-storage')).toHaveCount(0);
  await expect(page.locator('#patient-case-status')).toHaveText('Awaiting saved case');
  await expect(page.getByRole('heading', { name: 'Your care is in progress.' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('smartcareops-case-id'))).toBe(caseId);
  const readsBeforeRetry = reads;
  await page.waitForTimeout(5500);
  expect(reads).toBeGreaterThan(readsBeforeRetry);
});

test('Patient conversation badge gives factual fictional-demo guidance without privacy guarantees', async ({ page }) => {
  await page.goto('/patient');
  await page.locator('[data-intake-mode="voice"]').first().click();
  await expect(page.locator('.patient-live-badge')).toHaveText('Fictional details only');
  await expect(page.locator('.conversation-intro')).toContainText('share only fictional details for this demo');
  await expect(page.locator('.conversation-panel')).not.toContainText(/private\s*&\s*secure/i);
});

test('saved transport case replaces intake hero with status and keeps map readable on mobile', async ({ page }) => {
  const caseId = 'SC-20000000-0000-4000-8000-000000000001';
  await installGoogleMapsStub(page);
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.route(`**/api/cases/${caseId}`, route => route.fulfill({ json: {
    caseId, storage: 'memory', workflowStatus: 'ambulance_en_route', emergency: { status: 'acknowledged' },
    ambulance: { unitId: 'AMB-01', status: 'en_route' },
    routing: { status: 'routed', hospitalId: 'HOSP-001' },
  } }));
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/patient');
  await expect(page.locator('#patient-current-status')).toHaveText('Ambulance en route — simulation');
  await expect(page.locator('.patient-start-link')).toBeHidden();
  await expect(page.locator('.patient-view-case')).toBeVisible();
  await expect(page.locator('#patient-transport-action')).toBeVisible();
  await expect(page.locator('.patient-journey-steps .current')).toContainText('Transport');
  await expect(page.locator('.patient-journey-steps .current')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.patient-journey-steps .current')).toHaveAccessibleName('5. Transport, current step');
  await expect(page.locator('.patient-journey-steps .complete').first()).toHaveAccessibleName('1. First Contact, complete');
  await expect(page.locator('.patient-journey-steps > div').nth(5)).toContainText('Hospital');
  await expect(page.locator('.patient-journey-steps > div').nth(2)).not.toHaveClass(/complete/);
  await expect(page.locator('#patient-transport-destination')).toHaveText('Northstar General');
  await expect(page.locator('#patient-transport-eta')).toHaveText('Not available');
  await expect(page.locator('#patient-transport-map .google-map-canvas')).toHaveAttribute('data-map-ready', 'true');
  await expect(page.locator('.patient-mobile-nav')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('My Cases renders durable safe summaries and opens an owned case on desktop and mobile', async ({ page }) => {
  const caseId = 'SC-20000000-0000-4000-8000-000000000002';
  await page.route('**/api/cases?*', route => route.fulfill({ json: { storage: 'firestore', nextCursor: null, cases: [{
    caseId, intakeDate: '2026-09-29T01:00:00.000Z', workflowStatus: 'submitted_for_clinical_review',
    clinicalReview: { status: 'approved', updatedAt: '2026-09-29T02:00:00.000Z' }, nextStep: 'Your clinical review is complete. Review the recorded decision below.',
    doctorAttribution: { status: 'available', displayName: 'Dr. Fictional Rivera', specialty: 'general_medicine' },
  }] } }));
  await page.route(`**/api/cases/${caseId}`, route => route.fulfill({ json: { caseId, createdAt: '2026-09-29T01:00:00.000Z', storage: 'firestore',
    workflowStatus: 'submitted_for_clinical_review', handoffStatus: 'not_started', routing: null, emergency: null, ambulance: null,
    clinicalReview: { status: 'approved', updatedAt: '2026-09-29T02:00:00.000Z' }, doctorAttribution: { status: 'available', displayName: 'Dr. Fictional Rivera', specialty: 'general_medicine' },
  } }));
  await page.setViewportSize({ width: 412, height: 915 }); await page.goto('/patient');
  await expect(page.locator('#patient-recent-activity')).toContainText('Clinical review approved');
  await expect(page.locator('#patient-recent-activity')).toContainText('Dr. Fictional Rivera');
  await page.locator(`[data-case-id="${caseId}"]`).click();
  await expect(page.locator('#patient-case')).toBeVisible(); await expect(page.locator('#patient-case-doctor-row')).toContainText('Dr. Fictional Rivera');
  await expect(page.locator('.patient-journey-steps > div').nth(4)).toContainText('Doctor Decision');
  await expect(page.locator('.patient-journey-steps .current')).toContainText('Follow-up');
  await expect(page.locator('.patient-journey-steps')).not.toContainText('Hospital');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 412, height: 915 }]) {
  test(`Patient home shows one newest case and My Cases automatically loads every page on ${viewport.name}`, async ({ page }) => {
    const records = [
      { caseId: 'SC-21000000-0000-4000-8000-000000000003', intakeDate: '2026-09-29T03:00:00.000Z' },
      { caseId: 'SC-21000000-0000-4000-8000-000000000002', intakeDate: '2026-09-29T02:00:00.000Z' },
      { caseId: 'SC-21000000-0000-4000-8000-000000000001', intakeDate: '2026-09-29T01:00:00.000Z' },
    ].map(record => ({ ...record, workflowStatus: 'submitted_for_clinical_review', clinicalReview: { status: 'pending' }, nextStep: 'Waiting for clinical review.' }));
    const cursorRequests = new Map(); let paginationActive = 0, maxPaginationActive = 0;
    await page.route('**/api/cases?*', async route => {
      const url = new URL(route.request().url()), cursor = url.searchParams.get('cursor');
      cursorRequests.set(cursor || 'initial', (cursorRequests.get(cursor || 'initial') || 0) + 1);
      if (cursor) { paginationActive += 1; maxPaginationActive = Math.max(maxPaginationActive, paginationActive); }
      await new Promise(resolve => setTimeout(resolve, 40));
      if (cursor) paginationActive -= 1;
      if (!cursor) { expect(url.searchParams.get('limit')).toBe('1'); return route.fulfill({ json: { storage: 'firestore', cases: [records[0]], nextCursor: 'page-2' } }); }
      if (Number(url.searchParams.get('limit')) > 20) return route.fulfill({ status: 400, json: { code: 'INVALID_CASE_QUERY' } });
      expect(url.searchParams.get('limit')).toBe('20');
      if (cursor === 'page-2') return route.fulfill({ json: { storage: 'firestore', cases: [records[1], records[0]], nextCursor: 'page-3' } });
      return route.fulfill({ json: { storage: 'firestore', cases: [records[2]], nextCursor: null } });
    });
    await page.setViewportSize(viewport); await page.goto('/patient');
    const summary = page.locator('#patient-recent-activity');
    await expect(summary.locator('.patient-case-history-item')).toHaveCount(1);
    await expect(summary.locator('.patient-case-history-item')).toHaveAttribute('data-case-id', records[0].caseId);
    await expect(page.locator('#patient-cases-view')).toBeHidden();

    const navigation = viewport.name === 'mobile' ? page.locator('.patient-mobile-nav') : page.locator('.patient-sidebar');
    await navigation.getByRole('link', { name: 'My Cases' }).click();
    await expect(navigation.getByRole('link', { name: 'My Cases' })).toHaveAttribute('aria-current', 'page');
    await expect(navigation.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#patient-home-view')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'My Cases', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How would you like to answer?' })).toBeHidden();
    const full = page.locator('#patient-case-history-full');
    await expect(full.locator('.patient-case-history-item')).toHaveCount(3);
    expect(await full.locator('.patient-case-history-item').evaluateAll(items => items.map(item => item.dataset.caseId))).toEqual(records.map(record => record.caseId));
    expect(new Set(await full.locator('.patient-case-history-item').evaluateAll(items => items.map(item => item.dataset.caseId))).size).toBe(3);
    expect(cursorRequests.get('page-2')).toBe(1); expect(cursorRequests.get('page-3')).toBe(1); expect(maxPaginationActive).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('My Cases retains loaded pages and retries only the failed pagination cursor', async ({ page }) => {
  const records = [3, 2, 1].map(number => ({ caseId: `SC-22000000-0000-4000-8000-00000000000${number}`, intakeDate: `2026-09-29T0${number}:00:00.000Z`, workflowStatus: 'submitted_for_clinical_review', clinicalReview: { status: 'pending' } }));
  let pageThreeAttempts = 0;
  await page.route('**/api/cases?*', route => {
    const url = new URL(route.request().url()), cursor = url.searchParams.get('cursor');
    if (!cursor) return route.fulfill({ json: { cases: [records[0]], nextCursor: 'page-2' } });
    expect(url.searchParams.get('limit')).toBe('20');
    if (cursor === 'page-2') return route.fulfill({ json: { cases: [records[1]], nextCursor: 'page-3' } });
    pageThreeAttempts += 1;
    if (pageThreeAttempts === 1) return route.fulfill({ status: 503, json: { code: 'CASES_UNAVAILABLE' } });
    return route.fulfill({ json: { cases: [records[2], records[1]], nextCursor: null } });
  });
  await page.goto('/patient#cases');
  const full = page.locator('#patient-case-history-full');
  await expect(full.locator('.patient-case-history-item')).toHaveCount(2);
  await expect(full).toContainText('The cases already shown are unchanged');
  await full.getByRole('button', { name: 'Try again' }).click();
  await expect(full.locator('.patient-case-history-item')).toHaveCount(3);
  expect(await full.locator('.patient-case-history-item').evaluateAll(items => items.map(item => item.dataset.caseId))).toEqual(records.map(record => record.caseId));
  await expect(full.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(pageThreeAttempts).toBe(2);
});

test('My Cases shows the Patient-approved image and context, with an honest unavailable state on mobile', async ({ page }) => {
  const caseId = 'SC-30000000-0000-4000-8000-000000000003', unavailableCaseId = 'SC-30000000-0000-4000-8000-000000000004', evidenceId = 'body-area-123', unavailableEvidenceId = 'body-area-124';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4eYAAAAASUVORK5CYII=', 'base64');
  const entry = { evidenceId, kind: 'body_area', label: 'Pain location', patientDescription: 'I feel pain on the outer part of my left shoulder.', status: 'available', mimeType: 'image/png', byteLength: png.length, capturedAt: '2026-09-29T01:00:00.000Z' };
  const packageEntry = { ...entry, evidenceId: 'medicine-package', kind: 'medicine_package', label: 'Medicine package', patientDescription: 'Patient reports: one each morning.' };
  const unavailableEntry = { ...entry, evidenceId: unavailableEvidenceId, patientDescription: 'The patient description remains available.' };
  await page.route('**/api/cases?*', route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const id = cursor ? unavailableCaseId : caseId;
    return route.fulfill({ json: { storage: 'firestore', nextCursor: cursor ? null : 'older-page', cases: [{
      caseId: id, intakeDate: '2026-09-29T01:00:00.000Z', workflowStatus: 'submitted_for_clinical_review', clinicalReview: { status: 'pending' }, nextStep: 'Waiting for clinical review.'
    }] } });
  });
  for (const [id, item] of [[caseId, entry], [unavailableCaseId, unavailableEntry]]) {
    await page.route(`**/api/cases/${id}`, route => route.fulfill({ json: { caseId: id, createdAt: '2026-09-29T01:00:00.000Z', storage: 'firestore',
      workflowStatus: 'submitted_for_clinical_review', handoffStatus: 'not_started', reportedFacts: { symptoms: [], redFlags: [] }, patientEvidence: id === caseId ? [item, packageEntry] : [item],
      medications: id === caseId ? [{ name: 'Fictionalmed', strength: '25 mg', howTaken: 'one each morning', source: 'packaging_shown', verification: 'patient_reported' }] : [] } }));
  }
  await page.route(`**/api/cases/${caseId}/evidence/${evidenceId}`, async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.fulfill({ status: 200, body: png, contentType: 'image/png' }); });
  await page.route(`**/api/cases/${caseId}/evidence/medicine-package`, route => route.fulfill({ status: 200, body: png, contentType: 'image/png' }));
  await page.route(`**/api/cases/${unavailableCaseId}/evidence/${unavailableEvidenceId}`, route => route.fulfill({ status: 503, json: { code: 'CASE_EVIDENCE_UNAVAILABLE' } }));
  await page.setViewportSize({ width: 412, height: 915 }); await page.goto('/patient');
  await page.locator(`[data-case-id="${caseId}"]`).click();
  const evidence = page.locator('#patient-case-evidence');
  await expect(evidence).toContainText('Loading your shared image…');
  await expect(evidence).toContainText('I feel pain on the outer part of my left shoulder.');
  await expect(evidence).toContainText('not a diagnosis or verified anatomical finding');
  await expect(evidence.getByRole('img', { name: 'Image you shared: Pain location' })).toBeVisible();
  await expect(evidence).toContainText('Patient-reported; packaging shown: Fictionalmed · 25 mg. Not clinically verified.');
  await expect(evidence.getByRole('img', { name: 'Image you shared: Medicine package' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 }); await expect(evidence.getByRole('img').first()).toBeVisible();
  await expect(page.locator(`[data-case-id="${unavailableCaseId}"]`)).toBeVisible();
  await page.locator(`[data-case-id="${unavailableCaseId}"]`).click();
  await expect(evidence).toContainText('The shared image is temporarily unavailable. Your description remains saved.');
  await expect(evidence.getByRole('img')).toHaveCount(0);
});

test('narrow Patient layout fits and reduced motion keeps the listening visual still', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/patient');
  await expect(page.locator('.patient-mobile-nav')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.conversation-panel').evaluate(panel => { panel.dataset.audioState = 'listening'; });
  expect(await page.locator('.patient-voice-visual span').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none');
});

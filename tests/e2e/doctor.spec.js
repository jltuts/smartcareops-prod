import { test, expect } from '@playwright/test';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { routingIntake } from '../../backend/tests/routing-fixtures.js';
import { emergencyIntake } from '../../backend/tests/safety-fixtures.js';
import { createMemoryUserProfileStore } from '../../backend/src/user-profiles.js';
import { patientDisplayName } from '../../src/pages/doctor/patient-name.js';

test('patient names use trusted structured parts and preserve unstructured fallback without parsing', () => {
  expect(patientDisplayName({ firstName: 'John Louis', middleName: 'Miguel', lastName: 'De la Cruz' })).toBe('De la Cruz, John Louis M.');
  expect(patientDisplayName({ firstName: 'Maria Clara', lastName: 'Santos-Reyes' })).toBe('Santos-Reyes, Maria Clara');
  expect(patientDisplayName({}, { name: 'Garcia John Louis Miguel' })).toBe('Garcia John Louis Miguel');
  expect(patientDisplayName({ displayName: 'Single Display Value' })).toBe('Single Display Value');
});

// Browser rendering tests use real routing/service projections behind intercepted
// requests. Backend HTTP and live DEV verification separately cover transport.
async function fixture(page) {
  const store = createMemoryCaseStore(), id = newCaseId();
  const doctorUid = 'verified-neurology-doctor', at = '2026-09-25T00:00:00.000Z';
  const profiles = createMemoryUserProfileStore(new Map([[doctorUid, {
    uid: doctorUid, email: 'neurology-doctor@example.invalid', displayName: 'Dr Test Neurologist',
    roles: ['patient'], status: 'active', createdAt: at, updatedAt: at,
    doctorApplication: { status: 'pending', displayName: 'Dr Test Neurologist', specialty: 'neurology', submittedAt: at },
  }]]));
  await profiles.reviewDoctorApplication(doctorUid, { decision: 'approved', reviewedBy: 'admin-fixture', independentlyVerified: true });
  const routeCase = async caseId => store.routeCase(caseId, { availableSpecialties: await profiles.listVerifiedSpecialties() });
  await store.createCase({ caseId: id, intake: routingIntake([['dizziness', 'confirmed'], ['chest pain', 'denied'], ['difficulty breathing', 'denied']]) });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    try {
      const record = url.pathname === '/api/doctor/cases' ? await store.listDoctorCases({ after: url.searchParams.get('after') || undefined }) : await store.getDoctorCase(url.pathname.split('/').at(-1));
      await route.fulfill({ json: record });
    } catch { await route.fulfill({ status: 404, json: { code: 'CASE_NOT_FOUND' } }); }
  });
  await page.route(`**/api/cases/${id}`, async route => route.fulfill({ json: await store.getCase(id) }));
  await page.route(`**/api/cases/${id}/route`, async route => {
    expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({});
    await route.fulfill({ json: await routeCase(id) });
  });
  return { store, id, routeCase };
}
test('patient displays status only; doctor queue, detail and refresh show persisted route and denied facts', async ({ page }) => {
  const { store, id, routeCase } = await fixture(page);
  await page.addInitScript(caseId => sessionStorage.setItem('smartcareops-case-id', caseId), id);
  await routeCase(id);
  await page.goto('/patient');
  await expect(page.locator('#patient-case-routing')).toHaveText('Routed to Neurology for review.');
  await expect(page.locator('#patient-case-status')).toHaveText('Routed to doctor');
  await expect(page.getByRole('button', { name: 'Route to doctor', exact: true })).toBeHidden();
  const timestamp = (await store.getCase(id)).routing.routedAt;
  await page.goto('/doctor');
  await expect(page.locator('.doctor-card')).toHaveCount(1);
  await expect(page.locator('.doctor-card')).toContainText('Demo Alex');
  await expect(page.locator('.doctor-card')).toContainText('Neurology');
  await page.getByRole('button', { name: `Open case ${id}`, exact: true }).click();
  await expect(page.locator('#doctor-detail')).toContainText('Intake summary');
  await expect(page.locator('#doctor-detail')).toContainText('Denied symptoms: chest pain, difficulty breathing');
  await expect(page.locator('#doctor-detail')).toContainText('Handoff status: not_started');
  await page.reload(); await expect(page.locator('.doctor-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Refresh cases' }).click(); await expect(page.locator('.doctor-card')).toHaveCount(1);
  expect((await store.getCase(id)).routing.routedAt).toBe(timestamp);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('doctor queue handles empty, unavailable and retry states', async ({ page }) => {
  let failing = true;
  await page.route('**/api/doctor/cases', route => route.fulfill(failing ? { status: 503, json: {} } : { json: { cases: [], nextCursor: null } }));
  await page.goto('/doctor'); await expect(page.getByRole('status')).toHaveText('Queue unavailable. Refresh to retry.');
  failing = false; await page.getByRole('button', { name: 'Refresh cases' }).click();
  await expect(page.getByRole('status')).toHaveText('No routed cases yet.');
});

test('Doctor uploads a synthetic laboratory PDF and can reopen its case-scoped original', async ({ page }) => {
  const store = createMemoryCaseStore(), id = newCaseId(), reportId = 'e2f766a7-e9c3-4ed7-8e3e-8509882cfe70';
  await store.createCase({ caseId: id, intake: routingIntake([['dizziness', 'confirmed']]), submittedForReview: true });
  await store.routeCase(id, { availableSpecialties: new Set(['neurology']) });
  const uploaded = [], pdf = Buffer.from('%PDF-1.4\nFictional laboratory report\n%%EOF');
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: url.pathname === '/api/doctor/cases' ? await store.listDoctorCases() : await store.getDoctorCase(id) });
  });
  await page.route(`**/api/doctor/cases/${id}/lab-reports`, async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(['fictional-labs.pdf', 'dropped-labs.pdf']).toContain(body.filename);
      expect(body.mimeType).toBe('application/pdf');
      expect(Buffer.from(body.reportBase64, 'base64')).toEqual(pdf);
      const report = { reportId: uploaded.length ? 'dropped-report-id' : reportId, filename: body.filename, mimeType: body.mimeType, status: 'uploaded' };
      uploaded.push(report);
      await route.fulfill({ status: 201, json: { report } }); return;
    }
    await route.fulfill({ json: { reports: uploaded } });
  });
  await page.route(`**/api/doctor/cases/${id}/lab-reports/${reportId}/file`, route => route.fulfill({ body: pdf, contentType: 'application/pdf' }));
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${id}` }).click();
  const reports = page.locator('.doctor-lab-reports');
  await page.locator('.doctor-lab-details > summary').click();
  await expect(reports).toContainText('No laboratory reports uploaded');
  await reports.locator('input[type=file]').setInputFiles({ name: 'fictional-labs.pdf', mimeType: 'application/pdf', buffer: pdf });
  await reports.getByRole('button', { name: 'Upload report' }).click();
  await expect(reports).toContainText('fictional-labs.pdf · Uploaded');
  const download = page.waitForEvent('download');
  await reports.getByRole('button', { name: 'Open original' }).click();
  expect((await download).suggestedFilename()).toBe('fictional-labs.pdf');
  await reports.locator('.doctor-lab-dropzone').evaluate((zone, bytes) => {
    const dropped = new File([new Uint8Array(bytes)], 'dropped-labs.pdf', { type: 'application/pdf' });
    const transfer = new DataTransfer(); transfer.items.add(dropped);
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, Array.from(pdf));
  await expect(reports.locator('.doctor-lab-drop-hint')).toContainText('dropped-labs.pdf ready');
  await reports.getByRole('button', { name: 'Upload report' }).click();
  await expect(reports).toContainText('dropped-labs.pdf · Uploaded');
  expect(uploaded).toHaveLength(2);
  await expect(page.locator('#doctor-detail')).toContainText('Intake summary');
});

test('Doctor can request Gemini extraction while unverified rows remain separate from clinical decisions', async ({ page }) => {
  const store = createMemoryCaseStore(), id = newCaseId(), reportId = 'f142c55c-019a-4581-a263-572be3a6b913';
  await store.createCase({ caseId: id, intake: routingIntake([['dizziness', 'confirmed']]), submittedForReview: true });
  await store.routeCase(id, { availableSpecialties: new Set(['neurology']) });
  let report = { reportId, filename: 'synthetic-labs.pdf', mimeType: 'application/pdf', status: 'uploaded', canExtract: true };
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: url.pathname === '/api/doctor/cases' ? await store.listDoctorCases() : await store.getDoctorCase(id) });
  });
  await page.route(`**/api/doctor/cases/${id}/lab-reports`, route => route.fulfill({ json: { reports: [report] } }));
  await page.route(`**/api/doctor/cases/${id}/lab-reports/${reportId}/extract`, route => {
    report = { ...report, status: 'pending_review', canExtract: false, unverifiedExtraction: { documentStatus: 'clear', rows: [{ testName: 'Sodium', resultText: '140' }] } };
    return route.fulfill({ json: { report } });
  });
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${id}` }).click();
  const reports = page.locator('.doctor-lab-reports');
  await page.locator('.doctor-lab-details > summary').click();
  await expect(reports).toContainText('synthetic-labs.pdf · Uploaded');
  await reports.getByRole('button', { name: 'Extract with Gemini' }).click();
  await expect(reports).toContainText('Unverified extraction · Doctor review required');
  await expect(reports.getByRole('button', { name: 'Extract with Gemini' })).toHaveCount(0);
  await expect(page.locator('#doctor-detail')).not.toContainText('Sodium');
});
test('Doctor compares original, corrects a result, and explicitly verifies one report revision', async ({ page }) => {
  const store = createMemoryCaseStore(), id = newCaseId(), reportId = 'fe9ce006-c86e-42ef-bfb3-92184626142c';
  await store.createCase({ caseId: id, intake: routingIntake([['dizziness', 'confirmed']]), submittedForReview: true });
  await store.routeCase(id, { availableSpecialties: new Set(['neurology']) });
  const row = { testName: 'Sodium', resultText: '14O', numericValue: null, unit: 'mmol/L', referenceRange: '135-145', sourceLocation: 'page 1', uncertain: true, unreadable: false };
  let report = { reportId, filename: 'synthetic-labs.pdf', mimeType: 'application/pdf', status: 'pending_review', reviewToken: '3997f2c8-ea41-4b79-82d2-fd8bcb805d20', unverifiedExtraction: { documentStatus: 'clear', rows: [row] } };
  const pdf = Buffer.from('%PDF-1.4\nFictional laboratory report\n%%EOF');
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: url.pathname === '/api/doctor/cases' ? await store.listDoctorCases() : await store.getDoctorCase(id) });
  });
  await page.route(`**/api/doctor/cases/${id}/lab-reports`, route => route.fulfill({ json: { reports: [report] } }));
  await page.route(`**/api/doctor/cases/${id}/lab-reports/${reportId}/file`, route => route.fulfill({ body: pdf, contentType: 'application/pdf' }));
  await page.route(`**/api/doctor/cases/${id}/lab-reports/${reportId}/verify`, route => {
    const body = route.request().postDataJSON();
    expect(body.expectedReviewToken).toBe(report.reviewToken);
    expect(body.confirmedOriginal).toBe(true);
    expect(body.rows).toEqual([{ include: true, testName: 'Sodium', resultText: '140', numericValue: 140, unit: 'mmol/L', referenceRange: '135-145', sourceLocation: 'page 1' }]);
    report = { ...report, status: 'verified', reviewToken: undefined, verifiedResult: { revision: 1, rows: [body.rows[0]] } };
    return route.fulfill({ json: { report } });
  });
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${id}` }).click();
  const reports = page.locator('.doctor-lab-reports');
  await page.locator('.doctor-lab-details > summary').click();
  await reports.getByRole('button', { name: 'Review extracted results' }).click();
  const review = reports.locator('.doctor-lab-review');
  await expect(review.getByTitle('Original laboratory report: synthetic-labs.pdf')).toHaveCount(1);
  await expect(review.getByText('Gemini marked this row uncertain.')).toBeVisible();
  await review.getByLabel('Include in verified results').check();
  await review.getByLabel('Result as printed').fill('140');
  await review.getByLabel('Numeric value (if printed)').fill('140');
  await review.getByRole('button', { name: 'Verify reviewed results' }).click();
  await expect(reports).toContainText('Unverified extraction · Doctor review required');
  await review.getByLabel('I compared every included field with the original report.').check();
  await review.getByRole('button', { name: 'Verify reviewed results' }).click();
  await expect(reports).toContainText('Doctor verified · revision 1 · 1 results');
  await expect(page.locator('#doctor-detail')).toContainText('Intake summary');
});
test('Doctor evidence keeps confirmed packaging medicine separate and explicitly patient-reported', async ({ page }) => {
  const store = createMemoryCaseStore(), id = newCaseId(), intake = routingIntake([['dizziness', 'confirmed']]);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4eYAAAAASUVORK5CYII=', 'base64');
  await store.createCase({ caseId: id, intake, submittedForReview: true, medication: { name: 'Fictionalmed', strength: '10 mg', howTaken: 'I take one each morning.', source: 'packaging_shown', verification: 'patient_reported', confirmedAt: '2026-09-28T01:00:00.000Z' }, medicationImage: { mimeType: 'image/png', byteLength: bytes.length, bytes } });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/medicine-image')) { await route.fulfill({ body: bytes, contentType: 'image/png' }); return; }
    if (url.pathname.endsWith('/evidence/medicine-package')) { await route.fulfill({ body: bytes, contentType: 'image/png' }); return; }
    await route.fulfill({ json: url.pathname === '/api/doctor/cases' ? await store.listDoctorCases() : await store.getDoctorCase(id) });
  });
  await page.route(`**/api/doctor/cases/${id}/evidence/medicine-package`, route => route.fulfill({ body: bytes, contentType: 'image/png' }));
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${id}` }).click();
  const evidence = page.locator('#doctor-evidence-section');
  await expect(evidence).toContainText('Patient-reported; packaging shown');
  await expect(evidence).toContainText('Fictionalmed · 10 mg');
  await expect(evidence).toContainText('How the patient says they take it: I take one each morning.');
  await expect(evidence).toContainText('Not clinically verified.');
  await evidence.getByText('More patient evidence', { exact: true }).click();
  await expect(evidence.getByRole('img', { name: 'Patient-shared image: Medicine package' })).toBeVisible();
});

test('Doctor operational context shows a simulated appointment request without claiming contact or booking', async ({ page }) => {
  const store = createMemoryCaseStore(), id = newCaseId(), patientUid = 'patient-appointment-doctor';
  await store.createCase({ caseId: id, patientUid, intake: routingIntake([['dizziness', 'confirmed']]), submittedForReview: true });
  await store.routeCase(id, { availableSpecialties: ['neurology'] });
  await store.saveAppointmentRequest({ caseId: id, patientUid, appointmentRequest: {
    appointmentRequestId: 'appointment-doctor-1', intakeSessionId: 'session-doctor-1', patientUid, caseId: id,
    state: 'requested', simulation: true, contacted: false, confirmed: false, requestedAt: '2026-10-01T02:00:00.000Z',
    selection: { hospitalId: 'hospital-a', hospitalName: 'Fictional Harbor Hospital', specialty: 'neurology', date: '2026-10-02', time: '10:30', distanceMeters: 2400 },
  } });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    const result = url.pathname === '/api/doctor/cases' ? await store.listDoctorCases() : await store.getDoctorCase(id);
    await route.fulfill({ json: result });
  });
  await page.goto('/doctor');
  await page.getByRole('button', { name: `Open case ${id}` }).click();
  await page.locator('.doctor-case-context summary').click();
  const context = page.locator('.doctor-case-context');
  await expect(context).toContainText('Fictional Harbor Hospital');
  await expect(context).toContainText('Simulated request recorded — not a confirmed booking');
  await expect(context).toContainText('No hospital or Doctor was contacted');
});

test('Doctor opens shared body-area evidence with patient wording and no diagnostic inference', async ({ page }) => {
  const store = createMemoryCaseStore(), id = newCaseId();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4eYAAAAASUVORK5CYII=', 'base64');
  await store.createCase({ caseId: id, intake: routingIntake([['shoulder pain', 'confirmed']]), submittedForReview: true, patientUid: 'fictional-owner',
    patientEvidence: [{ evidenceId: 'body-area-123', kind: 'body_area', label: 'Pain location', patientDescription: 'I point to the outer part of my left shoulder.', mimeType: 'image/png', byteLength: png.length, bytes: png }] });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/evidence/body-area-123')) { await route.fulfill({ status: 200, body: png, contentType: 'image/png' }); return; }
    await route.fulfill({ json: url.pathname === '/api/doctor/cases' ? await store.listDoctorCases() : await store.getDoctorCase(id) });
  });
  await page.setViewportSize({ width: 412, height: 915 }); await page.goto('/doctor');
  await page.getByRole('button', { name: `Open case ${id}` }).click();
  const evidence = page.locator('#doctor-evidence-section');
  await expect(evidence).toContainText('I point to the outer part of my left shoulder.');
  await expect(evidence).toContainText('not a diagnosis or verified anatomical finding');
  await evidence.getByText('More patient evidence', { exact: true }).click();
  await expect(evidence.getByRole('img', { name: 'Patient-shared image: Pain location' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Doctor sees an honest unavailable state when a shared image cannot be read', async ({ page }) => {
  const store = createMemoryCaseStore(), id = newCaseId(), png = Buffer.from([1, 2, 3, 4]);
  await store.createCase({ caseId: id, intake: routingIntake(), submittedForReview: true,
    patientEvidence: [{ evidenceId: 'body-area-125', kind: 'body_area', label: 'Pain location', patientDescription: 'My left shoulder feels sore.', mimeType: 'image/png', byteLength: png.length, bytes: png }] });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/evidence/body-area-125')) { await route.fulfill({ status: 503, json: { code: 'CASE_EVIDENCE_UNAVAILABLE' } }); return; }
    await route.fulfill({ json: url.pathname === '/api/doctor/cases' ? await store.listDoctorCases() : await store.getDoctorCase(id) });
  });
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${id}` }).click();
  const evidence = page.locator('#doctor-evidence-section');
  await expect(evidence).toContainText('My left shoulder feels sore.');
  await expect(evidence).toContainText('The shared image is temporarily unavailable. The patient description remains available.');
  await expect(evidence.getByRole('img')).toHaveCount(0);
});

test('Doctor workspace pairs a real queue item with selected evidence across desktop and mobile', async ({ page }) => {
  const { id, routeCase } = await fixture(page);
  await routeCase(id);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 412, height: 915 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/doctor');
    await expect(page.locator('.site-header .landing-brand-mark')).toHaveCount(1);
    await expect(page.locator('.site-header .landing-brand-mark i')).toHaveCount(2);
    await expect(page.locator('.site-header .brand-mark')).toHaveCount(0);
    await page.evaluate(async () => {
      const { mountAuthBar } = await import('/src/auth/ui.js');
      document.querySelector('.site-header .auth-bar')?.remove();
      const root = document.createElement('div'); root.className = 'auth-bar'; document.querySelector('.site-header').append(root);
      mountAuthBar(root, { getState: () => ({ status: 'SIGNED_IN', user: { displayName: 'Alex Doctor', email: 'doctor@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: ['doctor'], specialties: ['general_medicine'] } } }), subscribe: () => () => {}, signIn: () => {}, signOut: () => {} });
    });
    const accountMenu = page.locator('.site-header .portal-account-menu');
    await expect(accountMenu.locator(':scope > summary')).toHaveText('My account');
    await expect(accountMenu.locator(':scope > summary')).toBeVisible();
    await accountMenu.locator(':scope > summary').click();
    await expect(accountMenu.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
    await expect(accountMenu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(accountMenu.getByRole('navigation', { name: 'Switch workspace' })).toBeVisible();
    await accountMenu.locator(':scope > summary').click();
    const headerBox = await page.locator('.site-header').boundingBox(), mainBox = await page.locator('main').boundingBox();
    expect(Math.abs(headerBox.x - mainBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(headerBox.width - mainBox.width)).toBeLessThanOrEqual(1);
    await expect(page.locator('.doctor-card')).toHaveCount(1);
    await expect(page.locator('#doctor-review-placeholder')).toBeVisible();
    await page.getByRole('button', { name: `Open case ${id}` }).click();
    await expect(page.locator('#doctor-review-placeholder')).toBeHidden();
    await expect(page.locator('#doctor-detail')).toContainText('Patient report');
    const caseNav = page.getByRole('navigation', { name: 'Case review sections' });
    await expect(caseNav).toBeVisible();
    await expect(caseNav.getByRole('button')).toHaveText(['Patient report', 'AI summary', 'Next step', 'Decision']);
    await expect(page.locator('#doctor-review-context')).toContainText(id);
    const review = await page.locator('#doctor-detail').boundingBox();
    const caseColumn = await page.locator('.doctor-case-column').boundingBox();
    const reviewScroll = await page.locator('.doctor-review-scroll').evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(caseColumn.height).toBeGreaterThanOrEqual(viewport.height - 112);
    expect(reviewScroll.clientHeight).toBeGreaterThan(caseColumn.height * .6);
    expect(reviewScroll.scrollHeight).toBeGreaterThan(reviewScroll.clientHeight);
    if (viewport.width > 760) {
      const inbox = await page.locator('.doctor-inbox').boundingBox();
      expect(review.x > inbox.x).toBeTruthy();
      expect(Math.abs(inbox.height - caseColumn.height)).toBeLessThanOrEqual(2);
      await expect(page.getByRole('button', { name: 'Back to inbox' })).toBeHidden();
    } else {
      await expect(page.locator('.doctor-page')).toHaveClass(/doctor-case-open/);
      await expect(page.locator('.doctor-inbox')).toBeHidden();
      await expect(page.getByRole('button', { name: 'Back to inbox' })).toBeVisible();
      await page.getByRole('button', { name: 'Back to inbox' }).click();
      await expect(page.locator('.doctor-inbox')).toBeVisible();
      await expect(page.getByRole('button', { name: `Open case ${id}` })).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    if (viewport.width !== 360) await page.screenshot({ path: `test-results/doctor-workspace-${viewport.width}.png`, fullPage: true });
  }
});
test('case search dropdown uses the same safe display name and does not reorder recent cards', async ({ page }) => {
  const cases = [
    { caseId: 'SC-30000000-0000-4000-8000-000000000003', patient: { name: 'Maria' }, patientIdentity: { firstName: 'Maria', lastName: 'Santos' }, mainReportedSymptom: 'nausea', workflowStatus: 'submitted_for_clinical_review', createdAt: '2026-09-25T01:00:00.000Z', storage: 'memory' },
    { caseId: 'SC-10000000-0000-4000-8000-000000000001', patient: { name: 'Sarah' }, patientIdentity: { firstName: 'John Louis', middleName: '', lastName: 'Garcia', displayName: 'John Louis Garcia' }, mainReportedSymptom: 'dizziness', workflowStatus: 'submitted_for_clinical_review', createdAt: '2026-09-25T04:00:00.000Z', storage: 'memory' },
    { caseId: 'SC-20000000-0000-4000-8000-000000000002', patient: { name: 'Unparsed Compound Name' }, mainReportedSymptom: 'fever', workflowStatus: 'submitted_for_clinical_review', createdAt: '2026-09-25T03:00:00.000Z', storage: 'memory' },
    { caseId: 'SC-40000000-0000-4000-8000-000000000004', patient: { name: 'Older Patient' }, mainReportedSymptom: 'cough', workflowStatus: 'submitted_for_clinical_review', createdAt: '2026-09-25T02:00:00.000Z', storage: 'memory' },
  ];
  await page.route('**/api/doctor/cases', route => route.fulfill({ json: { cases, nextCursor: null, storage: 'memory' } }));
  await page.goto('/doctor');
  await expect(page.locator('.doctor-card')).toHaveCount(3);
  await expect(page.locator('.doctor-card h2')).toHaveText(['Garcia, John Louis', 'Unparsed Compound Name', 'Older Patient']);
  await page.getByLabel('Search cases').fill('garcia');
  await expect(page.getByRole('option')).toHaveText('Garcia, John Louis');
  await page.getByLabel('Search cases').fill('john'); await expect(page.getByRole('option')).toHaveText('Garcia, John Louis');
  await page.getByLabel('Search cases').fill('GARC'); await expect(page.getByRole('option')).toHaveText('Garcia, John Louis');
});
test('Doctor case header shows trusted profile identity separately from the unchanged patient-reported name', async ({ page }) => {
  const caseId = 'SC-50000000-0000-4000-8000-000000000005';
  const record = {
    caseId,
    patient: { name: 'Louis', preferredName: 'Louis' },
    patientIdentity: { firstName: 'John Louis', middleName: 'Cano', lastName: 'Garcia', displayName: 'John Louis Cano Garcia' },
    intakeSummary: { 'Patient Name': 'Louis' },
    reportedFacts: { symptoms: [], redFlags: [] },
    workflowStatus: 'submitted_for_clinical_review', handoffStatus: 'not_started', routing: null,
    createdAt: '2026-09-25T04:00:00.000Z', storage: 'firestore',
  };
  await page.route('**/api/doctor/cases', route => route.fulfill({ json: { cases: [record], nextCursor: null, storage: 'firestore' } }));
  await page.route(`**/api/doctor/cases/${caseId}`, route => route.fulfill({ json: record }));
  await page.goto('/doctor');
  await page.getByRole('button', { name: `Open case ${caseId}` }).click();
  const detail = page.locator('#doctor-detail');
  await expect(detail.getByRole('heading', { name: 'Patient', exact: true })).toBeVisible();
  await expect(detail).toContainText('Garcia, John Louis C.');
  await expect(detail).toContainText('Name used during intake: Louis');
  await expect(page.locator('#doctor-review-context')).toContainText(caseId);
  await expect(detail).toContainText('Status: Waiting for review');
  await expect(detail).toContainText('Intake summary');
  await expect(detail).toContainText('Patient Name: Louis');
  await expect(detail).not.toContainText('Patient Name: Garcia, John Louis C.');
});

test('Doctor case header formats missing middle name and uses trusted displayName fallback', async ({ page }) => {
  const records = [
    { caseId: 'SC-60000000-0000-4000-8000-000000000006', patient: { name: 'Maria' }, patientIdentity: { firstName: 'Maria Clara', middleName: '', lastName: 'Santos' }, intakeSummary: { 'Patient Name': 'Maria' }, reportedFacts: { symptoms: [], redFlags: [] }, workflowStatus: 'submitted_for_clinical_review', handoffStatus: 'not_started', routing: null, createdAt: '2026-09-25T03:00:00.000Z', storage: 'firestore' },
    { caseId: 'SC-70000000-0000-4000-8000-000000000007', patient: { name: 'M.' }, patientIdentity: { displayName: 'Single Trusted Profile Display' }, intakeSummary: { 'Patient Name': 'M.' }, reportedFacts: { symptoms: [], redFlags: [] }, workflowStatus: 'submitted_for_clinical_review', handoffStatus: 'not_started', routing: null, createdAt: '2026-09-25T02:00:00.000Z', storage: 'firestore' },
  ];
  await page.route('**/api/doctor/cases', route => route.fulfill({ json: { cases: records, nextCursor: null, storage: 'firestore' } }));
  await page.route('**/api/doctor/cases/SC-*', route => route.fulfill({ json: records.find(item => item.caseId === new URL(route.request().url()).pathname.split('/').at(-1)) }));
  await page.goto('/doctor');
  const expected = [[records[0], 'Santos, Maria Clara'], [records[1], 'Single Trusted Profile Display']];
  for (const [index, [record, identity]] of expected.entries()) {
    await page.getByRole('button', { name: `Open case ${record.caseId}` }).click();
    await expect(page.locator('#doctor-detail')).toContainText(identity);
    await expect(page.locator('#doctor-detail')).toContainText(`Name used during intake: ${record.patient.name}`);
    if (index < expected.length - 1 && await page.getByRole('button', { name: 'Back to inbox' }).isVisible()) await page.getByRole('button', { name: 'Back to inbox' }).click();
  }
});
test('doctor renders patient text literally and never shows unrouted or emergency records', async ({ page }) => {
  const { store, id, routeCase } = await fixture(page);
  for (const emergency of [true, false]) await store.createCase({ caseId: newCaseId(), intake: emergency ? emergencyIntake() : routingIntake(), emergency });
  const hostileId = newCaseId(), intake = routingIntake(); intake.patient.name = '<img src=x onerror="window.injected=true">'; intake.patient.preferredName = intake.patient.name;
  await store.createCase({ caseId: hostileId, intake }); await routeCase(hostileId);
  await page.goto('/doctor'); await expect(page.locator('.doctor-card')).toHaveCount(1);
  await expect(page.locator('.doctor-card')).toContainText(intake.patient.preferredName);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await expect(page.locator('.doctor-card img')).toHaveCount(0);
  await expect(page.locator('.doctor-card')).not.toContainText(id);
});
test('emergency card has no normal routing control', async ({ page }) => {
  const id = newCaseId();
  await page.addInitScript(caseId => sessionStorage.setItem('smartcareops-case-id', caseId), id);
  await page.route(`**/api/cases/${id}`, route => route.fulfill({ json: { caseId: id, workflowStatus: 'emergency_pending_dispatcher', storage: 'firestore' } }));
  await page.goto('/patient'); await expect(page.locator('#patient-case-routing')).toHaveText('Normal doctor routing skipped.');
  await expect(page.getByRole('button', { name: 'Route to doctor', exact: true })).toBeHidden();
});
test('queue pagination appends cases without duplicates', async ({ page }) => {
  const { store, routeCase } = await fixture(page);
  for (let i = 0; i < 51; i++) { const caseId = newCaseId(); await store.createCase({ caseId, intake: routingIntake() }); await routeCase(caseId); }
  await page.goto('/doctor'); await expect(page.locator('.doctor-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Load more cases' }).click();
  await expect(page.locator('.doctor-card')).toHaveCount(51);
  await expect(page.getByRole('button', { name: 'Load more cases' })).toBeHidden();
});
test('Doctor queue labels Orthopedics-routed shoulder reports and excludes other specialties', async ({ page }) => {
  const store = createMemoryCaseStore(), shoulderId = newCaseId(), neuroId = newCaseId();
  await store.createCase({ caseId: shoulderId, intake: routingIntake([['left shoulder pain', 'confirmed']]), submittedForReview: true });
  await store.createCase({ caseId: neuroId, intake: routingIntake([['dizziness', 'confirmed']]), submittedForReview: true });
  await store.routeCase(shoulderId, { availableSpecialties: new Set(['orthopedics']) });
  await store.routeCase(neuroId, { availableSpecialties: new Set(['neurology']) });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/api/doctor/cases' ? await store.listDoctorCases({ specialty: 'orthopedics' }) : await store.getDoctorCase(shoulderId, { specialty: 'orthopedics' });
    await route.fulfill({ json: body });
  });
  await page.goto('/doctor'); await expect(page.locator('.doctor-card')).toHaveCount(1);
  await expect(page.locator('.doctor-card')).toContainText('Orthopedics');
  await expect(page.locator('.doctor-card')).not.toContainText(neuroId);
  await page.getByRole('button', { name: `Open case ${shoulderId}` }).click();
  await expect(page.locator('#doctor-detail')).toContainText('Orthopedics');
  await expect(page.locator('#doctor-detail')).toContainText('Patient report');
});

test('Doctor workspace keeps Profile, sign out and workspace switching secondary', async ({ page }) => {
  await page.route('**/api/doctor/cases', route => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.goto('/doctor');
  await expect(page.getByRole('navigation', { name: 'Doctor workspace' })).toContainText('Doctor Portal');
  await page.evaluate(async () => {
    const { mountAuthBar } = await import('/src/auth/ui.js');
    document.querySelector('.site-header .auth-bar')?.remove();
    const root = document.createElement('div'); root.id = 'doctor-account-test'; root.className = 'auth-bar'; document.querySelector('.site-header').append(root);
    mountAuthBar(root, { getState: () => ({ status: 'SIGNED_IN', user: { displayName: 'Alex Doctor', email: 'doctor@example.invalid' }, authorizationStatus: 'READY', identity: { user: { roles: ['doctor'], specialties: ['general_medicine'] } }, error: null }), subscribe: () => () => {}, signIn: () => {}, signOut: () => {} });
  });
  const account = page.locator('#doctor-account-test');
  await expect(account.getByRole('link', { name: 'Profile', exact: true })).toBeHidden();
  await account.locator('summary').first().click();
  await expect(account.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
  await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(account.getByRole('navigation', { name: 'Switch workspace' })).toBeVisible();
  await expect(account.getByText('Demo controls', { exact: true })).toHaveCount(0);
});

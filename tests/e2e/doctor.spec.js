import { test, expect } from '@playwright/test';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { routingIntake } from '../../backend/tests/routing-fixtures.js';
import { emergencyIntake } from '../../backend/tests/safety-fixtures.js';
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
    await route.fulfill({ json: await store.routeCase(id) });
  });
  return { store, id };
}
test('patient displays status only; doctor queue, detail and refresh show persisted route and denied facts', async ({ page }) => {
  const { store, id } = await fixture(page);
  await page.addInitScript(caseId => sessionStorage.setItem('smartcareops-case-id', caseId), id);
  await store.routeCase(id);
  await page.goto('/patient');
  await expect(page.locator('#patient-case-routing')).toHaveText('Routing: Neurology');
  await expect(page.locator('#patient-case-status')).toHaveText('Routed to doctor');
  await expect(page.getByRole('button', { name: 'Route to doctor', exact: true })).toBeHidden();
  const timestamp = (await store.getCase(id)).routing.routedAt;
  await page.goto('/doctor');
  await expect(page.locator('.doctor-card')).toHaveCount(1);
  await expect(page.locator('.doctor-card')).toContainText('Demo Alex');
  await expect(page.locator('.doctor-card')).toContainText('Neurology');
  await page.getByRole('button', { name: `Open case ${id}`, exact: true }).click();
  await expect(page.locator('#doctor-detail')).toContainText('Validated intake summary — patient reported');
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
  await expect(detail).toContainText('PROFILE IDENTITY: Garcia, John Louis C.');
  await expect(detail).toContainText('PATIENT REPORTED NAME: Louis');
  await expect(detail).toContainText(`Case: ${caseId}`);
  await expect(detail).toContainText('Status: Waiting for clinical review');
  await expect(detail).toContainText('Validated intake summary — patient reported');
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
  for (const [record, identity] of [[records[0], 'Santos, Maria Clara'], [records[1], 'Single Trusted Profile Display']]) {
    await page.getByRole('button', { name: `Open case ${record.caseId}` }).click();
    await expect(page.locator('#doctor-detail')).toContainText(`PROFILE IDENTITY: ${identity}`);
    await expect(page.locator('#doctor-detail')).toContainText(`PATIENT REPORTED NAME: ${record.patient.name}`);
  }
});
test('doctor renders patient text literally and never shows unrouted or emergency records', async ({ page }) => {
  const { store, id } = await fixture(page);
  for (const emergency of [true, false]) await store.createCase({ caseId: newCaseId(), intake: emergency ? emergencyIntake() : routingIntake(), emergency });
  const hostileId = newCaseId(), intake = routingIntake(); intake.patient.name = '<img src=x onerror="window.injected=true">'; intake.patient.preferredName = intake.patient.name;
  await store.createCase({ caseId: hostileId, intake }); await store.routeCase(hostileId);
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
  const { store } = await fixture(page);
  for (let i = 0; i < 51; i++) { const caseId = newCaseId(); await store.createCase({ caseId, intake: routingIntake() }); await store.routeCase(caseId); }
  await page.goto('/doctor'); await expect(page.locator('.doctor-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Load more cases' }).click();
  await expect(page.locator('.doctor-card')).toHaveCount(51);
  await expect(page.getByRole('button', { name: 'Load more cases' })).toBeHidden();
});

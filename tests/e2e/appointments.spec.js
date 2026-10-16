import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { routingIntake } from '../../backend/tests/routing-fixtures.js';
import { memoryClinicalStore } from '../../backend/src/clinical/storage.js';
import { createClinicalService } from '../../backend/src/clinical/service.js';

test('Doctor proposes, Patient explicitly confirms, and both portals reflect durable state', async ({ page }) => {
  const store = createMemoryCaseStore(), caseId = newCaseId();
  const doctor = { uid: 'doctor-test', displayName: 'Dr. Louie', specialties: ['orthopedics'], doctorVerification: { status: 'verified' } };
  await store.createCase({ caseId, intake: routingIntake([['left shoulder pain', 'confirmed']]), patientUid: 'patient-test', submittedForReview: true, intakeSource: 'live_intake', enrichmentStatus: 'succeeded' });
  await store.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
  await store.decideClinicalReview(caseId, { requestId: randomUUID(), decision: 'approved', reviewerId: doctor.uid, reviewerProfile: { displayName: doctor.displayName, specialty: 'orthopedics' } });
  const clinical = createClinicalService({ caseId, caseStore: store, store: memoryClinicalStore(), modelName: 'test-model', model: async () => { throw new Error('not used'); } });
  await page.route('**/api/doctor/cases**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/appointment')) {
      try { return route.fulfill({ json: await store.proposeAppointment(caseId, route.request().postDataJSON(), doctor) }); }
      catch (error) { return route.fulfill({ status: error.status || 503, json: { code: error.code, message: 'Refresh the case to review the proposal.' } }); }
    }
    return route.fulfill({ json: url.pathname === '/api/doctor/cases' ? await store.listDoctorCases({ specialties: doctor.specialties }) : await store.getDoctorCase(caseId, { specialties: doctor.specialties }) });
  });
  await page.route('**/api/clinical**', async route => route.fulfill({ json: await clinical.view() }));
  await page.route('**/api/cases/**', async route => {
    if (route.request().method() === 'POST') {
      try { return route.fulfill({ json: await store.respondToAppointment(caseId, route.request().postDataJSON(), 'patient-test') }); }
      catch (error) { return route.fulfill({ status: error.status || 503, json: { code: error.code, message: 'Refresh the case to review the proposal.' } }); }
    }
    return route.fulfill({ json: await store.getPatientCase(caseId, 'patient-test') });
  });
  await page.route('**/api/cases?**', async route => route.fulfill({ json: { cases: (await store.listPatientCases({ patientUid: 'patient-test', limit: 1 })).cases, nextCursor: null } }));
  await page.goto('/doctor');
  await page.getByRole('button', { name: `Open case ${caseId}` }).click();
  await expect(page.getByRole('heading', { name: 'Propose appointment' })).toBeVisible();
  const form = page.locator('.clinical-appointment-form');
  expect(await page.locator('.clinical-appointment').evaluate(element => {
    const style = getComputedStyle(element), input = getComputedStyle(element.querySelector('input'));
    return style.borderTopWidth === '4px' && style.borderRadius !== '0px' && input.borderRadius !== '0px';
  })).toBe(true);
  const start = new Date(Date.now() + 2 * 24 * 3600000), end = new Date(start.getTime() + 3600000);
  const local = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await form.locator('[data-slot-field="start"]').fill(local(start));
  await form.locator('[data-slot-field="end"]').fill(local(end));
  await form.getByRole('button', { name: 'Review proposal' }).click();
  await expect(form).toContainText('Review before sending');
  await form.getByRole('button', { name: 'Send proposal to Patient' }).click();
  await expect(page.getByText('Waiting for Patient confirmation', { exact: false })).toBeVisible();
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.goto('/patient');
  await page.getByRole('link', { name: 'View current status' }).click();
  await expect(page.getByRole('heading', { name: 'Fictional appointment proposal' })).toBeVisible();
  await expect(page.locator('#patient-next-step')).toHaveText('Choose an appointment time.');
  await expect(page.locator('.patient-journey-steps')).toContainText('Appointment Proposed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.patient-appointment-slots input[type=radio]').first().check();
  expect((await store.getPatientCase(caseId, 'patient-test')).appointmentProposal.state).toBe('awaiting_patient_confirmation');
  await page.getByRole('button', { name: 'Confirm this time' }).click();
  await expect(page.locator('#patient-next-step')).toHaveText('Your appointment is confirmed.');
  await expect(page.locator('.patient-journey-steps')).toContainText('Appointment Confirmed');
  await page.reload();
  await expect(page.locator('#patient-next-step')).toHaveText('Your appointment is confirmed.');
  await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${caseId}` }).click();
  await expect(page.getByText('Patient confirmed a time', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Patient can request another time without selecting a slot; manual explains fictional boundaries', async ({ page }) => {
  const store = createMemoryCaseStore(), caseId = newCaseId();
  const doctor = { uid: 'doctor-test', displayName: 'Dr. Louie', specialties: ['orthopedics'], doctorVerification: { status: 'verified' } };
  await store.createCase({ caseId, intake: routingIntake([['left shoulder pain', 'confirmed']]), patientUid: 'patient-test', submittedForReview: true });
  await store.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
  await store.decideClinicalReview(caseId, { requestId: randomUUID(), decision: 'approved', reviewerId: doctor.uid });
  await store.proposeAppointment(caseId, { requestId: randomUUID(), expectedVersion: 0, timeZone: 'Asia/Manila', appointmentType: 'Fictional consultation', slots: [{ startAt: new Date(Date.now() + 48 * 3600000).toISOString(), endAt: new Date(Date.now() + 49 * 3600000).toISOString() }] }, doctor);
  await page.route('**/api/cases/**', async route => route.fulfill({ json: route.request().method() === 'POST' ?
    await store.respondToAppointment(caseId, route.request().postDataJSON(), 'patient-test') : await store.getPatientCase(caseId, 'patient-test') }));
  await page.route('**/api/cases?**', async route => route.fulfill({ json: { cases: (await store.listPatientCases({ patientUid: 'patient-test', limit: 1 })).cases, nextCursor: null } }));
  await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
  await page.goto('/patient'); await page.locator('[data-patient-view-link="cases"]:visible').click();
  await page.locator('.patient-case-history-item').first().click();
  await expect(page.getByRole('button', { name: 'Request another time' })).toBeVisible();
  await page.getByRole('button', { name: 'Request another time' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#patient-next-step')).toHaveText('Your Doctor will propose another time.');
  expect((await store.getPatientCase(caseId, 'patient-test')).appointmentProposal.confirmedSlotId).toBeNull();
  await page.goto('/manual');
  await expect(page.getByRole('heading', { name: 'Fictional appointment proposals' })).toBeVisible();
  await expect(page.getByText('No Doctor, clinic, hospital, calendar, or external service was contacted.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proposing a fictional appointment' })).toBeVisible();
});

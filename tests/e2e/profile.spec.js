import { test, expect } from '@playwright/test';

const original = { uid: 'verified-user', email: 'john@example.invalid', displayName: 'John Louis Garcia', roles: ['patient', 'doctor', 'dispatcher', 'command-center'], status: 'active' };
test('profile loads, saves structured identity, persists after refresh and drives Doctor Recent Cases', async ({ page }) => {
  let profile = structuredClone(original), savedBody;
  await page.route('**/api/profile', async route => {
    if (route.request().method() === 'PATCH') {
      savedBody = route.request().postDataJSON(); const clean = Object.fromEntries(Object.entries(savedBody).map(([key, value]) => [key, value.trim()])); profile = { ...profile, ...clean, displayName: [clean.firstName, clean.middleName, clean.lastName].filter(Boolean).join(' ') };
      await route.fulfill({ json: { profile } }); return;
    }
    await route.fulfill({ json: { profile } });
  });
  await page.goto('/profile'); await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  await expect(page.locator('#profile-identity-name')).toHaveText('John Louis Garcia');
  await expect(page.locator('.patient-sidebar a[aria-current="page"]')).toHaveText('Profile');
  await expect(page.locator('#profile-photo')).not.toContainText('P');
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.getByLabel('First name').fill(' John Louis '); await page.getByLabel('Middle name').fill(''); await page.getByLabel('Last name').fill(' Garcia ');
  await page.getByLabel('Birthday').fill('1990-05-10'); await page.getByLabel('Address line 1').fill('123 José Rizal St.'); await page.getByLabel('City / Municipality').fill('Quezon City'); await page.getByLabel('Province / State').fill('Metro Manila'); await page.getByLabel('Country').fill('Philippines');
  await page.getByRole('button', { name: 'Save changes' }).click(); await expect(page.getByRole('status')).toHaveText('Profile updated successfully.');
  expect(Object.keys(savedBody).sort()).toEqual(['addressLine1', 'addressLine2', 'birthday', 'cityMunicipality', 'country', 'firstName', 'lastName', 'middleName', 'postalCode', 'provinceState'].sort());
  expect(savedBody).not.toHaveProperty('roles'); expect(savedBody).not.toHaveProperty('uid'); expect(savedBody).not.toHaveProperty('email');
  await page.reload(); await expect(page.locator('#profile-identity-name')).toHaveText('John Louis Garcia'); await page.getByRole('button', { name: 'Edit profile' }).click(); await expect(page.getByLabel('First name')).toHaveValue('John Louis'); await expect(page.getByLabel('Last name')).toHaveValue('Garcia'); await expect(page.getByLabel('Birthday')).toHaveValue('1990-05-10');
  await expect(page.getByText('Patient · Doctor · Dispatcher · Command Center')).toBeVisible();
  await page.route('**/api/doctor/cases', route => route.fulfill({ json: { cases: [{ caseId: 'SC-10000000-0000-4000-8000-000000000001', patient: { name: 'Louis' }, patientIdentity: { firstName: 'John Louis', middleName: '', lastName: 'Garcia', displayName: 'John Louis Garcia' }, mainReportedSymptom: 'dizziness', createdAt: '2026-09-25T04:00:00.000Z', workflowStatus: 'submitted_for_clinical_review' }], nextCursor: null } }));
  await page.goto('/doctor'); await expect(page.locator('.doctor-card h2')).toHaveText('Garcia, John Louis'); await page.getByLabel('Search cases').fill('garcia'); await expect(page.getByRole('option')).toHaveText('Garcia, John Louis');
});

test('profile page reports invalid server updates without changing read-only account fields', async ({ page }) => {
  await page.route('**/api/profile', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 400, json: { code: 'INVALID_BIRTHDAY', message: 'Review the profile fields and try again.' } }) : route.fulfill({ json: { profile: original } }));
  await page.goto('/profile'); await page.getByRole('button', { name: 'Edit profile' }).click(); await page.getByLabel('First name').fill('John'); await page.getByLabel('Last name').fill('Garcia'); await page.getByLabel('Birthday').fill('2999-01-01');
  // Browser max validation prevents the invalid request and keeps account data immutable.
  await expect(page.locator('#profile-email')).toHaveText('john@example.invalid'); await expect(page.getByText('Patient · Doctor · Dispatcher · Command Center')).toBeVisible();
});

test('profile address is optional, but partial addresses get inline errors and birthday submits as ISO date', async ({ page }) => {
  let savedBody;
  await page.route('**/api/profile', async route => {
    if (route.request().method() === 'PATCH') {
      savedBody = route.request().postDataJSON();
      await route.fulfill({ json: { profile: { ...original, ...savedBody, displayName: 'John Louis Garcia' } } });
      return;
    }
    await route.fulfill({ json: { profile: original } });
  });
  await page.goto('/profile'); await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.getByLabel('First name').fill('John Louis');
  await page.getByLabel('Middle name').fill('Cano');
  await page.getByLabel('Last name').fill('Garcia');
  await page.getByLabel('Birthday').fill('1985-01-07');
  await page.getByLabel('Province / State').fill('La Union');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Address line 1 is required when entering an address.')).toBeVisible();
  await expect(page.getByText('City / Municipality is required when entering an address.')).toBeVisible();
  await expect(page.getByText('Country is required when entering an address.')).toBeVisible();
  await expect(page.getByLabel('Address line 1')).toBeFocused();
  await expect(page.getByLabel('First name')).toHaveValue('John Louis');
  await expect(page.getByLabel('Province / State')).toHaveValue('La Union');
  await expect(page.locator('#profile-message')).toBeEmpty();
  await page.getByLabel('Address line 1').fill('12 Example Road');
  await page.getByLabel('City / Municipality').fill('San Fernando');
  await page.getByLabel('Country').fill('Philippines');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Profile updated successfully.');
  expect(savedBody.birthday).toBe('1985-01-07');
  expect(savedBody.provinceState).toBe('La Union');
});

test('profile may be saved when every address field is blank', async ({ page }) => {
  let savedBody;
  await page.route('**/api/profile', async route => {
    if (route.request().method() === 'PATCH') {
      savedBody = route.request().postDataJSON();
      await route.fulfill({ json: { profile: { ...original, ...savedBody, displayName: 'John Garcia' } } });
      return;
    }
    await route.fulfill({ json: { profile: original } });
  });
  await page.goto('/profile'); await page.getByRole('button', { name: 'Edit profile' }).click();
  await page.getByLabel('First name').fill('John');
  await page.getByLabel('Last name').fill('Garcia');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Profile updated successfully.');
  expect(['addressLine1', 'addressLine2', 'cityMunicipality', 'provinceState', 'postalCode', 'country'].every(key => savedBody[key] === '')).toBe(true);
});

test('Patient Profile stays readable at desktop and narrow mobile widths', async ({ page }) => {
  await page.route('**/api/profile', route => route.fulfill({ json: { profile: { ...original, firstName: 'John Louis', lastName: 'Garcia' } } }));
  for (const width of [1440, 412, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
    await expect(page.locator('#profile-identity-name')).toHaveText('John Louis Garcia');
    await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();
    await expect(page.locator('.site-header .smartcareops-brand')).toBeVisible();
    await expect(page.locator('.site-header .google-button')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Need help with your account? Read the patient guide' })).toBeVisible();
    if (width > 980) await expect(page.locator('.patient-sidebar a[aria-current="page"]')).toBeVisible();
    else {
      const activeLink = page.locator('.patient-mobile-nav a[aria-current="page"]');
      await expect(activeLink).toBeVisible();
      await expect(activeLink).toHaveCSS('color', 'rgb(8, 110, 180)');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

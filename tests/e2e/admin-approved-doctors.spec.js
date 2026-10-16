import { test, expect } from '@playwright/test';

async function stubOtherAdminReads(page) {
  await page.route('**/api/admin/doctor-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/patient-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/settings', route => route.fulfill({ json: { patientAccessMode: 'approved_only', version: 1 } }));
}

test('Approved Doctors directory shows only its minimal fields, pages, and refreshes independently of pending applications', async ({ page }) => {
  await stubOtherAdminReads(page);
  let empty = false;
  const queries = [];
  await page.route('**/api/admin/approved-doctors?*', route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push({ limit: query.get('limit'), cursor: query.get('cursor') });
    const doctors = empty ? [] : query.has('cursor')
      ? [{ uid: 'older', email: 'older@example.invalid', displayName: 'Dr. Older', specialty: 'general_medicine', status: 'approved', approvedAt: '2026-09-28T00:00:00.000Z' }]
      : [{ uid: 'newer', email: 'newer@example.invalid', displayName: 'Dr. Louie', specialty: 'orthopedics', status: 'approved', approvedAt: '2026-09-30T00:00:00.000Z' }];
    return route.fulfill({ json: { doctors, nextCursor: empty || query.has('cursor') ? null : 'newer' } });
  });
  await page.goto('/admin');
  const directory = page.getByRole('region', { name: 'Approved Doctors' });
  await expect(directory.locator('.admin-application')).toHaveCount(1);
  await expect(directory).toContainText('Dr. Louie');
  await expect(directory).toContainText('Orthopedics');
  await expect(directory).toContainText('newer@example.invalid');
  await expect(directory).toContainText('Approved');
  await expect(directory).toContainText('Doctor UID: newer');
  await expect(directory).not.toContainText('Requested specialty');
  await expect(page.locator('#doctor-application-list')).toContainText('No pending doctor applications.');
  await directory.getByRole('button', { name: 'Load more approved Doctors' }).click();
  await expect(directory.locator('.admin-application')).toHaveCount(2);
  await expect(directory.locator('.admin-application').last()).toContainText('Dr. Older');
  empty = true;
  await directory.getByRole('button', { name: 'Refresh approved Doctors' }).click();
  await expect(directory.locator('.admin-empty')).toHaveText('No approved Doctors yet.');
  expect(queries.every(query => query.limit === '25')).toBe(true);
  expect(queries.slice(-2)).toEqual([{ limit: '25', cursor: 'newer' }, { limit: '25', cursor: null }]);
});

test('Approved Doctors directory remains readable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubOtherAdminReads(page);
  await page.route('**/api/admin/approved-doctors?*', route => route.fulfill({ json: { doctors: [{ uid: 'doctor-1', email: 'doctor@example.invalid', displayName: 'Dr. Louie', specialty: 'orthopedics', status: 'approved', approvedAt: '2026-09-30T00:00:00.000Z' }], nextCursor: null } }));
  await page.goto('/admin');
  const directory = page.getByRole('region', { name: 'Approved Doctors' });
  await expect(directory).toContainText('Dr. Louie');
  await expect(directory.getByRole('button', { name: 'Refresh approved Doctors' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Admin removes one specialty while preserving the Doctor’s remaining verified access', async ({ page }) => {
  await stubOtherAdminReads(page);
  let specialties = ['general_medicine', 'orthopedics'];
  await page.route('**/api/admin/approved-doctors?*', route => route.fulfill({ json: { doctors: [{ uid: 'doctor-1', email: 'doctor@example.invalid', displayName: 'Dr. Louie', specialty: specialties[0], specialties, status: 'approved', approvedAt: '2026-09-30T00:00:00.000Z' }], nextCursor: null } }));
  await page.route('**/api/admin/approved-doctors/doctor-1/specialties/orthopedics', async route => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().postDataJSON()).toEqual({ expectedSpecialties: ['general_medicine', 'orthopedics'], confirmed: true });
    specialties = ['general_medicine'];
    await route.fulfill({ json: { removedSpecialty: 'orthopedics', remainingSpecialties: specialties, receipt: { receiptId: 'remove-specialty-1', specialty: 'orthopedics', removedAt: '2026-10-16T00:00:00.000Z', remainingSpecialties: specialties } } });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/admin');
  const directory = page.getByRole('region', { name: 'Approved Doctors' });
  await directory.getByRole('button', { name: 'Remove Orthopedics from Dr. Louie' }).click();
  const specialtyList = directory.locator('.admin-doctor-specialty-list');
  await expect(specialtyList).toContainText('Family Medicine'); await expect(specialtyList).not.toContainText('Orthopedics');
  await expect(directory).toContainText('Dr. Louie'); await expect(page.locator('#admin-receipt-list')).toContainText('remove-specialty-1');
});

test('Admin requires confirmation before removing a Doctor specialty', async ({ page }) => {
  await stubOtherAdminReads(page);
  let removalRequests = 0;
  await page.route('**/api/admin/approved-doctors?*', route => route.fulfill({ json: { doctors: [{ uid: 'doctor-1', email: 'doctor@example.invalid', displayName: 'Dr. Louie', specialty: 'general_medicine', specialties: ['general_medicine'], status: 'approved', approvedAt: '2026-09-30T00:00:00.000Z' }], nextCursor: null } }));
  await page.route('**/api/admin/approved-doctors/doctor-1/specialties/general_medicine', route => {
    removalRequests += 1;
    return route.abort();
  });
  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('final verified specialty');
    expect(dialog.message()).toContain('remove Doctor Portal access');
    await dialog.dismiss();
  });
  await page.goto('/admin');
  const directory = page.getByRole('region', { name: 'Approved Doctors' });
  await directory.getByRole('button', { name: 'Remove Family Medicine from Dr. Louie' }).click();
  await expect(directory.locator('.admin-doctor-specialty-list')).toContainText('Family Medicine');
  expect(removalRequests).toBe(0);
});

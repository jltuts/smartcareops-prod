import { test, expect } from '@playwright/test';

test('Admin portal lists applications and requires explicit credential verification before approval', async ({ page }) => {
  let decisionBody;
  await page.route('**/api/admin/doctor-applications?*', route => {
    return route.fulfill({ json: { applications: decisionBody ? [] : [{ uid: 'applicant-uid', email: 'doctor@example.invalid', displayName: 'Dr. Louie', specialty: 'orthopedics', submittedAt: '2026-09-29T00:00:00.000Z', status: 'pending', version: 3 }], nextCursor: null } });
  });
  await page.route('**/api/admin/doctor-applications/*/decision', async route => {
    decisionBody = route.request().postDataJSON();
    expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    await route.fulfill({ json: { application: { uid: 'applicant-uid', status: 'approved', displayName: 'Dr. Louie', specialty: 'orthopedics' }, receipt: { receiptId: 'doctor-receipt-3', decision: 'approved', applicationVersion: 3, reviewedAt: '2026-09-29T00:01:00.000Z' } } });
  });
  await page.route('**/api/admin/patient-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/settings', route => route.fulfill({ json: { patientAccessMode: 'approved_only', version: 1 } }));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/admin');
  const card = page.locator('.admin-application');
  await expect(card).toContainText('Dr. Louie');
  await expect(card).toContainText('Orthopedics');
  const approve = card.getByRole('button', { name: 'Approve Doctor access' });
  await expect(approve).toBeDisabled();
  await card.getByRole('checkbox').check();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.locator('#doctor-status')).toContainText('Doctor access approved. Receipt doctor-receipt-3.');
  await expect(page.locator('#doctor-status')).toBeFocused();
  expect(decisionBody).toEqual({ decision: 'approved', independentlyVerified: true, applicationVersion: 3, confirmed: true });
  await expect(page.locator('#admin-receipt-list')).toContainText('doctor-receipt-3');
  await expect(card).toHaveCount(0);
});

test('Admin portal renders an honest empty queue and refreshes unavailable queues', async ({ page }) => {
  let retryAllowed = false;
  await page.route('**/api/admin/doctor-applications?*', route => {
    return retryAllowed ? route.fulfill({ json: { applications: [], nextCursor: null } }) : route.fulfill({ status: 503, json: { message: 'Pending applications are unavailable.' } });
  });
  await page.route('**/api/admin/patient-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/settings', route => route.fulfill({ json: { patientAccessMode: 'approved_only', version: 1 } }));
  await page.goto('/admin');
  await expect(page.locator('#doctor-status')).toContainText('Pending applications are unavailable.');
  retryAllowed = true;
  await page.getByRole('button', { name: 'Refresh applications' }).click();
  await expect(page.locator('#doctor-application-list .admin-empty')).toHaveText('No pending doctor applications.');
});

test('Admin can approve Patient access and choose open or approved-only access', async ({ page }) => {
  let decision, mode = 'approved_only';
  await page.route('**/api/admin/doctor-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/patient-applications?*', route => route.fulfill({ json: { applications: decision ? [] : [{ uid: 'patient-uid', email: 'patient@example.invalid', displayName: 'Patient Sample', submittedAt: '2026-09-29T00:00:00.000Z', status: 'pending', version: 2 }], nextCursor: null } }));
  await page.route('**/api/admin/patient-applications/*/decision', async route => { decision = route.request().postDataJSON(); await route.fulfill({ json: { application: { uid: 'patient-uid', status: 'approved' }, receipt: { receiptId: 'patient-receipt-2', decision: 'approved', applicationVersion: 2, reviewedAt: '2026-09-29T00:01:00.000Z' } } }); });
  await page.route('**/api/admin/settings', route => route.fulfill({ json: { patientAccessMode: mode, version: mode === 'open' ? 2 : 1 } }));
  await page.route('**/api/admin/settings/patient-access', async route => { const body = route.request().postDataJSON(); mode = body.mode; expect(body).toEqual({ mode: 'open', expectedVersion: 1, confirmed: true }); await route.fulfill({ json: { patientAccessMode: mode, version: 2, receipt: { receiptId: 'policy-receipt-2', mode, previousVersion: 1, updatedAt: '2026-09-29T00:02:00.000Z' } } }); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/admin');
  const card = page.locator('#patient-application-list .admin-application');
  await expect(card).toContainText('Patient Sample');
  await card.getByRole('button', { name: 'Approve Patient access' }).click();
  await expect(page.locator('#patient-status')).toContainText('Patient access approved. Receipt patient-receipt-2.');
  expect(decision).toEqual({ decision: 'approved', applicationVersion: 2, confirmed: true });
  await page.locator('#patient-access-mode').selectOption('open');
  await page.getByRole('button', { name: 'Save access setting' }).click();
  await expect(page.locator('#patient-access-status')).toContainText('Saved: Anyone signed in. Receipt policy-receipt-2.');
  expect(mode).toBe('open');
});

test('Admin purge requires a preview, typed phrase, and deliberate confirmation', async ({ page }) => {
  let purged = false;
  await page.route('**/api/admin/doctor-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/patient-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/settings', route => route.fulfill({ json: { patientAccessMode: 'approved_only', version: 1 } }));
  await page.route('**/api/admin/purge-preview', route => route.fulfill({ json: { previewId: '11111111-1111-4111-8111-111111111111', expiresAt: '2026-10-01T00:05:00.000Z', dataVersion: 'version-1', counts: { cases: 3, evidenceObjects: 2, googleAuthAccounts: 4 }, total: 9, preservedAuthAccounts: 2 } }));
  await page.route('**/api/admin/purge', async route => { purged = true; expect(route.request().postDataJSON()).toEqual({ confirmation: 'PURGE ALL TEST DATA', previewId: '11111111-1111-4111-8111-111111111111' }); await route.fulfill({ json: { receiptId: 'purge-receipt-1', status: 'completed', total: 9, preservedAuthAccounts: 2 } }); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/admin');
  const purge = page.getByRole('button', { name: 'Purge all test data' });
  await expect(purge).toBeDisabled();
  await page.getByRole('button', { name: 'Preview data to purge' }).click();
  await expect(page.locator('#purge-preview')).toContainText('googleAuthAccounts: 4');
  await expect(page.locator('#purge-preview')).toContainText('johnlouisgarcia@gmail.com');
  await expect(page.locator('#purge-preview')).toContainText('chebulay.12@gmail.com');
  await expect(page.locator('.admin-purge-section')).toContainText('active intake writers are invalidated');
  await expect(page.locator('.admin-purge-section')).toContainText('Google sign-in test accounts');
  await expect(page.locator('#purge-preview')).toContainText('9 records and accounts would be removed');
  await page.locator('#purge-confirmation').fill('PURGE ALL TEST DATA');
  await expect(purge).toBeEnabled(); await purge.click();
  await expect(page.locator('#purge-status')).toContainText('9 test records and accounts deleted. Receipt purge-receipt-1.');
  await expect(page.locator('#admin-receipt-list')).toContainText('purge-receipt-1');
  expect(purged).toBe(true);
});

test('Admin portal route requires the backend-issued Admin role', async ({ page }) => {
  await page.goto('/');
  const access = await page.evaluate(async () => {
    const { resolvePortalAccess } = await import('/src/app/router.js');
    const base = { status: 'SIGNED_IN', user: { uid: 'verified-user' }, authorizationStatus: 'READY', identity: { user: { roles: ['patient'] } } };
    return {
      denied: resolvePortalAccess('/admin', base),
      allowed: resolvePortalAccess('/admin', { ...base, identity: { user: { roles: ['admin'] } } }),
    };
  });
  expect(access).toEqual({ denied: 'UNAUTHORIZED', allowed: 'AUTHORIZED' });
});

test('Admin cannot change fixed Demo Doctor roles', async ({ page }) => {
  await page.route('**/api/admin/doctor-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/patient-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/approved-doctors?*', route => route.fulfill({ json: { doctors: [], nextCursor: null } }));
  await page.route('**/api/admin/settings', route => route.fulfill({ json: { patientAccessMode: 'approved_only', version: 1 } }));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Demo Doctor access' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Doctor access/ })).toHaveCount(0);
});

test('Admin purge reports a partial failure honestly, restores retry controls, and remains responsive', async ({ page }) => {
  await page.route('**/api/admin/doctor-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/patient-applications?*', route => route.fulfill({ json: { applications: [], nextCursor: null } }));
  await page.route('**/api/admin/settings', route => route.fulfill({ json: { patientAccessMode: 'approved_only', version: 4 } }));
  await page.route('**/api/admin/purge-preview', route => route.fulfill({ json: { previewId: '22222222-2222-4222-8222-222222222222', expiresAt: '2026-10-01T00:05:00.000Z', dataVersion: 'version-2', counts: { cases: 1, evidenceObjects: 1 }, total: 2 } }));
  await page.route('**/api/admin/purge', route => route.fulfill({ status: 503, json: { code: 'PURGE_PARTIAL_FAILURE', message: 'The purge completed only partially.', receipt: { receiptId: 'purge-partial-1', status: 'partial_failure', total: 1, errorCategories: ['TEMPORARY_UNAVAILABLE'] } } }));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Preview data to purge' }).click();
  await page.locator('#purge-confirmation').fill('PURGE ALL TEST DATA');
  await page.getByRole('button', { name: 'Purge all test data' }).click();
  await expect(page.locator('#purge-status')).toContainText('completed only partially');
  await expect(page.locator('#purge-status')).toContainText('purge-partial-1');
  await expect(page.getByRole('button', { name: 'Preview data to purge' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Purge all test data' })).toBeDisabled();
  await expect(page.locator('#admin-receipt-list')).toContainText('purge-partial-1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const sizes = await page.locator('button:visible').evaluateAll(buttons => buttons.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
  expect(sizes.every(size => size.height >= 42 && size.width >= 42)).toBe(true);
});

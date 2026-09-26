import { test, expect } from '@playwright/test';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { emergencyIntake } from '../../backend/tests/safety-fixtures.js';

async function fixture(page, acknowledge = true) {
  const store = createMemoryCaseStore(), id = newCaseId();
  await store.createCase({ caseId: id, intake: emergencyIntake() }); if (acknowledge) await store.acknowledgeEmergency(id);
  await page.route('**/api/ambulances', async route => route.fulfill({ json: await store.listAmbulances() }));
  await page.route('**/api/dispatcher/cases**', async route => {
    const url = new URL(route.request().url()), parts = url.pathname.split('/');
    try {
      const record = url.pathname === '/api/dispatcher/cases' ? await store.listDispatcherCases() : await store.getDispatcherCase(parts[4]);
      await route.fulfill({ json: record });
    } catch { await route.fulfill({ status: 404, json: {} }); }
  });
  await page.route(`**/api/cases/${id}**`, async route => {
    const path = new URL(route.request().url()).pathname, parts = path.split('/');
    try {
      let record;
      if (parts.at(-1) === id) record = await store.getCase(id);
      else {
        expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({});
        record = parts.at(-1) === 'dispatch' ? await store.dispatchAmbulance(id) : await store.assignAmbulance(id, parts[5]);
      }
      await route.fulfill({ json: record });
    } catch { await route.fulfill({ status: 409, json: {} }); }
  });
  const open = async () => {
    await page.goto('/dispatcher'); await page.getByRole('button', { name: `Open emergency case ${id}`, exact: true }).click();
    await expect(page.locator('#dispatcher-ambulance')).toBeVisible();
  };
  return { store, id, open };
}
test('assignment and simulated dispatch persist across Dispatcher and Patient refresh', async ({ page }) => {
  const { store, id, open } = await fixture(page);
  await page.addInitScript(caseId => sessionStorage.setItem('smartcareops-case-id', caseId), id);
  await open(); await expect(page.locator('#ambulance-unit option')).toHaveCount(3);
  await page.getByLabel('Available fictional ambulances').selectOption('AMB-01');
  await page.getByRole('button', { name: 'Assign ambulance (simulation)', exact: true }).click();
  await expect(page.locator('#dispatcher-ambulance-status')).toHaveText('AMB-01 — Assigned');
  const assignedAt = (await store.getCase(id)).ambulance.assignedAt;
  await page.reload(); await page.getByRole('button', { name: `Open emergency case ${id}`, exact: true }).click();
  await expect(page.locator('#dispatcher-ambulance-status')).toHaveText('AMB-01 — Assigned');
  await page.goto('/patient'); await expect(page.locator('#patient-case-ambulance-status')).toHaveText('AMB-01 — Assigned');
  await expect(page.locator('#patient-case-ambulance')).toContainText('fictional simulation');
  await expect(page.locator('#patient-case-emergency-status')).toHaveText('Status: Dispatcher acknowledged');
  await open(); await page.getByRole('button', { name: 'Dispatch ambulance (simulation)', exact: true }).click();
  await expect(page.locator('#dispatcher-ambulance-status')).toHaveText('AMB-01 — En route');
  await page.reload(); await page.getByRole('button', { name: `Open emergency case ${id}`, exact: true }).click();
  await expect(page.locator('#dispatcher-ambulance-status')).toHaveText('AMB-01 — En route');
  await expect(page.getByRole('button', { name: 'Dispatch ambulance (simulation)', exact: true })).toHaveCount(0);
  await page.goto('/patient'); await expect(page.locator('#patient-case-ambulance-status')).toHaveText('AMB-01 — En route');
  await page.reload(); await expect(page.locator('#patient-case-ambulance-status')).toHaveText('AMB-01 — En route');
  await expect(page.getByRole('button', { name: 'Route to doctor', exact: true })).toBeHidden();
  expect((await store.getCase(id)).ambulance.assignedAt).toBe(assignedAt);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('pending emergency does not expose assignment or dispatch controls', async ({ page }) => {
  const { open } = await fixture(page, false); await open();
  await expect(page.locator('#dispatcher-ambulance')).toContainText('Dispatcher acknowledgement is required');
  await expect(page.getByRole('button', { name: 'Assign ambulance (simulation)', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dispatch ambulance (simulation)', exact: true })).toHaveCount(0);
});
test('stale unit availability fails safely, refresh offers only remaining units', async ({ page }) => {
  const { store, open } = await fixture(page); await open(); await expect(page.locator('#ambulance-unit option')).toHaveCount(3);
  const other = newCaseId(); await store.createCase({ caseId: other, intake: emergencyIntake() }); await store.acknowledgeEmergency(other); await store.assignAmbulance(other, 'AMB-01');
  await page.getByRole('button', { name: 'Assign ambulance (simulation)', exact: true }).click();
  await expect(page.locator('#ambulance-message')).toContainText('could not be confirmed');
  await expect(page.locator('#dispatcher-ambulance-status')).toHaveText('No ambulance assigned');
  await page.getByRole('button', { name: 'Refresh available units' }).click(); await expect(page.locator('#ambulance-unit option')).toHaveCount(2);
  await expect(page.locator('#ambulance-unit option[value="AMB-01"]')).toHaveCount(0);
  await page.getByLabel('Available fictional ambulances').selectOption('AMB-02');
  await page.getByRole('button', { name: 'Assign ambulance (simulation)', exact: true }).click();
  await expect(page.locator('#dispatcher-ambulance-status')).toHaveText('AMB-02 — Assigned');
});
test('fleet errors and exhaustion cannot produce assignments', async ({ page }) => {
  const { store, open } = await fixture(page);
  await page.route('**/api/ambulances', route => route.fulfill({ status: 503, json: {} }));
  await open(); await expect(page.locator('#ambulance-message')).toHaveText('Fleet unavailable. Refresh available units to retry.');
  await expect(page.getByRole('button', { name: 'Assign ambulance (simulation)', exact: true })).toBeDisabled();
  for (const unit of ['AMB-01', 'AMB-02', 'AMB-03']) {
    const caseId = newCaseId(); await store.createCase({ caseId, intake: emergencyIntake() }); await store.acknowledgeEmergency(caseId); await store.assignAmbulance(caseId, unit);
  }
  await page.unroute('**/api/ambulances');
  await page.route('**/api/ambulances', async route => route.fulfill({ json: await store.listAmbulances() }));
  await page.getByRole('button', { name: 'Refresh available units' }).click();
  await expect(page.locator('#ambulance-message')).toHaveText('No fictional ambulances are available.');
  await expect(page.getByRole('button', { name: 'Assign ambulance (simulation)', exact: true })).toBeDisabled();
});

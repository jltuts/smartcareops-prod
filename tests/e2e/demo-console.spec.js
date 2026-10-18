import { test, expect } from '@playwright/test';

const boundary = {
  reference: 'SC-12345678-1234-4123-8123-123456789abc',
  event: 'Routine intake recorded',
  projection: 'Operations projection recorded',
  routing: 'Kept in normal care',
  hospitalOperationsTriggered: false,
  classifiedAt: '2026-10-11T01:00:00.000Z',
  trace: [
    ['Intake case', 'Committed'], ['Outbox event', 'Recorded'], ['Audit receipt', 'Recorded'],
    ['Operations projection', 'Recorded'], ['Routing decision', 'Normal care'], ['Hospital Operations activation', 'Not requested'],
  ].map(([label, status]) => ({ label, status })),
};
const operations = { demoBoundary: boundary,
  runs: [{ runId: 'ops_run_3', status: 'completed', startedAt: '2026-10-11T00:30:00.000Z', planRevisionId: 'OPS-PLAN-3' },
    { runId: 'ops_run_1', status: 'completed', startedAt: '2026-10-10T00:30:00.000Z', planRevisionId: 'OPS-PLAN-1' }],
  decisionTrace: [{ planRevisionId: 'OPS-PLAN-3', triggers: [{ eventType: 'hospital.capacity.changed' }], action: {}, approval: { status: 'pending' } }],
};

test('Demo Console verifies the routine intake boundary without exposing Patient data', async ({ page }) => {
  await page.route('**/api/demo-console', route => route.fulfill({ json: operations }));
  await page.goto('/demo-console');
  await expect(page.getByRole('heading', { name: 'Demo Console' })).toBeVisible();
  await expect(page.getByText('Routine intake stayed in the normal care pathway.')).toBeVisible();
  await expect(page.getByText('Hospital Operations activation').locator('..')).toContainText('Not requested');
  await expect(page.getByText('Patient details shared').locator('..')).toContainText('None');
  await expect(page.getByText('Reference SC-12345678-1234-4123-8123-123456789abc')).toBeVisible();
  await expect(page.getByText('Agentic session 3')).toBeVisible();
  await expect(page.getByText('Agentic session 1')).toHaveCount(0);
  await expect(page.getByText('Hospital capacity changed')).toBeVisible();
  await expect(page.getByText('Routine intake routing stops here by design.')).toBeVisible();
  await expect(page.getByText(/dizz/i)).toHaveCount(0);
  await expect(page.locator('.demo-console-heading').getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Demo Console verifies a pasted Case ID, clears it, and displays only its masked trace', async ({ page }) => {
  const fullCaseId = 'SC-12345678-1234-4123-8123-123456789abc';
  await page.route('**/api/demo-console', route => route.fulfill({ json: operations }));
  await page.route('**/api/demo-console/verify', async route => {
    expect(await route.request().postDataJSON()).toEqual({ caseId: fullCaseId });
    await route.fulfill({ json: { demoBoundary: boundary } });
  });
  await page.goto('/demo-console');
  await page.getByLabel('Verify a specific case').fill(fullCaseId);
  await page.getByRole('button', { name: 'Verify trace' }).click();
  await expect(page.getByLabel('Verify a specific case')).toHaveValue('');
  await expect(page.getByText(`Reference ${fullCaseId}`)).toBeVisible();
  await expect(page.getByText('Outbox event').locator('..')).toContainText('Recorded');
  await expect(page.locator('body')).toContainText(fullCaseId);
});

test('Demo Console presents an older projection as a pre-rollout trace without inferring routing', async ({ page }) => {
  const fullCaseId = 'SC-6ac4e105-34ef-47cf-a0a0-39cab57bef2d';
  const legacy = { ...boundary, classificationStatus: 'legacy_unclassified', reference: fullCaseId, hospitalOperationsTriggered: null,
    trace: boundary.trace.map(item => ['Routing decision', 'Hospital Operations activation'].includes(item.label) ? { ...item, status: 'Not recorded' } : item) };
  await page.route('**/api/demo-console', route => route.fulfill({ json: operations }));
  await page.route('**/api/demo-console/verify', route => route.fulfill({ json: { demoBoundary: legacy } }));
  await page.goto('/demo-console');
  await page.getByLabel('Verify a specific case').fill(fullCaseId);
  await page.getByRole('button', { name: 'Verify trace' }).click();
  await expect(page.getByText('Pre-rollout trace', { exact: true })).toBeVisible();
  await expect(page.getByText('This case reached the event boundary before routing classification was recorded.')).toBeVisible();
  await expect(page.locator('.demo-trace').getByText('Routing decision').locator('..')).toContainText('Not recorded');
  await expect(page.locator('body')).toContainText(fullCaseId);
});

test('Demo Console shows the human-controlled emergency response without starting an agentic session', async ({ page }) => {
  const fullCaseId = 'SC-00000000-0000-4000-8000-00000000337a';
  const emergency = { ...boundary, classificationStatus: 'emergency', reference: fullCaseId, event: 'Emergency intake recorded',
    routing: 'Dispatcher acknowledged', hospitalOperationsTriggered: false,
    trace: [['Emergency intake', 'Committed'], ['Outbox event', 'Recorded'], ['Audit receipt', 'Recorded'], ['Operations projection', 'Recorded'],
      ['Emergency pathway', 'Dispatcher acknowledged'], ['Emergency response', 'Ambulance en route'], ['Hospital Operations activation', 'Not requested']].map(([label, status]) => ({ label, status })) };
  await page.route('**/api/demo-console', route => route.fulfill({ json: operations }));
  await page.route('**/api/demo-console/verify', route => route.fulfill({ json: { demoBoundary: emergency } }));
  await page.goto('/demo-console');
  await page.getByLabel('Verify a specific case').fill(fullCaseId);
  await page.getByRole('button', { name: 'Verify trace' }).click();
  await expect(page.getByText('Emergency trace', { exact: true })).toBeVisible();
  await expect(page.getByText('Emergency intake entered the human-controlled Dispatcher pathway.')).toBeVisible();
  await expect(page.locator('.demo-trace').getByText('Emergency pathway').locator('..')).toContainText('Dispatcher acknowledged');
  await expect(page.locator('.demo-trace').getByText('Emergency response').locator('..')).toContainText('Ambulance en route');
  await expect(page.getByText('Not created. Emergency response remains human-controlled.')).toBeVisible();
  await expect(page.locator('body')).toContainText(fullCaseId);
  await expect(page.locator('body')).not.toContainText(/severe breathing|preferred name/i);
});

test('Demo Console explains how to create verification evidence when no routine event is available', async ({ page }) => {
  await page.route('**/api/demo-console', route => route.fulfill({ json: { demoBoundary: null, runs: [], decisionTrace: [] } }));
  await page.goto('/demo-console');
  await expect(page.getByRole('heading', { name: 'No recent routine intake decision' })).toBeVisible();
  await expect(page.getByText('Complete a new fictional Chat intake')).toBeVisible();
  await expect(page.locator('#demo-boundary-path')).toBeHidden();
});

test('Demo Console is available to every authenticated demo account', async ({ page }) => {
  await page.goto('/');
  const access = await page.evaluate(async () => {
    const { resolvePortalAccess } = await import('/src/app/router.js');
    const auth = (roles, demoAccess = true) => ({ status: 'SIGNED_IN', user: { uid: 'demo-user' }, authorizationStatus: 'READY', identity: { demoAccess, user: { roles } } });
    return {
      patient: resolvePortalAccess('/demo-console', auth(['patient'])),
      commandCenter: resolvePortalAccess('/demo-console', auth(['command-center'])),
      commandCenterAlias: resolvePortalAccess('/demo-console', auth(['command_center'])),
      unapproved: resolvePortalAccess('/demo-console', auth([], false)),
    };
  });
  expect(access).toEqual({ patient: 'AUTHORIZED', commandCenter: 'AUTHORIZED', commandCenterAlias: 'AUTHORIZED', unapproved: 'UNAUTHORIZED' });
});

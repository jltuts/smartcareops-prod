import { test, expect } from '@playwright/test';
import { emptyIntake } from '../../backend/src/intake/schema.js';
import { openBrowser, viewport } from '../../backend/src/agent/browser.js';
import { caseFields } from '../../backend/src/agent/cases.js';
import { runHandoff } from '../../backend/src/agent/loop.js';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
function sample() { const intake = emptyIntake(); intake.patient.name = 'Demo Jael'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Demo Jael' }; return intake; }
test('fictional portal renders separately and submission shows a visible receipt', async ({ page }) => {
  await page.goto('/hospital-demo');
  await expect(page.getByRole('heading', { name: 'Hospital Intake Demo' })).toBeVisible();
  await expect(page.getByText('FICTIONAL HOSPITAL', { exact: false })).toBeVisible();
  await page.getByLabel('Patient Name', { exact: true }).fill('Demo Jael');
  await page.getByLabel('Chest Pain', { exact: true }).fill('denied');
  await page.getByRole('button', { name: 'SUBMIT INTAKE' }).click();
  await expect(page.getByRole('heading', { name: 'INTAKE RECEIVED' })).toBeVisible();
  await expect(page.locator('#case-id')).toHaveText(/^DEMO-[A-F0-9]{8}$/);
  await expect(page.locator('#received-fields')).toContainText('Demo Jael');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.reload();
  await expect(page.getByLabel('Patient Name', { exact: true })).toHaveValue('');
  await expect(page.locator('#receipt')).toBeHidden();
});

test('production browser adapter executes mocked visual actions and verifies rendered receipt', async ({ page }) => {
  test.setTimeout(60000);
  // The mock model uses fixture coordinates, not a production form-fill fallback.
  await page.setViewportSize(viewport); await page.goto('/hospital-demo');
  const box = await page.getByLabel('Patient Name', { exact: true }).boundingBox();
  const intake = sample(); const expected = caseFields(intake);
  const controller = new AbortController(); let controlled;
  const plans = [
    { type: 'function_call', id: 'focus', name: 'click', arguments: { x: Math.floor((box.x + 10) / viewport.width * 1000), y: Math.floor((box.y + 10) / viewport.height * 1000) } },
    { type: 'function_call', id: 'name', name: 'type', arguments: { text: 'Demo Jael' } },
    ...Array.from({ length: 11 }, (_, i) => ({ type: 'function_call', id: `tab-${i}`, name: 'press_key', arguments: { key: 'Tab' } })),
    { type: 'function_call', id: 'submit', name: 'press_key', arguments: { key: 'Enter' } },
  ];
  let round = 0;
  const result = await runHandoff({ intake, portalUrl: `http://127.0.0.1:${process.env.E2E_API_PORT || 8080}/hospital-demo`, emit() {}, signal: controller.signal, confirm: async () => false,
    open: async args => { controlled = await openBrowser({ ...args, headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }); return controlled; },
    request: async () => {
      if (round++ === 0) return { steps: plans };
      const id = await controlled.receipt(expected);
      return { steps: [{ type: 'model_output', content: [{ type: 'text', text: `INTAKE RECEIVED ${id}` }] }] };
    },
  });
  expect(result.caseId).toMatch(/^DEMO-[A-F0-9]{8}$/);
});

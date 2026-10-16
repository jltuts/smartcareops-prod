import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { createApiServer } from '../../backend/src/server.js';
import { createMemoryCaseStore, newCaseId } from '../../backend/src/cases/store.js';
import { memoryClinicalStore } from '../../backend/src/clinical/storage.js';
import { createClinicalService } from '../../backend/src/clinical/service.js';
import { createHospitalHandoff } from '../../backend/src/hospital/service.js';
import { createComputerUseConnector } from '../../backend/src/hospital/connectors.js';
import { hash } from '../../backend/src/hospital/contracts.js';
import { routingIntake } from '../../backend/tests/routing-fixtures.js';
import { assessment } from '../../backend/tests/clinical-fixtures.js';

for (const connector of ['rest', 'computer_use']) test(`doctor review and approval executes ${connector} once; patient remains status only`, async ({ page }) => {
  const caseStore = createMemoryCaseStore(), caseId = newCaseId(); let calls = 0;
  await caseStore.createCase({ caseId, intake: routingIntake(), fictionalConfirmed: true, submittedForReview: true });
  const connectors = {
    rest: { submitCase: async input => { calls++; return { receiptId: 'DEMO-1234ABCD', verified: true, caseId, hospitalId: input.hospitalId, idempotencyKey: input.idempotencyKey, payloadDigest: hash(input.payload) }; }, lookupReceipt: async () => null },
    computer_use: createComputerUseConnector({ portalUrl: () => 'http://127.0.0.1:8080/hospital-demo', run: async options => {
      calls++; if (!await options.confirm({ explanation: 'private provider detail' })) throw new Error('Declined');
      options.emit({ status: 'completed', caseId: 'DEMO-1234ABCD' }); return { caseId: 'DEMO-1234ABCD' };
    } }),
  };
  const hospitalHandoff = createHospitalHandoff({ store: caseStore, connectors, targets: { 'HOSP-001': { connector, version: 'e2e-v1' } } });
  const clinicalService = createClinicalService({ store: memoryClinicalStore(), caseStore, caseId, hospitalHandoff, modelName: 'test-model', model: async c => ({ ...assessment(c), recommendedActions: [{ toolName: 'submit_hospital_case', arguments: { hospitalId: 'HOSP-001' }, proposedRisk: 'READ_ONLY', expectedOutcome: 'Submit fictional case to selected hospital.' }] }) });
  const api = createApiServer({ caseStore, clinicalService }); api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
  const base = `http://127.0.0.1:${api.server.address().port}`;
  try {
    await page.route(/\/api\/(clinical|doctor|cases)/, async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: base + url.pathname + url.search }); await route.fulfill({ response });
    });
    await page.goto('/doctor'); await page.getByRole('button', { name: `Open case ${caseId}`, exact: true }).click();
    await expect(page.locator('#doctor-detail')).toContainText('Waiting for clinical review');
    expect((await clinicalService.view()).approvals).toHaveLength(0); expect(calls).toBe(0);
    await page.getByRole('button', { name: 'Run AI review', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve hospital handoff', exact: true })).toBeVisible();
    expect(calls).toBe(0); await page.reload();
    await expect(page.getByRole('button', { name: 'Approve hospital handoff', exact: true })).toBeVisible(); expect(calls).toBe(0);
    await page.getByRole('button', { name: 'Approve hospital handoff', exact: true }).click();
    if (connector === 'computer_use') {
      await expect(page.getByRole('button', { name: 'Approve legacy submission action' })).toBeVisible();
      await page.getByRole('button', { name: 'Approve legacy submission action' }).click();
    }
    await expect(page.getByText(/Fictional hospital confirmed receipt DEMO-1234ABCD/)).toBeVisible();
    await page.reload(); await expect(page.getByText(/Fictional hospital confirmed receipt DEMO-1234ABCD/)).toBeVisible(); expect(calls).toBe(1);
    await page.evaluate(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
    await page.goto('/patient'); await expect(page.locator('#handoff-receipt')).toContainText('DEMO-1234ABCD');
    await expect(page.getByRole('button', { name: /Approve|Start Handoff|Computer Use|Execute|Start Agent/i })).toHaveCount(0);
    expect(calls).toBe(1);
  } finally { await api.shutdown(); }
});

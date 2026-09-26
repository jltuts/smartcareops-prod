import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createApiServer } from '../../backend/src/server.js';
import { createMemoryCaseStore } from '../../backend/src/cases/store.js';
const { WebSocket } = createRequire(new URL('../../backend/src/live.js', import.meta.url))('ws');
test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

for (const outcome of ['normal', 'emergency']) test(`saved ${outcome} intake never executes a hospital connector`, async ({ page }) => {
  let callbacks, calls = 0, release, closed = 0, requestStart;
  const store = createMemoryCaseStore();
  const api = createApiServer({ caseStore: store, liveOptions: { apiKey: 'fake',
    connect: async options => { callbacks = options.callbacks; queueMicrotask(() => callbacks.onmessage({ setupComplete: {} })); return { sendRealtimeInput() {}, close() { closed++; } }; },
    extract: async ({ utterances }) => ({ updates: utterances.map(u => ({ kind: outcome === 'emergency' ? 'redFlag' : 'name', label: outcome === 'emergency' ? 'current chest pain' : null, value: outcome === 'emergency' ? null : 'Demo Alex', secondaryValue: null, unit: null, qualitative: null, status: outcome === 'emergency' ? 'confirmed' : null, evidenceId: u.id, quote: u.text })) }),
  }, agentRun: async () => { calls++; throw new Error('Patient must not execute Computer Use'); },
    hospitalConnectors: { rest: { submitCase: async () => { calls++; throw new Error('Patient must not execute REST'); } } } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
  const base = `http://127.0.0.1:${api.server.address().port}`;
  try {
    await page.route('**/api/cases/**', async route => { const response = await route.fetch({ url: base + new URL(route.request().url()).pathname }); await route.fulfill({ response }); });
    await page.route('**/api/intake-finalization', async route => { const response = await route.fetch({ url: base + '/api/intake-finalization' }); await route.fulfill({ response }); });
    await page.routeWebSocket('**/api/live', socket => {
      const backend = new WebSocket(base.replace('http', 'ws') + '/api/live', { origin: 'http://127.0.0.1:4173' }); const opened = once(backend, 'open');
      socket.onMessage(async raw => { await opened; const m = JSON.parse(raw); if (m.type === 'start') requestStart = m; if (backend.readyState === WebSocket.OPEN) backend.send(raw); });
      socket.onClose(() => backend.close()); backend.on('message', raw => socket.send(raw.toString())); backend.on('close', () => socket.close());
    });
    await page.goto('/patient');
    await expect(page.getByRole('button', { name: 'Start Conversation' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Start Agent|Trigger Workflow|Execute Agent|Run Reasoning/ })).toHaveCount(0);
    await page.locator('#intake-fictional').check(); await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected'); expect(requestStart.fictionalConfirmed).toBe(true);
    const emit = content => callbacks.onmessage({ serverContent: content });
    emit({ inputTranscription: { text: outcome === 'emergency' ? 'I have chest pain.' : 'My name is Demo Alex.', finished: true } });
    emit({ outputTranscription: { text: 'Your intake is complete.' }, turnComplete: true });
    if (outcome === 'emergency') {
      await expect(page.locator('#handoff-status')).toContainText('Pending dispatcher workflow'); expect(calls).toBe(0);
      await page.reload(); await expect(page.locator('#handoff-status')).toContainText('Pending dispatcher workflow'); expect(calls).toBe(0); return;
    }
    await expect(page.locator('#connection-status')).toHaveText('Completed'); expect(closed).toBe(1);
    await expect(page.locator('#handoff-status')).toHaveText('Your intake has been submitted for clinical review.');
    await expect(page.locator('#intake-saved-stages')).toContainText('Submitted for clinical review');
    await expect(page.getByRole('button', { name: /Start Agent|Start Handoff|Computer Use|Approve|Execute|Route to doctor/i })).toHaveCount(0);
    const id = await page.locator('#patient-case-id').textContent();
    const record = await store.getCase(id);
    expect(record.workflowStatus).toBe('submitted_for_clinical_review'); expect(record.hospitalHandoffs).toHaveLength(0);
    expect(record.handoffStatus).toBe('not_started'); expect(calls).toBe(0);
    await page.reload(); await expect(page.locator('#handoff-status')).toHaveText('Your intake has been submitted for clinical review.');
    await page.getByRole('button', { name: 'Refresh case', exact: true }).click();
    await expect(page.locator('#handoff-status')).toHaveText('Your intake has been submitted for clinical review.'); expect(calls).toBe(0);
  } finally { release?.(); await api.shutdown(); }
});

test('refresh of an unknown attempt shows reconciliation and cannot resubmit', async ({ page }) => {
  const { randomUUID } = await import('node:crypto');
  const { emptyIntake } = await import('../../backend/src/intake/schema.js');
  const { newCaseId, Handoff } = await import('../../backend/src/cases/store.js');
  const store = createMemoryCaseStore(), caseId = newCaseId(), attemptId = randomUUID();
  const intake = emptyIntake(); intake.patient.name = 'Demo Alex'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Demo Alex' };
  await store.createCase({ caseId, intake, fictionalConfirmed: true });
  await store.updateCaseStatus(caseId, Handoff.PENDING, attemptId); await store.updateCaseStatus(caseId, Handoff.ACTIVE, attemptId);
  let runs = 0; const api = createApiServer({ caseStore: store, agentRun: async () => { runs++; throw new Error('Must not replay'); } });
  api.server.listen(0, '127.0.0.1'); await once(api.server, 'listening');
  try {
    await page.addInitScript(id => sessionStorage.setItem('smartcareops-case-id', id), caseId);
    await page.route('**/api/cases/**', async route => { const response = await route.fetch({ url: `http://127.0.0.1:${api.server.address().port}` + new URL(route.request().url()).pathname }); await route.fulfill({ response }); });
    await page.goto('/patient'); await expect(page.locator('#handoff-status')).toContainText('reviewing hospital confirmation');
    await page.reload(); await expect(page.locator('#handoff-status')).toContainText('reviewing hospital confirmation');
    await expect(page.locator('#handoff-start')).toHaveCount(0); expect(runs).toBe(0);
    expect((await store.getCase(caseId)).handoffStatus).toBe(Handoff.ACTIVE);
  } finally { await api.shutdown(); }
});

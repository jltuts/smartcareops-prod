import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { hospitalDemo } from '../../backend/src/agent/portal.js';
import { openBrowser } from '../../backend/src/agent/browser.js';
import { caseFields } from '../../backend/src/agent/cases.js';
import { emptyIntake } from '../../backend/src/intake/schema.js';
async function fixture(change = value => value) {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(change(hospitalDemo)); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await openBrowser({ portalUrl: `http://127.0.0.1:${server.address().port}/hospital-demo`, signal: new AbortController().signal, headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', onBlocked: () => {} });
  const intake = emptyIntake(); intake.patient.name = 'Demo Alex'; intake.evidence.name = { utteranceId: 1, patientReportedText: 'Demo Alex' }; intake.additionalNotes = ['It feels like pressure.'];
  return { browser, fields: caseFields(intake), close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
test('isolated helper verifies every fixed field without submitting and refuses a second fill', async () => {
  const f = await fixture(); try { expect(await f.browser.populateValidated(f.fields)).toEqual({ fieldsVerified: 11 }); expect(await f.browser.receipt(f.fields)).toBeNull(); await expect(f.browser.populateValidated(f.fields)).rejects.toThrow('already attempted'); } finally { await f.close(); }
});
test('changed portal fields block deterministic population', async () => {
  const f = await fixture(html => html.replace('name="Patient Name"', 'name="Unexpected"')); try { await expect(f.browser.populateValidated(f.fields)).rejects.toThrow('contract changed'); } finally { await f.close(); }
});

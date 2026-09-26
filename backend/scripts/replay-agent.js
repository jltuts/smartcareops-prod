// One real M3 run with a fictional fixture; does not invoke or change M2.
// Uses backend/.env through server.js. Makes real Gemini Computer Use calls.
import { once } from 'node:events';
import { createApiServer } from '../src/server.js';
import { emptyIntake } from '../src/intake/schema.js';
import { runHandoff } from '../src/agent/loop.js';
import { diagnosticsFor } from '../src/agent/diagnostics.js';

const api = createApiServer();
try {
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  const intake = emptyIntake();
  intake.patient.name = 'Fictional Diagnostic Test';
  intake.evidence.name = { utteranceId: 1, patientReportedText: 'Fictional Diagnostic Test' };
  await runHandoff({
    intake,
    portalUrl: `http://127.0.0.1:${api.server.address().port}/hospital-demo`,
    emit() {},
    // An unattended replay never approves a safety confirmation.
    confirm: async () => false,
  });
  console.log('Fictional handoff completed with a verified receipt.');
} catch (error) {
  if (!diagnosticsFor(error)) console.log('Replay setup failed; no handoff diagnostics available.');
  process.exitCode = 1;
} finally {
  await api.shutdown();
}

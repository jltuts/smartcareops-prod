import { test, expect } from '@playwright/test';
import { emptyIntake } from '../../backend/src/intake/schema.js';
import { createIntakeSession } from '../../backend/src/intake/session.js';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('validated correction clears only the related visible repair after invalid schema', async ({ page }) => {
  let session, reject = true;
  await page.routeWebSocket('**/api/live', socket => {
    session = createIntakeSession({ delay: 1, log() {}, send: message => socket.send(JSON.stringify(message)), extract: async ({ utterances }) => {
      const u = utterances.at(-1);
      return { updates: [{ kind: 'symptom', label: 'chest pain', value: null, secondaryValue: null, unit: null, qualitative: null, status: reject ? null : 'denied', evidenceId: u.id, quote: u.text }] };
    } });
    socket.onMessage(raw => {
      if (JSON.parse(raw).type === 'start') { socket.send(JSON.stringify({ type: 'ready' })); session.start(); }
      if (JSON.parse(raw).type === 'end') session.close();
    });
  });
  try {
    await page.goto('/patient');
    await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    const answer = text => {
      session.accept({ outputTranscription: { text: 'Are you having chest pain?' }, turnComplete: true });
      session.accept({ inputTranscription: { text, finished: true } });
    };
    answer('I have chess playing.');
    await expect(page.locator('#intake-interpretation')).toHaveText('1 reported item(s) need clarification.');
    answer('Nope.');
    await expect(page.locator('#intake-status')).toContainText('temporarily unavailable');
    await expect(page.locator('#intake-interpretation')).toHaveText('1 reported item(s) need clarification.');
    reject = false;
    answer('Nope.');
    await expect(page.locator('#intake-status')).toHaveText('Updated from the conversation.');
    await expect(page.locator('#intake-interpretation')).toHaveText('Reported information has been organized. Missing fields remain blank.');
    await expect(page.locator('[data-group="denied"]')).toContainText('chest pain');
    await expect(page.locator('[data-intake="redFlags"] [data-status="unclear"]')).toHaveCount(0);
    await expect(page.locator('#intake-diagnostics')).toBeHidden();
  } finally { session?.close(); }
});

test('extraction queue reports quota failures and validated updates reach the visible summary', async ({ page }) => {
  let session; let fail = true;
  const batches = [];
  const reports = ['My name is JL.', "I'm feeling dizzy.", 'It started yesterday.', 'My blood pressure was 145 over 90.'];
  const facts = [{ kind: 'name', value: 'JL' }, { kind: 'symptom', label: 'dizzy', status: 'confirmed' }, { kind: 'onset', value: 'yesterday' }, { kind: 'bloodPressure', value: 145, secondaryValue: 90 }];
  await page.routeWebSocket('**/api/live', socket => {
    // Only the external extraction API is mocked; queue, validation, merge and UI are real.
    session = createIntakeSession({ delay: 1, log() {}, send: message => socket.send(JSON.stringify(message)), extract: async ({ utterances }) => {
      batches.push(utterances.map(u => u.id));
      if (fail) throw Object.assign(new Error('Quota exceeded'), { status: 429 });
      return { updates: utterances.filter(u => reports.includes(u.text)).map(u => ({ kind: null, label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId: u.id, quote: u.text, ...facts[reports.indexOf(u.text)] })) };
    } });
    socket.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'start') { socket.send(JSON.stringify({ type: 'ready' })); session.start(); }
      if (m.type === 'end') session.close();
    });
  });
  try {
    await page.goto('/patient');
    await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    for (const text of reports) session.accept({ inputTranscription: { text, finished: true } });
    await expect(page.locator('#intake-status')).toHaveText('Clinical summary is temporarily unavailable. Please try again shortly.');
    await page.locator('#intake-diagnostics summary').click();
    await expect(page.locator('#intake-error-detail')).toContainText('Gemini API quota or rate limit exceeded (HTTP 429).');
    await expect(page.locator('#handoff-status')).toHaveText('Waiting to begin…');
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    await expect(page.locator('#handoff-start')).toHaveCount(0);
    expect(batches).toEqual([[1, 2, 3, 4]]);
    await expect(page.locator('[data-intake="patient"] .intake-value').first()).toHaveText('—');
    fail = false;
    session.accept({ inputTranscription: { text: "That's correct.", finished: true } });
    await expect(page.locator('#intake-status')).toHaveText('Updated from the conversation.');
    await expect(page.locator('[data-intake="patient"] .intake-value').first()).toHaveText('JL');
    await expect(page.locator('[data-group="confirmed"]')).toContainText('dizzy');
    await expect(page.locator('[data-intake="onset"]')).toContainText('yesterday');
    await expect(page.locator('[data-intake="vitals"]')).toContainText('145 / 90');
    await expect(page.locator('[data-intake="vitals"]')).toContainText('REPORTED');
    fail = true;
    session.accept({ inputTranscription: { text: 'Another detail.', finished: true } });
    await expect(page.locator('#intake-status')).toHaveText('Clinical summary is temporarily unavailable. Please try again shortly.');
    await expect(page.locator('[data-intake="patient"] .intake-value').first()).toHaveText('JL');
    await expect(page.locator('[data-intake="vitals"]')).toContainText('145 / 90');
    await expect(page.locator('#connection-status')).toHaveText('Connected');
    await page.getByRole('button', { name: 'End Conversation' }).click();
  } finally { session?.close(); }
});

function sample() {
  const intake = emptyIntake();
  intake.patient = { name: 'Mark Lewis Garcia', preferredName: 'Mark' };
  intake.symptoms = [
    { name: 'cough', status: 'confirmed', patientReportedText: 'I have a cough.' },
    { name: 'fever', status: 'denied', patientReportedText: 'No fever.' },
    { name: 'increased thirst', status: 'unclear', patientReportedText: 'Maybe.' },
  ];
  intake.onset = { value: 'Yesterday', patientReportedText: 'Yesterday' };
  intake.vitals.temperature = { value: 38.5, unit: '°C', source: 'patient_reported' };
  intake.vitals.bloodPressure = { systolic: 120, diastolic: 80, source: 'patient_reported' };
  intake.vitals.heartRate = { value: 90, unit: 'bpm', source: 'patient_reported' };
  intake.vitals.spo2 = { value: 97, unit: '%', source: 'patient_reported' };
  intake.vitals.bloodGlucose = { value: null, unit: null, qualitative: 'patient reports high', source: 'patient_reported' };
  intake.redFlags = [{ type: 'current chest pain', status: 'unclear', patientReportedText: 'Yes.' }];
  intake.additionalNotes = ['I have not slept well.'];
  intake.evidence.name = { utteranceId: 1, patientReportedText: 'My name is Mark Lewis Garcia.' };
  return intake;
}

test('intake panel renders empty values without requesting a microphone', async ({ page }) => {
  await page.goto('/patient');
  await expect(page.getByRole('heading', { name: 'Clinical intake summary' })).toBeVisible();
  for (const title of ['Patient', 'Symptoms', 'Onset / Duration', 'Reported Vitals', 'Emergency Indicators', 'Additional Notes']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await expect(page.locator('[data-intake="vitals"] .intake-value')).toHaveText(['—', '—', '—', '—', '—']);
  await expect(page.locator('#connection-status')).toHaveText('Disconnected');
});

test('live updates distinguish reported facts, statuses, vitals and operational interpretation', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'intake-update', intake: sample() }));
  await expect(page.locator('[data-intake="patient"]')).toContainText('Mark Lewis Garcia');
  await expect(page.locator('[data-group="confirmed"]')).toContainText('cough');
  await expect(page.locator('[data-group="denied"]')).toContainText('fever');
  await expect(page.locator('[data-group="unclear"]')).toContainText('increased thirst');
  await expect(page.locator('[data-intake="vitals"] .intake-value')).toHaveText(['38.5 °C', '120 / 80', '90 bpm', '97 %', 'patient reports high']);
  await expect(page.locator('[data-intake="redFlags"]')).toContainText('NEEDS CLARIFICATION');
  await expect(page.locator('#intake-interpretation')).toHaveText('Reported information has been organized. Missing fields remain blank.');
  await expect(page.locator('.operational-note')).toContainText('AI-GENERATED · OPERATIONAL');
  const changed = sample();
  changed.vitals.bloodGlucose = { value: 240, unit: null, qualitative: null, source: 'patient_reported' };
  changed.patient.name = '<img src=x onerror=alert(1)>';
  relay.send(JSON.stringify({ type: 'intake-update', intake: changed }));
  await expect(page.locator('[data-intake="vitals"]')).toContainText('240 (unit not reported)');
  await expect(page.locator('[data-intake="patient"] img')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  relay.send(JSON.stringify({ type: 'intake-status', status: 'unavailable', code: 'EXTRACTION_FAILED', message: 'secret-api-key', detail: 'billing-secret' }));
  await expect(page.locator('#intake-status')).toHaveText('Clinical summary is temporarily unavailable. Please try again shortly.');
  await page.locator('#intake-diagnostics summary').click();
  await expect(page.locator('#intake-error-detail')).toContainText('EXTRACTION_FAILED');
  await expect(page.locator('#intake-error-detail')).not.toContainText('quota');
  await expect(page.locator('body')).not.toContainText('secret-api-key');
  await expect(page.locator('body')).not.toContainText('billing-secret');
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await page.getByRole('button', { name: 'End Conversation' }).click();
  await expect(page.locator('#intake-status')).toContainText('Session ended');
  await expect(page.locator('[data-intake="vitals"]')).toContainText('240');
});

test('disconnect retains visible summary and the next start immediately clears patient data', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'intake-update', intake: sample() }));
  await expect(page.locator('[data-intake="patient"]')).toContainText('Mark Lewis Garcia');
  relay.close({ code: 1011, reason: 'Test' });
  await expect(page.locator('#intake-status')).toContainText('Connection interrupted');
  await expect(page.locator('[data-intake="patient"]')).toContainText('Mark Lewis Garcia');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('[data-intake="patient"]')).not.toContainText('Mark');
  await expect(page.locator('[data-intake="vitals"] .intake-value')).toHaveText(['—', '—', '—', '—', '—']);
  await page.getByRole('button', { name: 'End Conversation' }).click();
});

test('completion with no pending audio preserves the summary and new intake resets it', async ({ page }) => {
  let relay;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.goto('/patient');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'intake-update', intake: sample() }));
  relay.send(JSON.stringify({ type: 'turn-complete' }));
  relay.send(JSON.stringify({ type: 'intake-complete' }));
  await expect(page.locator('#connection-status')).toHaveText('Completed');
  await expect(page.locator('[data-intake="patient"]')).toContainText('Mark Lewis Garcia');
  await expect(page.locator('[data-group="confirmed"]')).toContainText('cough');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect(page.locator('[data-intake="patient"]')).not.toContainText('Mark');
  await expect(page.locator('[data-intake="vitals"] .intake-value')).toHaveText(['—', '—', '—', '—', '—']);
  await page.getByRole('button', { name: 'End Conversation' }).click();
});


test('final extracted facts reach the summary before the completed handoff becomes available', async ({ page }) => {
  let relay; let handed;
  await page.routeWebSocket('**/api/live', socket => {
    relay = socket;
    socket.onMessage(raw => { if (JSON.parse(raw).type === 'start') socket.send(JSON.stringify({ type: 'ready' })); });
  });
  await page.routeWebSocket('**/api/agent/handoff', socket => socket.onMessage(raw => {
    const message = JSON.parse(raw); if (message.type === 'start') handed = message;
  }));
  await page.goto('/patient');
  await page.locator('#intake-fictional').check();
    await page.getByRole('button', { name: 'Start Conversation' }).click();
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  relay.send(JSON.stringify({ type: 'turn-complete' }));
  relay.send(JSON.stringify({ type: 'intake-status', status: 'updating' }));
  await expect(page.locator('#intake-status')).toContainText('Updating');
  await expect(page.locator('#handoff-start')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start Agentic Handoff' })).toHaveCount(0);
  const intake = emptyIntake();
  intake.patient.name = 'Jael';
  intake.symptoms = [
    { name: 'dizziness', status: 'confirmed', patientReportedText: "I'm feeling dizzy." },
    { name: 'chest pain', status: 'denied', patientReportedText: "I don't have chest pain." },
  ];
  intake.onset = { value: 'yesterday', patientReportedText: 'It started yesterday.' };
  intake.vitals.bloodPressure = { systolic: 145, diastolic: 90, source: 'patient_reported' };
  intake.evidence.name = { utteranceId: 1, patientReportedText: 'My name is Jael.' };
  relay.send(JSON.stringify({ type: 'intake-update', intake }));
  await expect(page.locator('[data-intake="patient"]')).toContainText('Jael');
  await expect(page.locator('[data-group="confirmed"]')).toContainText('dizziness');
  await expect(page.locator('[data-group="denied"]')).toContainText('chest pain');
  await expect(page.locator('[data-intake="onset"]')).toContainText('yesterday');
  await expect(page.locator('[data-intake="vitals"]')).toContainText('145 / 90');
  await expect(page.getByRole('button', { name: 'Start Agentic Handoff' })).toHaveCount(0);
  relay.send(JSON.stringify({ type: 'intake-complete', completionToken: 'drained-token' }));
  await expect(page.locator('#connection-status')).toHaveText('Completed');
  expect(handed).toBeUndefined(); // The patient never sends an orchestration request.
  await expect(page.locator('#handoff-start')).toHaveCount(0);
});

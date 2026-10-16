import { test, expect } from '@playwright/test';

async function installMedicineHarness(page, { camera = 'allowed', saveFails = false, saveFailsOnce = false, saveDelayMs = 0, scanFailsAfterFirst = false, scanOutcome = 'identified', videoWidth = 2400, videoHeight = 1600 } = {}) {
  await page.goto('/');
  return page.evaluate(async options => {
    const { renderPatient } = await import('/src/pages/patient/index.js');
    const { createMedicineFlow } = await import('/src/pages/patient/medicine.js');
    document.body.innerHTML = `<main id="medicine-test">${renderPatient()}</main>`;
    const track = { stopped: 0, stop() { this.stopped++; } };
    const mediaStream = { getTracks: () => [track], getVideoTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: options.camera === 'unsupported' ? {} : { getUserMedia: async constraints => {
      window.__medicineConstraints = constraints;
      if (options.camera === 'denied') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      return mediaStream;
    } } });
    Object.defineProperties(HTMLVideoElement.prototype, { videoWidth: { configurable: true, get: () => options.videoWidth }, videoHeight: { configurable: true, get: () => options.videoHeight } });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get() { return this.__medicineStream || null; }, set(value) { this.__medicineStream = value; } });
    HTMLVideoElement.prototype.play = async function () {};
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage(...args) { window.__medicineDraw = args.slice(1); } });
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) { window.__medicineEncode = { width: this.width, height: this.height, type, quality }; callback(new Blob([new Uint8Array([255, 216, 1, 2, 255, 217])], { type: 'image/jpeg' })); };
    const calls = [];
    const liveSocket = { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); } };
    const request = async (path, init) => {
      calls.push({ path, body: JSON.parse(init.body) });
      if (path.endsWith('/evidence/share')) return new Response(JSON.stringify({ evidence: { evidenceId: JSON.parse(init.body).evidenceId, kind: 'body_area' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      if (path.endsWith('/scan')) {
        if (options.scanFailsAfterFirst && calls.filter(call => call.path.endsWith('/scan')).length > 1) return new Response(JSON.stringify({ code: 'MEDICINE_SCAN_TEMPORARILY_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        if (options.scanOutcome === 'unavailable') return new Response(JSON.stringify({ code: 'MEDICINE_SCAN_TEMPORARILY_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        if (options.scanOutcome === 'malformed') return new Response(JSON.stringify({ code: 'MEDICINE_SCAN_RESPONSE_INVALID' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        if (options.scanOutcome === 'unclear') return new Response(JSON.stringify({ candidate: null, code: 'MEDICINE_LABEL_UNCLEAR' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ candidate: { status: 'identified', name: 'Fictionalmed', strength: '10 mg' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const confirmCount = calls.filter(call => call.path.endsWith('/confirm')).length;
      if (options.saveDelayMs) await new Promise(resolve => setTimeout(resolve, options.saveDelayMs));
      if (options.saveFails || options.saveFailsOnce && confirmCount === 1) return new Response(JSON.stringify({ code: 'MEDICINE_SERVICE_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ receiptId: 'medicine-test-receipt', medication: { name: 'Fictionalmed', strength: '10 mg', howTaken: 'I take one each morning.', source: 'packaging_shown', verification: 'patient_reported' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const outlet = document.querySelector('#medicine-test');
    window.__medicineSavedEvents = [];
    window.__bodyEvidenceSharedEvents = [];
    outlet.addEventListener('smartcareops:medicine-saved', event => window.__medicineSavedEvents.push(event.detail));
    outlet.addEventListener('smartcareops:body-evidence-shared', event => window.__bodyEvidenceSharedEvents.push(event.detail));
    const flow = createMedicineFlow(outlet, { request, getSession: () => ({ socket: liveSocket }) }); window.__medicineFlow = flow; window.__medicineCalls = calls; window.__medicineTrack = track; window.__medicineSocket = liveSocket;
    flow.beginSession('a'.repeat(64)); flow.setReady(true);
    return true;
  }, { camera, saveFails, saveFailsOnce, saveDelayMs, scanFailsAfterFirst, scanOutcome, videoWidth, videoHeight });
}

test('medicine requires explicit camera action, explains blocked save, and sends exactly one pending request', async ({ page }) => {
  await installMedicineHarness(page, { saveDelayMs: 120 });
  expect(await page.evaluate(() => window.__medicineConstraints)).toBeUndefined();
  await page.getByRole('button', { name: 'Use camera' }).click();
  expect(await page.evaluate(() => window.__medicineConstraints.video.facingMode.ideal)).toBe('environment');
  await expect(page.locator('#medicine-camera')).toBeVisible();
  await expect(page.locator('#medicine-preview')).toHaveCSS('object-fit', 'contain');
  await page.getByRole('button', { name: 'Switch camera' }).click();
  expect(await page.evaluate(() => window.__medicineConstraints.video.facingMode.ideal)).toBe('user');
  await page.getByRole('button', { name: 'Capture photo' }).click();
  await expect(page.locator('#medicine-capture-review')).toBeVisible();
  await expect(page.locator('#medicine-captured-image')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  const capturedSrc = await page.locator('#medicine-captured-image').getAttribute('src');
  expect((await page.evaluate(() => window.__medicineCalls)).filter(call => call.path.endsWith('/scan'))).toHaveLength(0);
  expect(await page.evaluate(() => window.__medicineEncode)).toEqual({ width: 1920, height: 1280, type: 'image/jpeg', quality: .92 });
  await page.getByRole('button', { name: 'Use this photo' }).click();
  await expect(page.locator('#medicine-review')).toBeVisible();
  await expect(page.locator('#medicine-name')).toHaveValue('Fictionalmed');
  await expect(page.getByRole('button', { name: 'Save confirmed medicine' })).toHaveAttribute('data-state', 'blocked');
  await page.getByRole('button', { name: 'Save confirmed medicine' }).click();
  await expect(page.locator('#medicine-status')).toContainText('Describe in your own words');
  expect((await page.evaluate(() => window.__medicineCalls)).filter(call => call.path.endsWith('/confirm'))).toHaveLength(0);
  await page.locator('#medicine-how-taken').fill('I take one each morning.');
  await page.locator('#medicine-confirmation').check();
  await expect(page.getByRole('button', { name: 'Save confirmed medicine' })).toHaveAttribute('data-state', 'ready');
  expect((await page.evaluate(() => window.__medicineSocket.sent)).filter(event => event.type === 'medicine-ui-state' && event.state === 'saved')).toHaveLength(0);
  await page.locator('#medicine-name').fill('Corrected fictional name');
  await expect(page.locator('#medicine-confirmation')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Save confirmed medicine' })).toHaveAttribute('data-state', 'blocked');
  await page.locator('#medicine-confirmation').check();
  await page.evaluate(() => { const button = document.querySelector('#save-medicine'); button.click(); button.click(); });
  await expect(page.getByRole('button', { name: 'Saving medicine…' })).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('#medicine-status')).toContainText('Medicine entry saved');
  await expect(page.getByRole('button', { name: 'Medicine saved' })).toHaveAttribute('data-state', 'success');
  const calls = await page.evaluate(() => window.__medicineCalls);
  expect(calls.filter(call => call.path.endsWith('/confirm'))).toHaveLength(1);
  expect(calls[0].body.imageBase64).toBeTruthy();
  expect(`data:${calls[0].body.mimeType};base64,${calls[0].body.imageBase64}`).toBe(capturedSrc);
  const liveEvents = await page.evaluate(() => window.__medicineSocket.sent);
  expect(liveEvents.filter(event => event.type === 'medicine-ui-state' && event.state === 'camera_ready')).toHaveLength(2);
  expect(liveEvents).toContainEqual({ type: 'medicine-ui-state', state: 'image_captured' });
  expect(liveEvents).toContainEqual({ type: 'medicine-scan-ready' });
  expect(liveEvents.at(-1)).toEqual({ type: 'medicine-ui-state', state: 'saved', receiptId: 'medicine-test-receipt' });
  expect(await page.evaluate(() => window.__medicineSavedEvents)).toEqual([{ intakeSessionId: 'a'.repeat(64), receiptId: 'medicine-test-receipt' }]);
});

test('voice medicine request selects and focuses evidence without opening the camera', async ({ page }) => {
  await installMedicineHarness(page);
  await page.evaluate(() => window.__medicineFlow.requestMedicinePackage());
  await expect(page.locator('#patient-evidence-kind')).toHaveValue('medicine_package');
  await expect(page.locator('#medicine-flow')).toHaveClass(/evidence-active/);
  await expect(page.getByRole('button', { name: 'Use camera' })).toBeFocused();
  await expect(page.locator('#medicine-status')).toContainText('Choose Use camera to start your camera');
  expect(await page.evaluate(() => window.__medicineConstraints)).toBeUndefined();
});

test('body-area still is reviewed and explicitly shared as patient context without Live or symptom upload', async ({ page }) => {
  await installMedicineHarness(page);
  await page.evaluate(() => window.__medicineFlow.requestBodyArea());
  await expect(page.locator('#patient-evidence-kind')).toHaveValue('body_area');
  await expect(page.getByRole('button', { name: 'Use camera' })).toBeFocused();
  expect(await page.evaluate(() => window.__medicineConstraints)).toBeUndefined();
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.getByRole('button', { name: 'Capture photo' }).click();
  const preview = await page.locator('#medicine-captured-image').getAttribute('src');
  await expect(page.locator('#medicine-capture-review')).toContainText('your report of where it hurts');
  await expect(page.getByRole('button', { name: 'Share image with case' })).toBeDisabled();
  await page.locator('.patient-body-evidence-fields input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Share image with case' }).click();
  await expect(page.locator('#medicine-status')).toContainText('will appear in My Cases after the intake is saved');
  await expect(page.locator('.patient-body-evidence-fields button')).toHaveAttribute('data-state', 'success');
  const calls = await page.evaluate(() => window.__medicineCalls), share = calls.find(call => call.path.endsWith('/evidence/share'));
  expect(share.body.kind).toBe('body_area'); expect(share.body.patientDescription).toBe('Patient shared this image to indicate the location of pain.');
  expect(`data:${share.body.mimeType};base64,${share.body.imageBase64}`).toBe(preview);
  expect(calls.some(call => call.path.endsWith('/scan') || call.path.endsWith('/confirm'))).toBe(false);
  expect(await page.evaluate(() => window.__medicineSocket.sent.some(event => JSON.stringify(event).includes('imageBase64')))).toBe(false);
  expect(await page.evaluate(() => window.__medicineTrack.stopped)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__bodyEvidenceSharedEvents)).toEqual([
    { intakeSessionId: 'a'.repeat(64), evidenceId: share.body.evidenceId },
  ]);
  await expect(page.locator('#medicine-status')).toContainText('will appear in My Cases after the intake is saved');
});

test('voice-led medication draft stays editable and still requires explicit on-screen confirmation', async ({ page }) => {
  await installMedicineHarness(page);
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.getByRole('button', { name: 'Capture photo' }).click();
  await page.getByRole('button', { name: 'Use this photo' }).click();
  await page.locator('#medicine-confirmation').check();
  await page.evaluate(() => window.__medicineFlow.applyVoiceDraft({ name: 'Corrected fictional medicine', strength: '20 mg', howTaken: 'I take one in the evening.', confirmedReading: false }));
  await expect(page.locator('#medicine-name')).toHaveValue('Corrected fictional medicine');
  await expect(page.locator('#medicine-strength')).toHaveValue('20 mg');
  await expect(page.locator('#medicine-how-taken')).toHaveValue('I take one in the evening.');
  await expect(page.locator('#medicine-confirmation')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Save confirmed medicine' })).toHaveAttribute('data-state', 'blocked');
  await expect(page.locator('#medicine-status')).toContainText('explicitly confirm');
});

test('portrait camera pixels keep their displayed orientation and exact encoded bytes through upload', async ({ page }) => {
  await installMedicineHarness(page, { videoWidth: 1600, videoHeight: 2400 });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.getByRole('button', { name: 'Capture photo' }).click();
  expect(await page.evaluate(() => window.__medicineEncode)).toEqual({ width: 1280, height: 1920, type: 'image/jpeg', quality: .92 });
  const capturedSrc = await page.locator('#medicine-captured-image').getAttribute('src');
  await page.getByRole('button', { name: 'Use this photo' }).click();
  const call = (await page.evaluate(() => window.__medicineCalls)).find(item => item.path.endsWith('/scan'));
  expect(`data:${call.body.mimeType};base64,${call.body.imageBase64}`).toBe(capturedSrc);
});

test('captured label can be reviewed and retaken, and unclear results never populate a guess', async ({ page }) => {
  await installMedicineHarness(page, { scanOutcome: 'unclear' });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.getByRole('button', { name: 'Capture photo' }).click();
  await page.getByRole('button', { name: 'Retake photo' }).click();
  await expect(page.locator('#medicine-camera')).toBeVisible();
  await expect(page.locator('#medicine-capture-review')).toBeHidden();
  expect((await page.evaluate(() => window.__medicineCalls)).filter(call => call.path.endsWith('/scan'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Capture photo' }).click();
  const capturedSrc = await page.locator('#medicine-captured-image').getAttribute('src');
  await page.getByRole('button', { name: 'Use this photo' }).click();
  await expect(page.locator('#medicine-status')).toContainText('couldn’t clearly read both');
  await expect(page.locator('#medicine-capture-review')).toBeVisible();
  await expect(page.locator('#medicine-captured-image')).toHaveAttribute('src', capturedSrc);
  await expect(page.locator('#medicine-review')).toBeHidden();
  await expect(page.locator('#medicine-name')).toHaveValue('');
  await expect(page.locator('#medicine-strength')).toHaveValue('');
});

test('temporary provider and malformed-response failures preserve the image without blaming image clarity', async ({ page }) => {
  for (const scanOutcome of ['unavailable', 'malformed']) {
    await installMedicineHarness(page, { scanOutcome });
    await page.getByRole('button', { name: 'Use camera' }).click();
    await page.getByRole('button', { name: 'Capture photo' }).click();
    const capturedSrc = await page.locator('#medicine-captured-image').getAttribute('src');
    await page.getByRole('button', { name: 'Use this photo' }).click();
    await expect(page.locator('#medicine-status')).toContainText('temporarily unavailable');
    await expect(page.locator('#medicine-status')).not.toContainText('clearer image');
    await expect(page.locator('#medicine-captured-image')).toHaveAttribute('src', capturedSrc);
    await expect(page.getByRole('button', { name: 'Use this photo' })).toBeEnabled();
  }
});

test('camera denial keeps voice intake available and every stop path closes camera tracks', async ({ page }) => {
  await installMedicineHarness(page, { camera: 'denied' });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await expect(page.locator('#medicine-status')).toContainText('Voice intake remains available');
  await expect(page.locator('#start-conversation')).toBeVisible();
  await installMedicineHarness(page, { camera: 'unsupported' });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await expect(page.locator('#medicine-status')).toContainText('Voice intake remains available');

  await installMedicineHarness(page);
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.getByRole('button', { name: 'Stop camera' }).click();
  expect(await page.evaluate(() => window.__medicineTrack.stopped)).toBe(1);
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.evaluate(() => window.__medicineFlow.endSession('ended'));
  expect(await page.evaluate(() => window.__medicineTrack.stopped)).toBe(2);
  await page.evaluate(() => { window.__medicineFlow.beginSession('b'.repeat(64)); window.__medicineFlow.setReady(true); });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.evaluate(() => window.__medicineFlow.endSession('emergency'));
  expect(await page.evaluate(() => window.__medicineTrack.stopped)).toBe(3);
  await page.evaluate(() => { window.__medicineFlow.beginSession('c'.repeat(64)); window.__medicineFlow.setReady(true); });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.evaluate(() => window.__medicineFlow.dispose());
  expect(await page.evaluate(() => window.__medicineTrack.stopped)).toBe(4);
  expect(await page.evaluate(() => window.__medicineFlow.isCameraActive())).toBe(false);
});

test('a failed repeat model read preserves the current corrected draft', async ({ page }) => {
  await installMedicineHarness(page, { scanFailsAfterFirst: true });
  await page.getByRole('button', { name: 'Use camera' }).click(); await page.getByRole('button', { name: 'Capture photo' }).click(); await page.getByRole('button', { name: 'Use this photo' }).click();
  await page.locator('#medicine-name').fill('My corrected medicine');
  await page.getByRole('button', { name: 'Use camera' }).click(); await page.getByRole('button', { name: 'Capture photo' }).click(); await page.getByRole('button', { name: 'Use this photo' }).click();
  await expect(page.locator('#medicine-status')).toContainText('temporarily unavailable');
  await expect(page.locator('#medicine-name')).toHaveValue('My corrected medicine');
});

test('save failure preserves the confirmed draft and retries idempotently without affecting audio-only transport', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await installMedicineHarness(page, { saveFailsOnce: true });
  await page.getByRole('button', { name: 'Use camera' }).click();
  await page.getByRole('button', { name: 'Capture photo' }).click();
  await page.getByRole('button', { name: 'Use this photo' }).click();
  await page.locator('#medicine-how-taken').fill('I take one each morning.'); await page.locator('#medicine-confirmation').check();
  await page.getByRole('button', { name: 'Save confirmed medicine' }).click();
  await expect(page.locator('#medicine-status')).toContainText('draft is still here');
  await expect(page.getByRole('button', { name: 'Retry save confirmed medicine' })).toHaveAttribute('data-state', 'failure');
  await expect(page.locator('#medicine-confirmation')).toBeChecked();
  await expect(page.locator('#medicine-name')).toHaveValue('Fictionalmed');
  await expect(page.locator('#medicine-how-taken')).toHaveValue('I take one each morning.');
  expect((await page.evaluate(() => window.__medicineSocket.sent)).filter(event => event.type === 'medicine-ui-state' && event.state === 'saved')).toHaveLength(0);
  await page.getByRole('button', { name: 'Retry save confirmed medicine' }).click();
  await expect(page.locator('#medicine-status')).toContainText('Medicine entry saved');
  const savedEvents = (await page.evaluate(() => window.__medicineSocket.sent)).filter(event => event.type === 'medicine-ui-state' && event.state === 'saved');
  expect(savedEvents).toEqual([{ type: 'medicine-ui-state', state: 'saved', receiptId: 'medicine-test-receipt' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const calls = await page.evaluate(() => window.__medicineCalls);
  expect(calls.every(call => call.path.startsWith('/api/intake/medicine/'))).toBe(true);
  const confirms = calls.filter(call => call.path.endsWith('/confirm'));
  expect(confirms).toHaveLength(2);
  expect(confirms[0].body.idempotencyKey).toBe(confirms[1].body.idempotencyKey);
  expect(await page.evaluate(() => window.__medicineSocket.readyState)).toBe(1);
});

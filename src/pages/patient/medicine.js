const MAX_IMAGE_BYTES = 512 * 1024;

const errorMessage = (code, action) => ({
  MEDICINE_LABEL_UNCLEAR: 'The medicine name and strength were not both clear. Try a clearer image.',
  MEDICINE_SCAN_TEMPORARILY_UNAVAILABLE: 'Medicine label scanning is temporarily unavailable. Your image is still here; try again shortly.',
  MEDICINE_SCAN_RESPONSE_INVALID: 'Medicine label scanning is temporarily unavailable. Your image is still here; try again shortly.',
  MEDICINE_READING_UNAVAILABLE: 'Medicine label scanning is temporarily unavailable. Your image is still here; try again shortly.',
  MEDICINE_SCAN_RATE_LIMITED: 'Please wait before trying another image.',
  ACTIVE_INTAKE_REQUIRED: 'This intake is no longer active. The medicine entry was not saved.',
  MEDICATION_ALREADY_CONFIRMED: 'One medicine entry has already been confirmed for this intake.',
}[code] || (action === 'scan' ? 'Medicine label scanning is temporarily unavailable. Your image is still here; try again shortly.' : 'The medicine entry was not saved. Your draft is still here; review it and try again.'));

const blobBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.readAsDataURL(blob);
});
const canvasBlob = (canvas, quality) => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));

export async function captureMedicineStill(video, { maxDimension = 1920 } = {}) {
  const sourceWidth = Number(video.videoWidth), sourceHeight = Number(video.videoHeight);
  if (!sourceWidth || !sourceHeight) throw new Error('CAMERA_NOT_READY');
  const initialScale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  for (const [scaleFactor, quality] of [[1, .92], [1, .84], [.86, .84], [.74, .78], [.64, .72]]) {
    const scale = initialScale * scaleFactor;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale)); canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, quality);
    if (!blob) throw new Error('IMAGE_ENCODE_FAILED');
    if (blob.size <= MAX_IMAGE_BYTES) return { mimeType: 'image/jpeg', imageBase64: await blobBase64(blob), byteLength: blob.size, width: canvas.width, height: canvas.height };
  }
  throw new Error('IMAGE_TOO_LARGE');
}

export function createMedicineFlow(outlet, { request, getSession } = {}) {
  const byId = id => outlet.querySelector(`#${id}`);
  const section = byId('medicine-flow'), show = byId('show-medicine'), camera = byId('medicine-camera'), video = byId('medicine-preview');
  const capture = byId('capture-medicine'), switchCamera = byId('switch-medicine-camera'), stopSharing = byId('stop-medicine-camera');
  const captureReview = byId('medicine-capture-review'), capturedImage = byId('medicine-captured-image');
  const scan = byId('scan-medicine'), retake = byId('retake-medicine');
  const review = byId('medicine-review'), name = byId('medicine-name'), strength = byId('medicine-strength'), howTaken = byId('medicine-how-taken');
  const confirmation = byId('medicine-confirmation'), save = byId('save-medicine'), saveGuidance = byId('medicine-save-guidance'), status = byId('medicine-status');
  if (confirmation.nextSibling?.nodeType === Node.TEXT_NODE) confirmation.nextSibling.textContent = ' I confirm this complete entry is accurate to the best of my knowledge and want the package image shared with this case.';
  const introduction = section.querySelector(':scope > p');
  if (introduction) introduction.textContent = 'Choose a medicine package to read its clearly visible printed name and strength, or share a still image of a body area with your own description. Images and gestures are patient-shared evidence, not diagnoses or verified clinical findings.';
  const modeLabel = document.createElement('div'); modeLabel.className = 'patient-evidence-mode-label';
  const modeQuestion = document.createElement('p'); modeQuestion.textContent = 'What would you like to submit as clinical photo?';
  const mode = document.createElement('select'); mode.id = 'patient-evidence-kind'; mode.setAttribute('aria-label', 'Type of image evidence');
  const modePlaceholder = document.createElement('option'); modePlaceholder.value = ''; modePlaceholder.textContent = 'Choose clinical photo type'; modePlaceholder.disabled = true; modePlaceholder.selected = true; mode.append(modePlaceholder);
  for (const [value, label] of [['medicine_package', 'Medicine package'], ['body_area', 'Pain location']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; mode.append(option); }
  mode.hidden = true;
  const choices = document.createElement('div'); choices.className = 'patient-evidence-choices'; choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', modeQuestion.textContent);
  let selectedChoice = null;
  const choiceIcon = kind => kind === 'medicine_package'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 5.5 10 10-5 5-10-10 5-5Z"/><circle cx="9" cy="10" r="1.2"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/></svg>';
  const choiceButtons = [...mode.options].filter(option => option.value).map(option => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'patient-evidence-choice'; button.dataset.value = option.value; button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', 'false');
    button.innerHTML = `${choiceIcon(option.value)}<span>${option.textContent}</span>`;
    button.disabled = true;
    button.addEventListener('click', async () => {
      selectedChoice = option.value; mode.value = option.value; mode.dispatchEvent(new Event('change', { bubbles: true }));
      if (!ready) return;
      section.classList.add('evidence-active');
      await startCamera();
    });
    choices.append(button); return button;
  });
  const syncChoices = () => choiceButtons.forEach(button => button.setAttribute('aria-checked', String(button.dataset.value === selectedChoice)));
  modeLabel.append(modeQuestion, mode, choices); camera.before(modeLabel); show.textContent = 'Use camera';
  const bodyFields = document.createElement('div'); bodyFields.className = 'patient-body-evidence-fields'; bodyFields.hidden = true;
  const bodyDescriptionLabel = document.createElement('label'); bodyDescriptionLabel.textContent = 'Describe the body area in your own words (optional)';
  const bodyDescription = document.createElement('textarea'); bodyDescription.id = 'patient-body-evidence-description'; bodyDescription.maxLength = 500; bodyDescription.rows = 3; bodyDescription.placeholder = 'For example: “I feel pain on the outer part of my left shoulder.”'; bodyDescriptionLabel.append(bodyDescription);
  const bodyConfirmLabel = document.createElement('label'); bodyConfirmLabel.className = 'medicine-confirm';
  const bodyConfirm = document.createElement('input'); bodyConfirm.type = 'checkbox';
  bodyConfirmLabel.append(bodyConfirm, document.createTextNode(' I confirm I want to share this image and any description with this case.'));
  const shareBody = document.createElement('button'); shareBody.type = 'button'; shareBody.className = 'patient-primary-cta'; shareBody.textContent = 'Share image with case'; shareBody.disabled = true;
  const bodyShareGuidance = document.createElement('p'); bodyShareGuidance.className = 'medicine-save-guidance'; bodyShareGuidance.textContent = 'Your description stays patient-reported. An image or pointing gesture cannot diagnose an injury.';
  bodyFields.append(bodyDescriptionLabel, bodyConfirmLabel, bodyShareGuidance, shareBody);
  const captureCopy = captureReview.querySelector('p'); captureCopy?.before(bodyFields);
  let stream = null, captured = null, facingMode = 'environment', sessionId = null, ready = false, saved = false, saving = false, saveFailed = false, idempotencyKey = null, bodyEvidenceKey = null, bodyShared = false, disposed = false;
  const notifyLive = (type = 'medicine-scan-ready', state = null, details = {}) => {
    const socket = getSession?.()?.socket;
    if (socket?.readyState !== 1 || socket.smartcareDirect) return false;
    socket.send(JSON.stringify({ type, ...(state ? { state } : {}), ...details }));
    return true;
  };
  const stopCamera = () => {
    stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null;
    camera.hidden = true; section.classList.remove('camera-active');
  };
  const updateCaptureMode = () => {
    const bodyArea = mode.value === 'body_area';
    bodyFields.hidden = !bodyArea; scan.hidden = bodyArea; capture.textContent = 'Capture photo'; capturedImage.alt = bodyArea ? 'Captured body-area image awaiting sharing review' : 'Captured medication package label awaiting review';
    video.setAttribute('aria-label', bodyArea ? 'Live camera preview for the body area you choose to share' : 'Live medicine package camera preview');
    captureReview.querySelector('h4').textContent = bodyArea ? 'Review the image you want to share' : 'Review the package photo';
    if (captureCopy) captureCopy.textContent = bodyArea
      ? 'Check that the image shows only the area you want to share. Your description—not the image—is your report of where it hurts.'
      : 'Make sure the printed medicine name and strength are sharp, large, and free of glare.';
  };
  const clearCapture = () => { captured = null; capturedImage.removeAttribute('src'); captureReview.hidden = true; scan.disabled = true; shareBody.disabled = true; };
  const saveIssue = () => !sessionId || !ready
    ? 'Keep the active voice intake connected before saving.'
    : !name.value.trim() || !strength.value.trim()
      ? 'Review the medicine name and strength before saving.'
      : !howTaken.value.trim()
        ? 'Describe in your own words how you actually take it before saving.'
        : !confirmation.checked
          ? 'Check the confirmation box before saving.'
          : '';
  const updateSave = () => {
    if (saved) {
      save.disabled = true; save.dataset.state = 'success'; save.setAttribute('aria-disabled', 'true'); save.textContent = 'Medicine saved';
      saveGuidance.textContent = 'The confirmed entry was saved once to this intake.'; return;
    }
    if (saving) {
      save.disabled = true; save.dataset.state = 'pending'; save.setAttribute('aria-disabled', 'true'); save.textContent = 'Saving medicine…';
      saveGuidance.textContent = 'Saving your confirmed medicine entry.'; return;
    }
    const issue = saveIssue();
    save.disabled = false; save.dataset.state = issue ? 'blocked' : saveFailed ? 'failure' : 'ready';
    save.removeAttribute('aria-disabled');
    save.textContent = saveFailed && !issue ? 'Retry save confirmed medicine' : 'Save confirmed medicine';
    saveGuidance.textContent = issue || (saveFailed ? 'The entry was not saved. Your confirmed draft is unchanged and ready to retry.' : 'Ready to save one confirmed medicine entry.');
  };
  const invalidateConfirmation = () => { if (confirmation.checked) confirmation.checked = false; updateSave(); };
  async function startCamera() {
    if (!ready || disposed || !navigator.mediaDevices?.getUserMedia) {
      status.textContent = 'Camera is not available on this device. Voice intake remains available.'; return;
    }
    show.disabled = true; status.textContent = 'Waiting for camera permission…';
    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (disposed || !ready) { next.getTracks().forEach(track => track.stop()); return; }
      const videoTrack = next.getVideoTracks?.()[0];
      const focusModes = videoTrack?.getCapabilities?.().focusMode;
      if (Array.isArray(focusModes) && focusModes.includes('continuous')) await videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      stopCamera(); stream = next; video.srcObject = stream; await video.play();
      camera.hidden = false; capture.disabled = false; switchCamera.disabled = false; stopSharing.disabled = false; section.classList.add('camera-active');
      const bodyArea = mode.value === 'body_area';
      status.textContent = bodyArea ? 'Camera active. Frame only the body area you choose to share; keep the phone steady.' : 'Camera active. Fill the guide with the printed medicine name and strength, avoid glare, and hold steady.';
      if (!bodyArea) notifyLive('medicine-ui-state', 'camera_ready');
    } catch (error) {
      status.textContent = error?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Voice intake remains available.'
        : error?.name === 'NotFoundError' ? 'No camera was found. Voice intake remains available.'
          : 'The camera could not be started. Voice intake remains available.';
    } finally { show.disabled = !ready; }
  }
  async function switchFacing() {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    stopCamera(); await startCamera();
  }
  async function captureLabel() {
    if (!ready || !stream || !sessionId) return;
    capture.disabled = true; status.textContent = mode.value === 'body_area' ? 'Capturing the image…' : 'Capturing the label…';
    try {
      captured = await captureMedicineStill(video); bodyEvidenceKey = null;
      capturedImage.src = `data:${captured.mimeType};base64,${captured.imageBase64}`;
      stopCamera(); captureReview.hidden = false; scan.disabled = false; updateCaptureMode();
      shareBody.disabled = mode.value !== 'body_area' || !bodyConfirm.checked || saving || bodyShared;
      status.textContent = mode.value === 'body_area' ? 'Review this exact still and your description. Sharing is optional.' : 'Review the captured image. Use it only if the printed name and strength are sharp and easy to read.';
      if (mode.value !== 'body_area') notifyLive('medicine-ui-state', 'image_captured');
    } catch (error) {
      status.textContent = error?.message === 'IMAGE_TOO_LARGE' ? 'The image could not be made small enough. Move closer to the label and try again.' : 'The image could not be captured. Hold the phone steady and try again.';
    } finally { capture.disabled = !ready || !stream; }
  }
  async function readLabel() {
    if (!ready || !captured || !sessionId) return;
    scan.disabled = true; status.textContent = 'Reading the visible printed label…';
    try {
      const response = await request('/api/intake/medicine/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intakeSessionId: sessionId, mimeType: captured.mimeType, imageBase64: captured.imageBase64 }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('SCAN_FAILED'), { code: body.code });
      const liveNotified = notifyLive();
      if (!body.candidate) { status.textContent = liveNotified
        ? 'SmartCareOps couldn’t clearly read both details. Gemini will explain that aloud; you can retake the photo. Nothing was guessed or saved.'
        : 'SmartCareOps couldn’t clearly read both the printed medicine name and strength. Retake the photo closer, without glare. Nothing was guessed or saved.'; return; }
      name.value = body.candidate.name; strength.value = body.candidate.strength; howTaken.value = ''; saved = false; idempotencyKey = crypto.randomUUID();
      confirmation.checked = false; review.hidden = false; clearCapture(); updateSave();
      status.textContent = liveNotified
        ? 'Gemini will read the packaging candidate aloud. Answer in the same conversation, then review and explicitly confirm the entry here.'
        : 'Review the label reading. Correct it if needed, then describe in your own words how you actually take it.';
    } catch (error) {
      status.textContent = errorMessage(error?.code, 'scan');
    } finally { scan.disabled = !ready || !captured; }
  }
  async function retakeLabel() { bodyEvidenceKey = null; clearCapture(); await startCamera(); }
  async function shareBodyEvidence() {
    const description = bodyDescription.value.trim() || 'Patient shared this image to indicate the location of pain.';
    if (!ready || !captured || mode.value !== 'body_area' || !bodyConfirm.checked || saving || bodyShared) {
      status.textContent = !bodyConfirm.checked ? 'Confirm that you want to share this image with the case.' : 'Capture and review an image before sharing it.'; return;
    }
    bodyEvidenceKey ||= crypto.randomUUID(); saving = true; shareBody.disabled = true; shareBody.dataset.state = 'pending'; shareBody.textContent = 'Sharing image…';
    status.textContent = 'Saving the image and your description to this active intake…';
    try {
      const response = await request('/api/intake/evidence/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intakeSessionId: sessionId, evidenceId: bodyEvidenceKey, kind: 'body_area', patientDescription: description, mimeType: captured.mimeType, imageBase64: captured.imageBase64 }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.evidence?.evidenceId !== bodyEvidenceKey || result.evidence?.kind !== 'body_area') throw new Error('EVIDENCE_SHARE_FAILED');
      bodyShared = true; saving = false; shareBody.dataset.state = 'success'; shareBody.textContent = 'Image shared with this intake'; bodyDescription.disabled = true; bodyConfirm.disabled = true;
      captured = null; capturedImage.removeAttribute('src'); captureReview.hidden = true; stopCamera();
      status.textContent = 'The image and your description are attached to this active intake. They will appear in My Cases after the intake is saved.';
      outlet.dispatchEvent(new CustomEvent('smartcareops:body-evidence-shared', {
        detail: { intakeSessionId: sessionId, evidenceId: bodyEvidenceKey },
      }));
    } catch {
      saving = false; shareBody.disabled = false; shareBody.dataset.state = 'failure'; shareBody.textContent = 'Retry sharing image';
      status.textContent = 'The image was not shared. Your captured image and description are still here; retry when ready.';
    }
  }
  async function confirmEntry() {
    if (saved || saving) return;
    const issue = saveIssue();
    if (issue || !idempotencyKey) {
      status.textContent = issue || 'Review the medicine draft before saving.'; updateSave(); return;
    }
    saving = true; saveFailed = false; updateSave(); status.textContent = 'Saving your confirmed medicine entry…';
    try {
      const response = await request('/api/intake/medicine/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intakeSessionId: sessionId, idempotencyKey, name: name.value, strength: strength.value, howTaken: howTaken.value, confirmed: true }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error('SAVE_FAILED'), { code: body.code });
      if (typeof body.receiptId !== 'string' || body.medication?.source !== 'packaging_shown' || body.medication?.verification !== 'patient_reported') throw Object.assign(new Error('SAVE_FAILED'), { code: 'MEDICINE_SERVICE_UNAVAILABLE' });
      saved = true; saving = false; stopCamera();
      for (const input of [name, strength, howTaken, confirmation]) input.disabled = true;
      updateSave(); status.textContent = 'Medicine entry saved to this intake as patient-reported information from packaging shown.';
      notifyLive('medicine-ui-state', 'saved', { receiptId: body.receiptId });
      outlet.dispatchEvent(new CustomEvent('smartcareops:medicine-saved', {
        detail: { intakeSessionId: sessionId, receiptId: body.receiptId },
      }));
    } catch (error) {
      saving = false; saveFailed = true; status.textContent = errorMessage(error?.code, 'save'); updateSave();
    }
  }
  show.addEventListener('click', startCamera); capture.addEventListener('click', captureLabel); scan.addEventListener('click', readLabel); retake.addEventListener('click', retakeLabel); switchCamera.addEventListener('click', switchFacing); stopSharing.addEventListener('click', stopCamera);
  mode.addEventListener('change', () => { if (!camera.hidden || !captureReview.hidden) { stopCamera(); clearCapture(); } syncChoices(); updateCaptureMode(); bodyEvidenceKey = null; });
  bodyDescription.addEventListener('input', () => { bodyConfirm.checked = false; shareBody.disabled = true; });
  bodyConfirm.addEventListener('change', () => { shareBody.disabled = !bodyConfirm.checked || !captured || saving || bodyShared; });
  shareBody.addEventListener('click', shareBodyEvidence);
  for (const input of [name, strength, howTaken]) input.addEventListener('input', invalidateConfirmation);
  confirmation.addEventListener('change', updateSave); save.addEventListener('click', confirmEntry);
  return {
    beginSession(id) {
      stopCamera(); clearCapture(); section.classList.remove('evidence-active'); sessionId = id || null; ready = false; saved = false; saving = false; saveFailed = false; idempotencyKey = null; bodyEvidenceKey = null; bodyShared = false; selectedChoice = null; mode.value = ''; bodyDescription.value = ''; bodyDescription.disabled = false; bodyConfirm.checked = false; bodyConfirm.disabled = false; shareBody.textContent = 'Share image with case'; shareBody.dataset.state = 'ready'; shareBody.disabled = true; section.hidden = !sessionId; show.disabled = true; review.hidden = true; choiceButtons.forEach(button => { button.disabled = true; }); syncChoices(); updateCaptureMode();
      switchCamera.disabled = false; stopSharing.disabled = false; capture.disabled = true;
      for (const input of [name, strength, howTaken, confirmation]) { input.disabled = false; if (input.type === 'checkbox') input.checked = false; else input.value = ''; }
      status.textContent = 'Use camera becomes available after the voice session connects.'; updateSave();
    },
    setReady(value) { ready = !!value && !!sessionId; show.disabled = !ready; choiceButtons.forEach(button => { button.disabled = !ready; }); capture.disabled = !ready || !stream; updateSave(); },
    requestMedicinePackage() {
      if (!ready || saved) return false;
      selectedChoice = 'medicine_package'; mode.value = selectedChoice;
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      section.classList.add('evidence-active'); syncChoices();
      status.textContent = 'Medicine package selected. Choose Use camera to start your camera.';
      requestAnimationFrame(() => {
        section.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        show.focus({ preventScroll: true });
      });
      return true;
    },
    requestBodyArea() {
      if (!ready || bodyShared) return false;
      selectedChoice = 'body_area'; mode.value = selectedChoice;
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      section.classList.add('evidence-active'); syncChoices();
      status.textContent = 'Pain location selected. Choose Use camera to start your camera.';
      requestAnimationFrame(() => {
        section.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        show.focus({ preventScroll: true });
      });
      return true;
    },
    endSession(reason = 'ended') {
      ready = false; stopCamera(); clearCapture(); show.disabled = true; capture.disabled = true; switchCamera.disabled = true; updateSave();
      if (!saved && mode.value === 'body_area' && !bodyShared) status.textContent = reason === 'emergency'
        ? 'Emergency handling took priority. This body-area image was not shared to a saved case.'
        : 'The voice session ended before the image was attached to a saved case.';
      else if (!saved && !review.hidden) status.textContent = reason === 'emergency'
        ? 'Emergency handling took priority. This medicine draft was not saved.'
        : 'The voice session ended. This medicine draft was not saved.';
    },
    dispose() { disposed = true; this.endSession(); },
    applyVoiceDraft(draft) {
      if (!ready || saved || !draft || typeof draft !== 'object') return;
      if (typeof draft.name === 'string') name.value = draft.name;
      if (typeof draft.strength === 'string') strength.value = draft.strength;
      if (typeof draft.howTaken === 'string') howTaken.value = draft.howTaken;
      confirmation.checked = false; review.hidden = false; idempotencyKey ||= crypto.randomUUID(); updateSave();
      status.textContent = 'Gemini prepared this editable medication draft from your conversation. Review every field and explicitly confirm it with the checkbox before saving.';
    },
    liveStatus(value) {
      if (!ready) return;
      if (saved) {
        if (value === 'save_unverified') status.textContent = 'The backend saved this medicine entry, but the voice session could not verify its receipt. Keep the intake open and continue with the next intake question; do not repeat this medicine step.';
        return;
      }
      if (value === 'queued') status.textContent = 'The label reading is ready. Gemini will discuss it after the current reply.';
      if (value === 'unavailable') status.textContent = 'Gemini could not discuss the label in this voice turn. Your draft remains available for review and nothing was saved.';
      if (value === 'review_ready') status.textContent = 'Review the medication draft and explicitly confirm it before saving.';
      if (value === 'save_unverified') status.textContent = 'The saved receipt could not be verified by the voice session. Your intake remains open; continue with the next intake question. Do not repeat this medicine step.';
    },
    isCameraActive: () => !!stream,
  };
}

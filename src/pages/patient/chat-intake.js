import { apiFetch } from '../../auth/service.js';
import { createIntakePanel } from './intake-panel.js';
import { captureMedicineStill } from './medicine.js';

const storageKey = 'smartcareops-chat-intake-session';
const sessionPattern = /^[a-f0-9]{64}$/;
const maxImageBytes = 512 * 1024;

const toBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.readAsDataURL(blob);
});
const canvasBlob = (canvas, quality) => new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
const decodeImage = async file => {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    return image;
  } finally { URL.revokeObjectURL(url); }
};

async function prepareEvidenceImage(file) {
  if (!['image/jpeg', 'image/webp'].includes(file?.type)) throw new Error('IMAGE_TYPE_UNSUPPORTED');
  if (file.size <= maxImageBytes) return { mimeType: file.type, imageBase64: await toBase64(file) };
  const bitmap = await decodeImage(file), width = bitmap.width || bitmap.naturalWidth, height = bitmap.height || bitmap.naturalHeight;
  try {
    const initialScale = Math.min(1, 1920 / Math.max(width, height));
    for (const [factor, quality] of [[1, .88], [.84, .82], [.7, .76], [.56, .7]]) {
      const canvas = document.createElement('canvas'), scale = initialScale * factor;
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, quality);
      if (blob?.size && blob.size <= maxImageBytes) return { mimeType: 'image/jpeg', imageBase64: await toBase64(blob) };
    }
  } finally { bitmap.close?.(); }
  throw new Error('IMAGE_TOO_LARGE');
}

export function mountChatIntake(outlet, { request = apiFetch } = {}) {
  const start = outlet.querySelector('#start-chat-intake'), consent = outlet.querySelector('#chat-fictional');
  if (!start || !consent) return () => {};
  const active = outlet.querySelector('#chat-intake-active'), messages = outlet.querySelector('#chat-intake-messages');
  const chatRegion = outlet.querySelector('#chat-conversation-box');
  const form = outlet.querySelector('#chat-intake-form'), answer = outlet.querySelector('#chat-intake-answer');
  const send = outlet.querySelector('#send-chat-answer'), cancel = outlet.querySelector('#cancel-chat-intake');
  const status = outlet.querySelector('#chat-intake-status'), error = outlet.querySelector('#chat-intake-error');
  const viewCases = outlet.querySelector('#chat-view-cases'), voiceStart = outlet.querySelector('#start-conversation');
  const voiceEnd = outlet.querySelector('#end-conversation'), voiceConsent = outlet.querySelector('#intake-fictional');
  const evidence = outlet.querySelector('#chat-evidence'), evidenceInput = outlet.querySelector('#chat-evidence-image');
  const evidencePreview = outlet.querySelector('#chat-evidence-preview'), evidenceDescription = outlet.querySelector('#chat-evidence-description');
  const evidenceConfirm = outlet.querySelector('#chat-evidence-confirm'), evidenceShare = outlet.querySelector('#chat-evidence-share');
  const evidenceStatus = outlet.querySelector('#chat-evidence-status'), evidenceFields = outlet.querySelector('#chat-evidence-fields');
  const evidenceGuidance = outlet.querySelector('#chat-evidence-guidance'), evidenceImageLabel = outlet.querySelector('#chat-evidence-image-label');
  const bodyEvidenceFields = outlet.querySelector('#chat-body-evidence-fields'), medicineEvidenceFields = outlet.querySelector('#chat-medicine-evidence-fields');
  const evidenceChoices = [...outlet.querySelectorAll('[data-chat-evidence-kind]')];
  const medicineSource = outlet.querySelector('#chat-medicine-source'), useCamera = outlet.querySelector('#chat-evidence-use-camera');
  const uploadPhoto = outlet.querySelector('#chat-evidence-upload-photo'), camera = outlet.querySelector('#chat-evidence-camera');
  const cameraPreview = outlet.querySelector('#chat-evidence-camera-preview'), capturePhoto = outlet.querySelector('#chat-evidence-capture');
  const switchCamera = outlet.querySelector('#chat-evidence-switch-camera'), stopCamera = outlet.querySelector('#chat-evidence-stop-camera');
  const cameraReview = outlet.querySelector('#chat-evidence-camera-review'), usePhoto = outlet.querySelector('#chat-evidence-use-photo');
  const retakePhoto = outlet.querySelector('#chat-evidence-retake-photo');
  const medicineName = outlet.querySelector('#chat-medicine-name'), medicineStrength = outlet.querySelector('#chat-medicine-strength');
  const medicineHowTaken = outlet.querySelector('#chat-medicine-how-taken'), medicineConfirm = outlet.querySelector('#chat-medicine-confirm');
  const intakePanel = createIntakePanel(outlet);
  let session = null, disposed = false, pending = false, evidencePending = false, preparedEvidence = null, evidenceId = null, previewUrl = null;
  let evidenceKind = null, medicineCandidate = null, medicineIdempotencyKey = null, medicineSaved = false;
  let evidenceSource = null, cameraStream = null, cameraFacing = 'environment', cameraCaptured = null, medicineResumeQuestion = null;
  let automaticMedicineRead = false;

  const savedSession = () => { try { const value = sessionStorage.getItem(storageKey); return sessionPattern.test(value || '') ? value : null; } catch { return null; } };
  const saveSession = value => { try { if (value) sessionStorage.setItem(storageKey, value); else sessionStorage.removeItem(storageKey); } catch {} };
  const setError = message => { error.hidden = !message; error.textContent = message || ''; };
  const setVoiceBlocked = blocked => { outlet.closest('.patient-page')?.classList.toggle('chat-intake-running', blocked); if (voiceStart) voiceStart.disabled = blocked || !voiceConsent?.checked; };
  const voiceActive = () => voiceEnd && !voiceEnd.disabled;
  const blockVoice = event => { if (!session || ['completed', 'emergency', 'cancelled'].includes(session.status)) return; event.preventDefault(); event.stopImmediatePropagation(); setError('Finish or cancel the active chat intake before starting voice intake.'); };
  const evidenceReady = () => evidenceKind === 'body_area'
    ? !!preparedEvidence && !!evidenceDescription.value.trim() && evidenceConfirm.checked && !evidencePending
    : evidenceKind === 'medicine_package' && medicineCandidate
      ? !!medicineName.value.trim() && !!medicineStrength.value.trim() && !!medicineHowTaken.value.trim() && medicineConfirm.checked && !evidencePending && !medicineSaved
      : evidenceKind === 'medicine_package' && !!preparedEvidence && !evidencePending;
  const updateEvidence = () => {
    evidenceShare.textContent = evidenceKind === 'body_area' ? 'Share image with case' : medicineCandidate ? 'Save confirmed medicine' : 'Read medicine package';
    evidenceShare.hidden = evidenceKind === 'medicine_package' && automaticMedicineRead;
    evidenceShare.disabled = !evidenceReady();
  };
  const syncMedicineSources = () => {
    useCamera.setAttribute('aria-checked', String(evidenceSource === 'camera'));
    uploadPhoto.setAttribute('aria-checked', String(evidenceSource === 'upload'));
  };
  const stopEvidenceCamera = () => {
    cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; cameraPreview.srcObject = null; camera.hidden = true;
  };
  const clearCameraCapture = () => { cameraCaptured = null; cameraReview.hidden = true; };
  const clearEvidenceDraft = () => {
    stopEvidenceCamera(); clearCameraCapture(); evidenceSource = null; syncMedicineSources(); medicineSource.hidden = true;
    preparedEvidence = null; evidenceId = null; evidenceInput.value = ''; evidenceDescription.value = ''; evidenceConfirm.checked = false;
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
    medicineCandidate = null; medicineIdempotencyKey = null; medicineSaved = false; automaticMedicineRead = false;
    for (const field of [medicineName, medicineStrength, medicineHowTaken]) { field.value = ''; field.disabled = false; }
    medicineConfirm.checked = false; medicineConfirm.disabled = false;
    evidenceInput.disabled = false; evidenceInput.hidden = false; evidenceImageLabel.hidden = false; evidenceDescription.disabled = false; evidenceConfirm.disabled = false;
    evidencePreview.removeAttribute('src'); evidencePreview.hidden = true; medicineEvidenceFields.hidden = true; updateEvidence();
  };
  const resetEvidence = () => {
    clearEvidenceDraft(); evidenceKind = null; evidenceFields.hidden = true; bodyEvidenceFields.hidden = true;
    evidenceChoices.forEach(choice => choice.setAttribute('aria-checked', 'false'));
    evidenceStatus.textContent = 'Choose a clinical photo type.';
  };

  function renderMessages(items = []) {
    messages.replaceChildren();
    for (const item of items) {
      const row = document.createElement('li'), label = document.createElement('strong'), text = document.createElement('p');
      row.className = item.role === 'Patient' ? 'patient-chat-message is-patient' : 'patient-chat-message is-assistant';
      label.textContent = item.role === 'Patient' ? 'You' : 'SmartCareOps'; text.textContent = item.text;
      row.append(label, text); messages.append(row);
    }
    messages.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  function resumeChatAfterMedicine() {
    const question = session?.question;
    if (!question || ['completed', 'emergency', 'cancelled'].includes(session.status)) return;
    medicineResumeQuestion = question;
    if (session.messages?.at(-1)?.role !== 'SmartCareOps' || session.messages.at(-1).text !== question) {
      session = { ...session, messages: [...(session.messages || []), { role: 'SmartCareOps', text: question }] };
      renderMessages(session.messages);
    }
    status.textContent = 'Medicine saved. Continue your chat intake.';
    requestAnimationFrame(() => {
      if (disposed) return;
      answer.focus({ preventScroll: true });
      chatRegion.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
  }

  function preserveMedicineResumeQuestion(next) {
    if (!medicineResumeQuestion || !Array.isArray(next?.messages) || next.messages.some(item => item.role === 'SmartCareOps' && item.text === medicineResumeQuestion)) {
      medicineResumeQuestion = null; return next;
    }
    const patientIndex = next.messages.findLastIndex(item => item.role === 'Patient');
    if (patientIndex < 0) { medicineResumeQuestion = null; return next; }
    const messages = [...next.messages];
    messages.splice(patientIndex, 0, { role: 'SmartCareOps', text: medicineResumeQuestion });
    medicineResumeQuestion = null;
    return { ...next, messages };
  }

  function apply(next, { focusConversation = false } = {}) {
    session = next; saveSession(next.sessionId); active.hidden = false; renderMessages(next.messages); intakePanel.update(next.intake); intakePanel.progress(next.progress);
    const terminal = ['completed', 'emergency'].includes(next.status);
    form.hidden = terminal; evidence.hidden = terminal; cancel.hidden = terminal; viewCases.hidden = !terminal; answer.disabled = terminal; send.disabled = terminal;
    status.textContent = next.status === 'completed' ? 'Your typed intake was saved.' : next.status === 'emergency'
      ? 'Emergency case sent to the SmartCareOps command center for dispatcher review. No ambulance or hospital referral has been confirmed.' : 'Chat intake active. Answer one question at a time.';
    setVoiceBlocked(!terminal);
    if (terminal) {
      stopEvidenceCamera(); clearCameraCapture();
      saveSession(null); window.dispatchEvent(new CustomEvent('smartcareops:case-updated', { detail: { caseId: next.patientCase?.caseId } }));
    } else if (focusConversation) {
      requestAnimationFrame(() => {
        if (disposed || session !== next) return;
        chatRegion.focus({ preventScroll: true });
        chatRegion.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      });
    } else answer.focus({ preventScroll: true });
  }

  async function parse(response) {
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.message || 'Chat intake is temporarily unavailable.'), { status: response.status, code: value.code });
    return value;
  }

  async function begin(resumeSessionId) {
    if (pending || disposed) return;
    if (voiceActive()) { setError('End the active voice conversation before starting chat intake.'); return; }
    if (!resumeSessionId) resetEvidence();
    pending = true; start.disabled = true; setError(''); status.textContent = resumeSessionId ? 'Restoring your chat intake…' : 'Starting chat intake…';
    try {
      const response = await request('/api/intake/chat/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resumeSessionId ? { resumeSessionId } : {}) });
      apply(await parse(response), { focusConversation: !resumeSessionId });
    } catch (cause) {
      if (resumeSessionId && [404, 410].includes(cause.status)) saveSession(null);
      setError(cause.message); status.textContent = 'Chat intake is unavailable. Nothing was submitted.';
    } finally { pending = false; start.disabled = !consent.checked || !!session && !['completed', 'emergency', 'cancelled'].includes(session.status); }
  }

  async function submit(event) {
    event.preventDefault();
    const message = answer.value.trim();
    if (!session || pending || !message) return;
    pending = true; send.disabled = true; answer.disabled = true; setError(''); status.textContent = 'Sending your answer…';
    try {
      const response = await request('/api/intake/chat/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ sessionId: session.sessionId, expectedRevision: session.revision, message }) });
      answer.value = ''; apply(preserveMedicineResumeQuestion(await parse(response)));
    } catch (cause) {
      setError(cause.message); status.textContent = cause.code === 'CHAT_MESSAGE_PENDING' ? 'Your previous answer is still being processed.' : 'Your answer was not added. Review it and try again.';
      if (cause.code === 'CHAT_SESSION_STALE') await restore();
    } finally { pending = false; const terminal = ['completed', 'emergency'].includes(session?.status); send.disabled = terminal; answer.disabled = terminal; }
  }

  async function restore() {
    const sessionId = savedSession();
    if (!sessionId || disposed) return;
    try {
      const response = await request('/api/intake/chat/session', { headers: { 'X-SmartCareOps-Chat-Session-Id': sessionId }, cache: 'no-store' });
      apply(await parse(response));
    } catch (cause) {
      if ([404, 410].includes(cause.status)) saveSession(null);
      setError(cause.message);
    }
  }

  async function stop() {
    if (!session || pending) return;
    pending = true; cancel.disabled = true; setError('');
    try {
      const response = await request('/api/intake/chat/session', { method: 'DELETE', headers: { 'X-SmartCareOps-Chat-Session-Id': session.sessionId } });
      await parse(response); session = null; saveSession(null); active.hidden = true; status.textContent = 'Chat intake cancelled. No case was created.'; intakePanel.reset(); resetEvidence(); setVoiceBlocked(false);
    } catch (cause) { setError(cause.message); }
    finally { pending = false; cancel.disabled = false; start.disabled = !consent.checked; }
  }

  function chooseEvidence(event) {
    const kind = event.currentTarget.dataset.chatEvidenceKind;
    if (!['medicine_package', 'body_area'].includes(kind) || kind === evidenceKind) return;
    clearEvidenceDraft(); evidenceKind = kind; evidenceFields.hidden = false;
    const bodyArea = kind === 'body_area'; bodyEvidenceFields.hidden = !bodyArea; medicineEvidenceFields.hidden = true; medicineSource.hidden = bodyArea;
    evidenceImageLabel.hidden = !bodyArea; evidenceInput.hidden = !bodyArea;
    evidenceGuidance.textContent = bodyArea
      ? 'Choose one still image and describe the body area in your own words. The image is patient-shared location evidence, not a diagnosis.'
      : 'Choose a clear photo of the printed medicine name and strength. You will review the reading and describe in your own words how you actually take it before anything is saved.';
    evidenceImageLabel.textContent = bodyArea ? 'Pain-location image' : 'Medicine package image';
    evidencePreview.alt = bodyArea ? 'Pain-location image selected for sharing' : 'Medicine package image selected for review';
    evidenceStatus.textContent = bodyArea ? 'No pain-location image selected.' : 'No medicine package image selected.';
    evidenceChoices.forEach(choice => choice.setAttribute('aria-checked', String(choice === event.currentTarget)));
    updateEvidence();
  }

  async function startEvidenceCamera() {
    if (evidenceKind !== 'medicine_package' || disposed || !session || !navigator.mediaDevices?.getUserMedia) {
      evidenceStatus.textContent = 'Camera is unavailable on this device. Choose Upload photo instead.'; return;
    }
    evidenceSource = 'camera'; syncMedicineSources(); evidenceInput.hidden = true; evidenceImageLabel.hidden = true;
    preparedEvidence = null; clearCameraCapture(); evidencePreview.removeAttribute('src'); evidencePreview.hidden = true; updateEvidence();
    evidenceStatus.textContent = 'Waiting for camera permission…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: cameraFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (disposed || evidenceKind !== 'medicine_package' || evidenceSource !== 'camera') { stream.getTracks().forEach(track => track.stop()); return; }
      stopEvidenceCamera(); cameraStream = stream; cameraPreview.srcObject = stream; await cameraPreview.play(); camera.hidden = false;
      evidenceStatus.textContent = 'Camera active. Fill the frame with the printed medicine name and strength.';
    } catch (cause) {
      evidenceStatus.textContent = cause?.name === 'NotAllowedError' ? 'Camera permission was denied. Choose Upload photo instead.'
        : cause?.name === 'NotFoundError' ? 'No camera was found. Choose Upload photo instead.' : 'The camera could not be started. Choose Upload photo instead.';
    }
  }

  function chooseUpload() {
    if (evidenceKind !== 'medicine_package') return;
    evidenceSource = 'upload'; syncMedicineSources(); stopEvidenceCamera(); clearCameraCapture(); preparedEvidence = null;
    evidenceImageLabel.hidden = false; evidenceInput.hidden = false; evidencePreview.removeAttribute('src'); evidencePreview.hidden = true; updateEvidence();
    evidenceStatus.textContent = 'Choose a clear JPEG or WebP photo of the printed package label.'; evidenceInput.click();
  }

  async function captureCameraPhoto() {
    if (!cameraStream || evidenceSource !== 'camera') return;
    capturePhoto.disabled = true; evidenceStatus.textContent = 'Capturing the package photo…';
    try {
      cameraCaptured = await captureMedicineStill(cameraPreview); stopEvidenceCamera();
      evidencePreview.src = `data:${cameraCaptured.mimeType};base64,${cameraCaptured.imageBase64}`; evidencePreview.hidden = false; cameraReview.hidden = false;
      evidenceStatus.textContent = 'Review this package photo before using it.';
    } catch (cause) {
      evidenceStatus.textContent = cause?.message === 'IMAGE_TOO_LARGE' ? 'The photo could not be prepared. Move closer and try again.' : 'The photo could not be captured. Hold the package steady and try again.';
    } finally { capturePhoto.disabled = false; }
  }

  async function useCameraPhoto() {
    if (!cameraCaptured) return;
    preparedEvidence = cameraCaptured; cameraCaptured = null; cameraReview.hidden = true; automaticMedicineRead = true; updateEvidence();
    try { await shareEvidence(); }
    finally { automaticMedicineRead = false; updateEvidence(); }
  }

  async function retakeCameraPhoto() {
    preparedEvidence = null; clearCameraCapture(); evidencePreview.removeAttribute('src'); evidencePreview.hidden = true; updateEvidence(); await startEvidenceCamera();
  }

  async function switchEvidenceCamera() {
    cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment'; stopEvidenceCamera(); await startEvidenceCamera();
  }

  function stopEvidenceCameraByUser() {
    stopEvidenceCamera();
    evidenceStatus.textContent = 'Camera stopped. Choose Use camera to start it again, or choose Upload photo.';
  }

  async function selectEvidence() {
    const file = evidenceInput.files?.[0]; preparedEvidence = null; evidenceId = null; evidenceConfirm.checked = false; updateEvidence();
    if (!file) { evidencePreview.hidden = true; evidenceStatus.textContent = 'No image selected.'; return; }
    evidenceStatus.textContent = 'Preparing the selected image…';
    try {
      preparedEvidence = await prepareEvidenceImage(file);
      if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(file); evidencePreview.src = previewUrl; evidencePreview.hidden = false;
      evidenceStatus.textContent = evidenceKind === 'body_area'
        ? 'Image ready. Add your description and confirm sharing.'
        : 'Image ready. Choose Read medicine package to continue.';
    } catch (cause) {
      evidenceInput.value = ''; evidencePreview.hidden = true;
      evidenceStatus.textContent = cause.message === 'IMAGE_TYPE_UNSUPPORTED' ? 'Choose a JPEG or WebP image.' : 'This image could not be prepared. Choose a smaller image and try again.';
    }
    updateEvidence();
  }

  async function shareEvidence() {
    if (!session || !evidenceReady()) return;
    if (evidenceKind === 'medicine_package') {
      if (!medicineCandidate) {
        evidencePending = true; updateEvidence(); evidenceStatus.textContent = 'Reading the visible printed label…';
        try {
          const response = await request('/api/intake/medicine/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            intakeSessionId: session.sessionId, ...preparedEvidence,
          }) });
          const value = await response.json().catch(() => ({}));
          if (!response.ok || !value.candidate?.name || !value.candidate?.strength) throw Object.assign(new Error('MEDICINE_SCAN_FAILED'), { code: value.code });
          medicineCandidate = value.candidate; medicineName.value = value.candidate.name; medicineStrength.value = value.candidate.strength;
          medicineIdempotencyKey = crypto.randomUUID(); medicineEvidenceFields.hidden = false;
          evidenceStatus.textContent = 'Review the printed name and strength, then describe in your own words how you actually take it.';
        } catch (cause) {
          evidenceStatus.textContent = cause.code === 'MEDICINE_LABEL_UNCLEAR'
            ? 'The medicine name and strength were not both clear. Choose a clearer image.'
            : 'Medicine label scanning is temporarily unavailable. Your image is still here; try again shortly.';
        } finally { evidencePending = false; updateEvidence(); }
        return;
      }
      evidencePending = true; updateEvidence(); evidenceStatus.textContent = 'Saving your confirmed medicine entry…';
      try {
        const response = await request('/api/intake/medicine/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          intakeSessionId: session.sessionId, idempotencyKey: medicineIdempotencyKey, name: medicineName.value, strength: medicineStrength.value,
          howTaken: medicineHowTaken.value, confirmed: true,
        }) });
        const value = await response.json().catch(() => ({}));
        if (!response.ok || typeof value.receiptId !== 'string' || value.medication?.source !== 'packaging_shown') throw Object.assign(new Error('MEDICINE_SAVE_FAILED'), { code: value.code });
        medicineSaved = true; evidenceInput.disabled = true;
        for (const field of [medicineName, medicineStrength, medicineHowTaken, medicineConfirm]) field.disabled = true;
        evidenceStatus.textContent = 'Medicine entry saved to this intake as patient-reported information from packaging shown.';
        resumeChatAfterMedicine();
      } catch {
        evidenceStatus.textContent = 'The medicine entry was not saved. Review it and try again.';
      } finally { evidencePending = false; updateEvidence(); }
      return;
    }
    evidencePending = true; evidenceShare.disabled = true; evidenceStatus.textContent = 'Sharing image with this intake…'; evidenceId ||= crypto.randomUUID();
    try {
      const response = await request('/api/intake/evidence/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        intakeSessionId: session.sessionId, evidenceId, kind: 'body_area', patientDescription: evidenceDescription.value.trim(), ...preparedEvidence,
      }) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok || value.evidence?.evidenceId !== evidenceId) throw new Error('EVIDENCE_SHARE_FAILED');
      evidenceStatus.textContent = 'Image shared with this intake. It will appear with the saved case.';
      evidenceInput.disabled = true; evidenceDescription.disabled = true; evidenceConfirm.disabled = true; evidenceShare.textContent = 'Image shared with this intake';
    } catch {
      evidenceStatus.textContent = 'The image was not shared. Your selection is still here; try again when ready.'; evidencePending = false; updateEvidence(); return;
    }
    evidencePending = false;
  }

  const consentChanged = () => { start.disabled = !consent.checked || pending || !!session && !['completed', 'emergency', 'cancelled'].includes(session.status); };
  const startClicked = () => void begin();
  const answerKeyDown = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!pending && !answer.disabled && answer.value.trim()) form.requestSubmit();
  };
  consent.addEventListener('change', consentChanged); start.addEventListener('click', startClicked); form.addEventListener('submit', submit); cancel.addEventListener('click', stop);
  answer.addEventListener('keydown', answerKeyDown);
  evidenceChoices.forEach(choice => choice.addEventListener('click', chooseEvidence));
  useCamera.addEventListener('click', startEvidenceCamera); uploadPhoto.addEventListener('click', chooseUpload);
  capturePhoto.addEventListener('click', captureCameraPhoto); switchCamera.addEventListener('click', switchEvidenceCamera); stopCamera.addEventListener('click', stopEvidenceCameraByUser);
  usePhoto.addEventListener('click', useCameraPhoto); retakePhoto.addEventListener('click', retakeCameraPhoto);
  evidenceInput.addEventListener('change', selectEvidence); evidenceDescription.addEventListener('input', updateEvidence); evidenceConfirm.addEventListener('change', updateEvidence); evidenceShare.addEventListener('click', shareEvidence);
  for (const field of [medicineName, medicineStrength, medicineHowTaken]) field.addEventListener('input', () => { medicineConfirm.checked = false; updateEvidence(); });
  medicineConfirm.addEventListener('change', updateEvidence);
  voiceStart?.addEventListener('click', blockVoice, true);
  const onCaseLink = () => { window.dispatchEvent(new CustomEvent('smartcareops:case-updated', { detail: { caseId: session?.patientCase?.caseId } })); };
  viewCases.addEventListener('click', onCaseLink);
  void restore();
  return () => { disposed = true; stopEvidenceCamera(); if (previewUrl) URL.revokeObjectURL(previewUrl); consent.removeEventListener('change', consentChanged); start.removeEventListener('click', startClicked); form.removeEventListener('submit', submit); answer.removeEventListener('keydown', answerKeyDown); cancel.removeEventListener('click', stop); evidenceChoices.forEach(choice => choice.removeEventListener('click', chooseEvidence)); useCamera.removeEventListener('click', startEvidenceCamera); uploadPhoto.removeEventListener('click', chooseUpload); capturePhoto.removeEventListener('click', captureCameraPhoto); switchCamera.removeEventListener('click', switchEvidenceCamera); stopCamera.removeEventListener('click', stopEvidenceCameraByUser); usePhoto.removeEventListener('click', useCameraPhoto); retakePhoto.removeEventListener('click', retakeCameraPhoto); evidenceInput.removeEventListener('change', selectEvidence); evidenceDescription.removeEventListener('input', updateEvidence); evidenceConfirm.removeEventListener('change', updateEvidence); evidenceShare.removeEventListener('click', shareEvidence); medicineConfirm.removeEventListener('change', updateEvidence); voiceStart?.removeEventListener('click', blockVoice, true); viewCases.removeEventListener('click', onCaseLink); };
}

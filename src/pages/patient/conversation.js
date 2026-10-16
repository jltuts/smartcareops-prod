import { ConversationAudio, encodePcm } from './audio.js';
import { createIntakePanel } from './intake-panel.js';
import { mountHandoff } from './handoff.js';
import { apiFetch, authEnabled, authState } from '../../auth/service.js';
import { createMedicineFlow } from './medicine.js';
import { DEFAULT_LIVE_LANGUAGE, isSupportedLiveLanguage } from '../../../shared/live-languages.js';
import { mountCaseHistory } from './case-history.js';
import { createDirectLiveSocket } from './direct-live-socket.js';
import { createReferenceConversation } from './reference-conversation.js';

const liveProtocol = 'smartcareops.live.v1';
const finalizationKey = 'smartcareops-finalization-id';
const activeIntakeKey = 'smartcareops-active-intake-id';
const finalizationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function openLiveSocket({ authenticated = authEnabled, fetchSession = apiFetch, Socket = WebSocket, location = window.location, preferredLanguage = DEFAULT_LIVE_LANGUAGE } = {}) {
  if (!isSupportedLiveLanguage(preferredLanguage)) throw new Error('Choose a supported conversation language.');
  let resumeIntakeSessionId;
  try { resumeIntakeSessionId = sessionStorage.getItem(activeIntakeKey) || undefined; } catch {}
  const bootstrap = await fetchSession('/api/live/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferredLanguage, ...(resumeIntakeSessionId ? { resumeIntakeSessionId } : {}) }) });
  if (!bootstrap.ok) throw new Error('Secure voice session could not be created.');
  const data = await bootstrap.json();
  if (typeof data.geminiToken === 'string') {
    if (data.geminiToken.length < 20 || data.geminiToken.length > 4096 || /[\s\u0000-\u001f]/.test(data.geminiToken) ||
        !/^[a-f0-9]{64}$/.test(data.intakeSessionId || '') || Date.parse(data.expiresAt) <= Date.now() ||
        typeof data.model !== 'string' || !data.model || !isSupportedLiveLanguage(data.preferredLanguage)) throw new Error('Secure voice session was invalid.');
    return createDirectLiveSocket({ bootstrap: data, request: fetchSession, Socket });
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '') || !/^[a-f0-9]{64}$/.test(data.intakeSessionId || '') || !/^wss:\/\//.test(data.webSocketUrl || '') || Date.parse(data.expiresAt) <= Date.now() || !isSupportedLiveLanguage(data.preferredLanguage)) throw new Error('Secure voice session was invalid.');
  const socket = new Socket(new URL(data.webSocketUrl), [liveProtocol, `smartcareops.session.${data.token}`]);
  socket.smartcareIntakeSessionId = data.intakeSessionId;
  socket.smartcarePreferredLanguage = data.preferredLanguage;
  socket.smartcareResumed = data.resumed === true;
  return socket;
}

export function mountPatient(outlet) {
  let referenceConversation;
  const find = id => outlet.querySelector(`#${id}`);
  const scrollToConversation = event => {
    const target = outlet.querySelector('#conversation-area');
    if (!target) return;
    const mobile = window.matchMedia?.('(max-width: 700px)').matches;
    if (!mobile) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    event?.preventDefault();
    const controls = outlet.querySelector('.conversation-controls');
    const mobileNav = outlet.querySelector('.patient-mobile-nav');
    if (!controls) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const navHeight = mobileNav?.getBoundingClientRect().height || 0;
    const safeViewportBottom = Math.max(16, window.innerHeight - navHeight - 16);
    const controlsRect = controls.getBoundingClientRect();
    const availableCenter = (16 + safeViewportBottom) / 2;
    const controlsCenter = (controlsRect.top + controlsRect.bottom) / 2;
    window.scrollBy({ top: controlsCenter - availableCenter, behavior: 'smooth' });
    try { window.history.replaceState(window.history.state, '', '#conversation-area'); } catch {}
  };
  const start = find('start-conversation');
  const fictional = find('intake-fictional');
  const showFacilityResult = (type, result) => {
    let panel = find('facility-coordination-status');
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'facility-coordination-status'; panel.className = 'patient-intake-card facility-coordination-status';
      panel.setAttribute('aria-live', 'polite');
      outlet.querySelector('.patient-transcript-wrap')?.before(panel);
    }
    panel.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = type === 'appointment-request' ? 'Fictional appointment request' : 'Demo hospital information'; panel.append(heading);
    const boundary = document.createElement('p'); boundary.textContent = type === 'appointment-request'
      ? 'Request recorded in this demo. No hospital or Doctor was contacted, and this is not a confirmed booking.'
      : 'The capacity shown here is simulated demo information. It is not live or guaranteed and has not been verified with a hospital. These options are not confirmed referrals.'; panel.append(boundary);
    if (type === 'facility-options') {
      const list = document.createElement('ol');
      for (const option of result?.options || []) {
        const item = document.createElement('li');
        const department = option.departmentCapacity;
        const capacity = department
          ? `ED ${department.emergencyOccupied}/${department.emergencyCapacity} (${department.emergencyAvailable} available), ICU ${department.icuOccupied}/${department.icuCapacity} (${department.icuAvailable} available), ${department.operationalState}`
          : Object.entries({ 'emergency bed': option.capacity?.emergencyBedsAvailable, 'monitored bed': option.capacity?.monitoredBedsAvailable, 'ICU bed': option.capacity?.icuBedsAvailable })
            .filter(([, count]) => Number.isInteger(count) && count >= 0).map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`).join(', ');
        item.textContent = `${option.hospitalName} · about ${(option.distanceMeters / 1000).toFixed(1)} km away · ${option.specialty.replaceAll('_', ' ')}${capacity ? ` · simulated capacity: ${capacity}` : ''}`;
        list.append(item);
      }
      panel.append(list);
    } else if (result?.selection) {
      const detail = document.createElement('p'); detail.textContent = `${result.selection.hospitalName} · ${result.selection.specialty.replaceAll('_', ' ')} · ${result.selection.date} ${result.selection.time} · ${(result.selection.distanceMeters / 1000).toFixed(1)} km`; panel.append(detail);
    }
  };
  const language = find('conversation-language');
  const end = find('end-conversation');
  const status = find('connection-status');
  const state = find('ai-state');
  const error = find('conversation-error');
  const retryEmergencyAudio = find('retry-emergency-audio');
  const languageHelp = outlet.querySelector('.conversation-language-help');
  const languageHelpButton = languageHelp?.querySelector('button');
  const languageHelpTooltip = languageHelp?.querySelector('[role="tooltip"]');
  let languageHelpPinned = false;
  const showLanguageHelp = () => { if (languageHelpTooltip) languageHelpTooltip.hidden = false; languageHelpButton?.setAttribute('aria-expanded', 'true'); };
  const hideLanguageHelp = () => { if (languageHelpTooltip) languageHelpTooltip.hidden = true; languageHelpButton?.setAttribute('aria-expanded', 'false'); };
  const leaveLanguageHelp = () => { if (!languageHelpPinned && !languageHelp?.matches(':hover') && !languageHelp?.contains(document.activeElement)) hideLanguageHelp(); };
  const toggleLanguageHelp = () => { if (languageHelpPinned) { languageHelpPinned = false; hideLanguageHelp(); } else { languageHelpPinned = true; showLanguageHelp(); } };
  const escapeLanguageHelp = event => { if (event.key === 'Escape' && !languageHelpTooltip?.hidden) { languageHelpPinned = false; hideLanguageHelp(); languageHelpButton?.focus(); } };
  languageHelp?.addEventListener('pointerenter', showLanguageHelp);
  languageHelp?.addEventListener('pointerleave', leaveLanguageHelp);
  languageHelpButton?.addEventListener('focus', showLanguageHelp);
  languageHelpButton?.addEventListener('blur', leaveLanguageHelp);
  languageHelpButton?.addEventListener('click', toggleLanguageHelp);
  languageHelpButton?.addEventListener('keydown', escapeLanguageHelp);
  const transcript = find('transcript');
  const transcriptRegion = outlet.querySelector('.patient-transcript-wrap');
  const evidencePanel = find('medicine-flow');
  const intakePanel = createIntakePanel(outlet);
  const intakePanelElement = outlet.querySelector('.intake-panel');
  const medicine = createMedicineFlow(outlet, { request: apiFetch, getSession: () => current });
  referenceConversation = createReferenceConversation(outlet, apiFetch, { medicine });
  const page = outlet.querySelector('.patient-page');
  find('patient-today').textContent = new Intl.DateTimeFormat(navigator.language, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
  const profileController = new AbortController();
  if (authEnabled) void apiFetch('/api/profile', { cache: 'no-store', signal: profileController.signal }).then(response => response.ok ? response.json() : null).then(data => {
    if (!disposed && data?.profile?.firstName) find('page-heading').textContent = `Good day, ${data.profile.firstName}.`;
  }).catch(() => {});
  const steps = [...outlet.querySelectorAll('.patient-journey-steps > div')];
  let activeCaseId = null;
  function displayCase(record) {
    const active = !!record?.caseId;
    activeCaseId = active ? record.caseId : null;
    page.classList.toggle('has-case', active);
    find('care-journey-heading').textContent = active ? 'Your care is in progress.' : 'Ready when you are.';
    find('patient-hero-description').textContent = active ? 'Follow your current status and see what happens next.' : 'Talk naturally with SmartCareOps to begin your care journey. Share what you’re feeling, one question at a time.';
    outlet.querySelector('.patient-start-link').hidden = active;
    outlet.querySelector('.patient-view-case').hidden = !active;
    find('patient-transport-action').hidden = !record?.ambulance;
    outlet.querySelector('.patient-active-details').hidden = !active;
    if (active) {
      find('patient-current-status').textContent = outlet.querySelector('#patient-case-status').textContent;
      const appointmentState = record.appointmentProposal?.state;
      find('patient-next-step').textContent = record.ambulance ? 'Follow your transport details below.' :
        appointmentState === 'appointment_confirmed' ? 'Your appointment is confirmed.' :
        appointmentState === 'alternate_time_requested' ? 'Your Doctor will propose another time.' :
        appointmentState === 'awaiting_patient_confirmation' ? 'Choose an appointment time.' :
        record.appointmentRequest?.state === 'requested' ? 'Your fictional appointment request was recorded for review. It is not a confirmed booking.' :
        record.clinicalReview?.status === 'approved' ? 'Review complete. No appointment is currently proposed.' : 'Follow the latest case update below.';
    }
    const handoffActive = ['pending', 'in_progress', 'completed'].includes(record?.handoffStatus);
    const reviewComplete = ['approved', 'rejected', 'deferred'].includes(record?.clinicalReview?.status);
    const appointmentState = record?.appointmentProposal?.state;
    const stageLabels = record?.ambulance ? [record.ambulance.status === 'completed' ? 'Response Complete' : 'Transport', record.ambulance.status === 'completed' ? 'Follow-up' : 'Hospital'] : handoffActive ? ['Hospital Handoff', 'Follow-up'] :
      appointmentState ? ['Appointment Proposed', appointmentState === 'appointment_confirmed' ? 'Appointment Confirmed' : appointmentState === 'alternate_time_requested' ? 'Await Another Time' : 'Confirm Appointment'] :
      reviewComplete ? ['Doctor Decision', 'Review Complete'] : ['Next Step', 'Follow-up'];
    steps[4].querySelector('strong').textContent = stageLabels[0];
    steps[5].querySelector('strong').textContent = stageLabels[1];
    let current = -1;
    const emergencyCase = !!record?.emergency;
    if (active && record.storage !== 'pending' && record.storage !== 'unavailable') current = record.ambulance ? record.ambulance.status === 'completed' ? 5 : 4 : emergencyCase ? -1 : record.handoffStatus === 'completed' ? 5 : handoffActive ? 4 : appointmentState === 'appointment_confirmed' ? 5 : appointmentState ? 4 : reviewComplete ? 5 : record.routing?.status === 'routed' ? 3 : record.workflowStatus === 'submitted_for_clinical_review' ? 2 : 1;
    steps.forEach((step, index) => {
      const complete = emergencyCase ? active && record.storage !== 'pending' && record.storage !== 'unavailable' && index < 2 : current >= 0 && index < current;
      const isCurrent = current >= 0 && index === current;
      step.classList.toggle('complete', complete);
      step.classList.toggle('current', isCurrent);
      if (isCurrent) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
      const label = step.querySelector('strong').textContent;
      if (complete || isCurrent) step.setAttribute('aria-label', `${index + 1}. ${label}, ${complete ? 'complete' : 'current step'}`);
      else step.removeAttribute('aria-label');
    });
  }
  const handoff = mountHandoff(outlet, displayCase);
  const openCase = caseId => {
    if (window.location.hash !== '#cases') window.history.pushState(window.history.state, '', '#cases');
    setPatientView(false);
    handoff.openCase(caseId);
    requestAnimationFrame(() => outlet.querySelector('#patient-case')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
  };
  const caseHistory = mountCaseHistory(outlet, { onOpen: openCase });
  const viewCurrentCase = event => { if (!activeCaseId) return; event.preventDefault(); openCase(activeCaseId); };
  outlet.querySelector('.patient-view-case').addEventListener('click', viewCurrentCase);
  const homeView = find('patient-home-view'), casesView = find('patient-cases-view');
  const patientViewLinks = [...outlet.querySelectorAll('[data-patient-view-link]')];
  function setPatientView(moveFocus = true) {
    const full = window.location.hash === '#cases';
    homeView.hidden = full; casesView.hidden = !full;
    page.classList.toggle('patient-cases-active', full);
    caseHistory.setMode(full ? 'full' : 'summary');
    for (const link of patientViewLinks) {
      const active = link.dataset.patientViewLink === (full ? 'cases' : 'home');
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    if (moveFocus && full) find('patient-cases-heading')?.focus({ preventScroll: true });
  }
  const hashChanged = () => setPatientView();
  window.addEventListener('hashchange', hashChanged);
  setPatientView(false);
  const conversationPanel = outlet.querySelector('.conversation-panel');
  const audioObserver = new MutationObserver(() => { conversationPanel.dataset.audioState = find('ai-state').textContent.trim().toLowerCase(); });
  audioObserver.observe(find('ai-state'), { childList: true, characterData: true, subtree: true });
  let lastIntake;
  let current;
  let finalizing;
  let disposed = false;
  let lastEmergencyReplay;
  const rows = new Map();

  function stop(message, completed = false) {
    if (referenceConversation?.active) { referenceConversation.stop(message); return; }
    const session = current;
    const emergency = session?.emergency;
    current = null; // Invalidate pending permission requests and asynchronous callbacks first.
    if (emergency) {
      session.emergencySpeechToken = undefined;
      clearTimeout(session.emergencySpeechTimer);
      try { window.speechSynthesis?.cancel(); } catch {}
    }
    intakePanelElement.hidden = true;
    medicine.endSession(emergency ? 'emergency' : 'ended');
    if (session) {
      session.voiceState = 'CLOSED';
      clearTimeout(session.timeout);
      session.stream?.getTracks().forEach(track => track.stop());
      session.audio?.close();
      if (session.socket) {
        session.socket.onmessage = session.socket.onerror = session.socket.onclose = session.socket.onopen = null;
        if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'end' }));
        session.socket.close();
      }
    }
    status.textContent = emergency ? 'Emergency escalation' : message ? 'Error' : completed ? 'Completed' : 'Disconnected';
    state.textContent = '—';
    fictional.disabled = false;
    language.disabled = false;
    language.value = DEFAULT_LIVE_LANGUAGE;
    start.disabled = !fictional.checked;
    end.disabled = true;
    error.hidden = emergency || !message;
    error.textContent = emergency ? '' : message || '';
    retryEmergencyAudio.hidden = !emergency || !lastEmergencyReplay;
    if (emergency && lastEmergencyReplay) retryEmergencyAudio.textContent = 'Play emergency message again';
    find('session-help').textContent = 'Microphone is off. Choose Start Conversation to begin a new session.';
    if (emergency) { handoff.emergency(); find('session-help').textContent = 'Microphone is off. Emergency escalation is pending dispatcher workflow; no emergency service has been contacted.'; }
    if (session && !emergency) intakePanel.finish(!!message);
    if (completed) { handoff.completed(lastIntake, session?.completionToken, session?.patientCase); void caseHistory.refresh(); }
    if (completed || emergency) { try { sessionStorage.removeItem(activeIntakeKey); } catch {} }
  }

  function append(message) {
    find('transcript-empty').hidden = true;
    let row = rows.get(message.role);
    if (!row) {
      const item = document.createElement('li');
      item.dataset.role = message.role;
      const label = document.createElement('strong');
      label.textContent = message.role;
      row = document.createElement('p');
      item.append(label, row);
      transcript.append(item);
      rows.set(message.role, row);
    }
    row.textContent += message.text;
    if (message.finished) rows.delete(message.role);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function emergencySpeechFailed(session) {
    if (current !== session || !session.emergency) return;
    clearTimeout(session.emergencySpeechTimer);
    session.emergencySpeechToken = undefined;
    retryEmergencyAudio.textContent = 'Retry emergency speech';
    retryEmergencyAudio.hidden = false;
    state.textContent = 'Speech unavailable';
    find('session-help').textContent = 'Emergency speech is unavailable. The authorized text remains visible; choose Retry emergency speech to try again.';
  }

  function speakEmergencyMessage(session, message, retry = false) {
    if (current !== session || !session.emergency || session.emergencyReady || message.id !== session.emergency.id || !['warning', 'facility'].includes(message.phase) || typeof message.text !== 'string' || !message.text.trim()) return;
    session.emergencySpeechMessages ||= new Map();
    const prior = session.emergencySpeechMessages.get(message.phase);
    if (!retry && prior) return;
    if (prior && prior !== message.text) return;
    session.emergencySpeechMessages.set(message.phase, message.text);
    session.emergencyPhase = message.phase;
    session.emergencyPhaseMessage = message;
    if (!session.emergencySpeechShown?.has(message.phase)) {
      session.emergencySpeechShown ||= new Set();
      session.emergencySpeechShown.add(message.phase);
      append({ role: 'SmartCareOps', text: message.text, finished: true });
    }
    retryEmergencyAudio.hidden = true;
    const speech = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!speech || typeof speech.speak !== 'function' || typeof Utterance !== 'function') { emergencySpeechFailed(session); return; }
    if (!session.emergencyVoiceSelected) {
      const voices = typeof speech.getVoices === 'function' ? speech.getVoices() : [];
      session.emergencyVoice = voices.find(voice => voice.default) || voices.find(voice => voice.lang?.toLowerCase().startsWith(session.preferredLanguage?.split('-')[0]?.toLowerCase())) || voices[0] || null;
      session.emergencyVoiceSelected = true;
    }
    lastEmergencyReplay = { text: message.text, voice: session.emergencyVoice, lang: session.emergencyVoice?.lang || session.preferredLanguage };
    const token = Symbol(message.phase);
    session.emergencySpeechToken = token;
    const utterance = new Utterance(message.text);
    if (session.emergencyVoice) utterance.voice = session.emergencyVoice;
    utterance.lang = session.emergencyVoice?.lang || session.preferredLanguage;
    utterance.onend = () => {
      if (current !== session || session.emergencySpeechToken !== token) return;
      clearTimeout(session.emergencySpeechTimer);
      session.emergencySpeechToken = undefined;
      retryEmergencyAudio.textContent = 'Play emergency message again';
      retryEmergencyAudio.hidden = false;
      if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'emergency-phase-settled', id: session.emergency.id, phase: message.phase }));
      state.textContent = message.phase === 'warning' ? 'Checking demo hospital information' : 'Finishing emergency message';
    };
    utterance.onerror = () => { if (session.emergencySpeechToken === token) emergencySpeechFailed(session); };
    try {
      speech.speak(utterance);
      session.emergencySpeechTimer = setTimeout(() => { if (session.emergencySpeechToken === token) emergencySpeechFailed(session); }, Math.min(55000, Math.max(20000, message.text.length * 100)));
      state.textContent = message.phase === 'warning' ? 'Speaking urgent warning' : 'Speaking hospital information';
      find('session-help').textContent = 'Emergency information is being spoken. The text is also shown below.';
    } catch { emergencySpeechFailed(session); }
  }

  function settlePlayback(session) {
    if (current === session && session.emergency) {
      if (session.audio.sources.size) return;
      if (!session.emergencyReady) return;
      if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'emergency-settled', id: session.emergency.id }));
      stop();
      return;
    }
    if (current !== session || session.pendingId === undefined || session.settled || session.audio.sources.size) return;
    session.settled = true;
    session.stream?.getTracks().forEach(track => track.stop());
    session.socket.send(JSON.stringify({ type: 'completion-settled', id: session.pendingId }));
    if (session.finalizationError) {
      stop(session.finalizationError.userMessage);
      intakePanel.finalization(session.finalizationError);
      status.textContent = 'Intake ended — summary needs review';
      return;
    }
    if (session.resultTicket) {
      stop();
      status.textContent = 'Intake ended — finalizing summary';
      handoff.finalizing();
      finalizing = session;
      void receiveFinalization(session);
    }
  }

  async function receiveFinalization(session) {
    const deadline = Date.now() + 120000;
    try {
      while (finalizing === session && !disposed) {
        const response = await apiFetch('/api/intake-finalization', { headers: { 'X-SmartCareOps-Finalization-Id': session.resultTicket }, cache: 'no-store' });
        if (finalizing !== session || disposed) return;
        if (response.status === 202 && Date.now() < deadline) {
          try { const progress = await response.json(); if (progress.patientCase) handoff.patientCase(progress.patientCase); } catch {}
          await new Promise(resolve => setTimeout(resolve, 250)); continue;
        }
        if (response.status === 404 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
        if (!response.ok || response.status === 202) throw new Error('Finalization result unavailable');
        const result = await response.json();
        if (finalizing !== session || disposed) return;
        finalizing = null;
        handoff.patientCase(result.patientCase);
        if (result.snapshot) { lastIntake = structuredClone(result.snapshot); intakePanel.update(lastIntake); }
        if (result.status === 'COMPLETED') {
          try { sessionStorage.removeItem(finalizationKey); } catch {}
          status.textContent = 'Completed';
          handoff.completed(lastIntake, result.completionToken, result.patientCase);
          find('intake-status').textContent = result.enrichmentStatus === 'failed'
            ? 'Intake saved for clinical review.' : 'Clinical summary finalized.';
        } else if (result.status === 'EMERGENCY_ESCALATED') {
          try { sessionStorage.removeItem(finalizationKey); } catch {}
          handoff.patientCase(result.patientCase);
          status.textContent = 'Emergency escalation';
          find('intake-status').textContent = 'Emergency escalation pending. Validated information preserved.';
          find('session-help').textContent = 'Microphone is off. Emergency escalation is pending dispatcher workflow; no emergency service has been contacted.';
          handoff.emergency();
        } else {
          status.textContent = 'Intake ended — summary needs review';
          handoff.failed();
          intakePanel.finalization(result.error);
        }
        return;
      }
    } catch {
      if (finalizing !== session || disposed) return;
      finalizing = null;
      status.textContent = 'Intake ended — summary needs review';
      handoff.failed();
      intakePanel.finalization({ code: 'FINALIZATION_UNKNOWN', stage: 'result', provider: 'backend', developerMessage: 'Finalization result could not be retrieved.' });
    }
  }

  async function begin() {
    if (referenceConversation) { await referenceConversation.start(); return; }
    if (current || disposed || !fictional.checked) return;
    finalizing = null;
    try { sessionStorage.removeItem(finalizationKey); } catch {}
    const preferredLanguage = language.value;
    if (!isSupportedLiveLanguage(preferredLanguage)) return;
    const session = { voiceState: 'ACTIVE', ready: false, openingReady: false, openingTurnComplete: false, openingHasOutput: false, turnComplete: false, geminiOutputActive: false, geminiOutputComplete: false, heardSpeech: false, silenceSince: 0, preferredLanguage };
    current = session;
    intakePanelElement.hidden = false;
    handoff.reset();
    lastIntake = null;
    intakePanel.reset();
    transcript.replaceChildren();
    rows.clear();
    find('transcript-empty').hidden = false;
    start.disabled = true;
    fictional.disabled = true;
    language.disabled = true;
    end.disabled = false;
    evidencePanel.hidden = false;
    requestAnimationFrame(() => {
      if (current !== session) return;
      transcriptRegion?.focus({ preventScroll: true });
      transcriptRegion?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    error.hidden = true;
    status.textContent = 'Connecting';
    state.textContent = '—';
    find('session-help').textContent = 'Allow microphone access to start. You can cancel with End Conversation.';
    session.timeout = setTimeout(() => { if (current === session) stop('Connection timed out. Check microphone permission and the backend, then try again.'); }, 30000);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) throw new Error('Audio capture is not supported by this browser.');
      const finishOpening = () => {
        if (current !== session || session.openingReady || !session.ready || !session.openingTurnComplete || session.audio.sources.size) return;
        session.openingReady = true;
        state.textContent = 'Listening';
        find('session-help').textContent = session.socket.smartcareResumed
          ? 'Your active intake was restored. Microphone is on; continue with the current question.'
          : 'Microphone is on. Speak naturally; End Conversation stops the microphone and audio.';
      };
      session.audio = new ConversationAudio(() => {
        if (current === session && session.intakeComplete) { stop(null, true); return; }
        if (current === session && session.geminiOutputComplete) session.geminiOutputActive = false;
        settlePlayback(session);
        if (current === session && !session.openingReady) { finishOpening(); if (!session.openingReady) state.textContent = 'Preparing first question'; return; }
        if (current === session && session.ready) state.textContent = session.pendingId !== undefined ? 'Finalizing' : session.turnComplete ? 'Listening' : 'Thinking';
      });
      // Resume during the explicit button gesture for browser autoplay policies.
      await session.audio.context.resume();
      if (current !== session) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current !== session) { stream.getTracks().forEach(track => track.stop()); return; }
      session.stream = stream;
      await session.audio.prepareDuplex();
      if (current !== session) { stream.getTracks().forEach(track => track.stop()); return; }
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (current === session && session.pendingId === undefined) stop('The microphone disconnected. Check your device and start again.');
      }));
      await session.audio.capture(stream, (samples, sampleRate) => {
        if (current !== session || !session.ready || !session.openingReady || session.geminiOutputActive || session.audio.sources.size || session.emergency || session.pendingId !== undefined || session.intakeComplete || session.settled || session.socket?.readyState !== WebSocket.OPEN) return;
        if (session.socket.bufferedAmount > 256 * 1024) { stop('Connection is too slow for live audio. Please try again.'); return; }
        session.socket.send(JSON.stringify({ type: 'audio', data: encodePcm(samples), sampleRate }));
        // Gemini controls turns. Local activity also protects the final playback boundary
        // from an immediate interruption while its transcription is still in flight.
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        if (rms > .02) {
          session.heardSpeech = true;
          session.silenceSince = performance.now();
          if (!session.audio.sources.size) state.textContent = 'Listening';
        }
        else if (session.heardSpeech && performance.now() - session.silenceSince > 650) {
          session.heardSpeech = false;
          if (!session.audio.sources.size) state.textContent = 'Thinking';
        }
      });
      if (current !== session) return;
      session.socket = await openLiveSocket({ preferredLanguage: session.preferredLanguage });
      session.intakeSessionId = session.socket.smartcareIntakeSessionId;
      try { sessionStorage.setItem(activeIntakeKey, session.intakeSessionId); } catch {}
      medicine.beginSession(session.intakeSessionId);
      session.socket.onopen = () => { if (current === session) session.socket.send(JSON.stringify({ type: 'start', fictionalConfirmed: true, preferredLanguage: session.socket.smartcarePreferredLanguage || session.preferredLanguage })); };
      session.socket.onerror = () => { if (current === session) stop('Unable to connect. Ensure the local backend is running and try again.'); };
      session.socket.onclose = () => { if (current === session) stop('Connection interrupted. Microphone stopped; start again when ready.'); };
      session.socket.onmessage = event => {
        if (current !== session) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'patient-case') { handoff.patientCase(message.patientCase); return; }
          if (session.pendingId !== undefined && ['transcript', 'audio', 'interrupted', 'turn-complete', 'completion-reopened', 'completion-pending'].includes(message.type)) return;
          if (message.type === 'emergency-escalation') {
            if (session.emergency) return;
            session.emergency = message;
            handoff.patientCase(message.patientCase);
            session.pendingId = undefined; session.settled = true;
            session.stream?.getTracks().forEach(track => track.stop());
            session.audio.interrupt(); rows.clear();
            try { window.speechSynthesis?.cancel(); } catch {}
            retryEmergencyAudio.hidden = true;
            lastIntake = structuredClone(message.snapshot); intakePanel.update(lastIntake);
            status.textContent = 'Emergency escalation';
            find('intake-status').textContent = 'Emergency escalation pending. Validated information preserved.';
            handoff.emergency();
            medicine.endSession('emergency');
            return;
          }
          if (session.emergency && !['emergency-phase-speech', 'emergency-playback-ready'].includes(message.type)) return;
          if (session.emergencyReady) return;
          if (message.type === 'emergency-phase-speech' && session.emergency?.id === message.id) { speakEmergencyMessage(session, message); return; }
          if (message.type === 'emergency-playback-ready' && session.emergency?.id === message.id) {
            session.emergencyReady = true;
            settlePlayback(session); return;
          }
          if (message.type === 'intake-update') { lastIntake = structuredClone(message.intake); intakePanel.update(message.intake); return; }
          if (message.type === 'intake-progress') { intakePanel.progress(message.progress); return; }
          if (message.type === 'medicine-draft') { medicine.applyVoiceDraft(message.draft); return; }
          if (message.type === 'medicine-live-status') { medicine.liveStatus(message.status); return; }
          if (message.type === 'facility-options' || message.type === 'appointment-request') { showFacilityResult(message.type, message.result); return; }
          if (message.type === 'finalization-error') { intakePanel.finalization(message.error); return; }
          if (message.type === 'intake-status') { intakePanel.status(message.status, message.code); return; }
          if (message.type === 'completion-pending') {
            session.voiceState = 'ENDING';
            session.pendingId = message.id;
            session.resultTicket = message.resultTicket;
            if (finalizationIdPattern.test(session.resultTicket || '')) {
              try { sessionStorage.setItem(finalizationKey, session.resultTicket); } catch {}
            }
            session.finalizationError = message.finalizationError;
            session.settled = false;
            settlePlayback(session);
            return;
          }
          if (message.type === 'completion-reopened') {
            return;
          }
          if (message.type === 'intake-complete') {
            session.intakeComplete = true;
            session.completionToken = message.completionToken;
            session.patientCase = message.patientCase;
            if (!session.audio.sources.size) stop(null, true);
            return;
          }
          if (message.type === 'error') { stop(message.message); return; }
          if (message.type === 'ready') {
            clearTimeout(session.timeout);
            session.ready = true;
            medicine.setReady(true);
            status.textContent = 'Connected';
            state.textContent = 'Preparing first question';
            find('session-help').textContent = 'Microphone access is ready. Waiting for the first question to finish before listening.';
          }
          if (message.type === 'transcript') {
            append(message);
            if (message.role === 'Gemini' && message.text?.trim()) {
              session.geminiOutputActive = true;
              session.geminiOutputComplete = false;
              session.heardSpeech = false;
              session.silenceSince = 0;
              if (!session.openingReady) session.openingHasOutput = true;
            }
            if (message.role === 'Patient' && session.openingReady && !session.audio.sources.size) state.textContent = 'Thinking';
          }
          if (message.type === 'audio') {
            session.turnComplete = false;
            session.geminiOutputActive = true;
            session.geminiOutputComplete = false;
            session.heardSpeech = false;
            session.silenceSince = 0;
            if (!session.openingReady) session.openingHasOutput = true;
            session.audio.play(message.data);
            state.textContent = 'Speaking';
          }
          if (message.type === 'interrupted') {
            session.audio.interrupt();
            session.geminiOutputActive = false;
            session.geminiOutputComplete = false;
            rows.delete('Gemini');
            if (!session.openingReady) { session.openingHasOutput = false; session.openingTurnComplete = false; }
            state.textContent = session.openingReady ? 'Listening' : 'Preparing first question';
          }
          if (message.type === 'turn-complete') {
            session.turnComplete = true;
            session.geminiOutputComplete = true;
            if (!session.audio.sources.size) session.geminiOutputActive = false;
            rows.clear();
            if (!session.openingReady) {
              session.openingTurnComplete = session.openingHasOutput;
              finishOpening();
            } else if (!session.audio.sources.size) state.textContent = 'Listening';
          }
        } catch { stop('Could not process the live response. Please start again.'); }
      };
    } catch (cause) {
      if (current !== session) return;
      const messages = {
        NotAllowedError: 'Microphone permission denied. Allow microphone access in your browser and start again.',
        NotFoundError: 'No microphone found. Connect a microphone and start again.',
        NotReadableError: 'The microphone is unavailable or in use by another application.',
      };
      stop(messages[cause.name] || 'Unable to start audio. Check your browser and microphone settings, then try again.');
    }
  }
  const endSession = () => { try { sessionStorage.removeItem(activeIntakeKey); } catch {} stop(); };
  const retryEmergency = () => {
    const session = current;
    if (session?.emergency && session.emergencyPhaseMessage && !session.emergencySpeechToken) {
      speakEmergencyMessage(session, session.emergencyPhaseMessage, true);
      return;
    }
    const replay = lastEmergencyReplay;
    const speech = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!replay || !speech || typeof speech.speak !== 'function' || typeof Utterance !== 'function') return;
    const utterance = new Utterance(replay.text);
    if (replay.voice) utterance.voice = replay.voice;
    utterance.lang = replay.lang;
    utterance.onend = () => {
      retryEmergencyAudio.textContent = 'Play emergency message again';
      retryEmergencyAudio.hidden = false;
    };
    utterance.onerror = () => {
      retryEmergencyAudio.textContent = 'Retry emergency speech';
      retryEmergencyAudio.hidden = false;
    };
    retryEmergencyAudio.hidden = true;
    try { speech.speak(utterance); }
    catch {
      retryEmergencyAudio.textContent = 'Retry emergency speech';
      retryEmergencyAudio.hidden = false;
    }
  };
  const suspendForPageHide = () => {
    // Reload tears down in-flight fetches. Invalidate their handlers first so an
    // aborted poll cannot erase the opaque recovery ticket from sessionStorage.
    disposed = true;
    finalizing = null;
    stop();
  };
  const consentChanged = () => { start.disabled = !!current || !fictional.checked; };
  fictional.addEventListener('change', consentChanged);
  outlet.querySelector('[data-scroll-to-conversation]')?.addEventListener('click', scrollToConversation);
  start.addEventListener('click', begin);
  end.addEventListener('click', endSession);
  retryEmergencyAudio.addEventListener('click', retryEmergency);
  window.addEventListener('pagehide', suspendForPageHide);
  try {
    const resultTicket = sessionStorage.getItem(finalizationKey);
    if (finalizationIdPattern.test(resultTicket || '')) {
      const session = { resultTicket };
      finalizing = session;
      status.textContent = 'Intake ended — finalizing summary';
      handoff.finalizing();
      void receiveFinalization(session);
    }
  } catch {}
  return () => {
    disposed = true;
    profileController.abort();
    audioObserver.disconnect();
    finalizing = null;
    handoff.dispose();
    caseHistory.dispose();
    medicine.dispose();
    stop();
    start.removeEventListener('click', begin);
    fictional.removeEventListener('change', consentChanged);
    end.removeEventListener('click', endSession);
    retryEmergencyAudio.removeEventListener('click', retryEmergency);
    languageHelp?.removeEventListener('pointerenter', showLanguageHelp);
    languageHelp?.removeEventListener('pointerleave', leaveLanguageHelp);
    languageHelpButton?.removeEventListener('focus', showLanguageHelp);
    languageHelpButton?.removeEventListener('blur', leaveLanguageHelp);
    languageHelpButton?.removeEventListener('click', toggleLanguageHelp);
    languageHelpButton?.removeEventListener('keydown', escapeLanguageHelp);
    outlet.querySelector('[data-scroll-to-conversation]')?.removeEventListener('click', scrollToConversation);
    outlet.querySelector('.patient-view-case')?.removeEventListener('click', viewCurrentCase);
    window.removeEventListener('pagehide', suspendForPageHide);
    window.removeEventListener('hashchange', hashChanged);
  };
}

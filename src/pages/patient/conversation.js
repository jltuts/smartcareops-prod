import { ConversationAudio, encodePcm } from './audio.js';
import { createIntakePanel } from './intake-panel.js';
import { mountHandoff } from './handoff.js';
import { apiFetch, authEnabled } from '../../auth/service.js';

const liveProtocol = 'smartcareops.live.v1';
const finalizationKey = 'smartcareops-finalization-id';
const finalizationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function openLiveSocket({ authenticated = authEnabled, fetchSession = apiFetch, Socket = WebSocket, location = window.location } = {}) {
  let url = new URL('/api/live', location.href);
  if (!authenticated) {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Socket(url);
  }
  const bootstrap = await fetchSession('/api/live/session', { method: 'POST' });
  if (!bootstrap.ok) throw new Error('Secure voice session could not be created.');
  const data = await bootstrap.json();
  if (!/^[A-Za-z0-9_-]{43}$/.test(data.token || '') || !/^wss:\/\//.test(data.webSocketUrl || '') || Date.parse(data.expiresAt) <= Date.now()) throw new Error('Secure voice session was invalid.');
  return new Socket(new URL(data.webSocketUrl), [liveProtocol, `smartcareops.session.${data.token}`]);
}

export function mountPatient(outlet) {
  const find = id => outlet.querySelector(`#${id}`);
  const start = find('start-conversation');
  const fictional = find('intake-fictional');
  const end = find('end-conversation');
  const status = find('connection-status');
  const state = find('ai-state');
  const error = find('conversation-error');
  const transcript = find('transcript');
  const intakePanel = createIntakePanel(outlet);
  const handoff = mountHandoff(outlet);
  let lastIntake;
  let current;
  let finalizing;
  let disposed = false;
  const rows = new Map();

  function stop(message, completed = false) {
    const session = current;
    const emergency = session?.emergency;
    current = null; // Invalidate pending permission requests and asynchronous callbacks first.
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
    start.disabled = !fictional.checked;
    end.disabled = true;
    error.hidden = emergency || !message;
    error.textContent = emergency ? '' : message || '';
    find('session-help').textContent = 'Microphone is off. Choose Start Conversation to begin a new session.';
    if (emergency) { handoff.emergency(); find('session-help').textContent = 'Microphone is off. Emergency escalation is pending dispatcher workflow; no emergency service has been contacted.'; }
    if (session && !emergency) intakePanel.finish(!!message);
    if (completed) handoff.completed(lastIntake, session?.completionToken, session?.patientCase);
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

  function settlePlayback(session) {
    if (current === session && session.emergency) {
      if (session.emergencyReady && !session.audio.sources.size) {
        if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'emergency-settled', id: session.emergency.id }));
        stop();
      }
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
    if (current || disposed || !fictional.checked) return;
    finalizing = null;
    try { sessionStorage.removeItem(finalizationKey); } catch {}
    const session = { voiceState: 'ACTIVE', ready: false, turnComplete: false, heardSpeech: false, silenceSince: 0 };
    current = session;
    handoff.reset();
    lastIntake = null;
    intakePanel.reset();
    transcript.replaceChildren();
    rows.clear();
    find('transcript-empty').hidden = false;
    start.disabled = true;
    fictional.disabled = true;
    end.disabled = false;
    error.hidden = true;
    status.textContent = 'Connecting';
    state.textContent = '—';
    find('session-help').textContent = 'Allow microphone access to start. You can cancel with End Conversation.';
    session.timeout = setTimeout(() => { if (current === session) stop('Connection timed out. Check microphone permission and the backend, then try again.'); }, 30000);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) throw new Error('Use a browser with microphone and AudioWorklet support on localhost or HTTPS.');
      session.audio = new ConversationAudio(() => {
        if (current === session && session.intakeComplete) { stop(null, true); return; }
        settlePlayback(session);
        if (current === session && session.ready) state.textContent = session.pendingId !== undefined ? 'Finalizing' : session.turnComplete ? 'Listening' : 'Thinking';
      });
      // Resume during the explicit button gesture for browser autoplay policies.
      await session.audio.context.resume();
      if (current !== session) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current !== session) { stream.getTracks().forEach(track => track.stop()); return; }
      session.stream = stream;
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (current === session && session.pendingId === undefined) stop('The microphone disconnected. Check your device and start again.');
      }));
      await session.audio.capture(stream, (samples, sampleRate) => {
        if (current !== session || !session.ready || session.emergency || session.pendingId !== undefined || session.intakeComplete || session.settled || session.socket?.readyState !== WebSocket.OPEN) return;
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
      session.socket = await openLiveSocket();
      session.socket.onopen = () => { if (current === session) session.socket.send(JSON.stringify({ type: 'start', fictionalConfirmed: true })); };
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
            lastIntake = structuredClone(message.snapshot); intakePanel.update(lastIntake);
            status.textContent = 'Emergency escalation';
            find('intake-status').textContent = 'Emergency escalation pending. Validated information preserved.';
            handoff.emergency();
            return;
          }
          if (session.emergency && !['audio', 'transcript', 'emergency-playback-ready'].includes(message.type)) return;
          if (session.emergencyReady) return;
          if (session.emergency && message.type === 'transcript' && message.role !== 'Gemini') return;
          if (message.type === 'emergency-playback-ready' && session.emergency?.id === message.id) {
            session.emergencyReady = true; settlePlayback(session); return;
          }
          if (message.type === 'intake-update') { lastIntake = structuredClone(message.intake); intakePanel.update(message.intake); return; }
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
            status.textContent = 'Connected';
            state.textContent = 'Listening';
            find('session-help').textContent = 'Microphone is on. Speak naturally; End Conversation stops the microphone and audio.';
          }
          if (message.type === 'transcript') {
            append(message);
            if (message.role === 'Patient' && !session.audio.sources.size) state.textContent = 'Thinking';
          }
          if (message.type === 'audio') {
            session.turnComplete = false;
            session.audio.play(message.data);
            state.textContent = 'Speaking';
          }
          if (message.type === 'interrupted') {
            session.audio.interrupt();
            rows.delete('Gemini');
            state.textContent = 'Listening';
          }
          if (message.type === 'turn-complete') {
            session.turnComplete = true;
            rows.clear();
            if (!session.audio.sources.size) state.textContent = 'Listening';
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
      stop(messages[cause.name] || 'Unable to start audio. Use a supported browser on localhost, check your microphone, and try again.');
    }
  }
  const endSession = () => stop();
  const suspendForPageHide = () => {
    // Reload tears down in-flight fetches. Invalidate their handlers first so an
    // aborted poll cannot erase the opaque recovery ticket from sessionStorage.
    disposed = true;
    finalizing = null;
    stop();
  };
  const consentChanged = () => { start.disabled = !!current || !fictional.checked; };
  fictional.addEventListener('change', consentChanged);
  start.addEventListener('click', begin);
  end.addEventListener('click', endSession);
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
    finalizing = null;
    handoff.dispose();
    stop();
    start.removeEventListener('click', begin);
    fictional.removeEventListener('change', consentChanged);
    end.removeEventListener('click', endSession);
    window.removeEventListener('pagehide', suspendForPageHide);
  };
}

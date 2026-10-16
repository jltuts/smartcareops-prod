const OPEN = 1;
const directEndpoint = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const safeJson = async response => {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || 'The voice intake service is unavailable.');
  return value;
};

const messageText = value => typeof value === 'string' ? value.trim() : '';
const speechInstruction = (text, language) => `[SMARTCAREOPS APPROVED MESSAGE]\nSpeak only the message below in the patient's selected language (${language}). Preserve its meaning, question structure, numbers, and 1-to-10 rating scale. Do not add advice, explanations, another question, or a completion statement.\n\n${text}`;
const voiceInstruction = language => `You are the live speech layer for SmartCareOps, not its clinical decision maker. The SmartCareOps backend owns every question, safety decision, emergency action, and completion decision. The selected conversation language is ${language}. When you receive client content beginning [SMARTCAREOPS APPROVED MESSAGE], speak only the approved message as directed. When you hear patient audio, listen and transcribe it accurately, but do not answer it, give advice, ask a question, or speak. SmartCareOps will provide the next approved message after it processes the transcript. Never diagnose, prescribe, or claim that emergency services, a doctor, a dispatcher, an ambulance, or a hospital has been contacted.`;

export class DirectLiveSocket {
  constructor({ token, model, preferredLanguage, intake, request, Socket = WebSocket }) {
    this.readyState = WebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.smartcareDirect = true;
    this.smartcareIntakeSessionId = intake.sessionId;
    this.smartcarePreferredLanguage = preferredLanguage;
    this.smartcareResumed = false;
    this.request = request;
    this.intake = intake;
    this.phase = 'connecting';
    this.patientText = '';
    this.patientTranscriptOpen = false;
    this.patientBoundaryPending = false;
    this.spokenQueue = [];
    this.closedByClient = false;
    const url = `${directEndpoint}?access_token=${encodeURIComponent(token)}`;
    this.upstream = new Socket(url);
    this.upstream.onopen = () => this.sendSetup(model, preferredLanguage);
    this.upstream.onmessage = event => { void this.receive(event); };
    this.upstream.onerror = event => this.onerror?.(event);
    this.upstream.onclose = event => {
      this.readyState = WebSocket.CLOSED;
      if (!this.closedByClient) this.onclose?.(event);
    };
  }

  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }

  sendSetup(model, language) {
    this.upstream.send(JSON.stringify({ setup: {
      model: `models/${String(model).replace(/^models\//, '')}`,
      generationConfig: { responseModalities: ['AUDIO'], temperature: 0.2, speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
      systemInstruction: { parts: [{ text: voiceInstruction(language) }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: false, silenceDurationMs: 2000, prefixPaddingMs: 500 },
        activityHandling: 'ACTIVITY_HANDLING_UNSPECIFIED',
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
      },
    } }));
  }

  send(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type === 'start') {
      if (this.phase !== 'ready') return;
      this.emit({ type: 'ready' });
      const opening = [...(this.intake.messages || [])].reverse().find(item => item.role === 'SmartCareOps')?.text || this.intake.question;
      this.speak([opening]);
      return;
    }
    if (message.type === 'audio') {
      if (this.phase !== 'listening' || this.upstream.readyState !== OPEN) return;
      this.upstream.send(JSON.stringify({ realtimeInput: { audio: { data: message.data, mimeType: `audio/pcm;rate=${message.sampleRate}` } } }));
      this.bufferedAmount = this.upstream.bufferedAmount || 0;
      return;
    }
    if (message.type === 'end') { void this.cancel(); return; }
    if (message.type === 'emergency-phase-settled' && this.emergency?.id === message.id) {
      if (message.phase === 'warning' && this.emergency.facility) this.emit({ type: 'emergency-phase-speech', id: message.id, phase: 'facility', text: this.emergency.facility });
      else this.emit({ type: 'emergency-playback-ready', id: message.id });
    }
  }

  async receive(event) {
    let raw = event.data;
    if (raw instanceof Blob) raw = await raw.text();
    else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
    let data;
    try { data = JSON.parse(raw); } catch { this.emit({ type: 'error', message: 'Could not process the live response. Please start again.' }); return; }
    if (data.setupComplete) {
      this.readyState = WebSocket.OPEN;
      this.phase = 'ready';
      this.onopen?.();
      return;
    }
    if (data.goAway) { this.emit({ type: 'error', message: 'The live session is ending. Start a new conversation to continue.' }); return; }
    const content = data.serverContent;
    if (!content) return;
    if (this.phase === 'listening' && content.inputTranscription?.text) {
      const text = content.inputTranscription.text;
      this.patientText += text;
      this.patientTranscriptOpen = false;
      this.patientBoundaryPending = true;
      this.emit({ type: 'transcript', role: 'Patient', text, finished: true });
      this.finalizePatientInput();
    }
    const hasModelOutput = !!content.outputTranscription?.text || (content.modelTurn?.parts || []).some(part => part.inlineData?.data);
    if (hasModelOutput) this.patientBoundaryPending = false;
    if (this.phase === 'speaking') {
      if (content.outputTranscription?.text) this.emit({ type: 'transcript', role: 'Gemini', text: content.outputTranscription.text, finished: !!content.outputTranscription.finished });
      for (const part of content.modelTurn?.parts || []) if (part.inlineData?.data && String(part.inlineData.mimeType || '').startsWith('audio/')) this.emit({ type: 'audio', data: part.inlineData.data });
      if (content.interrupted) this.emit({ type: 'interrupted' });
    }
    if (!content.turnComplete) return;
    if (this.patientBoundaryPending) { this.patientBoundaryPending = false; return; }
    if (this.phase === 'speaking') {
      this.emit({ type: 'turn-complete' });
      if (this.spokenQueue.length) { this.speakNext(); return; }
      if (this.terminal) {
        const terminal = this.terminal; this.terminal = null;
        this.emit({ type: 'intake-complete', patientCase: terminal.patientCase, completionToken: terminal.finalizationId || null });
        return;
      }
      this.phase = 'listening';
      return;
    }
    if (this.phase === 'listening') this.finalizePatientInput();
  }

  finalizePatientInput() {
    if (this.phase !== 'listening') return;
    const answer = this.patientText.trim();
    if (!answer) return;
    this.patientText = '';
    if (this.patientTranscriptOpen) { this.emit({ type: 'transcript', role: 'Patient', text: '', finished: true }); this.patientTranscriptOpen = false; }
    void this.submit(answer);
  }

  speak(messages) {
    this.spokenQueue.push(...messages.map(messageText).filter(Boolean));
    if (this.phase !== 'speaking') this.speakNext();
  }

  speakNext() {
    const text = this.spokenQueue.shift();
    if (!text || this.upstream.readyState !== OPEN) return;
    this.phase = 'speaking';
    this.upstream.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: speechInstruction(text, this.smartcarePreferredLanguage) }] }], turnComplete: true } }));
  }

  async submit(answer) {
    this.phase = 'processing';
    const priorCount = this.intake.messages?.length || 0;
    try {
      const response = await this.request('/api/intake/chat/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ sessionId: this.intake.sessionId, expectedRevision: this.intake.revision, message: answer }) });
      const next = await safeJson(response);
      this.intake = next;
      this.emit({ type: 'intake-update', intake: next.intake });
      this.emit({ type: 'intake-progress', progress: next.progress });
      if (next.patientCase) this.emit({ type: 'patient-case', patientCase: next.patientCase });
      const assistant = (next.messages || []).slice(priorCount).filter(item => item.role === 'SmartCareOps').map(item => item.text);
      if (next.status === 'emergency') {
        const id = crypto.randomUUID();
        this.emergency = { id, facility: assistant[1] || null };
        this.phase = 'emergency';
        this.emit({ type: 'emergency-escalation', id, snapshot: next.intake, patientCase: next.patientCase });
        queueMicrotask(() => this.emit({ type: 'emergency-phase-speech', id, phase: 'warning', text: assistant[0] || 'Please contact your local emergency number now.' }));
        return;
      }
      if (next.status === 'completed') this.terminal = { patientCase: next.patientCase, finalizationId: next.finalizationId };
      if (!assistant.length) { this.phase = 'listening'; return; }
      this.speak(assistant);
    } catch (error) {
      this.emit({ type: 'error', message: error.message || 'Your answer could not be processed. Please start again.' });
    }
  }

  async cancel() {
    if (this.closedByClient) return;
    this.closedByClient = true;
    try { await this.request('/api/intake/chat/session', { method: 'DELETE', headers: { 'X-SmartCareOps-Chat-Session-Id': this.intake.sessionId } }); } catch {}
  }

  close() {
    this.closedByClient = true;
    this.readyState = WebSocket.CLOSING;
    this.upstream.close();
    this.readyState = WebSocket.CLOSED;
  }
}

export async function createDirectLiveSocket({ bootstrap, request, Socket = WebSocket }) {
  const opened = await request('/api/intake/chat/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intakeSessionId: bootstrap.intakeSessionId }) });
  const intake = await safeJson(opened);
  if (intake.sessionId !== bootstrap.intakeSessionId) throw new Error('Secure voice session was invalid.');
  return new DirectLiveSocket({ token: bootstrap.geminiToken, model: bootstrap.model, preferredLanguage: bootstrap.preferredLanguage, intake, request, Socket });
}

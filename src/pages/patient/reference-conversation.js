import { GeminiLiveAPI, MultimodalLiveResponseType as Type } from './google-reference/client.js';
import { AudioStreamer, AudioPlayer } from './google-reference/media.js';

// The reference owns audio and turns. Completion is layered on the transcript;
// it must not gate, pause, or replace the reference audio path.
export function createReferenceConversation(outlet, request, { medicine } = {}) {
  const find = id => outlet.querySelector(`#${id}`);
  let current = null;
  let emergencyUtterance = null;
  let emergencySpeechTimer = null;
  let emergencyReplay = null;
  const retryEmergencyAudio = find('retry-emergency-audio');
  function clearEmergencySpeech() {
    clearTimeout(emergencySpeechTimer);
    if (emergencyUtterance) emergencyUtterance.onend = emergencyUtterance.onerror = null;
    emergencyUtterance = null;
  }
  function playEmergencySpeech(text, language, onend, onerror) {
    clearEmergencySpeech();
    const speech = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!speech || typeof speech.speak !== 'function' || typeof Utterance !== 'function') { onerror(); return; }
    const utterance = new Utterance(text);
    emergencyUtterance = utterance;
    utterance.lang = language;
    const settle = callback => {
      if (emergencyUtterance !== utterance) return;
      clearEmergencySpeech();
      callback();
    };
    utterance.onend = () => settle(onend);
    utterance.onerror = () => settle(onerror);
    // Some mobile speech engines can queue speech without firing either event.
    emergencySpeechTimer = setTimeout(() => settle(onerror), 55000);
    try { speech.speak(utterance); } catch { settle(onerror); }
  }
  function retryEmergencySpeech() {
    if (!emergencyReplay || current) return false;
    const { messages, language } = emergencyReplay;
    retryEmergencyAudio.hidden = true;
    const settled = failed => {
      if (failed) { try { window.speechSynthesis?.cancel(); } catch {} }
      retryEmergencyAudio.textContent = failed ? 'Retry emergency speech' : 'Play emergency message again';
      retryEmergencyAudio.hidden = false;
    };
    // Invoked synchronously by the button tap; does not reopen or resave intake.
    playEmergencySpeech(messages.join(' '), language, () => settled(false), () => settled(true));
    return true;
  }
  const notice = 'Only fictional test data is allowed. No real emergency response is dispatched.';
  const completionSentence = 'Thank you. Your intake is complete.';
  const closingQuestion = 'I got all the information I need for this intake. Is there anything else you want to say?';
  const medicineEvidenceGuidance = 'I opened the medicine package controls. Choose Use camera, then Capture photo. Complete and save the confirmed medicine entry; I will continue when it is saved.';
  const bodyEvidenceGuidance = 'I opened the Pain location controls. Choose Use camera, then Capture photo. Review the image, describe where it hurts in your own words, confirm sharing, and choose Share image with case. I will continue when it is shared.';
  const requestsMedicineEvidence = text => /\b(?:medicine|medication|prescription)\b/iu.test(String(text || '')) &&
    /\b(?:show|scan|camera|photo|picture|package|label|share)\b/iu.test(String(text || ''));
  const requestsBodyEvidence = text => /\b(?:show|share|camera|photo|picture|point)\b/iu.test(String(text || '')) &&
    /\b(?:pain|painful|hurt|hurts|hurting|body\s+area|location|where)\b/iu.test(String(text || ''));
  outlet.addEventListener('smartcareops:medicine-saved', event => {
    const session = current;
    if (!session?.medicineEvidenceRequested || event.detail?.intakeSessionId !== session.intakeSessionId) return;
    session.medicineEvidenceSaved = true;
    session.client?.sendTextMessage(`The patient has saved the confirmed medicine package entry. Ask exactly: "${session.closingQuestion || closingQuestion}"`);
    const region = outlet.querySelector('.patient-transcript-wrap');
    requestAnimationFrame(() => {
      region?.focus({ preventScroll: true });
      region?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
  });
  outlet.addEventListener('smartcareops:body-evidence-shared', event => {
    const session = current;
    if (!session?.bodyEvidenceRequested || event.detail?.intakeSessionId !== session.intakeSessionId) return;
    session.bodyEvidenceShared = true;
    session.client?.sendTextMessage(`The patient has shared the confirmed Pain location image and description. Ask exactly: "${session.closingQuestion || closingQuestion}"`);
    const region = outlet.querySelector('.patient-transcript-wrap');
    requestAnimationFrame(() => {
      region?.focus({ preventScroll: true });
      region?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
  });
  const emergencyWarning = "This information may require urgent attention. I'm stopping the standard intake. Emergency escalation is pending. No dispatcher or emergency service has been contacted.";
  const emergencyFacilityUnavailable = 'Current demo hospital information is unavailable.';
  const normalizePatientTurn = (session, text) => {
    const previous = session.turns.at(-1);
    const severityQuestion = previous?.role === 'Gemini' && /\b1\s+to\s+10\b/i.test(previous.text);
    return severityQuestion && /^x[.!?]?$/i.test(text.trim()) ? '10' : text;
  };
  const completionTool = {
    name: 'complete_intake',
    getDefinition() {
      return {
        name: this.name,
        description: 'Call when the patient clearly communicates, in any natural wording or language, that they are finished and have nothing else to add or ask. Do not call for an acknowledgement, silence, unclear speech, an interruption, or while the patient still has something to add.',
        parameters: { type: 'object', properties: {}, required: [] },
      };
    },
  };
  const emergencyTool = {
    name: 'trigger_emergency',
    getDefinition() {
      return {
        name: this.name,
        description: 'Call immediately when the patient clearly reports one supported emergency trigger. Do not infer an emergency from a severity number, fever, headache, dizziness, blood pressure, or an unclear statement. If the statement is ambiguous, ask one direct clarification instead.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              enum: [
                'current_chest_pain',
                'severe_difficulty_breathing',
                'loss_of_consciousness',
                'stroke_like_symptoms',
                'severe_uncontrolled_bleeding',
                'patient_requested_emergency_assistance',
              ],
            },
          },
          required: ['reason'],
        },
      };
    },
  };

  function stop(message = '') {
    const session = current;
    current = null;
    if (emergencyUtterance) { try { window.speechSynthesis?.cancel(); } catch {} }
    clearEmergencySpeech();
    if (session) {
      clearTimeout(session.closeTimer);
      clearTimeout(session.openingTimer);
      if (session.emergencyRequested) {
        try { window.speechSynthesis?.cancel(); } catch {}
      }
      session.controller.abort();
      session.client?.disconnect();
      session.streamer?.destroy();
      session.player?.destroy();
      medicine?.endSession(message ? 'error' : 'ended');
    }
    find('connection-status').textContent = message ? 'Error' : 'Disconnected';
    find('ai-state').textContent = '—';
    find('start-conversation').disabled = !find('intake-fictional').checked;
    find('end-conversation').disabled = true;
    find('intake-fictional').disabled = false;
    find('conversation-language').disabled = false;
    find('conversation-error').hidden = !message;
    find('conversation-error').textContent = message;
    find('session-help').textContent = notice;
  }

  async function saveCompletedIntake(session, outcome, speechUnavailable = false) {
    if (current !== session || session.saving) return;
    session.saving = true;
    const turns = session.turns.filter(turn => turn.role === 'Patient' || turn.role === 'Gemini');
    stop();
    find('start-conversation').disabled = true;
    find('intake-fictional').disabled = true;
    find('conversation-language').disabled = true;
    find('connection-status').textContent = outcome === 'emergency' ? 'Emergency escalation' : 'Saving intake';
    find('ai-state').textContent = 'Saving';
    find('session-help').textContent = 'Saving the validated fictional intake.';
    try {
      const response = await request('/api/intake/voice/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': session.saveKey },
        body: JSON.stringify({ intakeSessionId: session.intakeSessionId, outcome, turns }),
      });
      if (!response.ok) throw new Error('Save failed');
      const result = await response.json();
      if (!/^SC-[0-9a-f-]{36}$/.test(result?.patientCase?.caseId || '')) throw new Error('Invalid case');
      window.dispatchEvent(new CustomEvent('smartcareops:case-updated', { detail: { caseId: result.patientCase.caseId } }));
      find('connection-status').textContent = outcome === 'emergency' ? 'Emergency escalation' : 'Complete';
      find('ai-state').textContent = outcome === 'emergency'
        ? speechUnavailable ? 'Speech unavailable' : 'Emergency information complete'
        : 'Complete';
      find('session-help').textContent = outcome === 'emergency'
        ? 'Emergency case saved for dispatcher review. No dispatcher or emergency service has been contacted.'
        : `Voice intake saved as case ${result.patientCase.caseId}.`;
    } catch {
      find('connection-status').textContent = outcome === 'emergency' ? 'Emergency escalation — save failed' : 'Intake complete — save failed';
      find('ai-state').textContent = 'Save unavailable';
      find('conversation-error').hidden = false;
      find('conversation-error').textContent = 'The conversation completed, but the fictional intake could not be saved. Your existing cases are unchanged.';
      find('session-help').textContent = outcome === 'emergency'
        ? 'No dispatcher or emergency service has been contacted.'
        : 'Start a new intake to try again.';
    }
    find('start-conversation').disabled = !find('intake-fictional').checked;
    find('intake-fictional').disabled = false;
    find('conversation-language').disabled = false;
  }

  function finish(session) {
    void saveCompletedIntake(session, 'completed');
  }

  function finishEmergency(session, speechUnavailable = false) {
    void saveCompletedIntake(session, 'emergency', speechUnavailable);
  }

  function speakEmergency(session, append, messages, index = 0) {
    if (current !== session || !session.emergencyRequested) return;
    if (index >= messages.length) { finishEmergency(session); return; }
    const text = messages[index];
    append('SmartCareOps', text, true);
    const unavailable = () => {
      if (current !== session) return;
      for (const remaining of messages.slice(index + 1)) append('SmartCareOps', remaining, true);
      emergencyReplay = { messages: [...messages], language: session.preferredLanguage === 'fil' ? 'fil-PH' : session.preferredLanguage };
      retryEmergencyAudio.textContent = 'Retry emergency speech';
      retryEmergencyAudio.hidden = false;
      finishEmergency(session, true);
    };
    find('ai-state').textContent = index === 0 ? 'Speaking urgent warning' : 'Speaking hospital information';
    playEmergencySpeech(text, session.preferredLanguage === 'fil' ? 'fil-PH' : session.preferredLanguage,
      () => speakEmergency(session, append, messages, index + 1), unavailable);
  }

  async function start() {
    if (current || !find('intake-fictional').checked) return;
    if (emergencyUtterance) { try { window.speechSynthesis?.cancel(); } catch {} }
    clearEmergencySpeech();
    emergencyReplay = null;
    retryEmergencyAudio.hidden = true;
    const session = {
      controller: new AbortController(), rows: new Map(), startingAudio: false,
      playbackUntil: 0, completionRequested: false, closingResponseStarted: false, closeTimer: null,
      openingTimer: null, openingResponseSeen: false,
      emergencyRequested: false, preferredLanguage: find('conversation-language').value,
      turns: [], saveKey: crypto.randomUUID(), saving: false, intakeSessionId: null,
      medicineEvidenceRequested: false, medicineEvidenceSaved: false,
      bodyEvidenceRequested: false, bodyEvidenceShared: false,
    };
    current = session;
    find('start-conversation').disabled = true;
    find('end-conversation').disabled = false;
    find('intake-fictional').disabled = true;
    find('conversation-language').disabled = true;
    find('conversation-error').hidden = true;
    find('connection-status').textContent = 'Connecting';
    find('ai-state').textContent = '—';
    find('session-help').textContent = notice;
    find('transcript').replaceChildren();
    find('transcript-empty').hidden = false;
    find('medicine-flow').hidden = false;
    outlet.querySelector('.intake-panel').hidden = true;
    const region = outlet.querySelector('.patient-transcript-wrap');
    requestAnimationFrame(() => {
      if (current !== session) return;
      region?.focus({ preventScroll: true });
      region?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      });
    });

    const finalizeRow = role => {
      const row = session.rows.get(role);
      let text = row?.textContent?.trim();
      if (text && role === 'Patient') {
        text = normalizePatientTurn(session, text);
        row.textContent = text;
      }
      if (text && (role === 'Patient' || role === 'Gemini')) session.turns.push({ role, text });
      session.rows.delete(role);
    };
    const append = (role, text, finished = false) => {
      if (text) {
        find('transcript-empty').hidden = true;
        let row = session.rows.get(role);
        if (!row) {
          const item = document.createElement('li');
          const label = document.createElement('strong');
          label.textContent = role;
          row = document.createElement('p');
          item.append(label, row);
          find('transcript').append(item);
          session.rows.set(role, row);
        }
        row.textContent += text;
        find('transcript').scrollTop = find('transcript').scrollHeight;
      }
      if (finished) finalizeRow(role);
    };
    const requestEvidenceIfNeeded = () => {
      if (session.medicineEvidenceRequested || session.bodyEvidenceRequested) return;
      const patientTurn = session.turns.at(-1), priorTurn = session.turns.at(-2);
      if (patientTurn?.role !== 'Patient' || priorTurn?.role !== 'Gemini' || priorTurn.text.trim() !== session.closingQuestion) return;
      if (requestsMedicineEvidence(patientTurn.text)) session.medicineEvidenceRequested = medicine?.requestMedicinePackage() === true;
      else if (requestsBodyEvidence(patientTurn.text)) session.bodyEvidenceRequested = medicine?.requestBodyArea() === true;
    };
    const openingStage = (stage, detail) => {
      if (current !== session || session.openingResponseSeen) return;
      clearTimeout(session.openingTimer);
      find('session-help').textContent = `${notice} ${detail}`;
      session.openingTimer = setTimeout(() => {
        if (current === session && !session.openingResponseSeen) {
          const audioState = stage === 'audio player initialization'
            ? ` Audio context: ${session.player?.audioContext?.state || 'not created'}.` : '';
          find('session-help').textContent = `${notice} Still waiting: ${stage}.${audioState} You can end the conversation and try again.`;
        }
      }, 12000);
    };
    const openingResponse = () => {
      if (session.openingResponseSeen) return;
      session.openingResponseSeen = true;
      clearTimeout(session.openingTimer);
      find('session-help').textContent = notice;
    };
    const fail = () => { if (current === session) stop('The voice test could not connect. Your existing cases are unchanged.'); };
    try {
      // Start playback initialization during the Start tap so mobile browsers
      // can resume the audio context before the network bootstrap completes.
      session.player = new AudioPlayer();
      const playerReady = session.player.init();
      void playerReady.catch(fail);
      const language = session.preferredLanguage;
      const openingQuestion = language === 'fil'
        ? 'Kamusta, ito ang SmartCareOps. Ano ang gusto mong itawag ko sa iyo?'
        : 'Hello, this is SmartCareOps. What would you like me to call you?';
      const concernQuestion = language === 'fil' ? 'Ano ang iyong ipinag-aalala?' : 'What is your concern?';
      const onsetQuestion = language === 'fil'
        ? 'Kailan ito nagsimula o huling nagbago?'
        : 'When did it start or last change?';
      const clarificationSentence = language === 'fil'
        ? 'Pasensya na, hindi ko naintindihan iyon.'
        : "I'm sorry, I didn't catch that.";
      const severityQuestion = language === 'fil'
        ? 'Gaano ito kalala mula 1 hanggang 10, kung saan ang 10 ang pinakamalala?'
        : 'How severe is it from 1 to 10, with 10 being the most severe?';
      const historyQuestion = language === 'fil'
        ? 'Bagong sintomas ba ito, pabalik-balik, o may kaugnayan sa isang kondisyon na alam mo na?'
        : 'Is this new, recurring, or related to a condition you already know about?';
      session.closingQuestion = language === 'fil'
        ? 'Nakuha ko na ang lahat ng impormasyong kailangan ko para sa intake na ito. Mayroon ka pa bang gustong sabihin?'
        : closingQuestion;
      const selectedCompletionSentence = language === 'fil'
        ? 'Salamat. Tapos na ang iyong intake.'
        : completionSentence;
      const selectedMedicineEvidenceGuidance = language === 'fil'
        ? 'Binuksan ko ang mga kontrol para sa pakete ng gamot. Piliin ang Use camera, pagkatapos ang Capture photo. Kumpletuhin at i-save ang nakumpirmang tala ng gamot; magpapatuloy ako kapag na-save na ito.'
        : medicineEvidenceGuidance;
      const selectedBodyEvidenceGuidance = language === 'fil'
        ? 'Binuksan ko ang mga kontrol para sa lokasyon ng sakit. Piliin ang Use camera, pagkatapos ang Capture photo. Suriin ang larawan, ilarawan sa sarili mong mga salita kung saan masakit, kumpirmahin ang pagbabahagi, at piliin ang Share image with case. Magpapatuloy ako kapag naibahagi na ito.'
        : bodyEvidenceGuidance;
      session.emergencyMessages = language === 'fil'
        ? [
            'Maaaring kailanganin ng agarang atensyon ang impormasyong ito. Itinitigil ko ang karaniwang intake. Nakabinbin ang emergency escalation. Walang dispatcher o serbisyong pang-emergency na nakontak.',
            'Hindi available ang kasalukuyang impormasyon ng demo hospital.',
          ]
        : [emergencyWarning, emergencyFacilityUnavailable];
      const response = await request('/api/live/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredLanguage: language }), signal: session.controller.signal });
      if (!response.ok) throw new Error('Bootstrap failed');
      const bootstrap = await response.json();
      if (current !== session) return;
      if (typeof bootstrap.geminiToken !== 'string' || !bootstrap.geminiToken.startsWith('auth_tokens/') || typeof bootstrap.model !== 'string' || !/^[a-f0-9]{64}$/.test(bootstrap.intakeSessionId || '')) throw new Error('Direct Live token required');
      session.intakeSessionId = bootstrap.intakeSessionId;
      medicine?.beginSession(session.intakeSessionId);
      const client = session.client = new GeminiLiveAPI(bootstrap.geminiToken, bootstrap.model);
      client.systemInstructions = `You are the SmartCareOps clinical intake assistant. Conduct a short intake, one question at a time. Do not diagnose, recommend treatment, provide medical advice, search for providers, or continue with general conversation.
Each required item must be answered clearly before advancing. If an answer is unclear, unrelated, ambiguous, mistranscribed, or does not answer the current question, say: "${clarificationSentence}" Then repeat the current question. Do not infer an answer from an unrelated word. For severity, accept only a clear value from 1 to 10. For the condition-history question, require a response that clearly means new, recurring, or related to a known condition.
Collect these items in order, skipping an item only when the patient already answered it clearly:
1. Ask exactly: "${openingQuestion}"
2. Ask exactly: "${concernQuestion}"
3. Ask exactly: "${onsetQuestion}"
4. Ask exactly: "${severityQuestion}"
5. Ask exactly: "${historyQuestion}"
6. Ask exactly: "${session.closingQuestion}" Then wait for the patient's answer.
If the patient asks to show, photograph, scan, or share medicine or its package while answering the closing question, SmartCareOps opens those controls automatically. Say exactly: "${selectedMedicineEvidenceGuidance}" Then wait. Do not treat the request as ordinary additional information and do not repeat the closing question in the same response.
Do not call complete_intake while medicine-package capture or confirmation is unfinished. SmartCareOps will tell you when the confirmed medicine entry has been saved; only then ask the closing question again.
If the patient asks to show or share where something hurts, a pain location, or a body area while answering the closing question, SmartCareOps opens those controls automatically. Say exactly: "${selectedBodyEvidenceGuidance}" Then wait. Do not treat the request as ordinary additional information and do not repeat the closing question in the same response.
Do not call complete_intake while the requested Pain location image and confirmation are unfinished. SmartCareOps will tell you when the image has been shared; only then ask the closing question again.
When the patient's answer to the closing question clearly communicates that they are finished and have nothing else to add, call complete_intake. Use the meaning of the patient's response, including natural paraphrases in any language. If the patient adds information, acknowledge it and ask the same closing question again. Do not call complete_intake for a greeting, acknowledgement, silence, unclear speech, interruption, or while the patient still has something to add.
Emergency handling overrides the routine intake and completion. Immediately call trigger_emergency when the patient clearly reports current chest pain, severe difficulty breathing, loss of consciousness, stroke-like symptoms, severe uncontrolled bleeding, or explicitly requests emergency assistance. If a possible emergency statement is ambiguous, ask one direct clarification before calling the tool. Do not infer an emergency from a severity number, fever, headache, dizziness, blood pressure, or a combination of ordinary symptoms. After calling trigger_emergency, do not ask another routine question and do not call complete_intake.
After complete_intake succeeds, respond with exactly: "${selectedCompletionSentence}" The completion response must contain no other words.`;
      client.systemInstructions += ` LANGUAGE GUARDRAIL: The selected conversation language is ${language}. Keep routine responses in this language unless the patient explicitly asks to change it. Names, accents, medical terms, isolated foreign words, quoted phrases, and answers in another language do not themselves request a switch. Understand coherent multilingual answers without changing the response language or rejecting them merely for their language. On an explicit language-change request, continue in the requested language without restarting intake or discarding facts. A language-change request alone is not an answer to the pending intake question. Briefly acknowledge the switch in the requested language, then repeat that same unanswered question in the requested language and wait. Do not advance to onset, severity, history, or closing merely because the patient requested a language change. For example, after "What is your concern?", if Lui says "Can you speak in Tagalog?", respond "Oo, Lui. Ano ang iyong ipinag-aalala?" and wait; do not ask "Kailan ito nagsimula o huling nagbago?" because no concern has been reported. If the same turn also clearly answers the pending question, preserve that answer and follow the existing question sequence without asking it again. Emergency handling always retains priority. If the request is ambiguous, briefly ask which language the patient prefers before switching; keep the current clinical question unanswered and do not treat language preference as a clinical fact. If speech is unclear, request clarification rather than guessing symptoms or intent. Preserve all existing exact-wording instructions, opening question, emergency warning, emergency facility guidance, completion sentence, tool conditions, and one-question-at-a-time boundaries. This guardrail does not authorize additional clinical questions or actions.`;
      // Short Filipino answers such as "kahapon" were being auto-detected as
      // unrelated languages. Keep automatic detection for every other locale;
      // the selected Filipino flow accepts both Tagalog and English code-switching.
      client.inputAudioTranscription = language === 'fil'
        ? { languageCodes: ['fil-PH', 'en-US'] }
        : true;
      client.outputAudioTranscription = true;
      client.addFunction(completionTool);
      client.addFunction(emergencyTool);
      session.streamer = new AudioStreamer(client);
      client.onOpen = () => {
        if (current !== session) return;
        find('connection-status').textContent = 'Connected — voice test';
        openingStage('Gemini setup confirmation', 'Live socket connected; waiting for Gemini setup confirmation.');
      };
      client.onError = fail;
      client.onClose = () => { if (current === session) stop(); };
      client.onReceiveResponse = message => {
        if (current !== session) return;
        // After the emergency tool is accepted, SmartCareOps owns the terminal
        // warning. Ignore Gemini's post-tool generation so it cannot insert
        // filler text or audio between the two authorized messages.
        if (session.emergencyRequested && message.type !== Type.TOOL_CALL) return;
        const scheduleCompletion = () => {
          if (!session.completionRequested || !session.closingResponseStarted) return;
          clearTimeout(session.closeTimer);
          const remainingPlaybackMs = Math.max(0, session.playbackUntil - performance.now());
          session.closeTimer = setTimeout(() => finish(session), remainingPlaybackMs + 150);
        };
        switch (message.type) {
          case Type.SETUP_COMPLETE:
            if (session.startingAudio) return;
            session.startingAudio = true;
            openingStage('audio player initialization', 'Gemini setup confirmed; preparing phone audio.');
            void (async () => {
              await playerReady;
              if (current !== session) { session.player.destroy(); return; }
              openingStage('microphone start', 'Audio player ready; starting the microphone.');
              await session.streamer.start();
              if (current !== session) { session.streamer.destroy(); return; }
              medicine?.setReady(true);
              find('ai-state').textContent = 'Listening';
              client.sendTextMessage(`Begin the intake now. Ask exactly: "${openingQuestion}"`);
              openingStage('Gemini opening response', 'Microphone ready; opening question requested from Gemini.');
            })().catch(fail);
            break;
          case Type.AUDIO:
            openingResponse();
            void session.player.play(message.data).catch(fail);
            session.playbackUntil = Math.max(session.playbackUntil, performance.now())
              + ((atob(message.data).length / 2 / 24000) * 1000);
            if (session.completionRequested) session.closingResponseStarted = true;
            find('ai-state').textContent = 'Speaking';
            break;
          case Type.INPUT_TRANSCRIPTION:
            append('Patient', message.data.text, message.data.finished);
            if (message.data.finished) requestEvidenceIfNeeded();
            break;
          case Type.OUTPUT_TRANSCRIPTION:
            openingResponse();
            // Gemini Live does not consistently mark the final input transcript
            // with `finished`. Its first output transcript is the observed input
            // boundary, so finalize and inspect the Patient turn before appending
            // Gemini's response.
            finalizeRow('Patient');
            requestEvidenceIfNeeded();
            append('Gemini', message.data.text, message.data.finished);
            if (session.completionRequested && message.data.text) session.closingResponseStarted = true;
            break;
          case Type.TOOL_CALL: {
            openingResponse();
            const calls = Array.isArray(message.data?.functionCalls) ? message.data.functionCalls : [];
            const emergencyCalls = calls.filter(call => call?.name === emergencyTool.name);
            if (emergencyCalls.length) {
              client.sendToolResponse(emergencyCalls.map(call => ({
                id: call.id, name: call.name, response: { result: 'Emergency handling accepted. SmartCareOps will present the authorized warning.' },
              })));
              if (!session.emergencyRequested) {
                finalizeRow('Patient');
                session.emergencyRequested = true;
                session.completionRequested = false;
                session.closingResponseStarted = false;
                clearTimeout(session.closeTimer);
                session.streamer?.stop();
                session.player?.interrupt();
                session.rows.delete('Gemini');
                find('connection-status').textContent = 'Emergency escalation';
                find('ai-state').textContent = 'Preparing urgent warning';
                find('session-help').textContent = 'Microphone is off. Emergency information will be spoken and shown below.';
                speakEmergency(session, append, session.emergencyMessages);
              }
            }
            if (session.emergencyRequested) break;
            const completionCalls = calls.filter(call => call?.name === completionTool.name);
            if (!completionCalls.length) break;
            if (session.medicineEvidenceRequested && !session.medicineEvidenceSaved) {
              client.sendToolResponse(completionCalls.map(call => ({
                id: call.id, name: call.name, response: { result: 'Keep the intake open. The requested medicine evidence has not been saved yet.' },
              })));
              break;
            }
            if (session.bodyEvidenceRequested && !session.bodyEvidenceShared) {
              client.sendToolResponse(completionCalls.map(call => ({
                id: call.id, name: call.name, response: { result: 'Keep the intake open. The requested Pain location image has not been shared yet.' },
              })));
              break;
            }
            session.completionRequested = true;
            session.closingResponseStarted = false;
            client.sendToolResponse(completionCalls.map(call => ({
              id: call.id, name: call.name, response: { result: 'The intake may now be closed.' },
            })));
            break;
          }
          case Type.INTERRUPTED:
            clearTimeout(session.closeTimer);
            session.completionRequested = false;
            session.closingResponseStarted = false;
            session.playbackUntil = performance.now();
            session.player.interrupt();
            finalizeRow('Patient');
            session.rows.delete('Gemini');
            find('ai-state').textContent = 'Listening';
            break;
          case Type.TURN_COMPLETE:
            finalizeRow('Patient');
            finalizeRow('Gemini');
            scheduleCompletion();
            if (!session.completionRequested) find('ai-state').textContent = 'Listening';
            break;
        }
      };
      client.connect();
    } catch { fail(); }
  }
  return { start, stop, retryEmergencySpeech, get active() { return !!current; } };
}

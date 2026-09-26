// Only a finalized Gemini turn can end voice. Patient ASR never enters this buffer.
export function createVoiceState(log = () => {}) {
  let state = 'ACTIVE', transcript = '';
  return {
    get state() { return state; },
    observe(content) {
      if (state !== 'ACTIVE') return false;
      if (content.interrupted) { transcript = ''; return false; }
      transcript += content.outputTranscription?.text || '';
      if (!content.turnComplete) return false;
      const complete = /\byour intake is complete\.(?=\s|$)/i.test(transcript);
      transcript = '';
      if (!complete) return false;
      state = 'ENDING';
      log({ event: 'gemini_intake_complete', voiceState: state });
      return true;
    },
    close() {
      if (state === 'CLOSED') return;
      const terminal = state === 'ENDING';
      state = 'CLOSED'; transcript = '';
      if (terminal) log({ event: 'closed', reason: 'gemini_intake_complete' });
    },
  };
}

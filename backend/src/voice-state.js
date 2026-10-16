// Only a finalized Gemini turn can end voice. Patient ASR never enters this buffer.
export function createVoiceState(log = () => {}) {
  let state = 'ACTIVE', transcript = '', terminalOutputStarted = false, unauthorizedTerminal = false;
  const canonicalTerminal = 'your intake is complete';
  const terminalPhrase = /\byour intake is complete(?=$|[\s\p{P}])/iu;
  const terminalCarry = value => {
    const normalized = value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
    for (let length = Math.min(normalized.length, canonicalTerminal.length - 1); length >= 4; length--) {
      const suffix = normalized.slice(-length);
      if (canonicalTerminal.startsWith(suffix) && (suffix === 'your' || suffix.startsWith('your '))) return `${suffix} `;
    }
    return '';
  };
  return {
    get state() { return state; },
    get terminalOutputStarted() { return terminalOutputStarted; },
    get unauthorizedTerminal() { return unauthorizedTerminal; },
    observe(content, authorized = true) {
      if (state !== 'ACTIVE') return false;
      if (!transcript && unauthorizedTerminal) unauthorizedTerminal = false;
      if (content.interrupted) { transcript = ''; terminalOutputStarted = false; unauthorizedTerminal = false; return false; }
      transcript += content.outputTranscription?.text || '';
      const complete = terminalPhrase.test(transcript);
      if (complete && authorized) terminalOutputStarted = true;
      if (complete && !authorized) unauthorizedTerminal = true;
      if (!content.turnComplete) return false;
      transcript = authorized && !terminalOutputStarted ? terminalCarry(transcript) : '';
      if (!terminalOutputStarted) return false;
      state = 'ENDING';
      log({ event: 'gemini_intake_complete', voiceState: state });
      return true;
    },
    close() {
      if (state === 'CLOSED') return;
      const terminal = state === 'ENDING';
      state = 'CLOSED'; transcript = ''; unauthorizedTerminal = false;
      if (terminal) log({ event: 'closed', reason: 'gemini_intake_complete' });
    },
  };
}

// Presentation only: selecting a mode never calls either intake start action.
export function mountIntakeMode(outlet) {
  const page = outlet.querySelector('.patient-page');
  const buttons = [...outlet.querySelectorAll('[data-intake-mode]')];
  const voiceEnd = outlet.querySelector('#end-conversation');
  const chatActive = outlet.querySelector('#chat-intake-active');
  const chatForm = outlet.querySelector('#chat-intake-form');
  const chatStart = outlet.querySelector('#start-chat-intake');
  const chatConsent = outlet.querySelector('#chat-fictional');
  const workspace = outlet.querySelector('#conversation-area');
  let mode = chatActive.hidden ? 'none' : 'chat';
  const chatIsRunning = () => (!chatActive.hidden && !chatForm.hidden) ||
    (mode === 'chat' && chatActive.hidden && chatStart.disabled && chatConsent.checked);
  const update = () => {
    const voiceRunning = !voiceEnd.disabled;
    const chatRunning = chatIsRunning();
    if (voiceRunning) mode = 'voice';
    else if (chatRunning || !chatActive.hidden && mode === 'none') mode = 'chat';
    if (page.dataset.intakeMode !== mode) page.dataset.intakeMode = mode;
    outlet.querySelector('.patient-care-card').setAttribute('aria-labelledby', page.classList.contains('has-case') ? 'care-journey-heading' : 'patient-mode-heading');
    const playbackVisible = voiceRunning || !!outlet.querySelector('#transcript').children.length;
    if (page.classList.contains('intake-voice-output') !== playbackVisible) page.classList.toggle('intake-voice-output', playbackVisible);
    for (const button of buttons) {
      const pressed = String(button.dataset.intakeMode === mode);
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
      button.disabled = voiceRunning || chatRunning;
    }
    outlet.querySelector('#patient-selected-mode').textContent = mode === 'none' ? 'Start your intake' : mode === 'voice' ? 'Voice intake' : 'Chat intake';
    outlet.querySelector('#patient-mode-help').textContent = voiceRunning || chatRunning ? 'Finish or end this intake before choosing another mode.' : mode === 'none' ? 'Talk using your microphone or type your answers in chat. Choose an option to continue.' : mode === 'voice' ? 'Confirm fictional test data, then select Start Conversation to speak.' : 'Confirm fictional test data, then select Start Chat Intake to type.';
  };
  const choose = event => {
    if (!voiceEnd.disabled || chatIsRunning()) return;
    mode = event.currentTarget.dataset.intakeMode;
    update();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    workspace.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
    outlet.querySelector(mode === 'voice' ? '#intake-fictional' : '#chat-fictional').focus({ preventScroll: true });
  };
  const entry = outlet.querySelector('[data-choose-intake]');
  const showChoices = event => {
    event.preventDefault();
    const target = page.classList.contains('has-case') ? workspace : outlet.querySelector('#patient-mode-choice');
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    target.querySelector('[data-intake-mode]')?.focus({ preventScroll: true });
  };
  // Observe existing UI state without modifying the voice/chat controllers.
  const observer = new MutationObserver(update);
  observer.observe(voiceEnd, { attributes: true, attributeFilter: ['disabled'] });
  observer.observe(chatActive, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(chatForm, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(chatStart, { attributes: true, attributeFilter: ['disabled'] });
  observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  observer.observe(outlet.querySelector('#transcript'), { childList: true });
  buttons.forEach(button => button.addEventListener('click', choose));
  entry?.addEventListener('click', showChoices);
  update();
  return () => { observer.disconnect(); entry?.removeEventListener('click', showChoices); buttons.forEach(button => button.removeEventListener('click', choose)); };
}

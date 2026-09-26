import './patient.css';
import { intakeMarkup } from './intake-panel.js';
import { handoffMarkup } from './handoff.js';

export const renderPatient = () => `<section class="role-page patient-page" aria-labelledby="page-heading">
  <a class="back-link" href="/" data-link>← Back to home</a>
  <p class="eyebrow">Your intake conversation</p>
  <h1 id="page-heading" tabindex="-1">Patient Portal</h1>
  <p class="role-subtitle">AI-assisted healthcare intake and care coordination.</p>
  <p>A short voice conversation to share how you feel. Gemini will ask one follow-up question at a time.</p>
  <p class="scope-note">Intake prototype only; no diagnosis, prescriptions, or emergency response. Audio is sent to Google during the session. Use fictional details for testing.</p>
  <div class="patient-workspace"><section class="conversation-panel" aria-labelledby="conversation-heading">
    <h2 id="conversation-heading">Your conversation</h2>
    <div class="conversation-status" role="status" aria-live="polite">
      <span>Connection: <strong id="connection-status">Disconnected</strong></span>
      <span>AI: <strong id="ai-state">—</strong></span>
    </div>
    <div class="conversation-controls">
      <label><input id="intake-fictional" type="checkbox"> I confirm this conversation contains only fictional test data.</label>
      <button id="start-conversation" type="button" disabled>Start Conversation</button>
      <button id="end-conversation" type="button" disabled>End Conversation</button>
    </div>
    <p id="session-help">Your microphone starts only when you choose Start Conversation.</p>
    <p id="conversation-error" role="alert" hidden></p>
    <h3 id="transcript-heading">Live transcript</h3>
    <p id="transcript-empty">Patient and Gemini messages will appear here.</p>
    <ol id="transcript" aria-labelledby="transcript-heading" role="log" aria-live="polite" aria-relevant="additions text"></ol>
  </section>
  ${intakeMarkup()}</div>
  ${handoffMarkup()}
</section>`;

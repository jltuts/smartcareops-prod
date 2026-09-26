import { safeApiError } from './api-diagnostics.js';
// Construct diagnostics from allowlisted metadata, never raw SDK bodies or messages.
const failures = {
  BROWSER_LAUNCH_FAILED: 'Could not launch the isolated browser.',
  PORTAL_NAVIGATION_FAILED: 'Could not open the local demo portal.',
  SCREENSHOT_FAILED: 'Could not capture an acceptable portal screenshot.',
  MODEL_REQUEST_FAILED: 'Gemini Computer Use request failed.',
  MODEL_INVALID_RESPONSE: 'Gemini Computer Use response could not be processed.',
  ACTION_NOT_ALLOWED: 'The proposed browser action was not allowed.',
  ACTION_EXECUTION_FAILED: 'The browser action could not be executed.',
  ACTION_VERIFICATION_FAILED: 'The existing post-action browser check failed.',
  PORTAL_STATE_MISMATCH: 'The browser or receipt did not match the expected portal state.',
  TIMEOUT: 'The operation exceeded its deadline.',
  RECEIPT_VERIFICATION_FAILED: 'A matching receipt was not verified.',
  CANCELLED: 'The handoff was cancelled.',
  UNKNOWN_AGENT_ERROR: 'An unclassified handoff error occurred.',
};
const stageCodes = { prepare: 'UNKNOWN_AGENT_ERROR', browser_launch: 'BROWSER_LAUNCH_FAILED', portal_navigation: 'PORTAL_NAVIGATION_FAILED', screenshot: 'SCREENSHOT_FAILED', post_action_screenshot: 'SCREENSHOT_FAILED', model_request: 'MODEL_REQUEST_FAILED', parse_response: 'MODEL_INVALID_RESPONSE', validate_action: 'ACTION_NOT_ALLOWED', confirm_action: 'ACTION_NOT_ALLOWED', execute_action: 'ACTION_EXECUTION_FAILED', verify_action: 'ACTION_VERIFICATION_FAILED', portal_verification: 'ACTION_VERIFICATION_FAILED', receipt_verification: 'RECEIPT_VERIFICATION_FAILED', cleanup: 'UNKNOWN_AGENT_ERROR' };
const actions = new Set(['click', 'double_click', 'type', 'press_key', 'hotkey', 'scroll', 'wait', 'take_screenshot', 'navigate', 'populate_validated_intake']);
const intents = new Map();
for (const field of ['Patient Name', 'Reported Symptoms', 'Chest Pain', 'Onset / Duration', 'Blood Pressure', 'Temperature', 'Blood Glucose', 'Heart Rate', 'SpO2']) {
  for (const verb of ['Focus', 'Click', 'Fill', 'Enter', 'Read', 'Verify']) {
    const intent = `${verb} ${field} input field`;
    intents.set(intent.toLowerCase(), intent);
  }
}
for (const intent of ['Submit the fictional intake', 'Submit intake', 'Read portal screenshot', 'Verify portal receipt']) intents.set(intent.toLowerCase(), intent);
const saved = new WeakMap();
export const diagnosticsFor = error => error && typeof error === 'object' ? saved.get(error) : undefined;
export function tagAgentError(error, code) {
  if (error && typeof error === 'object') tagged.set(error, code);
  return error;
}
const tagged = new WeakMap();
export function createAgentDiagnostics(portalUrl, logger = entry => console.log('[agent]', JSON.stringify(entry))) {
  let url = null;
  try { const parsed = new URL(portalUrl); if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.pathname === '/hospital-demo' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) url = parsed.origin + parsed.pathname; } catch {}
  let state = { stage: 'prepare', step: 0, code: 'STARTED', actionType: null, intent: null, url, screenshotCaptured: false, modelCallStarted: false, modelCallSucceeded: false, actionExecuted: false, verificationSucceeded: null, receiptVerified: false, errorCategory: null, safeErrorMessage: null };
  const write = () => { const entry = { ...state, transport: 'generate_content' }; try { logger(entry); } catch {} return entry; };
  return {
    mark(stage, code = 'STARTED', flags = {}) { state = { ...state, ...flags, stage, code }; return write(); },
    action(call) { state.actionType = actions.has(call?.name) ? call.name : null; state.intent = typeof call?.arguments?.intent === 'string' ? intents.get(call.arguments.intent.trim().toLowerCase()) || '[Intent omitted: free-form model text]' : null; state.actionExecuted = false; state.verificationSucceeded = null; },
    fail(error) {
      let code = tagged.get(error) || stageCodes[state.stage] || 'UNKNOWN_AGENT_ERROR';
      if (error?.name === 'TimeoutError' || (code === 'MODEL_REQUEST_FAILED' && [408, 504].includes(error?.status ?? error?.statusCode))) code = 'TIMEOUT';
      let category = code;
      if (code === 'MODEL_REQUEST_FAILED') {
        const status = error?.status ?? error?.statusCode;
        category = status === 429 ? 'RATE_LIMIT' : [401, 403].includes(status) ? 'AUTH_ERROR' : Number.isInteger(status) && status >= 500 && status <= 599 ? 'SERVICE_UNAVAILABLE' : ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code) ? 'SERVICE_UNAVAILABLE' : 'GEMINI_ERROR';
      }
      if (['verify_action', 'portal_verification'].includes(state.stage)) state.verificationSucceeded = false;
      const status = error?.status ?? error?.statusCode;
      const statusDetail = state.stage === 'model_request' && [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504].includes(status) ? ` HTTP ${status}.` : '';
      state = { ...state, code, errorCategory: category, safeErrorMessage: (failures[code] || failures.UNKNOWN_AGENT_ERROR) + statusDetail,
        ...(state.stage === 'model_request' ? safeApiError(error) : {}),
      };
      const entry = write();
      if (error && typeof error === 'object') saved.set(error, entry);
      return entry;
    },
  };
}

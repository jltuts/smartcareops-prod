import { createAgentDiagnostics, tagAgentError } from './diagnostics.js';
import { HandoffError } from './errors.js';
import { createComputerClient } from './gemini-computer-use.js';
export { createComputerClient, computerUseModel, computerTools, agentInstruction } from './gemini-computer-use.js';
import { buildTask, caseFields } from './cases.js';
import { openBrowser, validateAction } from './browser.js';
import { rememberCall, callMetadata, isPng, buildFunctionResult, continuationMetadata, assertContinuation } from './continuation.js';

export async function runHandoff({ intake, portalUrl, emit, confirm, signal: parentSignal, request, open = openBrowser, maxSteps = 60, timeoutMs = 180000, screenshotLimit = 2 * 1024 * 1024, logger, assistedFill = true }) {
  const diagnostics = createAgentDiagnostics(portalUrl, logger);
  const started = Date.now(), metrics = { modelRequests: 0, browserActions: 0, populationCalls: 0, fieldsVerified: 0, modelMs: 0, browserActionMs: 0, screenshotMs: 0, totalMs: 0 };
  let populated = false, receiptVisible = false;
  const controller = new AbortController();
  const abort = () => controller.abort(tagAgentError(new HandoffError('Agentic handoff cancelled.'), 'CANCELLED'));
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(tagAgentError(new HandoffError('Agentic handoff timed out.'), 'TIMEOUT')), timeoutMs);
  let browser;
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = () => reject(signal.reason); signal.addEventListener('abort', rejectAborted, { once: true }); if (signal.aborted) rejectAborted(); });
  void aborted.catch(() => {});
  const bounded = work => Promise.race([work, aborted]);
  try {
    diagnostics.mark('prepare');
    emit({ status: 'preparing', message: 'Preparing case' });
    const task = buildTask(intake, portalUrl, assistedFill);
    const expected = caseFields(intake);
    diagnostics.mark('model_request', 'CONFIGURING');
    const generate = request || createComputerClient(undefined, { assistedFill });
    signal.throwIfAborted();
    emit({ status: 'opening', message: 'Opening hospital portal' });
    diagnostics.mark('browser_launch');
    const opening = open({ portalUrl, signal, diagnostic: (stage, code, flags) => { diagnostics.mark(stage, code, flags); if (stage === 'submission') emit({ status: 'submitting', message: 'Submitting' }); }, onBlocked: message => controller.abort(tagAgentError(new HandoffError(message), 'ACTION_NOT_ALLOWED')) });
    // Close even a browser whose launch resolves after cancellation/timeout.
    opening.then(value => { if (signal.aborted) void value.close().catch(() => {}); }, () => {});
    browser = await bounded(opening);
    const shot = async (stage = 'screenshot') => {
      diagnostics.mark(stage, 'STARTED', { screenshotCaptured: false });
      const shotStarted = Date.now(); const bytes = await bounded(browser.screenshot()); metrics.screenshotMs += Date.now() - shotStarted;
      if (!bytes.length || bytes.length > screenshotLimit) throw new HandoffError('Screenshot size limit reached.');
      if (!isPng(bytes)) throw new HandoffError('Portal screenshot is not a valid PNG capture.');
      diagnostics.mark(stage, 'SUCCEEDED', { screenshotCaptured: true });
      return { type: 'image', data: bytes.toString('base64'), mime_type: 'image/png' };
    };
    let history = [{ type: 'user_input', content: [{ type: 'text', text: task }, await shot()] }];
    let actions = 0;
    const continuations = [];
    for (let round = 0; round < maxSteps; round++) {
      signal.throwIfAborted();
      // Validate every retained result against immutable correlation/approval
      // metadata immediately before any continuation reaches the API.
      for (const { call, index, approved, sourceIndex } of continuations) {
        const metadata = continuationMetadata(call, history[index], portalUrl, approved, screenshotLimit, history[sourceIndex]);
        diagnostics.mark('model_request_prepare', 'CHECKING', { step: round + 1, ...metadata });
        assertContinuation(metadata);
      }
      diagnostics.mark('model_request', 'STARTED', { step: round + 1, modelCallStarted: true, modelCallSucceeded: false });
      emit({ status: receiptVisible ? 'verifying' : populated ? 'reviewing' : 'validating', message: receiptVisible ? 'Verifying receipt' : populated ? 'Reviewing submission' : 'Validating hospital form' });
      const modelStarted = Date.now(); metrics.modelRequests++;
      const response = await bounded(generate(history, signal)); metrics.modelMs += Date.now() - modelStarted;
      signal.throwIfAborted();
      diagnostics.mark('model_request', 'SUCCEEDED', { modelCallSucceeded: true });
      diagnostics.mark('parse_response');
      if (!Array.isArray(response.steps) || JSON.stringify(response.steps).length > 100000) throw new HandoffError('Invalid Computer Use response.');
      const calls = response.steps.filter(step => step.type === 'function_call');
      if (calls.some(call => call.name === 'populate_validated_intake') && (!assistedFill || populated || calls.length !== 1)) throw new HandoffError('Population must be a single visually confirmed action before review.');
      diagnostics.mark('parse_response', 'SUCCEEDED');
      // Retain the loop's normalized steps; the transport privately preserves
      // native signed model content. Never emit thoughts or raw responses.
      history = [...history, ...response.steps];
      if (!calls.length) {
        diagnostics.mark('receipt_verification');
        const caseId = await bounded(browser.receipt(expected));
        const text = response.steps.filter(s => s.type === 'model_output').flatMap(s => s.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
        if (!caseId || !text.includes(caseId)) throw new HandoffError('Agent did not verify a matching portal receipt.');
        diagnostics.mark('receipt_verification', 'SUCCEEDED', { receiptVerified: true });
        metrics.totalMs = Date.now() - started;
        diagnostics.mark('handoff_metrics', 'SUCCEEDED', { metrics: { ...metrics } });
        emit({ status: 'completed', message: 'Hospital handoff complete', caseId });
        return { caseId, metrics };
      }
      for (const call of calls) {
        if (++actions > maxSteps) throw tagAgentError(new HandoffError('Agentic handoff reached its action limit.'), 'UNKNOWN_AGENT_ERROR');
        diagnostics.action(call);
        diagnostics.mark('validate_action');
        validateAction(call, portalUrl);
        diagnostics.mark('validate_action', 'SUCCEEDED');
        const originalCall = rememberCall(call);
        diagnostics.mark('parsed_function_call', 'SUCCEEDED', callMetadata(originalCall));
        const a = call.arguments;
        let acknowledged = false;
        if (a.safety_decision?.decision === 'require_confirmation') {
          const explanation = typeof a.safety_decision.explanation === 'string' ? a.safety_decision.explanation.slice(0, 1000) : 'The model requests confirmation for this browser action.';
          diagnostics.mark('confirm_action');
          acknowledged = await bounded(confirm({ action: call.name, intent: a.intent || '', explanation }));
          if (!acknowledged) throw new HandoffError('Action blocked: confirmation declined.');
        }
        signal.throwIfAborted();
        emit({ status: call.name === 'populate_validated_intake' ? 'populating' : 'acting', message: call.name === 'populate_validated_intake' ? 'Populating patient intake' : populated ? 'Reviewing submission' : 'Validating hospital form' });
        diagnostics.mark('execute_action');
        const actionStarted = Date.now();
        if (call.name === 'populate_validated_intake') {
          if (typeof browser.populateValidated !== 'function') throw new HandoffError('Validated population is unavailable.');
          const result = await bounded(browser.populateValidated(expected)); metrics.populationCalls++; metrics.fieldsVerified += result.fieldsVerified; populated = true;
        } else { const result = await bounded(browser.execute(call)); metrics.browserActions++; receiptVisible = Boolean(result?.receiptVisible); }
        metrics.browserActionMs += Date.now() - actionStarted;
        diagnostics.mark('execute_action', 'SUCCEEDED', { actionExecuted: true });
        const screenshot = await shot('post_action_screenshot');
        emit({ status: receiptVisible ? 'verifying' : 'reviewing', message: receiptVisible ? 'Verifying receipt' : 'Reviewing submission' });
        // A click is not proof of success. Receipt/data checks occur only after
        // the model has received the screenshot and reports its observed ID.
        // No semantic action verifier exists here; do not claim one succeeded.
        diagnostics.mark('portal_verification', 'SCREENSHOT_READY_FOR_MODEL');
        continuations.push({ call: originalCall, index: history.length, approved: acknowledged, sourceIndex: history.indexOf(call) });
        history.push(buildFunctionResult(originalCall, screenshot, portalUrl, acknowledged));
      }
    }
    throw tagAgentError(new HandoffError('Agentic handoff reached its step limit.'), 'UNKNOWN_AGENT_ERROR');
  } catch (error) {
    diagnostics.fail(error);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
    signal.removeEventListener('abort', rejectAborted);
    try { await browser?.close(); } catch (error) { diagnostics.mark('cleanup'); diagnostics.fail(error); throw error; }
  }
}

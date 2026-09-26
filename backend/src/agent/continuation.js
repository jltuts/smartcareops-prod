import { createHash } from 'node:crypto';
import { HandoffError } from './errors.js';
import { tagAgentError } from './diagnostics.js';

const names = new Set(['click', 'double_click', 'type', 'press_key', 'hotkey', 'scroll', 'wait', 'take_screenshot', 'navigate', 'populate_validated_intake']);
const decisions = new Set(['allowed', 'regular', 'require_confirmation']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const keysAre = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
const present = value => typeof value === 'string' && value.length > 0;
const fingerprint = value => present(value) ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;

// Save correlation/approval metadata before executing the action. Do not retain
// or log typed text, intent, safety explanation or other free-form arguments here.
export function rememberCall(call) {
  return Object.freeze({ id: call.id, name: call.name, safetyDecision: call.arguments?.safety_decision?.decision ?? null });
}

export function callMetadata(call) {
  return {
    functionName: names.has(call.name) ? call.name : null,
    callIdPresent: present(call.id),
    callIdFingerprint: fingerprint(call.id),
    argumentsPresent: true,
    safetyDecision: decisions.has(call.safetyDecision) ? call.safetyDecision : null,
  };
}

export function isPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || !bytes.subarray(0, 8).equals(pngSignature)) return false;
  // Reject truncated/incorrectly labelled captures; Playwright is the encoder.
  let offset = 8, seenHeader = false, seenData = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + size + 12 > bytes.length) return false;
    if (!seenHeader) {
      if (type !== 'IHDR' || size !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) return false;
      seenHeader = true;
    }
    if (type === 'IDAT') seenData = true;
    offset += size + 12;
    if (type === 'IEND') return size === 0 && seenData && offset === bytes.length;
  }
  return false;
}

function screenshotValid(image, limit) {
  if (!keysAre(image, ['type', 'data', 'mime_type']) || image.type !== 'image' || image.mime_type !== 'image/png' || !present(image.data) || image.data.length > Math.ceil(limit / 3) * 4) return false;
  const bytes = Buffer.from(image.data, 'base64');
  return bytes.length <= limit && bytes.toString('base64') === image.data && isPng(bytes);
}

export function continuationMetadata(call, result, portalUrl, approved, screenshotLimit = 2 * 1024 * 1024, sourceCall) {
  const parts = Array.isArray(result?.result) ? result.result : [];
  let state;
  try { if (typeof parts[0]?.text === 'string') state = JSON.parse(parts[0].text); } catch {}
  const required = call.safetyDecision === 'require_confirmation';
  const included = !!state && Object.hasOwn(state, 'safety_acknowledgement');
  const fields = required ? ['url', 'safety_acknowledgement'] : ['url'];
  return {
    previousAction: names.has(call.name) ? call.name : null,
    functionName: names.has(result?.name) ? result.name : null,
    functionNamePresent: present(result?.name),
    functionNameMatchesPrevious: present(call.name) && result?.name === call.name,
    callIdPresent: present(result?.call_id),
    callIdMatchesPrevious: present(call.id) && result?.call_id === call.id,
    callIdFingerprint: fingerprint(result?.call_id),
    screenshotPresent: parts.some(part => part?.type === 'image'),
    screenshotValid: screenshotValid(parts[1], screenshotLimit),
    currentUrlPresent: typeof state?.url === 'string',
    currentUrlMatchesPortal: state?.url === portalUrl,
    safetyAcknowledgementRequired: required,
    safetyAcknowledgementIncluded: included,
    safetyAcknowledgementValid: required ? approved === true && state?.safety_acknowledgement === true : approved === false && !included,
    resultShapeValid: keysAre(result, ['type', 'name', 'call_id', 'result']) && result.type === 'function_result' && parts.length === 2 && keysAre(parts[0], ['type', 'text']) && parts[0].type === 'text' && keysAre(state, fields),
    originalCallUnchanged: !!sourceCall && sourceCall.type === 'function_call' && sourceCall.id === call.id && sourceCall.name === call.name && (sourceCall.arguments?.safety_decision?.decision ?? null) === call.safetyDecision,
  };
}

export function assertContinuation(metadata) {
  if (!['functionNamePresent', 'functionNameMatchesPrevious', 'callIdPresent', 'callIdMatchesPrevious', 'screenshotPresent', 'screenshotValid', 'currentUrlPresent', 'currentUrlMatchesPortal', 'safetyAcknowledgementValid', 'resultShapeValid', 'originalCallUnchanged'].every(key => metadata[key] === true)) {
    throw tagAgentError(new HandoffError('Computer Use continuation could not be validated. Retry the handoff.'), 'MODEL_INVALID_RESPONSE');
  }
}

/** @returns {import('@google/genai').Interactions.FunctionResultStep} */
export function buildFunctionResult(call, screenshot, portalUrl, approved) {
  return {
    type: 'function_result', name: call.name, call_id: call.id,
    result: [
      { type: 'text', text: JSON.stringify({ url: portalUrl, ...(call.safetyDecision === 'require_confirmation' && approved === true ? { safety_acknowledgement: true } : {}) }) },
      screenshot,
    ],
  };
}

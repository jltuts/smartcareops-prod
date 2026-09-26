// Diagnostic-only renderer. Never imported by the server or production agent.
import { createHash } from 'node:crypto';

const fields = new Set('model input store previous_interaction_id tools system_instruction type content signature summary encrypted_content arguments name id call_id result data inline_data inlineData mime_type mimeType text url safety_acknowledgement safety_decision decision explanation intent x y environment enable_prompt_injection_detection stream generation_config'.split(' '));
const enums = new Set('gemini-3.8-flash computer_use browser image text thought user_input model_output function_call function_result click double_click type press_key hotkey scroll wait take_screenshot navigate allowed regular require_confirmation image/png image/jpeg'.split(' '));
for (const field of 'contents role parts functionCall functionResponse function_call function_response response args thoughtSignature thought_signature computerUse computer_use enablePromptInjectionDetection systemInstruction generationConfig thinkingConfig includeThoughts'.split(' ')) fields.add(field);
for (const value of ['user', 'model', 'ENVIRONMENT_BROWSER']) enums.add(value);
const idView = value => `[sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}]`;

function imageView(data) {
  const magic = Buffer.from(data, 'base64').subarray(0, 8).toString('hex');
  return { wireType: 'string', dataLength: data.length, decodedMagic: magic === '89504e470d0a1a0a' ? magic : '[not PNG]' };
}

export function sanitizedWireBody(body) {
  const walk = (value, key = '', depth = 0) => {
    if (depth > 24) return '[depth omitted]';
    if (Array.isArray(value)) return value.map(item => walk(item, key, depth + 1));
    if (value && typeof value === 'object') {
      const output = {};
      for (const [field, child] of Object.entries(value)) {
        if (fields.has(field)) output[field] = walk(child, field, depth + 1);
        else output.unknownFieldsOmitted = true;
      }
      return output;
    }
    if (typeof value === 'string') {
      if (key === 'data') return imageView(value);
      if (['id', 'call_id', 'previous_interaction_id'].includes(key)) return idView(value);
      if (['signature', 'encrypted_content', 'thoughtSignature', 'thought_signature'].includes(key)) return { wireType: 'string', length: value.length, content: '[omitted]' };
      if (['model', 'role', 'type', 'name', 'mime_type', 'mimeType', 'environment', 'decision'].includes(key) && enums.has(value)) return value;
      if (key === 'text') {
        try {
          const state = JSON.parse(value);
          if (state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).every(k => ['url', 'safety_acknowledgement'].includes(k))) {
            return JSON.stringify({ ...(Object.hasOwn(state, 'url') ? { url: '[local URL omitted]' } : {}), ...(Object.hasOwn(state, 'safety_acknowledgement') ? { safety_acknowledgement: state.safety_acknowledgement === true } : {}) });
          }
        } catch {}
      }
      return '[omitted]';
    }
    if (typeof value === 'boolean' || value === null) return value;
    if (['x', 'y'].includes(key) && Number.isInteger(value) && value >= 0 && value <= 999) return value;
    return '[omitted]';
  };
  return walk(body);
}

export function wireImageFacts(body) {
  const images = [];
  let dataInlineDataExists = false;
  let inlineDataExists = false;
  const walk = (value, path = '$') => {
    if (!value || typeof value !== 'object') return;
    if (value.data && typeof value.data === 'object' && Object.hasOwn(value.data, 'inline_data')) dataInlineDataExists = true;
    if (value.type === 'image' && typeof value.data === 'string') images.push({ path, mimeTypeIsPng: value.mime_type === 'image/png', ...imageView(value.data) });
    for (const key of ['inlineData', 'inline_data']) {
      if (value[key] && typeof value[key].data === 'string') {
        inlineDataExists = true;
        images.push({ path: `${path}.${key}`, mimeTypeIsPng: (value[key].mimeType ?? value[key].mime_type) === 'image/png', ...imageView(value[key].data) });
      }
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${fields.has(key) || /^\d+$/.test(key) ? key : '[omitted]'}`);
  };
  walk(body);
  return { dataInlineDataExists, inlineDataExists, images };
}

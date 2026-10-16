import { GoogleGenAI } from '@google/genai';
import { runGeminiRequest } from '../../../shared/gemini-resilience.mjs';

const string = { type: 'string' };
export const patternInterpretationSchema = { type: 'object', additionalProperties: false, properties: {
  operationalImplications: string, monitoring: string, uncertainty: string,
}, required: ['operationalImplications', 'monitoring', 'uncertainty'] };
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 300 &&
  !/[<>\d]/.test(value) && !/outbreak|epidemic|confirmed/i.test(value);

export function validatePatternInterpretation(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== [...patternInterpretationSchema.required].sort().join(',') ||
      !patternInterpretationSchema.required.every(key => validText(value[key]))) throw new Error('INVALID_PATTERN_INTERPRETATION');
  return structuredClone(value);
}

export function createPatternModel({ request, model = process.env.GEMINI_PREDICTIVE_MODEL || process.env.GEMINI_CLINICAL_MODEL || 'gemini-3.6-flash' } = {}) {
  return async (context, signal) => {
    const client = request ? null : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const generate = request || client.interactions.create.bind(client.interactions);
    const result = await runGeminiRequest(() => generate({ model, store: false,
      system_instruction: 'Give a brief qualitative operational advisory for a deterministic synthetic respiratory pattern. The detector is authoritative. Do not decide whether it exists, change severity, repeat or invent numbers or locations, identify an outbreak, diagnose anyone, or trigger actions. Return only the three qualitative fields in the supplied schema. Do not include digits or outbreak declarations.',
      input: JSON.stringify({ severity: context.severity, trend: context.trend }),
      response_format: { type: 'text', mime_type: 'application/json', schema: patternInterpretationSchema },
      generation_config: { max_output_tokens: 500, thinking_level: 'low', thinking_summaries: 'none' },
    }, { signal, maxRetries: 0 }), { signal, idempotent: true, maxRetries: 0, validate: response => {
      if (response?.status !== 'completed' || typeof response.output_text !== 'string' || response.output_text.length > 4000) throw new Error('Invalid pattern interpretation');
      return validatePatternInterpretation(JSON.parse(response.output_text));
    } });
    if (!result.ok) throw new Error('PATTERN_MODEL_UNAVAILABLE');
    return result.value;
  };
}


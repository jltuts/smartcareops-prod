import { GoogleGenAI } from '@google/genai';
import { runGeminiRequest } from '../../../shared/gemini-resilience.mjs';

const string = { type: 'string' }, strings = { type: 'array', items: string };
export const predictiveInterpretationSchema = { type: 'object', additionalProperties: false, properties: {
  topBottleneck: string, recommendation: string, why: strings, whyNot: strings, uncertainty: strings, whatWouldChange: strings,
}, required: ['topBottleneck', 'recommendation', 'why', 'whyNot', 'uncertainty', 'whatWouldChange'] };
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[<>]/.test(value);
export function validatePredictiveInterpretation(value, bottlenecks) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== [...predictiveInterpretationSchema.required].sort().join(',') ||
      !validText(value.topBottleneck) || !validText(value.recommendation) ||
      !['why', 'whyNot', 'uncertainty', 'whatWouldChange'].every(key => Array.isArray(value[key]) && value[key].length >= 1 && value[key].length <= 4 && value[key].every(validText))) throw new Error('INVALID_PREDICTIVE_INTERPRETATION');
  const allowed = bottlenecks.map(item => item.resource);
  if (value.topBottleneck !== 'No significant bottleneck identified' && !allowed.includes(value.topBottleneck)) throw new Error('INVALID_PREDICTIVE_INTERPRETATION');
  return structuredClone(value);
}
export function createPredictiveModel({ request, model = process.env.GEMINI_PREDICTIVE_MODEL || process.env.GEMINI_CLINICAL_MODEL || 'gemini-3.6-flash' } = {}) {
  return async (context, signal) => {
    const client = request ? null : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const generate = request || client.interactions.create.bind(client.interactions);
    const result = await runGeminiRequest(() => generate({ model, store: false,
      system_instruction: 'Interpret only the deterministic M15 metrics and bottlenecks supplied by the backend. Do not invent or alter forecast numbers, facilities, statuses, or bottlenecks. Select topBottleneck only from the supplied bottleneck resource values, or use "No significant bottleneck identified" when the list is empty. Recommend an advisory operational consideration only. Never mutate the simulator, execute a CareTwin plan, contact facilities, perform handoff, or use Computer Use. Explain why, why not, uncertainty, and what observable input would change the recommendation. Do not expose chain-of-thought. Return concise JSON matching the schema.',
      input: JSON.stringify(context), response_format: { type: 'text', mime_type: 'application/json', schema: predictiveInterpretationSchema },
      generation_config: { max_output_tokens: 1400, thinking_level: 'low', thinking_summaries: 'none' },
    }, { signal, maxRetries: 0 }), { signal, idempotent: true, maxRetries: 0, validate: response => {
      if (response?.status !== 'completed' || typeof response.output_text !== 'string' || response.output_text.length > 8000) throw new Error('Invalid predictive interpretation');
      const parsed = JSON.parse(response.output_text);
      return validatePredictiveInterpretation(parsed, context.bottlenecks);
    } });
    if (!result.ok) throw new Error('PREDICTIVE_MODEL_UNAVAILABLE');
    return result.value;
  };
}

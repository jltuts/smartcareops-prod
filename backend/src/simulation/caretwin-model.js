import { GoogleGenAI } from '@google/genai';
import { runGeminiRequest } from '../../../shared/gemini-resilience.mjs';

const planIds = ['A', 'B', 'C'];
const string = { type: 'string' }, strings = { type: 'array', items: string };
export const careTwinComparisonSchema = { type: 'object', additionalProperties: false, properties: {
  comparisonSummary: string,
  recommendedPlan: { type: 'string', enum: planIds },
  whyRecommended: strings,
  whyNotOthers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { planId: { type: 'string', enum: planIds }, tradeoff: string }, required: ['planId', 'tradeoff'] } },
  uncertainty: strings,
  whatWouldChangeRecommendation: strings,
}, required: ['comparisonSummary', 'recommendedPlan', 'whyRecommended', 'whyNotOthers', 'uncertainty', 'whatWouldChangeRecommendation'] };

const plainText = (value, limit = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[<>]/.test(value);
export function validateCareTwinComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...careTwinComparisonSchema.required].sort().join(',')) throw new Error('INVALID_CARETWIN_COMPARISON');
  if (!plainText(value.comparisonSummary) || !planIds.includes(value.recommendedPlan)) throw new Error('INVALID_CARETWIN_COMPARISON');
  for (const key of ['whyRecommended', 'uncertainty', 'whatWouldChangeRecommendation']) {
    if (!Array.isArray(value[key]) || value[key].length < 1 || value[key].length > 4 || !value[key].every(item => plainText(item))) throw new Error('INVALID_CARETWIN_COMPARISON');
  }
  if (!Array.isArray(value.whyNotOthers) || value.whyNotOthers.length !== 2) throw new Error('INVALID_CARETWIN_COMPARISON');
  const otherIds = value.whyNotOthers.map(item => item?.planId);
  if (otherIds.some(id => !planIds.includes(id) || id === value.recommendedPlan) || new Set(otherIds).size !== 2 || value.whyNotOthers.some(item => Object.keys(item).sort().join(',') !== 'planId,tradeoff' || !plainText(item.tradeoff))) throw new Error('INVALID_CARETWIN_COMPARISON');
  return structuredClone(value);
}

export function createCareTwinModel({ request, model = process.env.GEMINI_CARETWIN_MODEL || process.env.GEMINI_CLINICAL_MODEL || 'gemini-3.6-flash' } = {}) {
  return async (context, signal) => {
    const client = request ? null : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const generate = request || client.interactions.create.bind(client.interactions);
    const result = await runGeminiRequest(() => generate({ model, store: false,
      system_instruction: 'You compare deterministic synthetic operational futures for human review. The backend-generated M15 outcomes are the only source of future metrics. Never invent or alter occupancy, capacity, demand, ambulance, hospital-state, or pressure values. Compare Plan A, B, and C using only supplied outcomes. State trade-offs, uncertainty, and what observable changes could alter the recommendation. The demand redistribution action uses synthetic arrivals only; patient-specific suitability, travel times, and admission capability are unknown and must remain explicit uncertainty. Recommend one plan as advisory only. Do not execute plans, call tools, create dispatches, contact hospitals, or claim real operational effects. Do not expose chain-of-thought. Return only the required concise JSON.',
      input: JSON.stringify(context), response_format: { type: 'text', mime_type: 'application/json', schema: careTwinComparisonSchema },
      generation_config: { max_output_tokens: 1800, thinking_level: 'low', thinking_summaries: 'none' },
    }, { signal, maxRetries: 0 }), { signal, idempotent: true, maxRetries: 0, validate: response => {
      if (response?.status !== 'completed' || typeof response.output_text !== 'string' || response.output_text.length > 12000) throw new Error('Invalid CareTwin comparison');
      return validateCareTwinComparison(JSON.parse(response.output_text));
    } });
    if (!result.ok) throw Object.assign(new Error('CARETWIN_MODEL_UNAVAILABLE'), { code: 'CARETWIN_MODEL_UNAVAILABLE' });
    return result.value;
  };
}

import { GoogleGenAI } from '@google/genai';

const modelName = value => String(value || 'gemini-3.8-live').replace(/^models\//, '');

export function createGeminiLiveTokenProvider({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live', now = () => Date.now(), client: injectedClient } = {}) {
  if (!apiKey && !injectedClient) return null;
  const client = injectedClient || new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
  const selectedModel = modelName(model);
  return async () => {
    const issuedAt = now();
    const expireTime = new Date(issuedAt + 30 * 60_000).toISOString();
    const newSessionExpireTime = new Date(issuedAt + 60_000).toISOString();
    const token = await client.authTokens.create({ config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      httpOptions: { apiVersion: 'v1beta' },
    } });
    if (typeof token?.name !== 'string' || !token.name || /\s/.test(token.name)) throw new Error('LIVE_TOKEN_UNAVAILABLE');
    return { token: token.name, model: selectedModel, expiresAt: expireTime };
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiLiveTokenProvider } from '../src/live-token.js';

test('ephemeral Live token is one-use, short-lived, v1beta, and leaves the WebSocket setup effective', async () => {
  let request;
  const client = { authTokens: { async create(value) { request = value; return { name: 'auth_tokens/test-token' }; } } };
  const issuedAt = Date.parse('2026-10-08T00:00:00.000Z');
  const createToken = createGeminiLiveTokenProvider({ client, model: 'gemini-3.8-live', now: () => issuedAt });
  const token = await createToken();
  assert.equal(token.token, 'auth_tokens/test-token');
  assert.equal(token.model, 'gemini-3.8-live');
  assert.deepEqual(request.config, {
    uses: 1,
    expireTime: '2026-10-08T00:30:00.000Z',
    newSessionExpireTime: '2026-10-08T00:01:00.000Z',
    httpOptions: { apiVersion: 'v1beta' },
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExtractionError } from '../src/intake/errors.js';
import { createExtractor } from '../src/intake/extractor.js';
import { emptyIntake } from '../src/intake/schema.js';

test('extraction uses shared retries without SDK retries and respects long Retry-After', async () => {
  let calls = 0;
  const extract = createExtractor('test-key', 'unchanged-test-model', { request: async (body, options) => {
    calls++; assert.equal(options.maxRetries, 0); assert.equal(body.model, 'unchanged-test-model');
    throw Object.assign(new Error('key=secret'), { status: 429, headers: { 'retry-after': '60' } });
  }, wait: async () => assert.fail('Must not shorten Retry-After') });
  await assert.rejects(extract({ utterances: [], intake: emptyIntake() }), error => {
    const diagnostic = classifyExtractionError(error);
    assert.equal(diagnostic.code, 'RATE_LIMIT'); assert.equal(diagnostic.retryAfterMs, 60000);
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret/); return true;
  });
  assert.equal(calls, 1);
});

test('extraction recovers from a transient failure and rejects malformed output without retrying it', async () => {
  let calls = 0; const delays = [];
  const extract = createExtractor('test-key', 'unchanged-test-model', { request: async () => {
    if (++calls === 1) throw { status: 503 };
    return { output_text: '{"updates":[]}' };
  }, wait: async ms => delays.push(ms) });
  assert.deepEqual(await extract({ utterances: [], intake: emptyIntake() }), { updates: [] });
  assert.equal(calls, 2); assert.equal(delays.length, 1);
  const invalid = createExtractor('test-key', 'unchanged-test-model', { request: async () => ({ output_text: 'invalid' }), wait: async () => assert.fail('Invalid responses are not retryable') });
  await assert.rejects(invalid({ utterances: [], intake: emptyIntake() }), error => classifyExtractionError(error).code === 'INVALID_RESPONSE');
});

test('429 and Gemini RESOURCE_EXHAUSTED map to safe RATE_LIMIT diagnostics', () => {
  for (const error of [{ status: 429 }, { code: 429 }, { error: { status: 'RESOURCE_EXHAUSTED' } }, { code: 'RESOURCE_EXHAUSTED' }, { message: 'RESOURCE_EXHAUSTED key=secret token=private billing=hidden' }]) {
    const result = classifyExtractionError(error);
    assert.equal(result.code, 'RATE_LIMIT');
    assert.equal(result.provider, 'gemini');
    assert.doesNotMatch(JSON.stringify(result), /secret|private|hidden|billing|token/);
  }
});

test('generic and unavailable errors do not masquerade as quota failures', () => {
  assert.equal(classifyExtractionError({ status: 503 }).code, 'SERVICE_UNAVAILABLE');
  assert.equal(classifyExtractionError({ status: 401 }).code, 'AUTH_ERROR');
  for (const error of [new Error('Invalid JSON'), { status: 400 }, null]) {
    assert.equal(classifyExtractionError(error).code, 'GEMINI_ERROR');
  }
});

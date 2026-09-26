import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGeminiError as classify, sanitizeGeminiError, getUserMessage, getDeveloperMessage, isRetryable, runGeminiRequest } from '../../shared/gemini-resilience.mjs';

for (const [name, error, expected] of [
  ['HTTP 429', { status: 429 }, 'RATE_LIMIT'],
  ['plain SDK category', { message: 'RESOURCE_EXHAUSTED: private details' }, 'RATE_LIMIT'],
  ['RESOURCE_EXHAUSTED', { error: { status: 'RESOURCE_EXHAUSTED' } }, 'RATE_LIMIT'],
  ['JSON SDK body', { message: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }) }, 'RATE_LIMIT'],
  ['timeout', { name: 'TimeoutError' }, 'TIMEOUT'],
  ['transport timeout', { cause: { code: 'ETIMEDOUT' } }, 'TIMEOUT'],
  ['deadline', { status: 504, code: 'DEADLINE_EXCEEDED' }, 'TIMEOUT'],
  ['upstream 500', { status: 500 }, 'SERVICE_UNAVAILABLE'],
  ['upstream 503', { response: { status: 503 } }, 'SERVICE_UNAVAILABLE'],
  ['upstream 599', { status: 599 }, 'SERVICE_UNAVAILABLE'],
  ['transient transport', { code: 'ECONNRESET' }, 'SERVICE_UNAVAILABLE'],
  ['authentication', { status: 401 }, 'AUTH_ERROR'],
  ['permission', { status: 403 }, 'AUTH_ERROR'],
  ['Gemini permission', { error: { status: 'PERMISSION_DENIED' } }, 'AUTH_ERROR'],
  ['invalid JSON', new SyntaxError('Private response'), 'INVALID_RESPONSE'],
  ['invalid schema', { code: 'INVALID_RESPONSE' }, 'INVALID_RESPONSE'],
  ['generic', new Error('Unknown'), 'GEMINI_ERROR'],
  ['explicit cancellation', { name: 'AbortError' }, 'GEMINI_ERROR'],
]) test(name, () => assert.equal(classify(error).code, expected));

test('unknown secrets are discarded rather than passed through in either message layer', () => {
  const secret = 'unrecognizable-secret-123';
  const error = { status: 429, message: secret, stack: secret, apiKey: secret, credentials: secret,
    request: { url: `https://example.invalid?key=${secret}` }, headers: { Authorization: `Bearer ${secret}` }, billingProject: secret };
  const safe = sanitizeGeminiError(error);
  assert.deepEqual(safe, { provider: 'gemini', code: 'RATE_LIMIT', httpStatus: 429 });
  assert.ok(!JSON.stringify(safe).includes(secret));
  assert.ok(!getUserMessage(safe).includes(secret));
  assert.match(getDeveloperMessage(safe), /Gemini API quota or rate limit exceeded/);
  assert.match(getDeveloperMessage(safe), /HTTP 429/);
  assert.ok(!getDeveloperMessage({ ...safe, code: secret, httpStatus: secret, detail: secret }).includes(secret));
});

test('only Gemini temporary failures are retry candidates', () => {
  for (const error of [{ status: 429 }, { status: 503 }]) assert.equal(isRetryable(classify(error)), true);
  for (const error of [{ name: 'TimeoutError' }, { status: 401 }, new SyntaxError(), new Error()]) assert.equal(isRetryable(classify(error)), false);
  assert.equal(isRetryable({ provider: 'other', code: 'RATE_LIMIT' }), false);
});

test('Retry-After handles seconds and HTTP date; invalid headers do not escape', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(classify({ status: 429, headers: { 'retry-after': '3' } }, { now }).retryAfterMs, 3000);
  assert.equal(classify({ status: 503, response: { headers: new Headers({ 'Retry-After': 'Thu, 01 Jan 2026 00:00:05 GMT' }) } }, { now }).retryAfterMs, 5000);
  assert.equal(classify({ headers: { 'retry-after': 'private-secret' } }).retryAfterMs, undefined);
});

test('failure preserves prior state and never enters the downstream success path', async () => {
  const previousState = Object.freeze({ value: 'last valid' });
  let downstream = 0;
  const result = await runGeminiRequest(async () => { throw { status: 429 }; }, { previousState, validate: x => x });
  if (result.ok) downstream++;
  assert.equal(result.ok, false);
  assert.equal(result.state, previousState);
  assert.deepEqual(previousState, { value: 'last valid' });
  assert.equal(downstream, 0);
});

test('exponential backoff is bounded and state commits only after a validated success', async () => {
  let calls = 0; const delays = [];
  const result = await runGeminiRequest(async () => { if (++calls <= 2) throw { status: 503 }; return { value: 7 }; }, {
    validate: response => response.value, maxRetries: 2, idempotent: true,
    random: () => 1, wait: async ms => delays.push(ms), baseDelayMs: 100,
  });
  assert.deepEqual(delays, [100, 200]);
  assert.deepEqual(result, { ok: true, value: 7 });
  assert.equal(calls, 3);
});

test('persistent quota stops at retry cap without losing prior state', async () => {
  let calls = 0;
  const result = await runGeminiRequest(async () => { calls++; throw { status: 429 }; }, {
    previousState: 'old', validate: x => x, maxRetries: 2, idempotent: true, wait: async () => {},
  });
  assert.equal(calls, 3); assert.equal(result.state, 'old'); assert.equal(result.ok, false);
});

test('Retry-After is never shortened to fit the configured budget', async () => {
  let calls = 0; const delays = [];
  const result = await runGeminiRequest(async () => { calls++; throw { status: 429, headers: { 'retry-after': '60' } }; }, {
    validate: x => x, maxRetries: 2, idempotent: true, maxTotalWaitMs: 1000, wait: async ms => delays.push(ms),
  });
  assert.equal(calls, 1); assert.deepEqual(delays, []); assert.equal(result.ok, false);
});

test('Retry-After within budget sets the minimum wait', async () => {
  let calls = 0; const delays = [];
  await runGeminiRequest(async () => { if (++calls === 1) throw { status: 429, headers: { 'retry-after': '2' } }; return 1; }, {
    validate: x => x, maxRetries: 1, idempotent: true, wait: async ms => delays.push(ms), random: () => 0,
  });
  assert.deepEqual(delays, [2000]);
});

test('retries require idempotency and project policy may veto a hard quota retry', async () => {
  for (const options of [{ idempotent: false }, { idempotent: true, shouldRetry: () => false }]) {
    let calls = 0;
    await runGeminiRequest(async () => { calls++; throw { status: 429 }; }, { validate: x => x, maxRetries: 3, ...options });
    assert.equal(calls, 1);
  }
});

test('invalid responses cannot commit or trigger retries', async () => {
  let calls = 0;
  const result = await runGeminiRequest(async () => { calls++; return 'malformed'; }, {
    previousState: 'old', validate: () => { throw new Error('private response'); }, maxRetries: 2, idempotent: true,
  });
  assert.equal(result.error.code, 'INVALID_RESPONSE'); assert.equal(result.state, 'old'); assert.equal(calls, 1);
});

test('a response arriving after cancellation never grants downstream readiness', async () => {
  const controller = new AbortController();
  const result = await runGeminiRequest(async () => { controller.abort(); return 'late'; }, { previousState: 'old', validate: x => x, signal: controller.signal });
  assert.equal(result.ok, false); assert.equal(result.state, 'old');
});

test('cancellation interrupts backoff without another request', async () => {
  const controller = new AbortController(); let calls = 0;
  const result = await runGeminiRequest(async () => { calls++; throw { status: 503 }; }, {
    previousState: 'old', validate: x => x, maxRetries: 2, idempotent: true, signal: controller.signal,
    wait: async () => { controller.abort(); },
  });
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.state, 'old');
});
